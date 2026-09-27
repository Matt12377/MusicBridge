import { createRequire } from 'node:module'
import { RECORDING_PRINT_GEOMETRY, type RecordingPrintCustomDesign, type RecordingPrintCustomGeometry, type RecordingPrintFacts, type RecordingPrintLease } from '@music-bridge/contracts'

/** 自制JP0排版；尺寸来自冻结几何，不包含制造商模板图文。 */
const g = RECORDING_PRINT_GEOMETRY
const outerSpineEnd = g.flapMm + g.spineMm
const insideTrackWidth = g.coverMm - 6
const style = `
@page { size:${g.widthMm}mm ${g.heightMm}mm; margin:0 }
* { box-sizing:border-box }
html,body { margin:0; padding:0; background:white; color:#172323; font-family:"PingFang SC","Noto Sans CJK SC","Heiti SC",sans-serif; font-size:8.5pt; -webkit-print-color-adjust:exact; print-color-adjust:exact }
@media screen { html,body { overflow:auto } }
.sheet { position:relative; width:${g.widthMm}mm; height:${g.heightMm}mm; break-after:page; page-break-after:always }
.sheet:last-child { break-after:auto; page-break-after:auto }
.fold { position:absolute; top:0; bottom:0; border-left:0.15mm dashed #b1bab7; pointer-events:none }
.outer .fold-one { left:${g.flapMm}mm }.outer .fold-two { left:${outerSpineEnd}mm }
.inner .fold-one { left:${g.insideFoldMm[0]}mm }.inner .fold-two { left:${g.insideFoldMm[1]}mm }
.flap { position:absolute; left:0; top:0; width:${g.flapMm}mm; height:${g.heightMm}mm; padding:3mm 2.5mm; display:flex; flex-direction:column; gap:3mm; overflow-wrap:anywhere }
.label { font-size:7.5pt; line-height:1.3; color:#455852 }
.identifier { font-size:7.5pt; line-height:1.45; overflow-wrap:anywhere; font-variant-numeric:tabular-nums }
.flap h2 { margin:0; font-size:10pt; line-height:1.35 }.flap p { margin:0 }
.footnote { margin-top:auto!important; font-size:7.5pt; line-height:1.35 }
.spine { position:absolute; top:0; left:${g.flapMm}mm; width:${g.spineMm}mm; height:${g.heightMm}mm }
.spine-text { position:absolute; width:95.6mm; height:7.7mm; top:46.95mm; left:-41.45mm; transform:rotate(90deg); font-size:10pt; font-weight:600; line-height:1.2; overflow-wrap:anywhere; text-align:center }
.cover { position:absolute; left:${outerSpineEnd}mm; top:0; width:${g.coverMm}mm; height:${g.heightMm}mm; padding:3mm; display:flex; flex-direction:column; gap:2mm }
.cover-title { height:27mm; flex:none; font-size:15pt; line-height:1.2; font-weight:600; overflow-wrap:anywhere }
.artwork { height:38mm; flex:none; display:flex; align-items:center; justify-content:center; background:#f1f4f2 }
.artwork img { display:block; width:100%; height:100%; object-fit:contain }
.artwork-missing { padding:4mm; font-size:9pt; line-height:1.5; text-align:center; color:#4b5c56 }
.cover-model { height:17mm; flex:none; font-size:8.5pt; line-height:1.35; overflow-wrap:anywhere }
.cover-date { font-size:7.5pt; line-height:1.35; font-variant-numeric:tabular-nums }
.track-area { position:absolute; top:3mm; left:3mm; width:${insideTrackWidth}mm; height:${g.heightMm-10}mm; display:flex; flex-direction:column }
.side-heading { margin:0 0 2mm; flex:none; font-size:11pt; font-weight:600; line-height:1.35 }
.side-duration { display:block; font-size:7.5pt; font-weight:400; line-height:1.4; margin-top:1mm }
.flow { flex:1; min-height:0 }
.track { padding:0 0 1.5mm; font-size:8.5pt; line-height:1.35; overflow-wrap:anywhere; break-inside:avoid }
.track-title { font-weight:500 }.track-artist { color:#455852; font-size:7.5pt; line-height:1.35 }
.empty-side { font-size:9pt; line-height:1.5 }
.inner .spine { left:${g.insideFoldMm[0]}mm }.inner .spine-text { font-size:8.5pt; font-weight:400 }
.inner .flap { left:${g.insideFoldMm[1]}mm }
.folio { position:absolute; left:3mm; bottom:2mm; font-size:7.5pt; line-height:1.2; color:#455852 }
`
const escape = (value: string) => value.replace(/[&<>"']/gu, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]!)
const duration = (milliseconds: number) => { const seconds = Math.floor(milliseconds / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}` }
function tapeModel(lease: RecordingPrintLease): string {
  if (lease.facts.tapeModel.state === 'unknown') return '历史型号未知'
  const d = lease.facts.tapeModel.descriptor
  return `${d.brand || '品牌未知'} / ${d.name || '型号未知'}${d.edition ? ` / ${d.edition}` : ''}${d.year === null ? '' : ` / ${d.year}`}`
}
function legacyRecordingPrintHtml(lease: RecordingPrintLease): string {
  const f = lease.facts
  const ids = `<p class="label">实体编号</p><p class="identifier">${escape(f.physicalId)}</p><p class="label">录音档案编号</p><p class="identifier">${escape(f.recordingId)}</p>`
  const folds = '<i class="fold fold-one"></i><i class="fold fold-two"></i>'
  const image = lease.artworkImage ? `<img alt="该次录音归档Artwork" src="${escape(lease.artworkImage.dataUrl)}">` : '<div class="artwork-missing">历史 Artwork 未提供<br>不使用当前图片替代</div>'
  const sources = f.sides.map(side => `<section class="source-side"><h2 class="side-heading">${side.side} 面<span class="side-duration">实际整面时长 ${duration(side.durationMs)}</span></h2>${side.tracks.length ? side.tracks.map(track => `<div class="track"><div class="track-title">${track.position}. ${escape(track.title)}</div>${track.artist === undefined ? '' : `<div class="track-artist">${escape(track.artist)}</div>`}</div>`).join('') : `<div class="track empty-side">${side.side} 面未使用</div>`}</section>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><title>历史录音 J-Card</title><style>${style}</style></head><body><main id="pages"><section class="sheet outer">${folds}<aside class="flap"><h2>历史录音</h2>${ids}<p class="label">${escape(f.displayDateUtc)} UTC</p><p class="footnote">JP0 基础版<br>${g.widthMm} × ${g.heightMm} mm<br>按实际大小 100% 打印<br>生成文件不等于已打印</p></aside><div class="spine"><div class="spine-text fit-spine">${escape(lease.design?.spineText??f.spine)}</div></div><div class="cover"><div class="cover-title fit-title">${escape(lease.design?.coverTitle??f.title)}</div><div class="artwork">${image}</div><div class="cover-model fit-model">${escape(tapeModel(lease))}</div><div class="cover-date">完成日期 ${escape(f.displayDateUtc)} UTC</div></div></section></main><template id="inner-template"><section class="sheet inner">${folds}<div class="track-area"><div class="heading-slot"></div><div class="flow"></div></div><div class="spine"><div class="spine-text">${escape(f.physicalId)} / 曲目续页</div></div><aside class="flap">${ids}<p class="footnote">历史曲序与实际整面时长<br>逐曲时长未作推断<br>本页为独立续页</p></aside><div class="folio"></div></section></template><div id="track-source" hidden>${sources}</div></body></html>`
}

/** 仅冻结的录音短身份和整面技术摘要；QR 不含路径、URL 或联网动作。 */
export function recordingPrintQrPayload(facts: RecordingPrintFacts): string {
  return `MBJC1;P=${facts.physicalId};R=${facts.recordingId.slice(0, 12)};A=${facts.sides[0]!.frameCount}@${facts.sides[0]!.sampleRate};B=${facts.sides[1]!.frameCount}@${facts.sides[1]!.sampleRate}`
}
function qrSvg(facts: RecordingPrintFacts): string {
  const qrCode = createRequire(import.meta.url)('qrcode') as { create(value: string, options: { errorCorrectionLevel: 'M' }): { modules: { size: number; get(row: number, column: number): boolean } } }
  const modules = qrCode.create(recordingPrintQrPayload(facts), { errorCorrectionLevel: 'M' }).modules
  const cells: string[] = []
  for (let row = 0; row < modules.size; row++) for (let column = 0; column < modules.size; column++) if (modules.get(row, column)) cells.push(`M${column + 4} ${row + 4}h1v1h-1z`)
  const extent = modules.size + 8
  return `<svg role="img" aria-label="冻结录音技术摘要二维码" viewBox="0 0 ${extent} ${extent}" xmlns="http://www.w3.org/2000/svg"><rect width="${extent}" height="${extent}" fill="white"/><path d="${cells.join('')}" fill="#172323"/></svg>`
}
function customStyle(g: RecordingPrintCustomGeometry): string {
  const spineEnd = g.flapMm + g.spineMm, spineTextWidth = g.heightMm - 6, spineTextHeight = g.spineMm - 5
  return `
@page { size:${g.widthMm}mm ${g.heightMm}mm; margin:0 }
* { box-sizing:border-box }
html,body { margin:0; padding:0; background:white; color:#172323; font-family:"PingFang SC","Noto Sans CJK SC","Heiti SC",sans-serif; font-size:8.5pt; -webkit-print-color-adjust:exact; print-color-adjust:exact }
@media screen { html,body { overflow:auto } }
.sheet { position:relative; width:${g.widthMm}mm; height:${g.heightMm}mm; break-after:page; page-break-after:always }
.sheet:last-child { break-after:auto; page-break-after:auto }
.sheet::before { content:""; position:absolute; inset:0.5mm; border:0.12mm solid #a6b3ad; pointer-events:none }
.fold { position:absolute; top:0.5mm; bottom:0.5mm; border-left:0.15mm dashed #7a9187; pointer-events:none }
.outer .fold-one { left:${g.flapMm}mm }.outer .fold-two { left:${spineEnd}mm }
.inner .fold-one { left:${g.insideFoldMm[0]}mm }.inner .fold-two { left:${g.insideFoldMm[1]}mm }
.flap { position:absolute; left:0; top:0; width:${g.flapMm}mm; height:${g.heightMm}mm; padding:3mm 2.5mm; display:flex; flex-direction:column; gap:2mm; overflow-wrap:anywhere }
.label { font-size:7.5pt; line-height:1.3; color:#455852 }
.identifier { font-size:7.5pt; line-height:1.45; overflow-wrap:anywhere; font-variant-numeric:tabular-nums }
.flap h2 { margin:0; font-size:10pt; line-height:1.35 }.flap p { margin:0 }
.footnote { margin-top:auto!important; font-size:7.5pt; line-height:1.3 }
.calibration { font-size:6.5pt; line-height:1.2; white-space:nowrap }
.calibration::before { content:""; display:block; width:10mm; border-top:0.25mm solid #172323; margin-bottom:0.7mm }
.spine { position:absolute; top:0; left:${g.flapMm}mm; width:${g.spineMm}mm; height:${g.heightMm}mm }
.spine-text { position:absolute; width:${spineTextWidth}mm; height:${spineTextHeight}mm; top:${(g.heightMm-spineTextHeight)/2}mm; left:${(g.spineMm-spineTextWidth)/2}mm; transform:rotate(90deg); font-size:10pt; font-weight:600; line-height:1.2; overflow-wrap:anywhere; text-align:center }
.cover { position:absolute; left:${spineEnd}mm; top:0; width:${g.coverMm}mm; height:${g.heightMm}mm; padding:3mm; display:flex; flex-direction:column; gap:2mm }
.cover-title { height:${Math.min(27,g.heightMm*0.26)}mm; flex:none; font-size:15pt; line-height:1.2; font-weight:600; overflow-wrap:anywhere }
.artwork { position:relative; height:${Math.min(38,g.heightMm*0.36)}mm; flex:none; display:flex; align-items:center; justify-content:center; background:#f1f4f2 }
.artwork img { display:block; width:100%; height:100%; object-fit:contain }
.artwork-missing { padding:4mm; font-size:9pt; line-height:1.5; text-align:center; color:#4b5c56 }
.qr { position:absolute; right:1mm; bottom:1mm; width:14mm; height:14mm; background:white }.qr svg { display:block; width:100%; height:100% }
.cover-model { height:${Math.min(17,g.heightMm*0.17)}mm; flex:none; font-size:8.5pt; line-height:1.35; overflow-wrap:anywhere }
.cover-date { font-size:7.5pt; line-height:1.35; font-variant-numeric:tabular-nums }
.track-area { position:absolute; top:3mm; left:3mm; width:${g.coverMm-6}mm; height:${g.heightMm-10}mm; display:flex; flex-direction:column }
.side-heading { margin:0 0 2mm; flex:none; font-size:11pt; font-weight:600; line-height:1.35 }
.side-duration { display:block; font-size:7.5pt; font-weight:400; line-height:1.4; margin-top:1mm }
.flow { flex:1; min-height:0 }
.track { padding:0 0 1.5mm; font-size:8.5pt; line-height:1.35; overflow-wrap:anywhere; break-inside:avoid }
.track-title { font-weight:500 }.track-artist { color:#455852; font-size:7.5pt; line-height:1.35 }
.empty-side { font-size:9pt; line-height:1.5 }
.inner .spine { left:${g.insideFoldMm[0]}mm }.inner .spine-text { font-size:8.5pt; font-weight:400 }
.inner .flap { left:${g.insideFoldMm[1]}mm }
.folio { position:absolute; left:3mm; bottom:2mm; font-size:7.5pt; line-height:1.2; color:#455852 }
`
}
function customRecordingPrintHtml(lease: RecordingPrintLease & { design: RecordingPrintCustomDesign }): string {
  const f = lease.facts, g = lease.design.geometry
  const ids = `<p class="label">实体编号</p><p class="identifier">${escape(f.physicalId)}</p><p class="label">录音档案编号</p><p class="identifier">${escape(f.recordingId)}</p>`
  const folds = '<i class="fold fold-one"></i><i class="fold fold-two"></i>'
  const selected = lease.design.image.source === 'selected-image' ? lease.designImage : lease.artworkImage
  const image = selected ? `<img alt="本次印刷设计图片" src="${escape(selected.dataUrl)}">` : '<div class="artwork-missing">历史 Artwork 未提供<br>不使用当前图片替代</div>'
  const qr = lease.design.qr === 'recording-summary' ? `<div class="qr">${qrSvg(f)}</div>` : ''
  const sources = f.sides.map(side => `<section class="source-side"><h2 class="side-heading">${side.side} 面<span class="side-duration">实际整面时长 ${duration(side.durationMs)}</span></h2>${side.tracks.length ? side.tracks.map(track => `<div class="track"><div class="track-title">${track.position}. ${escape(track.title)}</div>${track.artist === undefined ? '' : `<div class="track-artist">${escape(track.artist)}</div>`}</div>`).join('') : `<div class="track empty-side">${side.side} 面未使用</div>`}</section>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><title>历史录音 J-Card</title><style>${customStyle(g)}</style></head><body><main id="pages"><section class="sheet outer">${folds}<aside class="flap"><h2>历史录音</h2>${ids}<p class="label">${escape(f.displayDateUtc)} UTC</p><p class="footnote">用户自定义尺寸<br>${g.widthMm} × ${g.heightMm} mm<br>按实际大小 100% 打印<br>生成文件不等于已打印</p><p class="calibration">10 mm 校验线</p></aside><div class="spine"><div class="spine-text fit-spine">${escape(lease.design.spineText)}</div></div><div class="cover"><div class="cover-title fit-title">${escape(lease.design.coverTitle)}</div><div class="artwork">${image}${qr}</div><div class="cover-model fit-model">${escape(tapeModel(lease))}</div><div class="cover-date">完成日期 ${escape(f.displayDateUtc)} UTC</div></div></section></main><template id="inner-template"><section class="sheet inner">${folds}<div class="track-area"><div class="heading-slot"></div><div class="flow"></div></div><div class="spine"><div class="spine-text">${escape(f.physicalId)} / 曲目续页</div></div><aside class="flap">${ids}<p class="footnote">历史曲序与实际整面时长<br>逐曲时长未作推断<br>本页为独立续页</p><p class="calibration">10 mm 校验线</p></aside><div class="folio"></div></section></template><div id="track-source" hidden>${sources}</div></body></html>`
}
export function recordingPrintHtml(lease: RecordingPrintLease): string {
  return lease.design?.schemaVersion === 2 ? customRecordingPrintHtml(lease as RecordingPrintLease & { design: RecordingPrintCustomDesign }) : legacyRecordingPrintHtml(lease)
}

/** 仅Main执行的固定脚本；不拼接用户JSON/HTML。按实际字体与元素高度分页。 */
export const RECORDING_PRINT_LAYOUT_SCRIPT = `(async () => {
  const fail = () => ({ok:false,errorCode:'LAYOUT_OVERFLOW'});
  await document.fonts.ready;
  await Promise.all(Array.from(document.images, image => image.decode()));
  const fits = element => element.scrollHeight <= element.clientHeight + 0.5 && element.scrollWidth <= element.clientWidth + 0.5;
  const fit = (element, sizes) => { for (const size of sizes) { element.style.fontSize = size + 'pt'; if (fits(element)) return true; } return false; };
  for (const [selector, sizes] of [['.fit-title',[15,13,11,9,7.5]],['.fit-spine',[10,9,8,7.5]],['.fit-model',[8.5,8,7.5]]]) if (!fit(document.querySelector(selector), sizes)) return fail();
  const pages = document.querySelector('#pages'), template = document.querySelector('#inner-template');
  const sources = Array.from(document.querySelectorAll('.source-side'));
  for (const source of sources) {
    const heading = source.querySelector('.side-heading'); let sheet, flow;
    const nextPage = () => {
      if (pages.children.length >= 24) return false;
      sheet = template.content.firstElementChild.cloneNode(true); sheet.querySelector('.heading-slot').append(heading.cloneNode(true));
      pages.append(sheet); flow = sheet.querySelector('.flow'); return true;
    };
    if (!nextPage()) return fail();
    for (const track of Array.from(source.querySelectorAll('.track'))) {
      flow.append(track);
      if (!fits(flow)) {
        track.remove(); if (!flow.children.length || !nextPage()) return fail();
        flow.append(track); if (!fits(flow)) return fail();
      }
    }
  }
  document.querySelector('#track-source').remove();
  const sheets = Array.from(pages.children);
  for (const [index, sheet] of sheets.entries()) {
    const folio = sheet.querySelector('.folio'); if (folio) folio.textContent = '曲目续页 ' + index + ' / ' + (sheets.length - 1);
    for (const element of sheet.querySelectorAll('.flap,.cover,.cover-date,.spine-text,.track,.side-heading')) if (!fits(element)) return fail();
    const box = sheet.getBoundingClientRect(); if (Math.abs(box.width-${g.widthMm*96/25.4}) > 0.1 || Math.abs(box.height-${g.heightMm*96/25.4}) > 0.1) return fail();
  }
  window.scrollTo(0,0);
  return {ok:true,pageCount:sheets.length};
})()`
export function recordingPrintLayoutScript(lease: RecordingPrintLease): string {
  if (lease.design?.schemaVersion !== 2) return RECORDING_PRINT_LAYOUT_SCRIPT
  const geometry = lease.design.geometry
  return RECORDING_PRINT_LAYOUT_SCRIPT
    .replace(`box.width-${g.widthMm*96/25.4}`, `box.width-${geometry.widthMm*96/25.4}`)
    .replace(`box.height-${g.heightMm*96/25.4}`, `box.height-${geometry.heightMm*96/25.4}`)
}
