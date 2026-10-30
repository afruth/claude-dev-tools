#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const MANIFEST_NAME = 'tsdev.json';
const SERVE_TIMEOUT_MS = 40_000;
const PROBE_TIMEOUT_MS = 8_000;
const HTTPS_PORT_OFFSET = 10_000;
const HTTPS_SCAN_START = 13_000;
const MAX_PORT = 65_535;

const fail = (message) => {
  console.error(`tsdev: ${message}`);
  process.exit(1);
};

const capture = (file, args, options = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', ...options });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
};

const gitOutput = (args, cwd) => {
  const result = capture('git', args, { cwd });
  return result.ok ? result.stdout.trim() : null;
};

const locateTailscale = () => {
  const onPath = capture('sh', ['-c', 'command -v tailscale']);
  const candidates = [
    onPath.ok ? onPath.stdout.trim() : '',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) fail('the Tailscale CLI was not found');
  return found;
};

const tailscaleJson = (bin, args) => {
  const result = capture(bin, args);
  if (!result.ok) fail(`tailscale ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout || '{}');
};

const readMachine = (bin) => {
  const status = tailscaleJson(bin, ['status', '--json']);
  if (status.BackendState !== 'Running') {
    fail(`Tailscale is not running (state: ${status.BackendState}). Connect Tailscale first.`);
  }
  const host = (status.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!host) fail('this machine has no MagicDNS name. Enable MagicDNS for the tailnet.');
  if (!(status.CertDomains ?? []).includes(host)) {
    fail('HTTPS certificates are off for this tailnet. Enable HTTPS in the Tailscale admin console.');
  }
  return { host, ip: status.Self?.TailscaleIPs?.[0] ?? null };
};

const readServeTargets = (bin) => {
  const config = tailscaleJson(bin, ['serve', 'status', '--json']);
  const targets = new Map();
  for (const port of Object.keys(config.TCP ?? {})) targets.set(Number(port), null);
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const port = Number(hostPort.split(':').pop());
    targets.set(port, web.Handlers?.['/']?.Proxy ?? null);
  }
  return targets;
};

const readListeningPorts = () => {
  const ports = new Set();
  const addMatches = (text, pattern) => {
    for (const match of text.matchAll(pattern)) ports.add(Number(match[1]));
  };
  const lsof = capture('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  if (lsof.ok) addMatches(lsof.stdout, /:(\d+) \(LISTEN\)/g);
  const ss = capture('ss', ['-ltnH']);
  if (ss.ok) addMatches(ss.stdout, /:(\d+)\s+\S+:\S+/g);
  const docker = capture('docker', ['ps', '--format', '{{.Ports}}']);
  if (docker.ok) addMatches(docker.stdout, /:(\d+)->/g);
  return ports;
};

const parseArgs = (argv) => {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg.startsWith('--')) {
      flags[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else positional.push(arg);
  }
  return { flags, positional };
};

const resolveCheckout = () => {
  const cwd = process.cwd();
  const root = gitOutput(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const gitDir = gitOutput(['rev-parse', '--absolute-git-dir'], cwd);
  const manifestPath = gitDir ? join(gitDir, MANIFEST_NAME) : join(root, `.${MANIFEST_NAME}`);
  return { root, manifestPath, isGit: Boolean(gitDir) };
};

const loadManifest = (checkout) => {
  if (!existsSync(checkout.manifestPath)) {
    return { root: checkout.root, proxies: {}, env: {}, stopCommand: null, reservedPorts: [] };
  }
  return JSON.parse(readFileSync(checkout.manifestPath, 'utf8'));
};

const saveManifest = (checkout, manifest) => {
  writeFileSync(checkout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

const printJson = (value) => console.log(JSON.stringify(value, null, 2));

const commandReserve = ({ flags }) => {
  const count = Number(flags.count ?? 10);
  const from = Number(flags.from ?? 3300);
  if (!Number.isInteger(count) || count < 1) fail('--count must be a positive integer');
  if (!Number.isInteger(from) || from < 1024) fail('--from must be an integer of 1024 or more');
  const checkout = resolveCheckout();
  const manifest = loadManifest(checkout);
  const bin = locateTailscale();
  const taken = readListeningPorts();
  for (const port of readServeTargets(bin).keys()) taken.add(port);
  const ownTargets = new Set(Object.values(manifest.proxies).map((proxy) => proxy.port));
  const reuse =
    manifest.reservedPorts.length === count &&
    manifest.reservedPorts.every((port) => !taken.has(port) || ownTargets.has(port));
  if (!reuse) {
    let start = from;
    const blockIsFree = (first) =>
      Array.from({ length: count }, (_, offset) => first + offset).every((port) => !taken.has(port));
    while (!blockIsFree(start)) {
      start += 10;
      if (start + count > HTTPS_SCAN_START) fail(`no free block of ${count} ports from ${from}`);
    }
    manifest.reservedPorts = Array.from({ length: count }, (_, offset) => start + offset);
    saveManifest(checkout, manifest);
  }
  printJson({ root: checkout.root, ports: manifest.reservedPorts, reused: reuse });
};

const commandRecord = ({ flags }) => {
  if (!flags.stop) fail('record needs --stop "<command>"');
  if (/(^|\s)(-v|--volumes|--rmi)(\s|$)|rm\s+-/.test(flags.stop)) {
    fail('the stop command must not delete volumes, images, or files');
  }
  const checkout = resolveCheckout();
  const manifest = loadManifest(checkout);
  manifest.stopCommand = flags.stop;
  saveManifest(checkout, manifest);
  printJson({ root: checkout.root, stopCommand: manifest.stopCommand });
};

const commandSetEnv = ({ positional }) => {
  const [file, ...assignments] = positional;
  if (!file || assignments.length === 0) fail('set-env needs <file> KEY=VALUE [KEY=VALUE ...]');
  const checkout = resolveCheckout();
  const relative = isAbsolute(file) ? file.slice(checkout.root.length + 1) : file;
  const path = resolve(checkout.root, relative);
  if (checkout.isGit && gitOutput(['ls-files', '--error-unmatch', relative], checkout.root) !== null) {
    fail(`${relative} is tracked by git. Change only untracked env files.`);
  }
  const manifest = loadManifest(checkout);
  const originals = (manifest.env[relative] ??= {});
  let lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator < 1) fail(`invalid assignment: ${assignment}`);
    const key = assignment.slice(0, separator);
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (!(key in originals)) originals[key] = index === -1 ? null : lines[index].slice(key.length + 1);
    if (index === -1) lines = [...lines.filter((line, at) => line || at < lines.length - 1), assignment, ''];
    else lines[index] = assignment;
  }
  writeFileSync(path, lines.join('\n'));
  saveManifest(checkout, manifest);
  printJson({ file: relative, recordedOriginals: originals });
};

const restoreEnv = (checkout, manifest) => {
  const restored = [];
  for (const [relative, originals] of Object.entries(manifest.env)) {
    const path = resolve(checkout.root, relative);
    if (!existsSync(path)) continue;
    let lines = readFileSync(path, 'utf8').split('\n');
    for (const [key, original] of Object.entries(originals)) {
      if (original === null) lines = lines.filter((line) => !line.startsWith(`${key}=`));
      else lines = lines.map((line) => (line.startsWith(`${key}=`) ? `${key}=${original}` : line));
      restored.push(`${relative}:${key}`);
    }
    writeFileSync(path, lines.join('\n'));
  }
  return restored;
};

const chooseHttpsPort = (hostPort, taken) => {
  const preferred = hostPort + HTTPS_PORT_OFFSET;
  if (preferred <= MAX_PORT && !taken.has(preferred)) return preferred;
  for (let port = HTTPS_SCAN_START; port <= MAX_PORT; port += 1) {
    if (!taken.has(port)) return port;
  }
  return fail('no free HTTPS port');
};

const commandServe = ({ positional }) => {
  if (positional.length === 0) fail('serve needs name=hostPort [name=hostPort ...]');
  const checkout = resolveCheckout();
  const manifest = loadManifest(checkout);
  const bin = locateTailscale();
  const { host } = readMachine(bin);
  const serveTargets = readServeTargets(bin);
  const listening = readListeningPorts();
  const taken = new Set([...serveTargets.keys(), ...listening]);
  const wanted = positional.map((entry) => {
    const [name, value] = entry.split('=');
    const port = Number(value);
    if (!name || !Number.isInteger(port)) fail(`invalid entry: ${entry}`);
    if (!listening.has(port)) fail(`nothing listens on port ${port} (${name}). Start the stack first.`);
    return { name, port, target: `http://127.0.0.1:${port}` };
  });
  for (const { name, port, target } of wanted) {
    const existing = [...serveTargets].find(([, current]) => current === target);
    const owned = manifest.proxies[name];
    if (existing && owned?.httpsPort === existing[0]) continue;
    if (existing) {
      if (existing[0] !== port + HTTPS_PORT_OFFSET) {
        fail(`port ${port} is already served on HTTPS port ${existing[0]} by another owner`);
      }
      manifest.proxies[name] = { port, httpsPort: existing[0], url: `https://${host}:${existing[0]}` };
      continue;
    }
    const httpsPort = chooseHttpsPort(port, taken);
    const result = capture(bin, ['serve', '--bg', `--https=${httpsPort}`, target], {
      timeout: SERVE_TIMEOUT_MS,
    });
    if (!result.ok) {
      saveManifest(checkout, manifest);
      const reason = result.timedOut ? 'the command waited for approval' : 'the command failed';
      fail(`tailscale serve for ${name}: ${reason}.\n${result.stdout}${result.stderr}`);
    }
    taken.add(httpsPort);
    manifest.proxies[name] = { port, httpsPort, url: `https://${host}:${httpsPort}` };
  }
  saveManifest(checkout, manifest);
  printJson({ root: checkout.root, proxies: manifest.proxies });
};

