import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildStoragePolicy } from '../apps/desktop/scripts/build-storage-root.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (file, root) => file.startsWith(root + path.sep);
const schema = 'musicbridge.desktop-development-workspace.v1';

export function desktopBuildPaths(sourceRoot) {
  sourceRoot = fs.realpathSync(sourceRoot);
  const policy = buildStoragePolicy();
  const parent = policy.hosted ? policy.root : path.join(policy.root, 'worktrees');
  const root = policy.check(path.join(parent, 'musicbridge-dev-' + digest(sourceRoot).slice(0, 12)));
  if (root === sourceRoot || inside(root, sourceRoot) || inside(sourceRoot, root)) throw new Error('源码与编译副本不能相互包含。');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  policy.check(root, { mustExist: true });
  return { sourceRoot, root, workspace: path.join(root, 'workspace'), stateFile: path.join(root, 'state.json'), policy };
}

function relativeFile(name) {
  if (!name || path.isAbsolute(name) || path.normalize(name) !== name || name === '..' || name.startsWith('../')
    || name.split('/').some(part => ['.git', 'node_modules', 'dist', 'release'].includes(part))) throw new Error('编译输入路径越界。');
  return name;
}

export function prepareDesktopWorkspace(paths) {
  const { sourceRoot, workspace, stateFile, policy } = paths;
  const gitRoot = fs.realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: sourceRoot, encoding: 'utf8' }).trim());
  if (gitRoot !== sourceRoot) throw new Error('开发入口必须来自工作树根目录。');
  const names = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: sourceRoot, encoding: 'utf8' })
    .split('\0').filter(Boolean).filter(name => !name.split('/').some(part => ['.git', 'node_modules', 'dist', 'release'].includes(part))));
  // 原生分发资源是既有本机构建输入；不把其他被忽略的用户资料或凭据复制进来。
  const collectNative = directory => {
    const info = fs.lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error('原生编译输入不能是符号链接。');
    if (info.isDirectory()) for (const name of fs.readdirSync(directory)) collectNative(path.join(directory, name));
    else if (info.isFile()) names.add(path.relative(sourceRoot, directory));
    else throw new Error('原生编译输入必须是普通文件。');
  };
  const native = path.join(sourceRoot, 'apps/desktop/native');
  if (fs.existsSync(native)) collectNative(native);
  policy.check(workspace);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  let previous = { paths: [], builtInputHash: null, installedDependenciesHash: null };
  if (fs.existsSync(stateFile)) {
    policy.check(stateFile, { mustExist: true, kind: 'file' });
    previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (previous.schema !== schema || previous.sourceRoot !== sourceRoot || !Array.isArray(previous.paths)) throw new Error('编译副本记录身份不匹配。');
  }
  const rows = [];
  let copied = 0, removed = 0;
  for (const name of [...names].sort()) {
    relativeFile(name);
    const source = path.join(sourceRoot, name);
    const info = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!info) continue; // Git 中已跟踪、当前尚未提交的删除，也必须同步到副本。
    if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(source) !== source) throw new Error('编译输入必须具有真实普通文件身份：' + name);
    const bytes = fs.readFileSync(source), sha256 = digest(bytes), mode = info.mode & 0o777;
    const target = policy.check(path.join(workspace, name), { kind: 'file' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('编译副本不能覆盖链接或非普通文件。');
    if (!existing || digest(fs.readFileSync(target)) !== sha256 || (existing.mode & 0o777) !== mode) {
      fs.writeFileSync(target, bytes, { mode });
      fs.chmodSync(target, mode);
      copied++;
    }
    rows.push({ path: name, sha256, mode });
  }
  const current = new Set(rows.map(row => row.path));
  // 只移除上次清单拥有、这次源码明确已删除的副本文件；不清理未知文件。
  for (const name of previous.paths) if (!current.has(relativeFile(name))) {
    const target = policy.check(path.join(workspace, name), { kind: 'file' });
    if (fs.existsSync(target)) { fs.unlinkSync(target); removed++; }
  }
  const buildInputs = rows.filter(row => /^(?:apps|packages|native|scripts|patches)\//u.test(row.path)
    || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.nvmrc'].includes(row.path));
  const dependencyInputs = rows.filter(row => /(?:^|\/)package\.json$/u.test(row.path)
    || ['pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(row.path) || row.path.startsWith('patches/'));
  const inputHash = digest(JSON.stringify(buildInputs));
  const state = { ...previous, schema, sourceRoot, paths: rows.map(row => row.path), inputHash,
    builtInputHash: previous.inputHash === inputHash ? previous.builtInputHash : null,
    dependenciesHash: digest(JSON.stringify(dependencyInputs)) };
  const save = () => {
    const temp = policy.check(stateFile + '.new-' + process.pid, { kind: 'file' });
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, stateFile);
  };
  save();
  return { ...paths, state, save, copied, removed };
}
