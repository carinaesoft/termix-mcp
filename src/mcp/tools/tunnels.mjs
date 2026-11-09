import { z } from 'zod';
import { withUnconfirmedTarget } from '../../util/upstream.mjs';
import { TUNNELS } from '../../termix/routes.mjs';

// SSH tunnel status and control. Tunnels are addressed by name; connecting one
// references a source host and a tunnel index from its saved configuration.
export function tunnelTools() {
  return [
    {
      name: 'list_tunnels',
      title: 'List tunnels',
      description: 'List all SSH tunnels and their current status. Pass a name to get just that tunnel.',
      mutating: false,
      hostArg: null,
      inputSchema: { name: z.string().optional().describe('Tunnel name to filter by') },
      handler: (args, ctx) => (args.name
        ? ctx.client.get(`${TUNNELS}/status/${encodeURIComponent(args.name)}`)
        : ctx.client.get(`${TUNNELS}/status`)),
    },
    {
      name: 'tunnel_action',
      title: 'Control a tunnel',
      description:
        'Connect, disconnect, or cancel-retry an SSH tunnel. Connecting needs the source host id and the '
        + 'tunnel index from that host\'s saved tunnel configuration. Mutating.',
      mutating: true,
      hostArg: null,
      inputSchema: {
        action: z.enum(['connect', 'disconnect', 'cancel']),
        name: z.string().describe('Tunnel name'),
        sourceHostId: z.number().optional().describe('Source host id (required for connect)'),
        tunnelIndex: z.number().optional().describe('Tunnel index on the source host (required for connect)'),
      },
      handler: async (args, ctx) => {
        if (args.action === 'connect') {
          if (args.sourceHostId === undefined || args.tunnelIndex === undefined) {
            throw new Error('connect requires sourceHostId and tunnelIndex');
          }
          // sourceHostId is a host reference the gate's hostArg check never sees,
          // so the blocklist is applied here or not at all.
          ctx.recordHost(await ctx.hosts.resolveAllowed(args.sourceHostId));
          // The tunnels plugin checks the request against the name, which
          // encodes "hostId::index::label::sourcePort::endpointHost::endpointPort"
          // (Plugin-Tunnels src/backend/utils.ts parseTunnelName), and refuses
          // a mismatch. The ports and endpoint are sent from the name itself.
          const parts = args.name.split('::');
          const fromName = parts.length === 6
            ? { sourcePort: Number(parts[3]), endpointHost: parts[4], endpointPort: Number(parts[5]) }
            : {};
          return ctx.client.post(`${TUNNELS}/connect`, {
            name: args.name, sourceHostId: args.sourceHostId, tunnelIndex: args.tunnelIndex, ...fromName,
          });
        }
        // disconnect and cancel take only a name, and Termix acknowledges both
        // for a tunnel that does not exist. Worse than a meaningless ack: it
        // PERSISTS one. A probe against a deliberately fake name left a record
        // for it in the tunnel list, `manualDisconnect: true` -- exactly the
        // state a disconnect sets. So an agent typo appends permanent junk to
        // the estate. Resolve the name first and refuse an unknown one, the way
        // connect already resolves and enforces its sourceHostId.
        const status = await ctx.client.get(`${TUNNELS}/status`).catch(() => null);
        if (status && typeof status === 'object' && !(args.name in status)) {
          const known = Object.keys(status);
          throw new Error(
            `no tunnel named "${args.name}"`
            + (known.length ? `; known tunnels: ${known.join(', ')}` : '; none are configured')
            + '. Termix would acknowledge this and create a record for the name, so it is refused.',
          );
        }

        const endpoint = `${TUNNELS}/${args.action}`;
        return withUnconfirmedTarget(
          await ctx.client.post(endpoint, { tunnelName: args.name }),
          `tunnel "${args.name}"`,
        );
      },
    },
  ];
}
