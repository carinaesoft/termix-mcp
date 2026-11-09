import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMockTermix } from './mock-termix.mjs';
import { createClient } from '../src/termix/client.mjs';
import { createHostRegistry } from '../src/termix/hosts.mjs';
import { createSessionManager } from '../src/termix/sessions.mjs';
import { runScript, execTools } from '../src/mcp/tools/exec.mjs';
import { fileTools } from '../src/mcp/tools/files.mjs';
import { hostTools } from '../src/mcp/tools/hosts.mjs';
import { dockerTools } from '../src/mcp/tools/docker.mjs';
import { systemTools } from '../src/mcp/tools/system.mjs';
import { observabilityTools } from '../src/mcp/tools/observability.mjs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const silentLog = { info() {}, warn() {}, debug() {}, error() {} };

function makeConfig(baseUrl, overrides = {}) {
  return {
    baseUrl,
    apiKey: 'test-key',
    timeoutMs: 5000,
    execTimeoutMs: 5000,
    retry: 0,
    keepaliveMs: 60000,
    sessionIdleMs: 300000,
    maxSessions: 16,
    tmpDir: '/tmp',
    execShebang: '#!/usr/bin/env bash',
    ...overrides,
  };
}

function ctxFor(mock) {
  const config = makeConfig(mock.baseUrl);
  const client = createClient(config, silentLog);
  const hosts = createHostRegistry(client, [], silentLog);
  const sessions = createSessionManager({ client, config, logger: silentLog });
  return { client, hosts, sessions, config, logger: silentLog };
}

test('run_command writes, chmods 755, executes, and deletes in order, capturing output', async () => {
  const mock = await startMockTermix();
  const ctx = ctxFor(mock);
  try {
    const host = await ctx.hosts.resolve(1);
    const result = await runScript(ctx, host, 'echo termix-mcp-ok && id');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /termix-mcp-ok/);
    // A successful command writes nothing to stderr, so stderr must be empty --
    // not Termix's trailer, which 0.3.2 left there on every single call.
    assert.equal(result.stderr, '', 'no sentinel in stderr on the success path');

    const fileCalls = mock.state.calls
      .map((c) => c.path)
      .filter((p) => p.startsWith('/plugin-api/file-manager/'));
    const idx = (needle) => fileCalls.findIndex((p) => p.endsWith(needle));
    assert.ok(idx('writeFile') !== -1, 'writeFile happened');
    assert.ok(idx('changePermissions') > idx('writeFile'), 'chmod after write');
    assert.ok(idx('executeFile') > idx('changePermissions'), 'execute after chmod');
    assert.ok(idx('deleteItem') > idx('executeFile'), 'delete after execute');

    // Temp script was cleaned up.
    assert.equal(mock.state.files.size, 0, 'no temp script left behind');

    // Explicit as well as implicit. From Termix 2.7.0 an omitted `permanent`
    // moves the temp files to ~/.termix-trash instead of removing them, which
    // would leave the two capture files -- holding whatever the command
    // printed -- in the SSH user's home for the retention window. The mock
    // models that, so the assertion above already fails without the flag;
    // this one names the reason so a future edit knows what it broke.
    const deletes = mock.state.calls.filter((c) => c.path.endsWith('deleteItem'));
    assert.equal(deletes.length, 3, 'the script and both capture files are deleted');
    for (const call of deletes) {
      assert.equal(call.body.permanent, true, `${call.body.path} must be deleted, not trashed`);
    }
  } finally {
    await ctx.sessions.closeAll();
    await mock.close();
  }
});

test('a failing command surfaces its exit code and stderr, end to end', async () => {
  // The regression this exists for: Termix reports exitCode 0 for the API call
  // whatever the script did, so a failure read as a success all the way up to
  // any agent branching on it. Streams were merged too, so stderr was empty.
  const mock = await startMockTermix({
    execRc: 42,
    execStdout: 'to-stdout',
    execStderr: 'ls: cannot access /nonexistent: No such file or directory',
  });
  const ctx = ctxFor(mock);
  try {
    const host = await ctx.hosts.resolve(1);
    const result = await runScript(ctx, host, 'ls /nonexistent; exit 42');

    assert.equal(result.exitCode, 42, 'the script status, not the API call status');
    assert.equal(result.stdout, 'to-stdout');
    assert.match(result.stderr, /No such file or directory/, 'stderr is its own stream');
    // find_file splits stdout on newlines into matches, so a leaked sentinel
    // used to arrive as a filesystem path.
    assert.ok(!result.stdout.includes('EXIT_CODE'), 'no sentinel in stdout');
    assert.ok(!result.stderr.includes('EXIT_CODE'), 'no sentinel in stderr');
  } finally {
    await ctx.sessions.closeAll();
    await mock.close();
  }
});