const probe = async (url) => {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.status;
  } catch (error) {
    return `no response (${error.cause?.code ?? error.name})`;
  }
};

const commandCheck = async () => {
  const checkout = resolveCheckout();
  const manifest = loadManifest(checkout);
  const results = {};
  for (const [name, proxy] of Object.entries(manifest.proxies)) {
    results[name] = { url: proxy.url, status: await probe(proxy.url) };
  }
  printJson(results);
};

const commandStatus = () => {
  const checkout = resolveCheckout();
  const manifest = loadManifest(checkout);
  const bin = locateTailscale();
  const { host, ip } = readMachine(bin);
  const serveTargets = readServeTargets(bin);
  const listening = readListeningPorts();
  const ownHttpsPorts = new Set(Object.values(manifest.proxies).map((proxy) => proxy.httpsPort));
  const others = [...serveTargets]
    .filter(([port]) => !ownHttpsPorts.has(port))
    .map(([httpsPort, target]) => {
      const targetPort = Number(target?.split(':').pop()?.split('/')[0]);
      return { httpsPort, target, targetListening: listening.has(targetPort) };
    });
  printJson({
    root: checkout.root,
    machine: { host, ip },
    manifest: existsSync(checkout.manifestPath) ? checkout.manifestPath : null,
    stopCommand: manifest.stopCommand,
    reservedPorts: manifest.reservedPorts,
    envChanged: manifest.env,
    proxies: Object.fromEntries(
      Object.entries(manifest.proxies).map(([name, proxy]) => [
        name,
        {
          ...proxy,
          serveActive: serveTargets.get(proxy.httpsPort) === `http://127.0.0.1:${proxy.port}`,
          targetListening: listening.has(proxy.port),
        },
      ]),
    ),
    otherServeEntries: others,
  });
};

