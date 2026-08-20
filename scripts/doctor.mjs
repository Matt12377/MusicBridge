import { createServer } from 'node:net';
import { access } from 'node:fs/promises';

const checks = [];

function add(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

async function portAvailable(host, port) {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

const major = Number(process.versions.node.split('.')[0]);
add('Node.js >= 22', major >= 22, process.versions.node);

for (const variable of [
  'ENABLE_GENERAL_UNBLOCK',
  'ENABLE_PROXY',
  'ENABLE_RANDOM_CN_IP',
]) {
  add(`${variable} disabled`, !truthy(process.env[variable]), process.env[variable] ?? 'unset');
}

const controlHost = process.env.BRIDGE_CONTROL_HOST || '127.0.0.1';
const streamHost = process.env.BRIDGE_STREAM_HOST || '127.0.0.1';
const controlPort = Number(process.env.BRIDGE_CONTROL_PORT || 38501);
const streamPort = Number(process.env.BRIDGE_STREAM_PORT || 38502);

add('Control host is loopback', ['127.0.0.1', '::1'].includes(controlHost), controlHost);
add('Stream host is loopback', ['127.0.0.1', '::1'].includes(streamHost), streamHost);
add(
  'Control port available',
  await portAvailable(controlHost, controlPort),
  `${controlHost}:${controlPort}`,
);
add(
  'Stream port available',
  await portAvailable(streamHost, streamPort),
  `${streamHost}:${streamPort}`,
);

let dependenciesInstalled = true;
try {
  await access(new URL('../node_modules/node-roon-api/package.json', import.meta.url));
  await access(
    new URL(
      '../node_modules/@neteasecloudmusicapienhanced/api/package.json',
      import.meta.url,
    ),
  );
} catch {
  dependenciesInstalled = false;
}
add(
  'Dependencies installed',
  dependenciesInstalled,
  dependenciesInstalled ? 'node_modules present' : 'run npm install',
);
add(
  'NetEase cookie configured',
  Boolean(process.env.NETEASE_COOKIE?.trim()),
  process.env.NETEASE_COOKIE?.trim() ? 'present (not printed)' : 'missing; pairing can start but play will fail',
);

for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
}

const hardFailures = checks.filter(
  (check) => !check.ok && check.name !== 'NetEase cookie configured',
);
process.exitCode = hardFailures.length === 0 ? 0 : 1;
