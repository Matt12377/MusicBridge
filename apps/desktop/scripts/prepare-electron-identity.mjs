import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { buildStoragePolicy } from './build-storage-root.mjs';
import { electronSource, verifyElectronArchive, ELECTRON_VERSION } from './electron-identity.mjs';

const storage = buildStoragePolicy();
// 第一次落盘/下载之前准入；后续下载与收据都只用同一受验值。
const tempRoot = storage.check(process.env.TMPDIR ?? '', { mustExist: true });
const source = electronSource();
const cacheRoot = path.join(process.env.DEV_CACHE_ROOT ?? path.join(storage.root, 'musicbridge-electron/cache'), 'Electron');
storage.check(cacheRoot); mkdirSync(cacheRoot, { recursive: true, mode: 0o700 }); storage.check(cacheRoot, { mustExist: true });
// 复用官方installer缓存；固定版本/平台/checksum及独立ZIP pin，禁止环境自报exe SHA。
const dependency = createRequire(path.join(source.packageRoot, 'package.json'));
const { downloadArtifact } = dependency('@electron/get');
const archivePath = await downloadArtifact({ version: ELECTRON_VERSION, artifactName: 'electron', platform: process.platform, arch: process.arch, cacheRoot, tempDirectory: tempRoot, checksums: source.checksums, mirrorOptions: { resolveAssetURL: () => `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${source.assetName}` } });
const receipt = verifyElectronArchive(archivePath);
const run = mkdtempSync(path.join(tempRoot, 'musicbridge-electron-identity-')), receiptPath = path.join(run, 'receipt.json');
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `MUSIC_BRIDGE_ELECTRON_IDENTITY_RECEIPT=${receiptPath}\n`);
console.log('MUSIC_BRIDGE_ELECTRON_IDENTITY_RECEIPT=' + receiptPath);
