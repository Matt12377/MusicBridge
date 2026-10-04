import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';
import { verifyRustElectronHosts } from './rust-electron-host-receipt.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, ''), storage = buildStoragePolicy();
const base = process.env.MUSIC_BRIDGE_RUST_GATE_DIR ?? path.join(storage.root, 'musicbridge-rust-core');
storage.check(base); mkdirSync(base, { recursive: true, mode: 0o700 }); storage.check(base, { mustExist: true });
const runDirectory = mkdtempSync(path.join(base, 'run-'));
const result = spawnSync(process.execPath, ['scripts/ci/verify-rust-core.mjs'], { cwd: root, env: { ...process.env, MUSIC_BRIDGE_RUST_RUN_DIR: runDirectory, CARGO_TARGET_DIR: path.join(runDirectory, 'target') }, stdio: 'inherit', timeout: 1_200_000 });
if (result.error || result.status !== 0 || result.signal !== null) throw new Error('本次完整Rust Gate未自然成功，禁止移交宿主。');
const receipt = verifyRustElectronHosts(path.join(runDirectory, 'manifest.json'), { root, runDirectory });
const receiptPath = path.join(runDirectory, 'electron-hosts-receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `MUSIC_BRIDGE_RUST_MAIN_HOST_BUILD_ROOT=${receipt.mainHostBuildRoot}\nMUSIC_BRIDGE_RUST_COLLECTION_HOST_BUILD_ROOT=${receipt.collectionHostBuildRoot}\nMUSIC_BRIDGE_RUST_HOSTS_RECEIPT=${receiptPath}\n`);
console.log('RUST_ELECTRON_HOSTS_READY=' + receiptPath);
