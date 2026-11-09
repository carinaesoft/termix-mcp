// Read-only live verification against a real Termix 26.11.x instance. Confirms
// the base URL/auth and version, checks that the plugins this server calls are
// active, enumerates hosts (flagging blocklisted ones, never touching them),
// and -- only when a target host is named -- lists / on it and runs a single
// echo through the command path to prove executeFile still captures output.
//
//   TERMIX_BASE_URL=... TERMIX_API_KEY=... node scripts/verify-live.mjs
//   ... node scripts/verify-live.mjs --host 5      # also runs the file + exec probes
//
// The exec probe writes a temporary script to the host's TERMIX_TMP_DIR and
// deletes it; pass a host you are comfortable running `echo`/`id` on. Nothing
// else writes anything, in Termix or on a host.

// Plugins each tool family needs. The first five carry run_command, read_file,
// write_file and list_files; the rest are optional.
const PLUGINS = [
  ['file-manager', true], ['docker', false], ['host-metrics', false], ['host-status', false],
  ['snippets', false], ['tunnels', false], ['alerts', false], ['session-recording', false],
  ['service-manager', false], ['process-manager', false],
];

import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logging.mjs';
import { createClient } from '../src/termix/client.mjs';
import { createHostRegistry } from '../src/termix/hosts.mjs';
import { createSessionManager } from '../src/termix/sessions.mjs';
import { runScript } from '../src/mcp/tools/exec.mjs';
import { FILES, HOST_STATUS } from '../src/termix/routes.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);

const config = loadConfig('stdio');
const logger = createLogger({ level: 'warn' });
const client = createClient(config, logger);
const hosts = createHostRegistry(client, config.blocklist, logger);
const sessions = createSessionManager({ client, config, logger });

let failures = 0;

console.log(`\nTermix base URL: ${config.baseUrl}`);

// 1. Auth / reachability.
console.log('\n[1] Auth and reachability');
try {
  const me = await client.get('/users/me');
  ok(`authenticated as ${me?.username ?? me?.id ?? 'unknown user'}`);
} catch (error) {
  failures += 1;
  bad(`GET /users/me failed: ${error.message}`);
  console.log('      The base URL or API key is wrong, or nginx is not serving the API on this origin.');
}

try {
  const version = await client.get('/version');
  ok(`Termix ${version?.localVersion ?? 'version unknown'}`);
  if (!String(version?.localVersion ?? '').startsWith('26.')) {
    console.log('      termix-mcp targets Termix 26.11.x; other versions are not supported.');
  }
} catch (error) {
  bad(`GET /version failed: ${error.message}`);
}

// 1b. Plugins.
console.log('\n[1b] Plugins');
try {
  const raw = await client.get('/plugins');
  const list = Array.isArray(raw) ? raw : (raw?.plugins ?? []);
  const byId = new Map(list.map((p) => [p.id, p]));
  for (const [id, required] of PLUGINS) {
    const p = byId.get(id);
    const active = p && p.enabled !== false && (p.state === undefined || p.state === 'active');
    if (active) ok(`${id} ${p.version ?? ''} active`);
    else if (required) { failures += 1; bad(`${id} is ${p ? `not active (${p.state})` : 'not installed'}; file tools and run_command need it`); }
    else console.log(`  - ${id} ${p ? `not active (${p.state})` : 'not installed'}; its tools will say so`);
  }
} catch (error) {
  bad(`GET /plugins failed: ${error.message}`);
}

// 2. Host inventory + blocklist.
console.log('\n[2] Host inventory');
let allHosts = [];
try {
  allHosts = await hosts.list();
  ok(`${allHosts.length} hosts registered`);
  for (const h of allHosts) {
    const blocked = hosts.isBlocked(h) ? '  [BLOCKED]' : '';
    console.log(`      #${h.id} ${h.name || '(no name)'} ${h.ip}:${h.port}${blocked}`);
  }
} catch (error) {
  failures += 1;
  bad(`GET /host/db/host failed: ${error.message}`);
}

// 3. Status map + uptime.
console.log('\n[3] Status and uptime');
try {
  const statuses = await client.get(`${HOST_STATUS}/`);
  ok(`GET ${HOST_STATUS}/ returned ${Object.keys(statuses ?? {}).length} host statuses`);
} catch (error) {
  bad(`GET ${HOST_STATUS}/ failed: ${error.message}`);
}
try {
  const uptime = await client.get('/dashboard/uptime');
  ok(`server uptime: ${uptime?.formatted ?? `${uptime?.uptimeSeconds ?? '?'}s`}`);
} catch (error) {
  bad(`GET /dashboard/uptime failed: ${error.message}`);
}

// 4. Command-execution probe (opt-in via --host).
const target = arg('--host');
if (target) {
  console.log(`\n[4] File and command-execution probes on host ${target}`);
  try {
    const host = await hosts.resolveAllowed(target);
    const listing = await sessions.withFileSession(host, (s) => client.get(`${FILES}/listFiles`, {
      sessionId: s.sessionId, path: '/',
    }));
    ok(`file-manager session opened; / has ${listing?.files?.length ?? '?'} entries`);
    const result = await runScript({ client, sessions, config, logger }, host, 'echo termix-mcp-ok && id');
    if (result.stdout.includes('termix-mcp-ok') && typeof result.exitCode === 'number') {
      ok(`executeFile captured output (exit ${result.exitCode}); run_command is fully functional`);
      console.log(`      stdout: ${result.stdout.replace(/\n/g, ' ').slice(0, 120)}`);
    } else {
      failures += 1;
      bad('executeFile did not return the expected {exitCode, output} shape');
      console.log('      run_command may need the redirect-to-file fallback on this Termix version.');
      console.log(`      raw: ${JSON.stringify(result).slice(0, 200)}`);
    }
  } catch (error) {
    failures += 1;
    bad(`exec probe failed: ${error.message}`);
  }
} else {
  console.log('\n[4] File and command-execution probes skipped (pass --host <id|name> to run them)');
}

await sessions.closeAll();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
