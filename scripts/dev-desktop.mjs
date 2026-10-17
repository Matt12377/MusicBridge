import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { desktopBuildPaths, prepareDesktopWorkspace } from './desktop-dev-workspace.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--start', '--build-only'].includes(arg)) || args.length > 1) throw new Error('开发入口仅支持 --start 或 --build-only。');
if (process.versions.node.split('.')[0] !== '22') throw new Error('请先在工作树中执行 nvm use，使用项目固定的 Node 22。');
const paths = desktopBuildPaths(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const lock = path.join(paths.root, 'running.json');
let child;
const run = (command, parameters, options = {}) => new Promise((resolve, reject) => {
  child = spawn(command, parameters, { cwd: paths.workspace, stdio: 'inherit', ...options });
  child.once('error', reject);
  child.once('close', (code, signal) => {
    child = null;
    if (code === 0 && signal === null) resolve();
    else reject(new Error('开发命令未正常完成：' + command + '，退出码 ' + code + (signal ? '，信号 ' + signal : '')));
  });
});
const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
  if (child) child.kill(signal);
  else process.exitCode = signal === 'SIGINT' ? 130 : 143;
}]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
let ownsLock = false;
try {
  if (fs.existsSync(lock)) {
    paths.policy.check(lock, { mustExist: true, kind: 'file' });
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (owner.sourceRoot !== paths.sourceRoot || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('开发进程锁身份不匹配。');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('此工作树已有开发命令运行，请先正常结束原命令。');
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, JSON.stringify({ sourceRoot: paths.sourceRoot, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  ownsLock = true;
  const build = prepareDesktopWorkspace(paths);
  console.log('源码工作树：' + paths.sourceRoot);
  console.log('外置编译副本：' + paths.workspace + '（更新 ' + build.copied + '，移除 ' + build.removed + '）');
  const pnpm = (...parameters) => run('corepack', ['pnpm@10.17.1', ...parameters]);
  if (!args.includes('--start')) {
    // 开始重建就撤销旧完成声明，失败后不能启动部分更新的产物。
    build.state.builtInputHash = null;
    build.save();
  }
  if (build.state.installedDependenciesHash !== build.state.dependenciesHash || !fs.existsSync(path.join(paths.workspace, 'node_modules/.modules.yaml'))) {
    await pnpm('install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline');
    build.state.installedDependenciesHash = build.state.dependenciesHash;
    build.save();
  }
  const require = createRequire(path.join(paths.workspace, 'apps/desktop/package.json'));
  const electronRoot = path.dirname(require.resolve('electron'));
  const electronPath = path.join(electronRoot, 'path.txt');
  if (!fs.existsSync(electronPath) || !fs.existsSync(path.join(electronRoot, 'dist', fs.readFileSync(electronPath, 'utf8').trim()))) {
    await run(process.execPath, [path.join(electronRoot, 'install.js')], { env: { ...process.env, ELECTRON_CACHE: path.join(paths.policy.root, 'Caches/electron') } });
  }
  if (args.includes('--start')) {
    if (build.state.builtInputHash !== build.state.inputHash) throw new Error('源码已有变化，请先执行 corepack pnpm@10.17.1 dev:desktop。');
    await pnpm('--filter', '@music-bridge/desktop', 'run', 'start');
  } else if (args.includes('--build-only')) {
    const script = JSON.parse(fs.readFileSync(path.join(paths.workspace, 'apps/desktop/package.json'), 'utf8')).scripts.dev.split(' && ');
    if (script.pop() !== 'electron dist/main/index.js') throw new Error('桌面开发脚本结构已变更，请同步构建入口。');
    await pnpm('--filter', '@music-bridge/desktop', 'exec', '/bin/sh', '-c', script.join(' && '));
    await pnpm('--filter', '@music-bridge/desktop', 'exec', 'electron', '--version');
    build.state.builtInputHash = build.state.inputHash;
    build.save();
  } else {
    await pnpm('--filter', '@music-bridge/desktop', 'run', 'dev');
    build.state.builtInputHash = build.state.inputHash;
    build.save();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (ownsLock) {
    try { fs.unlinkSync(lock); }
    catch (error) { console.error('开发进程锁收尾失败：' + error.message); process.exitCode = 1; }
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
