#!/usr/bin/env node
/**
 * Native-binary smoke test for the Vellum desktop app.
 *
 * Launches the built binary, checks editor startup and file-picker/download
 * installation, and verifies the app version through the IPC capability set.
 * Linux and Windows release builds must pass before promotion. Script-level
 * tests separately cover save cancellation and failed filesystem writes.
 *
 * Two ways in, both zero-dependency (raw WebDriver over Node 20's fetch):
 *
 *   Linux - tauri-driver + WebKitWebDriver ("launch" mode).
 *   Windows - "attach" mode: we start the app ourselves with
 *             VELLUM_CORE_REMOTE_DEBUG_PORT=N
 *             and point msedgedriver at that port (ms:edgeOptions.
 *             debuggerAddress). Edge WebDriver's "launch" mode waits for a
 *             DevToolsActivePort file in a user-data folder it chose, which
 *             a Tauri app never writes because it pins its own folder - the
 *             session dies with "DevToolsActivePort file doesn't exist".
 *
 * Usage:
 *   node scripts/e2e/webdriver-smoke.mjs --app <binary> [--native-driver <msedgedriver.exe>]
 *        [--expect-version 1.7.3] [--port 4444] [--attach-port 9222] [--boot-timeout-ms 120000]
 *
 * The app inherits VELLUM_CORE_DISABLE_UPDATER=1 so the (blocking, native)
 * update prompt can never freeze the run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ARTIFACT_DIR = path.resolve('e2e-artifacts');
const ATTACH = process.platform === 'win32';

function parseArgs(argv) {
  const out = { port: 4444, attachPort: 9222, bootTimeoutMs: 120_000, nativeDriver: null, app: null, expectVersion: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--app') out.app = next();
    else if (a === '--native-driver') out.nativeDriver = next();
    else if (a === '--expect-version') out.expectVersion = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--attach-port') out.attachPort = Number(next());
    else if (a === '--boot-timeout-ms') out.bootTimeoutMs = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.app) throw new Error('--app <binary> is required');
  if (ATTACH && !out.nativeDriver) throw new Error('--native-driver <msedgedriver.exe> is required on Windows');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const appPath = path.resolve(args.app);
const base = `http://127.0.0.1:${args.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const APP_ENV = { ...process.env, VELLUM_CORE_DISABLE_UPDATER: '1' };
let driver = null;
let app = null;
let sessionId = null;

function log(msg) {
  console.log(`[smoke] ${msg}`);
}
function check(name, ok, detail) {
  if (ok) {
    log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`[smoke] FAIL ${name}${detail === undefined ? '' : ` - ${JSON.stringify(detail)}`}`);
  }
  return ok;
}
function pipe(child, tag) {
  child.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
  child.on('exit', (code) => log(`${tag} exited (${code})`));
}

async function wd(method, suffix, body) {
  const res = await fetch(base + suffix, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { value: text };
  }
  if (!res.ok) {
    const v = json && json.value;
    const msg = v && v.message ? `${v.error}: ${v.message}` : text.slice(0, 300);
    throw new Error(`${method} ${suffix} → HTTP ${res.status} ${msg}`);
  }
  return json.value;
}

async function waitForHttp(label, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`${label} did not come up within ${timeoutMs}ms (${url})`);
}

async function startLaunchMode() {
  const driverArgs = ['--port', String(args.port)];
  if (args.nativeDriver) driverArgs.push('--native-driver', path.resolve(args.nativeDriver));
  log(`starting tauri-driver ${driverArgs.join(' ')}`);
  driver = spawn('tauri-driver', driverArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: APP_ENV });
  pipe(driver, 'tauri-driver');
  await waitForHttp('tauri-driver', `${base}/status`, 30_000);
  const value = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: appPath, args: [] } } },
  });
  sessionId = value.sessionId;
}

async function startAttachMode() {
  log(`starting app with remote debugging on ${args.attachPort}`);
  app = spawn(appPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The app opens the port itself when asked (see lib.rs): WebView2 drops the
    // WEBVIEW2_* environment overrides once the app passes explicit options.
    env: { ...APP_ENV, VELLUM_CORE_REMOTE_DEBUG_PORT: String(args.attachPort) },
  });
  pipe(app, 'app');
  await waitForHttp('the app\'s DevTools endpoint', `http://127.0.0.1:${args.attachPort}/json/version`, 90_000);
  const drv = path.resolve(args.nativeDriver);
  log(`starting ${drv} --port=${args.port}`);
  driver = spawn(drv, [`--port=${args.port}`], { stdio: ['ignore', 'pipe', 'pipe'], env: APP_ENV });
  pipe(driver, 'msedgedriver');
  await waitForHttp('msedgedriver', `${base}/status`, 30_000);
  const value = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'webview2',
        'ms:edgeOptions': { debuggerAddress: `localhost:${args.attachPort}` },
      },
    },
  });
  sessionId = value.sessionId;
}

const exec = (script, scriptArgs = []) =>
  wd('POST', `/session/${sessionId}/execute/sync`, { script, args: scriptArgs });
const execAsync = (script, scriptArgs = []) =>
  wd('POST', `/session/${sessionId}/execute/async`, { script, args: scriptArgs });

async function screenshot(name) {
  try {
    const b64 = await wd('GET', `/session/${sessionId}/screenshot`);
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const file = path.join(ARTIFACT_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(b64, 'base64'));
    log(`screenshot → ${file}`);
  } catch (e) {
    log(`screenshot ${name} unavailable: ${e.message}`);
  }
}

async function waitFor(label, fn, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = `error: ${e.message}`;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/* Raw invoke through the same bridge the polyfill uses. Settles within
   10s either way so a hung invoke is reported as such. */
