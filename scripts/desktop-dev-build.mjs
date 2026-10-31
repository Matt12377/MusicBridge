import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const schema = 'musicbridge.desktop-development-build.v2';
const digest = value => createHash('sha256').update(value).digest('hex');
const outputRoots = ['packages/contracts/dist', 'packages/bridge-core/dist', 'apps/desktop/dist', 'apps/desktop/native/media-worker'];
const requiredOutputs = [
  'packages/contracts/dist/index.js',
  'packages/contracts/dist/index.d.ts',
  'packages/bridge-core/dist/main.js',
  'packages/bridge-core/dist/library/metadata-reader-worker.bundle.mjs',
  'packages/bridge-core/dist/library/metadata-reader-worker.bundle.build.json',
  'apps/desktop/dist/main/index.js',
  'apps/desktop/dist/main/media-worker-build.json',
  `apps/desktop/native/media-worker/${process.platform}-${process.arch}/manifest.json`,
  `apps/desktop/native/media-worker/${process.platform}-${process.arch}/bin/musicbridge-media-worker`,
  'apps/desktop/dist/preload/index.cjs',
  'apps/desktop/dist/renderer/index.html',
];

/** 分别识别界面、桌面端与共享核心输入，复用未变化的构建层。 */
export function desktopDevBuildInputs(build, env = process.env) {
  const environment = Object.keys(env).filter(key => key.startsWith('VITE_') || key.endsWith('_BUILD')
    || key.startsWith('CARGO_PROFILE_')
    || ['NODE_ENV', 'NODE_OPTIONS', 'ESBUILD_BINARY_PATH', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTUP_TOOLCHAIN', 'CARGO_INCREMENTAL'].includes(key)).sort().map(key => [key, env[key]]);
  return {
    inputHash: build.state.inputHash,
    backendInputHash: digest(JSON.stringify(build.inputRows.filter(row => !row.path.startsWith('apps/desktop/src/renderer/')))),
    coreInputHash: digest(JSON.stringify(build.inputRows.filter(row => !row.path.startsWith('apps/desktop/src/')))),
    environmentHash: digest(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, environment })),
  };
}

/** 缓存只认完整产物的内容清单；不以目录存在或 mtime 代替成功构建。 */
export function desktopDevOutputHash(build) {
  const rows = [], files = new Set();
  const visit = name => {
    const file = path.join(build.workspace, name);
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error('开发构建产物不能是符号链接。');
    if (info.isDirectory()) {
      for (const child of fs.readdirSync(file).sort()) visit(name + '/' + child);
    } else if (info.isFile() && info.nlink === 1) {
      files.add(name);
      rows.push({ path: name, sha256: digest(fs.readFileSync(file)), mode: info.mode & 0o777 });
    } else throw new Error('开发构建产物必须是独立普通文件。');
  };
  for (const root of outputRoots) {
    build.policy.check(path.join(build.workspace, root), { mustExist: true });
    visit(root);
  }
  if (!requiredOutputs.every(file => files.has(file))) throw new Error('开发构建产物不完整。');
  return digest(JSON.stringify(rows));
}

export function planDesktopDevBuild(build, inputs, { force = false } = {}) {
  const previous = build.state.developmentBuild;
  if (force || previous?.schema !== schema || previous.environmentHash !== inputs.environmentHash) return 'full';
  try {
    if (previous.outputHash !== desktopDevOutputHash(build)) return 'full';
  } catch {
    return 'full';
  }
  if (previous.inputHash === inputs.inputHash) return 'reuse';
  if (previous.backendInputHash === inputs.backendInputHash) return 'renderer';
  return previous.coreInputHash === inputs.coreInputHash ? 'desktop' : 'full';
}

export function invalidateDesktopDevBuild(build) {
  build.state.builtInputHash = null;
  build.state.developmentBuild = null;
  build.save();
}

export function finishDesktopDevBuild(build, inputs) {
  build.state.developmentBuild = { schema, ...inputs, outputHash: desktopDevOutputHash(build) };
  build.state.builtInputHash = build.state.inputHash;
  build.save();
}