const commandDown = ({ flags }) => {
  const checkout = resolveCheckout();
  const manifest = loadManifest(checkout);
  const proxies = Object.entries(manifest.proxies);
  if (proxies.length === 0 && !manifest.stopCommand && Object.keys(manifest.env).length === 0) {
    if (!flags.dryRun) rmSync(checkout.manifestPath, { force: true });
    printJson({ root: checkout.root, message: 'this checkout has no record of a Tailscale stack' });
    return;
  }
  const bin = locateTailscale();
  const serveTargets = readServeTargets(bin);
  const removals = proxies.filter(
    ([, proxy]) => serveTargets.get(proxy.httpsPort) === `http://127.0.0.1:${proxy.port}`,
  );
  const skipped = proxies.filter(([name]) => !removals.some(([removal]) => removal === name));
  if (flags.dryRun) {
    printJson({
      dryRun: true,
      root: checkout.root,
      wouldRemove: removals.map(([name, proxy]) => ({ name, ...proxy })),
      wouldSkip: skipped.map(([name]) => name),
      wouldRun: manifest.stopCommand,
      wouldRestore: manifest.env,
    });
    return;
  }
  const errors = [];
  for (const [name, proxy] of removals) {
    const result = capture(bin, ['serve', `--https=${proxy.httpsPort}`, 'off'], {
      timeout: SERVE_TIMEOUT_MS,
    });
    if (result.ok) delete manifest.proxies[name];
    else errors.push(`${name}: ${result.stderr.trim()}`);
  }
  for (const [name] of skipped) delete manifest.proxies[name];
  let stopped = null;
  if (manifest.stopCommand) {
    try {
      execFileSync('sh', ['-c', manifest.stopCommand], { cwd: checkout.root, stdio: 'inherit' });
      stopped = manifest.stopCommand;
      manifest.stopCommand = null;
    } catch {
      errors.push(`the stop command failed: ${manifest.stopCommand}`);
    }
  }
  const restored = restoreEnv(checkout, manifest);
  manifest.env = {};
  manifest.reservedPorts = [];
  if (errors.length > 0) saveManifest(checkout, manifest);
  else rmSync(checkout.manifestPath, { force: true });
  printJson({
    root: checkout.root,
    removed: removals.map(([name]) => name),
    skipped: skipped.map(([name]) => name),
    stopped,
    restoredEnv: restored,
    errors,
  });
  if (errors.length > 0) process.exit(1);
};