const ipc = (cmd, payload) =>
  execAsync(
    `var cmd = arguments[0], payload = arguments[1], cb = arguments[arguments.length - 1];
     var done = false;
     function finish(v) { if (!done) { done = true; cb(v); } }
     setTimeout(function () { finish({ ok: false, error: 'invoke did not settle within 10s' }); }, 10000);
     try {
       window.__TAURI_INTERNALS__.invoke(cmd, payload).then(function (v) { finish({ ok: true, value: v }); },
         function (e) { finish({ ok: false, error: String(e && e.message || e) }); });
     } catch (e) { finish({ ok: false, error: String(e && e.message || e) }); }`,
    [cmd, payload === undefined ? null : payload],
  );

async function main() {
  if (!existsSync(appPath)) throw new Error(`app binary not found: ${appPath}`);
  log(`app: ${appPath} (${process.platform}, ${ATTACH ? 'attach' : 'launch'} mode)`);
  if (ATTACH) await startAttachMode();
  else await startLaunchMode();
  if (!sessionId) throw new Error('no sessionId');
  log(`session ${sessionId}`);

  try {
    await waitFor(
      'the editor to boot (tab strip present)',
      () => exec(`return !!(window.__vellumDesktopFiles__ && document.querySelector('[data-vellum-tabs-bar]'));`),
      args.bootTimeoutMs,
    );
  } catch (e) {
    await screenshot('boot-timeout');
    const state = await exec(
      `return { href: location.href, readyState: document.readyState, title: document.title,
                files: !!window.__vellumDesktopFiles__, tauri: !!window.__TAURI_INTERNALS__,
                tabs: !!document.querySelector('[data-vellum-tabs-bar]') };`,
    ).catch((err) => `unavailable: ${err.message}`);
    console.error('[smoke] boot state:', JSON.stringify(state));
    throw e;
  }
  log('editor booted');
  await screenshot('booted');

  const report = await exec(`
    return {
      href: location.href,
      tauri: !!window.__TAURI_INTERNALS__,
      pickers: {
        open: typeof window.showOpenFilePicker === 'function' && String(window.showOpenFilePicker).indexOf('plugin:dialog|open') >= 0,
        save: typeof window.showSaveFilePicker === 'function' && String(window.showSaveFilePicker).indexOf('plugin:dialog|save') >= 0
      },
      downloadHook: String(HTMLAnchorElement.prototype.click).indexOf('plugin:dialog|save') >= 0,
      inner: { w: window.innerWidth, h: window.innerHeight }
    };`);
  log(`report ${JSON.stringify(report)}`);
  check('Tauri IPC bridge present', report.tauri);
  check('File System Access pickers are the Tauri-dialog polyfill', report.pickers.open && report.pickers.save, report.pickers);
  check('<a download> exports are routed through the save dialog', report.downloadHook);
  check('window has a usable size', report.inner.w >= 800 && report.inner.h >= 500, report.inner);

  const version = await ipc('plugin:app|version');
  check('app version readable over IPC', version.ok && typeof version.value === 'string', version);
  if (args.expectVersion) {
    check(`built binary reports version ${args.expectVersion}`, version.ok && version.value === args.expectVersion, version);
  }
  await screenshot('after-checks');
}

function killTree(child, tag) {
  if (!child || child.exitCode !== null) return;
  log(`stopping ${tag} (pid ${child.pid})`);
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

async function cleanup() {
  if (sessionId) {
    await wd('DELETE', `/session/${sessionId}`).catch(() => {});
  }
  killTree(driver, 'driver');
  killTree(app, 'app');
}

main()
  .then(async () => {
    await cleanup();
    if (failures.length) {
      console.error(`[smoke] ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
    log('ALL CHECKS PASSED');
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(`[smoke] ABORTED: ${e.stack || e}`);
    await cleanup();
    process.exit(2);
  });
