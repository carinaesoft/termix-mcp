// Where things live on Termix 26.11.x. Since 26.10 every feature beyond hosts,
// credentials and sharing is its own plugin, served by the one backend under
// /plugin-api/<plugin id>/ (Termix src/backend/database/routes/plugin-api-routes.ts).
// Kept in one place so the next remount is a one-file change.
//
// An unknown plugin id answers 404 {"error":"This feature is not available"},
// an installed but disabled one 503, before auth runs -- which is how a
// missing plugin is told apart from a missing route.

export const plugin = (id) => `/plugin-api/${id}`;

export const FILES = plugin('file-manager');
export const DOCKER = plugin('docker');
export const METRICS = plugin('host-metrics');
export const HOST_STATUS = plugin('host-status');
export const SNIPPETS = plugin('snippets');
export const TUNNELS = plugin('tunnels');
export const ALERTS = plugin('alerts');
export const RECORDINGS = plugin('session-recording');
// Not bundled-active on every install: these two replaced host-metrics'
// managers/services and managers/processes, which 26.x no longer serves.
export const SERVICES = plugin('service-manager');
export const PROCESSES = plugin('process-manager');
