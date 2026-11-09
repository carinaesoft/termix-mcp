import http from 'node:http';

// A minimal in-process stand-in for Termix 26.11.x: just enough of the API for
// the session manager, run_command, the reconnect path and the read tools.
// Records the call sequence so a test can assert write -> chmod -> execute ->
// delete ordering.
//
// Routes and response shapes follow 26.11.1 and its plugins (file-manager
// 1.2.0, docker 1.3.0, host-metrics 1.4.0, host-status 1.1.0, snippets 1.3.0,
// alerts 1.3.0): core at the root, each plugin under /plugin-api/<id>/. Like
// the real server, a path nothing claims gets the single-page app's HTML, and
// a plugin that is not installed answers 404 "This feature is not available".
//
// `delays` maps a path suffix to milliseconds the mock waits before it
// answers, e.g. { executeFile: 400 }. Holding one endpoint open is the only
// way to observe which timeout a given call was dispatched with.
const FM = '/plugin-api/file-manager';
const DK = '/plugin-api/docker';
// What is mounted. service-manager and process-manager are left out, as on the
// instance this was written against.
const INSTALLED = new Set([
  'file-manager', 'docker', 'host-metrics', 'host-status', 'snippets', 'alerts',
  'tunnels', 'session-recording', 'operations-center',
]);