const commandRelease = ({ positional }) => {
  const httpsPort = Number(positional[0]);
  if (!Number.isInteger(httpsPort)) fail('release needs an HTTPS port');
  const bin = locateTailscale();
  const target = readServeTargets(bin).get(httpsPort);
  if (target === undefined) fail(`HTTPS port ${httpsPort} has no serve entry`);
  const targetPort = Number(target?.split(':').pop()?.split('/')[0]);
  if (readListeningPorts().has(targetPort)) {
    fail(`port ${targetPort} still listens, so another stack can own this entry. Nothing changed.`);
  }
  const result = capture(bin, ['serve', `--https=${httpsPort}`, 'off'], { timeout: SERVE_TIMEOUT_MS });
  if (!result.ok) fail(result.stderr.trim());
  printJson({ released: httpsPort, target });
};

const COMMANDS = {
  reserve: commandReserve,
  record: commandRecord,
  'set-env': commandSetEnv,
  serve: commandServe,
  check: commandCheck,
  status: commandStatus,
  down: commandDown,
  release: commandRelease,
};

const [commandName, ...rest] = process.argv.slice(2);
const command = COMMANDS[commandName];
if (!command) fail(`usage: tsdev.mjs <${Object.keys(COMMANDS).join('|')}> [args]`);
await command(parseArgs(rest));
