import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { desktopBuildPaths, prepareDesktopWorkspace } from '../../desktop-dev-workspace.mjs';

function fixture() {
  const policy = buildStoragePolicy();
  const parent = policy.hosted ? policy.root : policy.check(process.env.TMPDIR, { mustExist: true });
  const source = fs.mkdtempSync(path.join(parent, 'musicbridge-dev-workspace-test-'));
  execFileSync('git', ['init', '-q', source]);
  fs.writeFileSync(path.join(source, '.gitignore'), '.env\nnode_modules/\ndist/\napps/desktop/native/\n');
  fs.mkdirSync(path.join(source, 'packages/sample/src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'packages/sample/src/source.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', '--', '.gitignore', 'packages/sample/src/source.ts'], { cwd: source });
  const paths = desktopBuildPaths(source);
  return { source, paths, cleanup() { fs.rmSync(paths.root, { recursive: true }); fs.rmSync(source, { recursive: true }); } };
}

test('开发副本复用相同输入，采用未提交修改，删除仅限原清单且不复制凭据或旧产物', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.source, '.env'), 'SYNTHETIC_ONLY=private-test-value\n');
    fs.mkdirSync(path.join(f.source, 'dist')); fs.writeFileSync(path.join(f.source, 'dist/stale.js'), '旧产物');
    fs.mkdirSync(path.join(f.source, 'apps/desktop/native/demo'), { recursive: true });
    fs.writeFileSync(path.join(f.source, 'apps/desktop/native/demo/resource.bin'), '合成原生资源');
    const first = prepareDesktopWorkspace(f.paths);
    first.state.builtInputHash = first.state.inputHash; first.save();
    assert.equal(fs.readFileSync(path.join(first.workspace, 'packages/sample/src/source.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal(fs.existsSync(path.join(first.workspace, '.env')), false);
    assert.equal(fs.existsSync(path.join(first.workspace, 'dist/stale.js')), false);
    assert.equal(fs.readFileSync(path.join(first.workspace, 'apps/desktop/native/demo/resource.bin'), 'utf8'), '合成原生资源');
    assert.equal(prepareDesktopWorkspace(f.paths).copied, 0);
    fs.writeFileSync(path.join(first.workspace, 'generated-preserve.txt'), '保留未知副本文件');
    fs.writeFileSync(path.join(f.source, 'packages/sample/src/uncommitted.ts'), 'export const value = 2;\n');
    fs.unlinkSync(path.join(f.source, 'packages/sample/src/source.ts'));
    const updated = prepareDesktopWorkspace(f.paths);
    assert.equal(updated.removed, 1);
    assert.equal(fs.existsSync(path.join(updated.workspace, 'packages/sample/src/source.ts')), false);
    assert.equal(fs.readFileSync(path.join(updated.workspace, 'packages/sample/src/uncommitted.ts'), 'utf8'), 'export const value = 2;\n');
    assert.equal(fs.readFileSync(path.join(updated.workspace, 'generated-preserve.txt'), 'utf8'), '保留未知副本文件');
    assert.notEqual(updated.state.inputHash, first.state.inputHash);
    assert.equal(updated.state.builtInputHash, null);
    fs.unlinkSync(path.join(f.source, 'packages/sample/src/uncommitted.ts'));
    fs.writeFileSync(path.join(f.source, 'packages/sample/src/source.ts'), 'export const value = 1;\n');
    const reverted = prepareDesktopWorkspace(f.paths);
    assert.equal(reverted.state.inputHash, first.state.inputHash);
    assert.equal(reverted.state.builtInputHash, null);
  } finally { f.cleanup(); }
});

test('开发副本拒绝符号链接输入和输出，不覆盖链接指向的外部文件', () => {
  const f = fixture();
  try {
    const outside = path.join(f.source, '.env'); fs.writeFileSync(outside, '合成私密输入');
    const link = path.join(f.source, 'escape.ts'); fs.symlinkSync(outside, link);
    assert.throws(() => prepareDesktopWorkspace(f.paths), /真实普通文件/u);
    fs.unlinkSync(link);
    const target = path.join(f.paths.workspace, 'packages/sample/src/source.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.symlinkSync(outside, target);
    assert.throws(() => prepareDesktopWorkspace(f.paths), /真实身份越界|链接/u);
    assert.equal(fs.readFileSync(outside, 'utf8'), '合成私密输入');
  } finally { f.cleanup(); }
});

test('不同源码工作树的开发副本保持隔离', () => {
  const a = fixture(), b = fixture();
  try {
    fs.writeFileSync(path.join(b.source, 'packages/sample/src/source.ts'), 'export const other = 42;\n');
    const aa = prepareDesktopWorkspace(a.paths), bb = prepareDesktopWorkspace(b.paths);
    assert.notEqual(aa.workspace, bb.workspace);
    assert.notEqual(aa.state.inputHash, bb.state.inputHash);
    assert.equal(fs.readFileSync(path.join(aa.workspace, 'packages/sample/src/source.ts'), 'utf8'), 'export const value = 1;\n');
    assert.equal(fs.readFileSync(path.join(bb.workspace, 'packages/sample/src/source.ts'), 'utf8'), 'export const other = 42;\n');
  } finally { a.cleanup(); b.cleanup(); }
});
