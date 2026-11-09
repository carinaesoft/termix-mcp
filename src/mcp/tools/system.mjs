import { z } from 'zod';

import { hostArg } from './host-arg.mjs';
import { assertUpstreamOk } from '../../util/upstream.mjs';
import { SERVICES, PROCESSES } from '../../termix/routes.mjs';

// systemd and process management. Termix 26.x moved these out of host-metrics
// into two plugins of their own, service-manager and process-manager, which
// address the host by its Termix id (no file/docker session needed). Neither is
// active on every install; without it Termix answers 404 "This feature is not
// available", which notInstalled() turns into an actionable message.
const notInstalled = (pluginId) => (error) => {
  if (error?.status === 404 && /not available/i.test(error.message)) {
    throw new Error(
      `the Termix "${pluginId}" plugin is not installed or not enabled on this Termix, `
      + 'so this tool has nothing to call. Install it in Termix (Settings -> Plugins), '
      + 'or use run_command.',
    );
  }
  throw error;
};
export function systemTools() {
  return [
    {
      name: 'list_services',
      title: 'List systemd services',
      description: 'List systemd services on a host, with their load/active/sub state.',
      mutating: false,
      hostArg: 'host',
      inputSchema: { host: hostArg },
      handler: (_args, ctx) => ctx.client
        .get(`${SERVICES}/${ctx.host.id}/units`, { type: 'service' })
        .catch(notInstalled('service-manager')),
    },
    {
      name: 'service_action',
      title: 'Control a systemd service',
      description:
        'Start, stop, restart, enable, or disable a systemd unit on a host. Mutating. '
        + 'Needs the Termix service-manager plugin and edit access to the host; '
        + 'run_command with systemctl is the workaround.',
      mutating: true,
      hostArg: 'host',
      inputSchema: {
        host: hostArg,
        unit: z.string().describe('Unit name, e.g. "nginx.service"'),
        action: z.enum(['start', 'stop', 'restart', 'enable', 'disable']),
      },
      handler: async (args, ctx) => assertUpstreamOk(
        await ctx.client.post(
          `${SERVICES}/${ctx.host.id}/units/${encodeURIComponent(args.unit)}/actions/${args.action}`,
          {},
        ).catch(notInstalled('service-manager')),
        `service ${args.action}`,
      ),
    },
    {
      name: 'list_processes',
      title: 'List processes',
      description: 'List running processes on a host with pid, user, CPU, memory, and command.',
      mutating: false,
      hostArg: 'host',
      inputSchema: { host: hostArg },
      handler: (_args, ctx) => ctx.client
        .get(`${PROCESSES}/${ctx.host.id}/processes`)
        .catch(notInstalled('process-manager')),
    },
    {
      name: 'process_signal',
      title: 'Signal a process',
      description: 'Send a signal (TERM, KILL, HUP, or INT) to a process on a host by pid. Mutating.',
      mutating: true,
      hostArg: 'host',
      inputSchema: {
        host: hostArg,
        pid: z.number().int().positive(),
        signal: z.enum(['TERM', 'KILL', 'HUP', 'INT']).default('TERM'),
      },
      handler: async (args, ctx) => assertUpstreamOk(
        await ctx.client.post(
          `${PROCESSES}/${ctx.host.id}/processes/${args.pid}/signal`,
          { signal: args.signal },
        ).catch(notInstalled('process-manager')),
        `signal ${args.signal} to pid ${args.pid}`,
      ),
    },
  ];
}
