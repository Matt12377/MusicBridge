import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(repository, 'apps/desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const output = process.env.MBRS009_PRIVATE_EVIDENCE_ROOT;
assert.equal(typeof output === 'string' && path.isAbsolute(output), true, 'SSR必须使用明确私有外置输出根。');
const info = lstatSync(output);
assert.equal(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700, true);
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
  'apps/desktop/src/renderer', 'packages/contracts/src'], {cwd: repository}).toString().split('\0').filter(Boolean).sort()
  .map(file => ({file, sha256: hash(readFileSync(path.join(repository, file)))}));
const startedAtMs = Date.now(), sources = identity();
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vuePlugin } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const { createSSRApp, h } = await import(pathToFileURL(require.resolve('vue')).href);
const { renderToString } = await import(pathToFileURL(require.resolve('vue/server-renderer')).href);
const server = await createServer({
  configFile: false, root: path.join(desktop, 'src/renderer'),
  cacheDir: path.join(process.env.TMPDIR, 'mbrs009-vite-ssr-cache'), plugins: [vuePlugin()],
  server: { middlewareMode: true, ws: false, hmr: false, watch: null }, appType: 'custom', logLevel: 'error',
});
assert.equal(server.httpServer, null, 'SSR不监听HTTP端口。');
assert.equal(server.config.server.ws, false, 'SSR关闭WebSocket通道。');
const outputs = [], oldWindow = globalThis.window;
// 此对象只供组件SSR setup读取；不会启动Main、Scanner或替换普通App中的API。
globalThis.window = {musicBridge: Object.freeze({})};
const id = n => '11111111-1111-4111-8111-' + String(n).padStart(12, '0');
const root = {root: {id: id(1), sourceRootId: id(2), role: 'library', revision: '1'}, label: '009合成只读目录', availability: 'ONLINE'};
const item = n => ({
  track: {id: id(100+n), assetId: id(200+n), selectionRevision: '1', segment: null},
  asset: {id: id(200+n), libraryRootId: id(1), sourceRootId: id(2), rootRevision: '1',
    fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null},
  metadata: {title: n === 0 ? '合成主题 (Live)' : '合成主题 (2020 Remaster)', artist: '合成作者', album: '合成专辑'},
  versionTokens: [],
});
try {
  const { default: LocalLibraryView } = await server.ssrLoadModule('/src/components/library/LocalLibraryView.vue');
  const { useLocalLibrary } = await server.ssrLoadModule('/src/composables/application/useLocalLibrary.ts');
  for (const scene of ['loaded-detail', 'initial-query-failed']) {
    const api = {
      listLocalLibraryRoots: async () => [root], getLocalLibraryPlaybackTarget: async () => null,
      queryLocalLibraryTracks: async request => {
        if (scene === 'initial-query-failed') throw new Error('自建SSR读取故障');
        return {...request, total: 2, hasMore: false, items: [item(0), item(1)]};
      },
      getLocalLibraryTrackDetail: async () => {
        const value = item(0);
        return {track: value.track, asset: value.asset,
          metadata: {raw: value.metadata, override: null, effective: value.metadata},
          editions: [{id: id(300), title: '合成现场发行', edition: 'Live', revision: '1'}], versionTokens: [],
          fileParameters: {container: 'WAVE', codec: 'PCM', sampleRateHz: 44100, channels: 2,
            bitsPerSample: 16, durationMs: 1000, lossless: true, evidence: 'bounded-parser-reported'}};
      },
    };
    const model = useLocalLibrary({api, getSelectedZone: () => undefined,
      play: async () => {throw new Error('SSR不允许派发播放');}});
    try {
      await model.activate();
      if (scene === 'loaded-detail') await model.selectTrack(item(0).track.id);
      const html = await renderToString(createSSRApp({render: () => h(LocalLibraryView, {session: model, playbackState: null})}));
      const visible = html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ');
      assert.match(visible, /本地音乐/u);
      assert.match(visible, /Roon/u);
      assert.match(visible, /尚未选择可用的 Roon/u, '缺可信目标不能显示点播资格。');
      assert.match(visible, /打开原播放队列/u, '沿用原队列入口。');
      if (scene === 'loaded-detail') {
        assert.match(visible, /合成主题 \(Live\)/u);
        assert.match(visible, /合成主题 \(2020 Remaster\)/u);
        assert.match(visible, /原始标签.*显示更正.*生效信息/u);
        assert.match(visible, /扫描解析报告.*WAVE.*44.1 kHz.*16 bit/u);
        assert.match(visible, /Roon 实际输入、处理与输出：未知/u);
        assert.match(html, /aria-rowcount="3"/u, '虚拟表总数需包含表头。');
        assert.match(html, /aria-rowindex="2"/u);
        assert.equal([...html.matchAll(/role="columnheader"/gu)].length, 3, '共享表格需提供歌曲、时长、操作三个逻辑列标题。');
        assert.equal([...html.matchAll(/role="cell"/gu)].length, 6, '两首已加载曲目需各提供三个对应的逻辑单元格。');
        assert.match(html, /aria-label="查看 合成主题 \(Live\) 的版本与文件详情"/u);
      } else {
        assert.match(visible, /未获确认|暂时无法|读取.*失败/u, '首次读取失败必须可见。');
        assert.doesNotMatch(visible, /本地音乐库还没有曲目|没有匹配的曲目/u, '失败不能冒充成功空库。');
        assert.match(html, /role="alert"/u);
      }
      assert.doesNotMatch(visible, /端到端位精确|完整无损|DSD直通/u);
      const file = 'local-library-' + scene + '.html';
      writeFileSync(path.join(output, file), html, {flag: 'wx', mode: 0o600});
      outputs.push({file, bytes: Buffer.byteLength(html), sha256: hash(html),
        assertions: scene === 'loaded-detail' ? 'CURRENT_COMPONENT_SHARED_TABLE_DETAIL_AND_UNKNOWN_TARGET' : 'QUERY_FAILURE_IS_NOT_EMPTY_LIBRARY'});
    } finally {model.dispose();}
  }
} finally {
  await server.close();
  if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
}
const sourceInputsUnchanged = JSON.stringify(sources) === JSON.stringify(identity());
assert.equal(sourceInputsUnchanged, true, 'SSR加载期间源漂移。');
writeFileSync(path.join(output, 'ui-render-receipt.json'), JSON.stringify({
  schema: 'mbrs009.ui-ssr-receipt.v1', startedAtMs, completedAtMs: Date.now(), success: true,
  sourceInputsUnchanged, sourceInputs: sources, outputs,
  layer: 'SYNTHETIC_ACTUAL_VUE_SSR_COMPONENT_RENDER_NOT_ORDINARY_APP_OR_OWNER',
  realRoonAndDevice: 'NOT_RUN', actual100kLoad: 'NOT_RUN',
}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log('009正式本地库组件的列表详情与首次查询故障SSR已验证；普通App、真实Roon与Owner另记。');