test('a stale session is transparently reconnected once', async () => {
  const mock = await startMockTermix({ dropSessionOnce: true });
  const ctx = ctxFor(mock);
  try {
    const host = await ctx.hosts.resolve(1);
    // First writeFile 400s "not connected"; the manager reconnects and retries.
    const result = await runScript(ctx, host, 'echo ok');
    assert.equal(result.exitCode, 0);
    const connects = mock.state.calls.filter((c) => c.path === '/plugin-api/file-manager/connect');
    assert.equal(connects.length, 2, 'reconnected exactly once');
  } finally {
    await ctx.sessions.closeAll();
    await mock.close();
  }
});

test('session is reused across two calls to the same host', async () => {
  const mock = await startMockTermix();
  const ctx = ctxFor(mock);
  try {
    const host = await ctx.hosts.resolve(1);
    await runScript(ctx, host, 'echo one');
    await runScript(ctx, host, 'echo two');
    const connects = mock.state.calls.filter((c) => c.path === '/plugin-api/file-manager/connect');
    assert.equal(connects.length, 1, 'only one connect for two commands');
  } finally {
    await ctx.sessions.closeAll();
    await mock.close();
  }
});

test('buildServer wires the full stack against the mock and lists hosts', async () => {
  const mock = await startMockTermix();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termix-it-'));
  const saved = { ...process.env };
  process.env.TERMIX_BASE_URL = mock.baseUrl;
  process.env.TERMIX_API_KEY = 'k';
  process.env.DATA_DIR = dir;
  process.env.TERMIX_BLOCKLIST = 'legacy-box';
  try {
    const { loadConfig } = await import('../src/config.mjs');
    const { buildServer } = await import('../src/mcp/server.mjs');
    const config = loadConfig('stdio');
    const built = buildServer({ config, logger: silentLog, transport: 'stdio' });
    await built.probeCapabilities();
    assert.equal(built.state.capabilities.reachable, true);
    const hosts = await built.hosts.list();
    assert.equal(hosts[0].name, 'web');
    await built.sessions.closeAll();
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

// --- the HTTP front end, booted for real -----------------------------------
// index-http.mjs is the process the container runs and had no coverage at all:
// it is a top-level script, so importing it starts a server. Spawning it is the
// only way to assert on the request path an operator actually hits.

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startHttpServer(mock, extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termix-http-'));
  const entry = fileURLToPath(new URL('../src/index-http.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      TERMIX_BASE_URL: mock.baseUrl,
      TERMIX_API_KEY: 'k',
      MCP_HTTP_TOKEN: 'health-token',
      TERMIX_POLICY_FILE: '',
      TERMIX_PROFILE: '',
      HTTP_BIND: '127.0.0.1',
      HTTP_PORT: String(port),
      DATA_DIR: dir,
      LOG_LEVEL: 'info',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.on('data', (c) => { logs += String(c); });
  child.stderr.on('data', (c) => { logs += String(c); });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (probe.ok) break;
    } catch { /* still starting */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server never became healthy. logs:\n${logs}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    port,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    logs: () => logs,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 2000); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the unauthenticated health endpoint says nothing beyond liveness', async () => {
  const mock = await startMockTermix();
  const server = await startHttpServer(mock);
  try {
    const response = await fetch(server.url('/healthz'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { ok: true }, 'no version, no session counts, no upstream state');
  } finally {
    await server.stop();
    await mock.close();
  }
});

test('the authenticated health endpoint reports upstream reachability it checked', async () => {
  const mock = await startMockTermix();
  const server = await startHttpServer(mock);
  try {
    const response = await fetch(server.url('/healthz'), {
      headers: { Authorization: 'Bearer health-token' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.termixReachable, true, 'the probe actually reached the mock');
    assert.ok(body.termixCheckedAt, 'and says when');
    assert.equal(body.mcpSessions, 0);
    // The probe must have gone to the upstream, not been assumed.
    assert.ok(
      mock.state.calls.some((c) => c.path === '/users/me'),
      'health reported reachability without probing anything',
    );
  } finally {
    await server.stop();
    await mock.close();
  }
});

test('a rejected token is answered 401 AND written to the log', async () => {
  const mock = await startMockTermix();
  const server = await startHttpServer(mock);
  try {
    const missing = await fetch(server.url('/mcp'), { method: 'POST' });
    assert.equal(missing.status, 401);

    const wrong = await fetch(server.url('/mcp'), {
      method: 'POST',
      headers: { Authorization: 'Bearer not-the-token' },
    });
    assert.equal(wrong.status, 401);

    // The regression this exists for: both of the above used to return 401 in
    // complete silence, so probing the credential that reaches shell on every
    // host left no trace in the app log or the audit trail.
    await new Promise((r) => setTimeout(r, 200));
    const logs = server.logs();
    const rejections = logs.split('\n').filter((l) => l.includes('rejected unauthorized MCP request'));
    assert.equal(rejections.length, 2, `expected two logged rejections, got:\n${logs}`);
    assert.ok(rejections[0].includes('127.0.0.1'), 'the caller address is recorded');
    // A fingerprint, never the presented secret itself.
    assert.ok(!logs.includes('not-the-token'), 'the presented token must not be logged');
  } finally {
    await server.stop();
    await mock.close();
  }
});

test('a good token still initializes a session, and it is tracked', async () => {
  const mock = await startMockTermix();
  const server = await startHttpServer(mock);
  try {
    const response = await fetch(server.url('/mcp'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer health-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1' },
        },
      }),
    });

    assert.ok(response.status < 400, `initialize failed with ${response.status}`);
    const sid = response.headers.get('mcp-session-id');
    assert.ok(sid, 'no session id came back');
    await response.body?.cancel();

    // And the registry knows about it, which is what the reaper operates on.
    const health = await fetch(server.url('/healthz'), {
      headers: { Authorization: 'Bearer health-token' },
    });
    assert.equal((await health.json()).mcpSessions, 1);

    // An unknown session id is still the 404 that makes a client re-initialize.
    const stale = await fetch(server.url('/mcp'), {
      method: 'POST',
      headers: { Authorization: 'Bearer health-token', 'mcp-session-id': 'no-such-session' },
    });
    assert.equal(stale.status, 404);
  } finally {
    await server.stop();
    await mock.close();
  }
});

test('the session registry is bounded, and the current session is never the one evicted', async () => {
  const mock = await startMockTermix();
  // Cap of one, so the second initialize must displace the first.
  const server = await startHttpServer(mock, { MCP_MAX_SESSIONS: '1', MCP_SESSION_IDLE_MS: '0' });

  const initialize = async () => {
    const response = await fetch(server.url('/mcp'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer health-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1' },
        },
      }),
    });
    const sid = response.headers.get('mcp-session-id');
    await response.body?.cancel();
    return sid;
  };

  try {
    const first = await initialize();
    const second = await initialize();
    assert.ok(first && second && first !== second);

    const health = await fetch(server.url('/healthz'), {
      headers: { Authorization: 'Bearer health-token' },
    });
    const body = await health.json();
    assert.equal(body.mcpSessions, 1, 'the registry grew past its cap');

    // The evicted one is the older, and it is answered 404 so the client
    // re-initializes rather than being told its request was malformed.
    const evicted = await fetch(server.url('/mcp'), {
      method: 'POST',
      headers: { Authorization: 'Bearer health-token', 'mcp-session-id': first },
    });
    assert.equal(evicted.status, 404);

    // The newer session survived: this is the "never evict the current one"
    // guarantee, which a naive LRU sweep gets wrong under a reconnect burst.
    assert.ok(
      server.logs().includes('over-capacity'),
      `expected an over-capacity eviction in the log:\n${server.logs()}`,
    );
  } finally {
    await server.stop();
    await mock.close();
  }
});

