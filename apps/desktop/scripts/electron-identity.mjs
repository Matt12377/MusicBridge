import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStoragePolicy } from './build-storage-root.mjs';

export const ELECTRON_VERSION = '43.4.0';
export const ELECTRON_ARCHIVES = Object.freeze({
  'darwin-arm64': '827f9f182566f46846377575b51c547b9926b111637313a373b6f717462aebac',
  'darwin-x64': '7ab39ec1b0bcf5463f2dc0040142fbc1c30cd7bc3f99086066f588c717b11e24',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const desktop = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(desktop, 'package.json'));
const forbidden = ['ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH', 'ELECTRON_MIRROR', 'ELECTRON_CUSTOM_DIR', 'ELECTRON_CUSTOM_FILENAME', 'npm_config_electron_mirror', 'npm_config_electron_custom_dir', 'npm_config_electron_custom_filename'];
export function electronSource() {
  if (forbidden.some(key => process.env[key]) || Object.keys(process.env).some(key => /^(?:electron_|(?:npm_config_|npm_package_config_)electron_)/iu.test(key) && /(?:mirror|customdir|custom_dir|customfilename|custom_filename|customversion|custom_version|override_dist_path|install_platform|install_arch)/iu.test(key) && process.env[key])) throw new Error('官方Electron身份禁止运行输入/镜像环境覆盖。');
  const platformKey = process.platform + '-' + process.arch, archiveSha256 = ELECTRON_ARCHIVES[platformKey];
  if (!archiveSha256) throw new Error('此Electron Gate只准入已固定官方资产的macOS arm64/x64。');
  const lock = readFileSync(fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url)), 'utf8');
  const lockedPackage = lock.match(/^  electron@43\.4\.0:\n([\s\S]*?)(?=\n  \S|$)/mu)?.[1] ?? '';
  if (!lockedPackage.includes('sha512-3qxGF0CeQbiox5oWV1JlbWGQ1VerbmDhTFqW4sJ8h7uqTHniFYPObXJcDna0DMh32et0fFyKzz0YY8lJv3t5jg==')) throw new Error('Electron锁定npm integrity不符。');
  const packageRoot = path.dirname(realpathSync(require.resolve('electron/package.json')));
  if (JSON.parse(readFileSync(path.join(packageRoot, 'package.json'))).version !== ELECTRON_VERSION) throw new Error('Electron精确版本不符。');
  const checksumBytes = readFileSync(path.join(packageRoot, 'checksums.json'));
  if (sha(checksumBytes) !== 'b5e50acefeceb1ba65bac98abd6c626a1a3d7cb4cc7747be007dec3650f68421' || sha(readFileSync(path.join(packageRoot, 'install.js'))) !== '5a83199076ae20cfe57576a984e31b92890a2ae4e0759454bb6df4f9e7f47460') throw new Error('锁定官方Electron源输入身份不符。');
  const assetName = `electron-v${ELECTRON_VERSION}-${platformKey}.zip`, checksums = JSON.parse(checksumBytes);
  if (checksums[assetName] !== archiveSha256) throw new Error('独立官方资产pin与npm内置checksum不一致。');
  const executable = 'Electron.app/Contents/MacOS/Electron';
  if (readFileSync(path.join(packageRoot, 'path.txt'), 'utf8') !== executable || readFileSync(path.join(packageRoot, 'dist/version'), 'utf8').replace(/^v/u, '') !== ELECTRON_VERSION) throw new Error('当前平台Electron path/version不符。');
  return { packageRoot, assetName, archiveSha256, checksums, executable };
}
export function verifyElectronArchive(archivePath) {
  const source = electronSource();
  buildStoragePolicy().check(archivePath, { mustExist: true, kind: 'file' });
  const result = spawnSync('python3', [fileURLToPath(new URL('./electron-archive-tree.py', import.meta.url)), archivePath, source.packageRoot, source.archiveSha256, source.executable], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) throw new Error('当前实际Electron树未通过官方ZIP核验：' + (result.stderr ?? ''));
  return { schemaVersion: 1, kind: 'OFFICIAL_ELECTRON_ARCHIVE_AND_CURRENT_DIST', version: ELECTRON_VERSION, platform: process.platform, architecture: process.arch,
    assetName: source.assetName, archivePath, archiveSha256: source.archiveSha256, packageRoot: source.packageRoot, ...JSON.parse(result.stdout) };
}
export function verifiedElectronExecution(receiptPath = process.env.MUSIC_BRIDGE_ELECTRON_IDENTITY_RECEIPT) {
  if (!receiptPath) throw new Error('缺少本轮官方Electron身份收据；先运行prepare-electron-identity.mjs。');
  buildStoragePolicy().check(receiptPath, { mustExist: true, kind: 'file' });
  const recorded = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const current = verifyElectronArchive(recorded.archivePath);
  if (JSON.stringify(recorded) !== JSON.stringify(current)) throw new Error('Electron身份收据与当前官方资产/实际运行树不一致。');
  return current;
}