export function startMockTermix({
  dropSessionOnce = false,
  execRc = 0,
  execStdout = 'termix-mcp-ok\nuid=0(root)',
  execStderr = '',
  delays = {},
  dockerAvailable = true,
} = {}) {
  const state = {
    calls: [],
    sessions: new Set(),
    files: new Map(),
    dropped: false,
  };

  let pendingPath = null;

  function json(res, status, body) {
    const text = JSON.stringify(body);
    const send = () => {
      // The client may have aborted on its own timeout while we waited.
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };
    const key = Object.keys(delays).find((k) => pendingPath?.endsWith(k));
    if (key) setTimeout(send, delays[key]).unref?.();
    else send();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const p = url.pathname;
      pendingPath = p;
      state.calls.push({ method: req.method, path: p, body });

      if (p === '/users/me') return json(res, 200, { id: 'u1', username: 'panda' });
      if (p === '/host/db/host' && req.method === 'GET') {
        return json(res, 200, [{ id: 1, name: 'web', ip: '10.0.0.1', port: 22, username: 'root' }]);
      }
      if (p === '/host/db/host/1') {
        return json(res, 200, { id: 1, name: 'web', ip: '10.0.0.1', port: 22, username: 'root' });
      }

      // A file-manager op on a session it does not hold. The exact text the
      // plugin uses (content-routes.ts), which is what isStaleSession sees.
      const notEstablished = () => json(res, 400, { error: 'SSH connection not established' });
      const fileOp = p.startsWith(`${FM}/`) && !['/connect', '/keepalive', '/disconnect']
        .some((x) => p === `${FM}${x}`);
      if (fileOp && !state.sessions.has(body.sessionId ?? url.searchParams.get('sessionId'))) {
        return notEstablished();
      }

      if (p === `${FM}/connect`) {
        if (!body.sessionId || !body.ip || !body.username || !body.port) {
          return json(res, 400, { error: 'Missing SSH connection parameters', connectionLogs: [] });
        }
        state.sessions.add(body.sessionId);
        return json(res, 200, { status: 'success', message: 'SSH connection established', connectionLogs: [] });
      }
      if (p === `${FM}/keepalive`) {
        return json(res, 200, { status: 'success', connected: true, message: 'Session keepalive successful' });
      }
      if (p === `${FM}/disconnect`) {
        state.sessions.delete(body.sessionId);
        return json(res, 200, { status: 'success', message: 'SSH connection disconnected' });
      }

      if (p === `${FM}/writeFile`) {
        // Simulate Termix forgetting the session exactly once, to drive the
        // reconnect-and-retry path.
        if (dropSessionOnce && !state.dropped) {
          state.dropped = true;
          state.sessions.delete(body.sessionId);
          return notEstablished();
        }
        state.files.set(body.path, body.content);
        return json(res, 200, {
          message: 'File written successfully',
          path: body.path,
          toast: { type: 'success', message: `File written: ${body.path}` },
        });
      }
      if (p === `${FM}/changePermissions`) {
        return json(res, 200, { success: true, message: 'Permissions changed successfully' });
      }
      if (p === `${FM}/executeFile`) {
        // Emulate the REAL plugin (action-routes.ts), line for line, which is
        // where the exit-code bug came from. It runs `<script> 2>&1; echo
        // "EXIT_CODE:$?"`, so the streams are merged and the output ends in
        // "EXIT_CODE:<rc>\n". Its own /EXIT_CODE:(\d+)$/ has no m flag and so
        // never matches before that final newline: exitCode falls back to the
        // channel's status -- the echo's, always 0 -- and the trailer survives
        // into `output`, trimmed.
        const script = state.files.get(body.filePath) ?? '';
        const nonce = (script.match(/__TERMIX_MCP_[0-9a-f]+__/) ?? [])[0];
        // Reproduce the wrapper's output byte for byte: `cat` emits each stream
        // verbatim, and each closing marker is printed with one leading newline.
        //
        // Getting this exactly right is load-bearing. A mock that omits the
        // closing marker sends the parser down its legacy fallback, so the
        // integration tests would exercise a path the real server never takes
        // and say nothing about the one it does.
        const output = nonce
          ? `${nonce} rc=${execRc}\n${nonce} stdout\n${execStdout}\n`
            + `${nonce} stderr\n${execStderr}\n${nonce} end\nEXIT_CODE:${execRc}\n`
          : `${execStdout}\n${execStderr}\nEXIT_CODE:${execRc}\n`;
        const exitCodeMatch = output.match(/EXIT_CODE:(\d+)$/);
        return json(res, 200, {
          success: true,
          exitCode: exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0,
          output: output.replace(/EXIT_CODE:\d+$/, '').trim(),
          error: '',
          timestamp: '2026-11-09T00:00:00.000Z',
        });
      }
      if (p === `${FM}/deleteItem`) {
        // Plugin semantics, modelled deliberately: WITHOUT `permanent` the item
        // is moved to ~/.termix-trash instead of being removed, so it is still
        // sitting on the host afterwards. Keeping it in `files` under its trash
        // path -- rather than quietly dropping it -- is what makes the "no temp
        // script left behind" assertion a real regression guard for the flag.
        if (!body.permanent) {
          const content = state.files.get(body.path);
          state.files.delete(body.path);
          state.files.set(`/root/.termix-trash/files${body.path}`, content);
          return json(res, 200, { message: 'Item moved to trash', path: body.path, trashItem: { id: 1 } });
        }
        state.files.delete(body.path);
        return json(res, 200, { message: 'Item deleted successfully', path: body.path });
      }
      if (p === `${FM}/readFile`) {
        const path = url.searchParams.get('path');
        if (!state.files.has(path)) return json(res, 404, { error: `File not found: ${path}` });
        return json(res, 200, { content: state.files.get(path), path, encoding: 'utf8' });
      }
      if (p === `${FM}/listFiles`) {
        const dir = url.searchParams.get('path') || '.';
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        const files = [...state.files.keys()]
          .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
          .map((f) => ({
            name: f.slice(prefix.length), path: f, type: 'file', size: String(state.files.get(f)?.length ?? 0),
            permissions: 'rw-r--r--', owner: 'root', group: 'root', modified: '2026-11-09T00:00:00.000Z',
          }));
        return json(res, 200, { files, path: dir });
      }

      if (p === `${DK}/ssh/connect`) {
        if (!body.sessionId || !body.hostId) return json(res, 400, { error: 'Missing connection parameters' });
        state.sessions.add(body.sessionId);
        return json(res, 200, { success: true, status: 'success', connectionLogs: [] });
      }
      if (p === `${DK}/ssh/keepalive`) return json(res, 200, { success: true, connected: true });
      if (p === `${DK}/ssh/disconnect`) {
        state.sessions.delete(body.sessionId);
        return json(res, 200, { success: true, message: 'SSH session disconnected' });
      }
      const dockerSession = /^\/plugin-api\/docker\/(?:validate|containers)\/([^/]+)/.exec(p)?.[1];
      if (dockerSession && !state.sessions.has(dockerSession)) {
        return json(res, 400, { error: 'SSH session not found or not connected' });
      }
      if (p.startsWith(`${DK}/validate/`)) {
        return json(res, 200, dockerAvailable
          ? { available: true, version: '27.3.1', runtime: 'docker' }
          : { available: false, error: 'Docker is not installed on this host.', code: 'NOT_INSTALLED', runtime: 'docker' });
      }
      if (p === `${DK}/containers/${dockerSession}`) {
        return json(res, 200, [{ id: 'c1', name: 'web', image: 'nginx', state: 'running', status: 'Up 2 hours' }]);
      }

      if (p === '/plugin-api/host-status/' || p === '/plugin-api/host-status') {
        const all = { 1: { status: 'online', lastChecked: '2026-11-09T00:00:00.000Z' } };
        const wanted = url.searchParams.get('hostIds');
        if (!wanted) return json(res, 200, all);
        return json(res, 200, Object.fromEntries(wanted.split(',').filter((id) => all[id]).map((id) => [id, all[id]])));
      }
      if (p === '/dashboard/uptime') return json(res, 200, { uptimeMs: 1000, uptimeSeconds: 1, formatted: '0d 0h 0m' });
      // host-metrics answers null until its poller has a first sample.
      if (p === '/plugin-api/host-metrics/metrics/1') return json(res, 200, null);

      if (p === '/plugin-api/snippets' || p === '/plugin-api/snippets/') {
        return json(res, 200, [{ id: 3, name: 'uptime', content: 'uptime', folder: null }]);
      }
      if (p === '/plugin-api/snippets/execute') {
        return json(res, 200, { success: true, output: ' 10:00:00 up 1 day' });
      }

      if (p === '/plugin-api/alerts/items') {
        return json(res, 200, { items: [{ id: 7, title: 'disk', severity: 'warning', read: false }], unread: 1 });
      }
      if (p === '/plugin-api/alerts/items/read') return json(res, 200, { unread: body.read === false ? 1 : 0 });

      // The dispatcher refuses a plugin it does not know before auth runs.
      const pluginId = /^\/plugin-api\/([^/]+)/.exec(p)?.[1];
      if (pluginId && !INSTALLED.has(pluginId)) {
        return json(res, 404, { error: 'This feature is not available' });
      }
      // Every path Termix 2.x served and 26.x does not (/ssh/file_manager/...,
      // /status, /uptime, ...) gets the single-page app, exactly as live.
      if (!pluginId && !p.startsWith('/users/') && !p.startsWith('/host/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><html lang="en"><head></head><body></body></html>');
      }

      return json(res, 404, { error: `unmocked ${req.method} ${p}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
