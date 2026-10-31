import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDesktopDevRuntimeLog, teeDesktopRuntimeOutput } from './desktop-dev-runtime-log.mjs';
import { spawn } from 'node:child_process';
import { desktopBuildPaths, prepareDesktopWorkspace } from './desktop-dev-workspace.mjs';
import { desktopDevBuildInputs, planDesktopDevBuild, invalidateDesktopDevBuild, finishDesktopDevBuild } from './desktop-dev-build.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--start', '--build-only', '--rebuild'].includes(arg)) || new Set(args).size !== args.length
  || args.includes('--start') && args.length > 1) throw new Error('开发入口支持 --start、--build-only 和 --rebuild；--start 不能与其他参数组合。');
if (process.versions.node.split('.')[0] !== '22') throw new Error('请先在工作树中执行 nvm use，使用项目固定的 Node 22。');
const paths = desktopBuildPaths(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const lock = path.join(paths.root, 'running.json');
let child;
const run = (command, parameters, options = {}, runtimeLog) => new Promise((resolve, reject) => {
  child = spawn(command, parameters, { cwd: paths.workspace, stdio: 'inherit', ...options });
  const detachOutput = runtimeLog ? teeDesktopRuntimeOutput(child, runtimeLog) : () => {};
  child.once('error', reject);
  child.once('close', (code, signal) => {
    detachOutput();
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
  const syncStarted = performance.now();
  const build = prepareDesktopWorkspace(paths);
  console.log('源码工作树：' + paths.sourceRoot);
  console.log('外置编译副本：' + paths.workspace + '（更新 ' + build.copied + '，移除 ' + build.removed + '，同步 ' + ((performance.now() - syncStarted) / 1000).toFixed(2) + ' 秒）');
  const pnpm = (...parameters) => run('corepack', ['pnpm@10.17.1', ...parameters]);
  let installed = false;
  if (build.state.installedDependenciesHash !== build.state.dependenciesHash || !fs.existsSync(path.join(paths.workspace, 'node_modules/.modules.yaml'))) {
    invalidateDesktopDevBuild(build);
    await pnpm('install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline');
    installed = true;
    build.state.installedDependenciesHash = build.state.dependenciesHash;
    build.save();
  }
  const require = createRequire(path.join(paths.workspace, 'apps/desktop/package.json'));
  const electronRoot = path.dirname(require.resolve('electron'));
  const electronPath = path.join(electronRoot, 'path.txt');
  if (!fs.existsSync(electronPath) || !fs.existsSync(path.join(electronRoot, 'dist', fs.readFileSync(electronPath, 'utf8').trim()))) {
    await run(process.execPath, [path.join(electronRoot, 'install.js')], { env: { ...process.env, electron_config_cache: path.join(paths.policy.root, 'Caches/electron') } });
  }
  const inputs = desktopDevBuildInputs(build);
  const plan = planDesktopDevBuild(build, inputs, { force: installed || args.includes('--rebuild') });
  if (args.includes('--start') && (build.state.builtInputHash !== build.state.inputHash || plan !== 'reuse')) {
    throw new Error('源码、构建环境或产物已有变化，请先执行 corepack pnpm@10.17.1 dev:desktop。');
  }
  if (plan === 'reuse') console.log('开发构建：输入与产物均未变化，复用现有产物。');
  else {
    console.log(plan === 'renderer' ? '开发构建：仅界面发生变化，只构建 Renderer。' : '开发构建：首次构建、输入变化或缓存失效，执行完整构建。');
    // 开始写产物前撤销旧完成声明；失败后不能复用半次构建。
    invalidateDesktopDevBuild(build);
    const buildStarted = performance.now();
    await pnpm('--filter', '@music-bridge/desktop', 'run', plan === 'renderer' ? 'build:dev:renderer' : 'build:dev');
    finishDesktopDevBuild(build, inputs);
    console.log('开发构建完成：' + ((performance.now() - buildStarted) / 1000).toFixed(2) + ' 秒。');
  }
  if (args.includes('--build-only')) {
    await pnpm('--filter', '@music-bridge/desktop', 'exec', 'electron', '--version');
  } else {
    // 构建完成即保存身份，不等 Electron 退出；下次启动可直接复用。
    const runtimeLog = await createDesktopDevRuntimeLog(paths);
    if (runtimeLog.enabled) console.log('开发运行日志（仅资料库闭集事件）：' + runtimeLog.firstFile);
    try {
      await run('corepack', ['pnpm@10.17.1', '--filter', '@music-bridge/desktop', 'run', 'start'],
        runtimeLog.enabled ? { stdio: ['inherit', 'pipe', 'pipe'] } : {}, runtimeLog.enabled ? runtimeLog : undefined);
    } finally { await runtimeLog.close(); }
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