// --- TASK-TERMIX-EXECTIMEOUT-001 -------------------------------------------
// TERMIX_TIMEOUT_MS used to bound every call, so the only way to give a slow
// command four minutes was to give a hung list_files four minutes too -- times
// three, because GETs retry twice. These two tests pin the split: the long
// timeout reaches executeFile and nothing else.

test('the long exec timeout covers executeFile, so a slow command still completes', async () => {
  const mock = await startMockTermix({ delays: { executeFile: 400 } });
  const config = makeConfig(mock.baseUrl, { timeoutMs: 150, execTimeoutMs: 4000 });
  const client = createClient(config, silentLog);
  const hosts = createHostRegistry(client, [], silentLog);
  const sessions = createSessionManager({ client, config, logger: silentLog });
  const ctx = { client, hosts, sessions, config, logger: silentLog };
  try {
    const host = await hosts.resolve(1);
    const result = await runScript(ctx, host, 'sleep 1');
    assert.equal(result.exitCode, 0, 'a command slower than timeoutMs is not cut off');
    assert.match(result.stdout, /termix-mcp-ok/);
  } finally {
    await sessions.closeAll();
    await mock.close();
  }
});

test('the long exec timeout does not leak onto the surrounding metadata calls', async () => {
  // writeFile is an ordinary round trip. If it inherited execTimeoutMs, this
  // would wait four seconds and pass; it must give up at timeoutMs instead.
  const mock = await startMockTermix({ delays: { writeFile: 4000 } });
  const config = makeConfig(mock.baseUrl, { timeoutMs: 150, execTimeoutMs: 4000 });
  const client = createClient(config, silentLog);
  const hosts = createHostRegistry(client, [], silentLog);
  const sessions = createSessionManager({ client, config, logger: silentLog });
  const ctx = { client, hosts, sessions, config, logger: silentLog };
  try {
    const host = await hosts.resolve(1);
    const started = Date.now();
    await assert.rejects(
      runScript(ctx, host, 'echo hi'),
      (err) => /timed out after 150ms/.test(err.message),
      'writeFile keeps the short global timeout',
    );
    assert.ok(Date.now() - started < 2000, 'it failed on the short clock, not the long one');
  } finally {
    await sessions.closeAll();
    await mock.close();
  }
});

