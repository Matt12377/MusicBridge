import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

export const RUST_GATE_RUN_NAMES = ["rustc-version", "cargo-version", "fmt", "clippy", "rust-test", "metadata", "rust-build", "contracts-build", "ts-client", "node-atomic-snapshot", "node-snapshot-version", "ts-refresh-router", "node-large-snapshot", "ts-large-snapshot", "ts-query-index", "ts-core-owner-lifecycle", "ts-core-utility-options", "ts-rust-integration", "core-runtime-integration", "ts-node-mixed-reads", "ts-core-host-controls", "core-host-integration", "ts-main-read-boundary", "desktop-core-host-adapter", "main-host-isolated-build", "main-background-components", "main-evidence-acceptance", "ts-collection-ui-read-boundary", "node-collection-ui-purity", "collection-host-isolated-build"];
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  });
}
export function rustGateSources(root) {
  return [
    ...sourceFiles(path.join(root, 'native/rust-core')),
    ...sourceFiles(path.join(root, 'packages/bridge-core/src')),
    ...sourceFiles(path.join(root, 'packages/contracts/src')),
    ...sourceFiles(path.join(root, 'packages/bridge-core/test/helpers')),
    ...sourceFiles(path.join(root, 'packages/bridge-core/test/rust-core')),
    ...sourceFiles(path.join(root, 'apps/desktop/src')),
    ...sourceFiles(path.join(root, 'apps/desktop/test/helpers')),
    ...sourceFiles(path.join(root, 'apps/desktop/test/rust-core')),
    path.join(root, 'rust-toolchain.toml'), path.join(root, 'package.json'),
    path.join(root, 'pnpm-lock.yaml'), path.join(root, 'pnpm-workspace.yaml'),
    path.join(root, 'patches/@neteasecloudmusicapienhanced__api@4.40.1.patch'),
    fs.realpathSync(createRequire(path.join(root, 'apps/desktop/package.json')).resolve('@neteasecloudmusicapienhanced/api/util/crypto.js')),
    ...sourceFiles(path.join(root, 'apps/desktop/test/fixtures/rust015-historical')),
    path.join(root, 'packages/bridge-core/package.json'), path.join(root, 'packages/contracts/package.json'),
    path.join(root, 'scripts/ci/rust-gate-inputs.mjs'), path.join(root, 'scripts/ci/rust-electron-host-receipt.mjs'), path.join(root, 'scripts/ci/prepare-rust-electron-hosts.mjs'),
    path.join(root, 'scripts/ci/verify-rust-core.mjs'), path.join(root, 'apps/desktop/scripts/build-storage-root.mjs'), path.join(root, 'scripts/ci/verify-boundaries.mjs'),
    path.join(root, 'scripts/ci/rust-main-evidence.mjs'),
    path.join(root, 'scripts/ci/test/rust-main-evidence.test.mjs'),
    path.join(root, 'scripts/ci/rust-collection-evidence.mjs'),
    path.join(root, 'scripts/ci/test/rust-collection-evidence.test.mjs'),
    path.join(root, '.github/workflows/rust-core.yml'), path.join(root, 'packages/bridge-core/test/rust-sidecar-client.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-collection-snapshot.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-snapshot-version.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-router.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-large-snapshot.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-large-sidecar.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-query-index.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-core-owner-lifecycle.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-core-utility-options.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-node-reads.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-core-host-controls.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-main-boundary.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-collection-ui.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-collection-ui-node-purity.test.ts'),
    path.join(root, 'apps/desktop/test/rust-core-host.test.ts'),
    path.join(root, 'apps/desktop/test/native-output-device-package.test.ts'),
    path.join(root, 'apps/desktop/package.json'), path.join(root, 'apps/desktop/tsconfig.json'),
    path.join(root, 'apps/desktop/electron.vite.config.ts'),
    ...sourceFiles(path.join(root, 'apps/desktop/e2e')).filter(file => /\/(?:private-rust-|rust-main-host|rust-collection-host)/.test(file)),
    path.join(root, 'apps/desktop/electron-gate/rust-main-host.test.ts'),
    path.join(root, 'apps/desktop/scripts/rust-main-host-gate.mjs'),
    path.join(root, 'apps/desktop/electron-gate/rust-collection-host.test.ts'),
    path.join(root, 'apps/desktop/scripts/rust-collection-host-gate.mjs'),
  ].sort().map(file => ({ path: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
}

export function hostGateSources(root, task) {
  const scopes = ['apps/desktop/src', 'apps/desktop/e2e', 'apps/desktop/test', 'apps/desktop/electron-gate', 'apps/desktop/scripts', 'packages/bridge-core/src', 'packages/bridge-core/test/helpers', 'packages/contracts/src'];
  if (task === 'RUST-009') scopes.push('scripts/ci/rust-collection-evidence.mjs', 'scripts/ci/test/rust-collection-evidence.test.mjs');
  const result = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...scopes], { encoding: 'utf8' });
  if (result.status !== 0 || result.signal !== null || result.error) throw new Error('无法闭合集合读取本轮宿主源码。');
  const files = result.stdout.trim().split('\n').filter(Boolean);
  files.push('scripts/ci/rust-gate-inputs.mjs', 'scripts/ci/rust-electron-host-receipt.mjs', 'scripts/ci/prepare-rust-electron-hosts.mjs', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'packages/bridge-core/package.json', 'packages/contracts/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/@neteasecloudmusicapienhanced__api@4.40.1.patch');
  const installed = fs.realpathSync(createRequire(path.join(root, 'apps/desktop/package.json')).resolve('@neteasecloudmusicapienhanced/api/util/crypto.js'));
  if (!installed.startsWith(root + path.sep)) throw new Error('实际Provider必须属于本轮锁定源码树。');
  files.push(path.relative(root, installed));
  files.push(...sourceFiles(path.join(root, 'packages/contracts/dist')).map(file => path.relative(root, file)));
  return [...new Set(files)].sort().map(file => ({ path: file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
}
