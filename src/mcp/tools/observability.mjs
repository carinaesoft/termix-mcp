import { z } from 'zod';
import { scrubValue } from '../../util/redact.mjs';
import { withUnconfirmedTarget } from '../../util/upstream.mjs';
import { ALERTS, RECORDINGS } from '../../termix/routes.mjs';

// Termix's own records: its audit log, terminal session logs, activity feed,
// and alerts. Useful for verifying what the MCP (or anyone) did, and for
// cross-checking this server's local audit against Termix's.
export function observabilityTools() {
  return [
    {
      name: 'audit_logs',
      title: 'Query Termix audit logs',
      description:
        'Query Termix\'s own audit log, filterable by user, action, resource type, success, and date range. '
        + 'This is Termix\'s server-side record, separate from this MCP server\'s local audit file.',
      mutating: false,
      hostArg: null,
      inputSchema: {
        page: z.number().int().positive().default(1),
        limit: z.number().int().positive().max(500).default(50),
        userId: z.string().optional(),
        action: z.string().optional(),
        resourceType: z.string().optional(),
        success: z.boolean().optional(),
        startDate: z.string().optional().describe('ISO date lower bound'),
        endDate: z.string().optional().describe('ISO date upper bound'),
      },
      handler: async (args, ctx) => {
        try {
          return await ctx.client.get('/audit-logs', {
            page: args.page,
            limit: args.limit,
            userId: args.userId,
            action: args.action,
            resourceType: args.resourceType,
            success: args.success,
            startDate: args.startDate,
            endDate: args.endDate,
          });
        } catch (error) {
          // Termix's audit endpoint is admin-only. A raw upstream 403 reads as
          // a transient failure worth retrying; it is a permanent property of
          // the API key, so say that once and name the remedy.
          if (error?.status === 403) {
            throw new Error(
              'Termix\'s audit log requires an admin API key, and the key this server uses '
              + 'belongs to a non-admin account, so this tool cannot succeed as deployed. '
              + 'Retrying will not help. This server\'s own audit file is unaffected and records '
              + 'every call it made, including refusals.',
            );
          }
          throw error;
        }
      },
    },
    {
      name: 'session_logs',
      title: 'Terminal session logs',
      description:
        'List session recordings (the session-recording plugin), or fetch one recording\'s metadata '
        + 'or full content by id. Content is the plain recording -- text or asciicast; remote-desktop '
        + 'recordings are binary and large. Every content read is recorded in Termix\'s access history.',
      mutating: false,
      hostArg: null,
      inputSchema: {
        id: z.string().optional().describe('Recording id from the list'),
        content: z.boolean().default(false).describe('With an id, return the full content instead of metadata'),
      },
      handler: async (args, ctx) => {
        if (!args.id) return ctx.client.get(`${RECORDINGS}/`);
        // ENCODED, not interpolated raw. urlFor concatenates onto the origin and
        // hands the result to fetch, whose URL parser resolves "..", so an id of
        // "../users/api-keys" used to leave the recordings route entirely and reach any
        // endpoint the API key can -- around call_api's denylist, the host
        // blocklist, and the session-ownership check, from a read-only tool. A
        // "?" in the value opened a real query string too.
        const id = encodeURIComponent(args.id);
        if (!args.content) return ctx.client.get(`${RECORDINGS}/${id}`);
        // A terminal transcript contains whatever was typed at a sudo, mysql or
        // ssh prompt. Scrubbed before it reaches the model, because this is the
        // one tool that hands raw keystrokes back.
        const log = await ctx.client.get(`${RECORDINGS}/${id}/content`);
        if (typeof log === 'string') return scrubValue(log);
        if (log && typeof log.content === 'string') {
          return { ...log, content: scrubValue(log.content), scrubbed: true };
        }
        return log;
      },
    },
    {
      name: 'recent_activity',
      title: 'Recent activity',
      description: 'Get Termix\'s recent activity feed.',
      mutating: false,
      hostArg: null,
      inputSchema: { limit: z.number().int().positive().max(200).default(50) },
      handler: (args, ctx) => ctx.client.get('/dashboard/activity/recent', { limit: args.limit }),
    },
    {
      name: 'alerts',
      title: 'List alerts',
      description:
        'List alerts from the Termix alerts inbox, newest first, with the unread count. mode "active" '
        + '(default) returns unread alerts, "all" includes those already read (dismissed). Read-only; '
        + 'use alert_action to dismiss.',
      mutating: false,
      hostArg: null,
      inputSchema: {
        mode: z.enum(['active', 'all']).default('active'),
        severity: z.enum(['info', 'success', 'warning', 'critical']).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
      // Plugin-Alerts src/backend/routes.ts GET /items?unread&severity&limit.
      handler: (args, ctx) => ctx.client.get(`${ALERTS}/items`, {
        unread: args.mode === 'active' ? 'true' : undefined,
        severity: args.severity,
        limit: args.limit,
      }),
    },
    {
      // Split from `alerts` rather than folded in as a mode: a tool that
      // sometimes mutates would be recorded as mutating:false in the audit log,
      // making the record lie about what happened.
      name: 'alert_action',
      title: 'Dismiss or restore an alert',
      description:
        'Dismiss an alert (mark it read), or undismiss one (mark it unread again). Mutating.',
      mutating: true,
      hostArg: null,
      inputSchema: {
        action: z.enum(['dismiss', 'undismiss']),
        alertId: z.coerce.number().int().positive().describe('Alert id from the alerts tool'),
      },
      handler: async (args, ctx) => withUnconfirmedTarget(
        // 26.x has no dismissed list: an alert is read or unread, and POST
        // /items/read {ids, read} flips it, answering with the new unread count.
        await ctx.client.post(`${ALERTS}/items/read`, {
          ids: [args.alertId], read: args.action === 'dismiss',
        }),
        `alert "${args.alertId}"`,
      ),
    },
  ];
}