// --- TASK-TERMIX-SESSIONIDLE-001 -------------------------------------------
// lastActive was stamped when a session was ACQUIRED and never again, so the
// idle sweep measured from the start of a call. That is why the exec timeout
// had to be held below TERMIX_SESSION_IDLE_MS: a longer one let the sweep
// disconnect a session still carrying a running command.

test('a busy session survives the idle sweep, and its clock restarts when the work ends', async () => {
  const mock = await startMockTermix();
  const config = makeConfig(mock.baseUrl, { sessionIdleMs: 60 });
  const client = createClient(config, silentLog);
  const hosts = createHostRegistry(client, [], silentLog);
  const sessions = createSessionManager({ client, config, logger: silentLog });
  try {
    const host = await hosts.resolve(1);

    let release;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const op = sessions.withFileSession(host, async () => {
      markStarted();
      await new Promise((resolve) => { release = resolve; });
      return 'done';
    });
    await started;

    // The operation has now been running for longer than the idle window.
    await new Promise((r) => setTimeout(r, 120));
    await sessions.sweepIdle();
    assert.equal(sessions.stats().file, 1, 'a session with work in flight is not idle');

    release();
    assert.equal(await op, 'done');

    // lastActive is re-stamped on completion, so the clock runs from the end of
    // the call rather than its start.
    await sessions.sweepIdle();
    assert.equal(sessions.stats().file, 1, 'the idle clock restarts when the work ends');

    // And a genuinely idle session is still reaped -- the fix narrows the
    // sweep, it does not disable it.
    await new Promise((r) => setTimeout(r, 120));
    await sessions.sweepIdle();
    assert.equal(sessions.stats().file, 0, 'an actually-idle session still goes');
  } finally {
    await sessions.closeAll();
    await mock.close();
  }
});

// --- Termix 26.11 plugin routes, through the real tool handlers -------------

const tool = (list, name) => list.find((t) => t.name === name).handler;

test('26.x: read_file and list_files go through /plugin-api/file-manager', async () => {
  const mock = await startMockTermix();
  const ctx = ctxFor(mock);
  try {
    ctx.host = await ctx.hosts.resolve(1);
    // Seed a file the way write_file would.
    await ctx.sessions.withFileSession(ctx.host, (s) => ctx.client.post(
      '/plugin-api/file-manager/writeFile', { sessionId: s.sessionId, path: '/etc/motd', content: 'hi\n' },
    ));
    const read = await tool(fileTools(), 'read_file')({ path: '/etc/motd' }, ctx);
    assert.equal(read.content, 'hi\n');
    assert.equal(read.encoding, 'utf8');
    const listing = await tool(fileTools(), 'list_files')({ path: '/etc' }, ctx);
    assert.deepEqual(listing.files.map((f) => f.name), ['motd']);
    assert.ok(mock.state.calls.every((c) => !c.path.startsWith('/ssh/')), 'no 2.x path was called');
  } finally {
    await ctx.sessions.closeAll();
    await mock.close();
  }
});

