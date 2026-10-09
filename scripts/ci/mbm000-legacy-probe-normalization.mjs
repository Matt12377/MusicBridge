import { createHash } from 'node:crypto';

// 只准本轮已核完整首页字节的可逆时序修复；旧49输入清单和原断言继续固定。
export const MBM000_EARLY_PROBE_IDENTITY = Object.freeze({
  "path": "apps/desktop/e2e/v1-ui.spec.ts",
  "parentSource": "d980de9037b5d7cc1df402b3638072cd3514a1f0",
  "before": {
    "bytes": 289590,
    "sha256": "43666556b8c7def39a42560e9d97a41264ea89d7d52d945c700d7f77a72121db"
  },
  "after": {
    "bytes": 289978,
    "sha256": "ba87fc6d36eaf18f51344d70a64f507fba88ff963ea8ee290cdd0eeeb83cbf3f"
  }
});
const markers = Object.freeze({
  "fixedCleanupBlock": "  const ownedProbe = crashProbeCleanup, ownedApp = electronApp\n  crashProbeCleanup = undefined\n  try {\n    if (ownedProbe) await ownedProbe\n  } finally {\n    // 保留正文的首发UI错误；清理只等待本次自有进程，不把close当验收成功。\n    if (ownedApp) await ownedApp.close()\n  }\n",
  "fixedGlobalLine": "let crashProbeCleanup: ReturnType<typeof runStartupProcess> | undefined\n",
  "caseStart": "test('v5 Home、设置 Footer、Settings、每日推荐和 Renderer isolation', async () => {\n",
  "caseEnd": "\n})\n\ntest('合成 Profile",
  "cleanupAssignment": "  crashProbeCleanup = crashFlight\n",
  "resultAwaitLine": "  const crashResult = await crashFlight\n",
  "callStart": "  const crashFlight = runStartupProcess",
  "oldComment": "// 此阶段无UI断言；从spawn即收集标记，等待真实stdio关闭，避免Playwright先消费stdout。",
  "newComment": "// 探针仅核Core生命周期；提前spawn并立即捕获输出，末尾仍等真实stdio关闭。"
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, identity) => bytes.length === identity.bytes && sha(bytes) === identity.sha256;
const reject = () => { const error = new Error('000首页探针只准精确已核字节逆变换。'); error.code = 'MBM000_LEGACY_PROBE_INPUT_CHANGED'; throw error; };
const replaceOnce = (text, before, after) => { if (text.split(before).length !== 2) reject(); return text.replace(before, after); };

/** 验证当前完整SHA后逆回原Git全文；任何额外修改先拒绝，不靠删行掩盖断言变动。 */
export function normalizeMbm000LegacyEarlyProbe(file, bytes) {
  if (typeof file !== 'string' || !Buffer.isBuffer(bytes)) reject();
  if (file !== MBM000_EARLY_PROBE_IDENTITY.path) return bytes;
  if (matches(bytes, MBM000_EARLY_PROBE_IDENTITY.before)) return bytes;
  if (!matches(bytes, MBM000_EARLY_PROBE_IDENTITY.after)) reject();
  let text = bytes.toString('utf8');
  if (text.split(markers.caseStart).length !== 2) reject();
  const start = text.indexOf(markers.caseStart) + markers.caseStart.length;
  const end = text.indexOf(markers.caseEnd, start); if (end < start) reject();
  const body = text.slice(start, end), callStart = body.indexOf(markers.callStart);
  for (const marker of [markers.callStart, markers.cleanupAssignment, markers.resultAwaitLine]) if (body.split(marker).length !== 2) reject();
  const cleanup = body.indexOf(markers.cleanupAssignment), uiStart = cleanup + markers.cleanupAssignment.length;
  const result = body.indexOf(markers.resultAwaitLine); if (!(0 < callStart && callStart < cleanup && uiStart < result)) reject();
  const setup = replaceOnce(body.slice(0, callStart), markers.newComment, markers.oldComment);
  const call = replaceOnce(body.slice(callStart, cleanup), 'const crashFlight = runStartupProcess', 'const crashResult = await runStartupProcess');
  const ui = body.slice(uiStart, result), assertions = body.slice(result + markers.resultAwaitLine.length);
  text = text.slice(0, start) + ui + setup + call + assertions + text.slice(end);
  text = replaceOnce(text, markers.fixedGlobalLine, '');
  text = replaceOnce(text, markers.fixedCleanupBlock, '  if (electronApp) await electronApp.close()\n');
  const restored = Buffer.from(text); if (!matches(restored, MBM000_EARLY_PROBE_IDENTITY.before)) reject();
  return restored;
}
