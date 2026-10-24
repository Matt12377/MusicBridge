import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { desktopBuildPaths, prepareDesktopWorkspace } from '../../desktop-dev-workspace.mjs';
import { desktopDevBuildInputs, planDesktopDevBuild, invalidateDesktopDevBuild, finishDesktopDevBuild } from '../../desktop-dev-build.mjs';

function fixture() {
  const policy = buildStoragePolicy();
  const parent = policy.hosted ? policy.root : policy.check(process.env.TMPDIR, { mustExist: true });
  const source = fs.mkdtempSync(path.join(parent, 'musicbridge-dev-build-test-'));
  const write = (root, name, text) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  execFileSync('git', ['init', '-q', source]);
  write(source, '.gitignore', 'node_modules/\ndist/\n');
  write(source, 'apps/desktop/src/renderer/App.vue', '<template>初始界面</template>');
  write(source, 'apps/desktop/src/main/index.ts', 'export const main = 1;');
  execFileSync('git', ['add', '--', '.'], { cwd: source });
  const paths = desktopBuildPaths(source);
  const build = prepareDesktopWorkspace(paths);
  for (const name of [
    'packages/contracts/dist/index.js', 'packages/contracts/dist/index.d.ts',
    'packages/bridge-core/dist/main.js', 'packages/bridge-core/dist/library/metadata-reader-worker.bundle.mjs',
    'packages/bridge-core/dist/library/metadata-reader-worker.bundle.build.json',
    'apps/desktop/dist/main/index.js', 'apps/desktop/dist/preload/index.cjs',
    'apps/desktop/dist/main/media-worker-build.json',
    `apps/desktop/native/media-worker/${process.platform}-${process.arch}/manifest.json`,
    `apps/desktop/native/media-worker/${process.platform}-${process.arch}/bin/musicbridge-media-worker`,
    'apps/desktop/dist/renderer/index.html', 'apps/desktop/dist/renderer/assets/app.js',
  ]) write(build.workspace, name, '合成构建产物：' + name);
  finishDesktopDevBuild(build, desktopDevBuildInputs(build, {}));
  return {
    source, paths, build,
    writeSource: (name, text) => write(source, name, text),
    writeOutput: (name, text) => write(build.workspace, name, text),
    refresh: () => prepareDesktopWorkspace(paths),
    cleanup() { fs.rmSync(paths.root, { recursive: true }); fs.rmSync(source, { recursive: true }); },
  };
}

test('未改动复用产物；仅修改或删除界面文件时只重建 Renderer', () => {
  const f = fixture();
  try {
    let build = f.refresh();
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'reuse');
    f.writeSource('apps/desktop/src/renderer/App.vue', '<template>已修改界面</template>');
    build = f.refresh();
    assert.equal(build.state.builtInputHash, null);
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'renderer');
    finishDesktopDevBuild(build, desktopDevBuildInputs(build, {}));
    fs.unlinkSync(path.join(f.source, 'apps/desktop/src/renderer/App.vue'));
    build = f.refresh();
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'renderer');
  } finally { f.cleanup(); }
});

test('主进程、原生输入、依赖、配置和构建环境改变时必须完整构建', () => {
  const f = fixture();
  try {
    for (const name of [
      'apps/desktop/src/main/index.ts', 'apps/desktop/native/demo/manifest.json',
      'packages/contracts/src/index.ts', 'pnpm-lock.yaml', 'apps/desktop/electron.vite.config.ts',
    ]) {
      f.writeSource(name, '已修改输入');
      const build = f.refresh();
      assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'full', name);
      finishDesktopDevBuild(build, desktopDevBuildInputs(build, {}));
    }
    const build = f.refresh();
    for (const env of [{ VITE_EXAMPLE: 'changed' }, { MUSIC_BRIDGE_PRIVATE_DESKTOP_ARTWORK_BUILD: 'once' }, { NODE_OPTIONS: '--no-warnings' }]) {
      assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, env)), 'full');
    }
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {}), { force: true }), 'full');
  } finally { f.cleanup(); }
});

test('产物被修改或丢失时不复用；输入复原也不能接受未完成构建', () => {
  const f = fixture();
  try {
    f.writeOutput('apps/desktop/dist/renderer/assets/app.js', '产物被改写');
    let build = f.refresh();
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'full');
    finishDesktopDevBuild(build, desktopDevBuildInputs(build, {}));
    fs.unlinkSync(path.join(build.workspace, 'apps/desktop/dist/preload/index.cjs'));
    build = f.refresh();
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'full');
    assert.throws(() => finishDesktopDevBuild(build, desktopDevBuildInputs(build, {})), /产物不完整/u);
    f.writeOutput('apps/desktop/dist/preload/index.cjs', '合成 Preload');
    finishDesktopDevBuild(build, desktopDevBuildInputs(build, {}));
    invalidateDesktopDevBuild(build);
    f.writeOutput('apps/desktop/dist/renderer/assets/app.js', '中途失败留下的文件');
    build = f.refresh();
    assert.equal(build.state.builtInputHash, null);
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'full');
  } finally { f.cleanup(); }
});

test('构建成功即可保存复用身份；产物符号链接不能取得缓存资格', () => {
  const f = fixture();
  try {
    let build = f.refresh();
    assert.equal(build.state.builtInputHash, build.state.inputHash);
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'reuse');
    const file = path.join(build.workspace, 'apps/desktop/dist/renderer/assets/app.js');
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(build.workspace, 'apps/desktop/dist/main/index.js'), file);
    build = f.refresh();
    assert.equal(planDesktopDevBuild(build, desktopDevBuildInputs(build, {})), 'full');
    assert.throws(() => finishDesktopDevBuild(build, desktopDevBuildInputs(build, {})), /符号链接/u);
  } finally { f.cleanup(); }
});
