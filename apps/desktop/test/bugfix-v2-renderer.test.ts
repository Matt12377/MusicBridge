import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const rendererRoot = path.resolve('src/renderer/src')

test('实际音质详情只随曲目或音质身份变化重置，不受 position snapshot 替换影响', async () => {
  const source = await readFile(path.join(rendererRoot, 'components/NowPlayingView.vue'), 'utf8')

  assert.match(source, /playbackQualityIdentity/)
  assert.doesNotMatch(
    source,
    /watch\(\(\)\s*=>\s*\[props\.currentTrack\?\.id,\s*props\.playbackState\?\.actualQuality,\s*props\.playbackState\?\.bitrate\]/u,
  )
})

test('Bottom Player 音质选择复用自定义弹层且不再渲染原生 select', async () => {
  const source = await readFile(path.join(rendererRoot, 'components/BottomPlayer.vue'), 'utf8')

  assert.match(source, /QualityControl/)
  assert.doesNotMatch(source, /<select\b/u)
  assert.match(source, /update:selected-quality/)
})

test('歌词自动跟随按视觉中线容差判定，不再使用 35%-65% safe zone', async () => {
  const source = await readFile(path.join(rendererRoot, 'components/LyricsLines.vue'), 'utf8')

  assert.match(source, /CENTER_TOLERANCE_PX/)
  assert.match(source, /lineVisuallyCentered/)
  assert.doesNotMatch(source, /SAFE_ZONE_(?:START|END)/u)
})

test('歌单单曲播放留在详情页，并保留主动进出 Now Playing 前的双层滚动位置', async () => {
  const app = await readFile(path.join(rendererRoot, 'App.vue'), 'utf8')
  const playStart = app.indexOf('function playPlaylistTrack')
  const playEnd = app.indexOf('function playAllPlaylist', playStart)

  assert.ok(playStart >= 0 && playEnd > playStart)
  assert.doesNotMatch(app.slice(playStart, playEnd), /enterNowPlaying\(\)/)
  assert.match(app, /playlistContentScrollTop/)
  assert.match(app, /v-model:scroll-top="playlistTableScrollTop"/)
})

test('艺术家无图片、请求失败和解码失败在 Renderer 中保持三种安全状态', async () => {
  const source = await readFile(path.join(rendererRoot, 'components/RoonArtwork.vue'), 'utf8')

  assert.match(source, /ROON_IMAGE_UNAVAILABLE/)
  assert.match(source, /暂无封面/)
  assert.match(source, /封面读取失败/)
  assert.match(source, /封面解码失败/)
})
