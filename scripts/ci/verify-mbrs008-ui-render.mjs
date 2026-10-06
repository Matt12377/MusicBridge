import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(repository, 'apps/desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const output = process.env.MBRS008_PRIVATE_EVIDENCE_ROOT;
assert.equal(typeof output === 'string' && path.isAbsolute(output), true, 'SSR必须使用明确私有外置输出根。');
const info = lstatSync(output);
assert.equal(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700, true);
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps/desktop/src/renderer', 'packages/contracts/src'], {cwd: repository}).toString().split('\0').filter(Boolean).sort().map(file => ({file, sha256: hash(readFileSync(path.join(repository, file)))}));
const startedAtMs = Date.now(), sources = identity();
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vuePlugin } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const { createSSRApp, h } = await import(pathToFileURL(require.resolve('vue')).href);
const { renderToString } = await import(pathToFileURL(require.resolve('vue/server-renderer')).href);
const server = await createServer({
  configFile: false,
  root: path.join(desktop, 'src/renderer'),
  cacheDir: path.join(process.env.TMPDIR, 'mbrs008-vite-ssr-cache'),
  plugins: [vuePlugin()],
  server: { middlewareMode: true, ws: false, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
});
assert.equal(server.httpServer, null, 'SSR不监听HTTP端口。');
assert.equal(server.config.server.ws, false, 'SSR关闭WebSocket通道。');
const outputs = [];
try {
  const { default: NowPlaying } = await server.ssrLoadModule('/src/components/NowPlayingView.vue');
  const id = randomUUID();
  for (const scene of ['known-file', 'unknown-file']) {
    const track = {id, title: '008合成界面样本', artists: ['软件验证'], album: '私有证据', durationMs: 10000};
    const local = {
      schema_version: '1.2', request_id: randomUUID(), attempt_id: randomUUID(), intent_generation: '1',
      route: 'roon_audio_input', local_track_id: id, asset_id: randomUUID(), asset_revision: '1',
      target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' }, session_epoch: 'synthetic-session',
      phase: 'PLAYING', ownership: 'MB_OWNED', queue_owner: 'MB', delivery_state: 'BYTES_SENT',
      roon_observation: {event: 'PLAYING', observed: true, correlation: 'ATTEMPT_CONFIRMED'}, position_ms: 0,
      quality: {http_bytes: 'NOT_TESTED', signal_path: 'NOT_TESTED', digital_output: 'NOT_TESTED', gapless: 'NOT_TESTED'}, error_code: null,
      ...(scene === 'known-file' ? {file_parameters: {container: 'FLAC', codec: 'FLAC', lossless: true, sampleRateHz: 96000, channels: 2, bitsPerSample: 24, durationMs: 10000, evidence: 'bounded-parser-reported'}} : {}),
    };
    const playbackState = {
      state: 'playing', source: 'local_file', local, currentTrack: track,
      queue: {items: [{trackId: id, qualityPreference: 'auto'}], index: 0, hasNext: false, hasPrevious: false},
      positionMs: 0, format: 'flac', actualQuality: 'unknown', qualityPreference: 'auto',
      selectedZoneId: 'synthetic-zone', canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false,
    };
    const html = await renderToString(createSSRApp({render: () => h(NowPlaying, {
      currentTrack: track, playbackState, lyricsSnapshot: {state: 'idle', lines: []},
      qualityLabel: () => '音质未知', playbackIssueMessage: () => '', trackLikeState: 'idle', trackLikeAvailable: false,
      playbackSource: 'local_file', seekAllowed: true, localLyricsMatchState: {status: 'hidden'},
    })}));
    const visible = html.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ');
    assert.match(visible, /本地(?:音乐|文件)/u, '本地来源必须有准确标签。');
    assert.doesNotMatch(visible, /网易云/u, '本地来源不能沿用云来源标签。');
    assert.match(visible, /Roon.{0,24}(?:输出|音质).{0,24}(?:未知|未测)/u, '缺真实Roon观测必须明确未知。');
    if (scene === 'known-file') {
      assert.match(visible, /FLAC/u);
      assert.match(visible, /24\s*(?:bit|位)/u);
      assert.match(visible, /96\s*kHz/u);
      assert.match(visible, /解析/u, '参数需要明确解析报告来源。');
    } else assert.match(visible, /文件.{0,16}(?:未知|未测)/u, '缺文件解析事实必须明确未知。');
    assert.doesNotMatch(visible, /端到端位精确|完整无损|DSD直通/u);
    const file = 'now-playing-' + scene + '.html';
    writeFileSync(path.join(output, file), html, {flag: 'wx', mode: 0o600});
    outputs.push({file, bytes: Buffer.byteLength(html), sha256: hash(html), assertions: 'LOCAL_SOURCE_FILE_PARAMETERS_AND_ROON_OUTPUT_UNKNOWN_SEPARATE'});
  }
} finally { await server.close(); }
const sourceInputsUnchanged = JSON.stringify(sources) === JSON.stringify(identity());
assert.equal(sourceInputsUnchanged, true, 'SSR加载期间源漂移。');
writeFileSync(path.join(output, 'ui-render-receipt.json'), JSON.stringify({
  schema: 'mbrs008.ui-ssr-receipt.v1', startedAtMs, completedAtMs: Date.now(), success: true,
  sourceInputsUnchanged, sourceInputs: sources, outputs,
  layer: 'SYNTHETIC_ACTUAL_VUE_SSR_COMPONENT_RENDER_NOT_ORDINARY_APP_OR_OWNER',
  realRoonAndDevice: 'NOT_RUN',
}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log('008原NowPlaying组件两种文件证据状态SSR已验证；真实App/Roon/Owner未执行。');