test('26.x: a 2.x path gets the web page, and the client names it as no endpoint', async () => {
  const mock = await startMockTermix();
  const ctx = ctxFor(mock);
  try {
    await assert.rejects(
      () => ctx.client.post('/ssh/file_manager/ssh/executeFile', {}),
      (error) => error.code === 'NOT_AN_API_ENDPOINT',
    );
  } finally {
    await mock.close();
  }
});

test('26.x: host_status reads the host-status plugin map, host_metrics tolerates no sample', async () => {
  const mock = await startMockTermix();
  const ctx = ctxFor(mock);
  try {
    ctx.host = await ctx.hosts.resolve(1);
    const one = await tool(hostTools(), 'host_status')({ host: 1 }, ctx);
    assert.equal(one.status, 'online');
    assert.ok(mock.state.calls.some((c) => c.path === '/plugin-api/host-status/'));

    ctx.host = undefined;
    const all = await tool(hostTools(), 'host_status')({}, { ...ctx, host: undefined });
    assert.equal(all.statuses['1'].name, 'web', 'entries are annotated with the host name');
    assert.equal(all.uptime.formatted, '0d 0h 0m', 'uptime comes from /dashboard/uptime');

    ctx.host = await ctx.hosts.resolve(1);
    const metrics = await tool(hostTools(), 'host_metrics')({ history: false }, ctx);
    assert.match(metrics.note, /no metrics sample yet/);
  } finally {
    await mock.close();
  }
});

test('26.x: docker opens its session under /plugin-api/docker and refuses available:false', async () => {
  const ok = await startMockTermix();
  const ctx = ctxFor(ok);
  try {
    ctx.host = await ctx.hosts.resolve(1);
    const { containers } = await tool(dockerTools(), 'docker_containers')({ all: true }, ctx);
    assert.equal(containers[0].name, 'web');
  } finally {
    await ctx.sessions.closeAll();
    await ok.close();
  }

  const missing = await startMockTermix({ dockerAvailable: false });
  const ctx2 = ctxFor(missing);
  try {
    ctx2.host = await ctx2.hosts.resolve(1);
    await assert.rejects(
      () => tool(dockerTools(), 'docker_containers')({ all: true }, ctx2),
      /Docker is not available on web: Docker is not installed/,
    );
    assert.equal(ctx2.sessions.stats().docker, 0, 'the useless session was torn down');
  } finally {
    await ctx2.sessions.closeAll();
    await missing.close();
  }
});

test('26.x: list_services says which plugin is missing instead of a bare 404', async () => {
  const mock = await startMockTermix();
  const ctx = ctxFor(mock);
  try {
    ctx.host = await ctx.hosts.resolve(1);
    await assert.rejects(
      () => tool(systemTools(), 'list_services')({}, ctx),
      /"service-manager" plugin is not installed/,
    );
    await assert.rejects(
      () => tool(systemTools(), 'list_processes')({}, ctx),
      /"process-manager" plugin is not installed/,
    );
  } finally {
    await mock.close();
  }
});

test('26.x: alerts read the inbox and alert_action marks read; run_snippet returns output', async () => {
  const mock = await startMockTermix();
  const ctx = ctxFor(mock);
  try {
    const inbox = await tool(observabilityTools(), 'alerts')({ mode: 'active' }, ctx);
    assert.equal(inbox.unread, 1);
    const call = mock.state.calls.find((c) => c.path === '/plugin-api/alerts/items');
    assert.ok(call, 'alerts listed from /plugin-api/alerts/items');

    await tool(observabilityTools(), 'alert_action')({ action: 'dismiss', alertId: 7 }, ctx);
    const read = mock.state.calls.find((c) => c.path === '/plugin-api/alerts/items/read');
    assert.deepEqual(read.body, { ids: [7], read: true });

    ctx.host = await ctx.hosts.resolve(1);
    const ran = await tool(execTools(), 'run_snippet')({ snippetId: 3 }, ctx);
    assert.match(ran.output, /up 1 day/);
  } finally {
    await mock.close();
  }
});
