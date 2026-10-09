import { createHash } from 'node:crypto';

// 只回核001真实Preload装载器的两行增量；旧49清单、API闭集和业务断言不改。
export const MBM001_LEGACY_PROBE_IDENTITY = Object.freeze({
  path: 'apps/desktop/test/preload.test.ts',
  baseReportSha: 'c6c4745dfc7fe4242b8a2682798e00605649b12e',
  capturedSourceSha: 'fc3c52302b53b2adebd3645ecf31024a1525f419',
  before: Object.freeze({ bytes: 37035, sha256: '596e20ca190f0285d384f9038a80106cefd18761cc79056076692f5130837124' }),
  after: Object.freeze({ bytes: 37168, sha256: '4a288ee751deebd20f76c420b67bf5d5ede7e86d6800589f4e6ad278318a0166' }),
  // 原014/012/013正例已经准入的整份历史输入只原样通过，不能成为新的逆变换目标。
  earlierApprovedOriginals: Object.freeze([
    Object.freeze({ bytes: 36611, sha256: 'e71abb2064cfbb52715da88b494b6b963fe41a3271d9a99a4757563fcc691e32' }),
    Object.freeze({ bytes: 36786, sha256: '7e217790f0cf811b4629bee7de0749402ee56eebe161a1d15c8a1511a1c00fd3' }),
    Object.freeze({ bytes: 37008, sha256: '8fb8b3daef9c1826e6794b02fbb524fdd08ed40f293e51459e4d11bfa95aa639' }),
  ]),
  windows: Object.freeze([
    Object.freeze({ offset: 2474, before: '', after: "  const mobileModule = await import('../src/preload/mobile-connection-client.js')\n" }),
    Object.freeze({ offset: 3081, before: '', after: "    './mobile-connection-client.js': mobileModule,\n" }),
  ]),
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, identity) => bytes.length === identity.bytes && sha(bytes) === identity.sha256;
const reject = () => {
  const error = new Error('001旧Preload探针只准已核完整字节和两个固定窗口的逆变换。');
  error.code = 'MBM001_LEGACY_PROBE_INPUT_CHANGED';
  throw error;
};

/** 纯内存回到封存000基线；先001、再000、再013。当前Owner/Main行为仍须001独立验证。 */
export function normalizeMbm001LegacyProbe(file, bytes) {
  if (typeof file !== 'string' || !Buffer.isBuffer(bytes)) reject();
  const identity = MBM001_LEGACY_PROBE_IDENTITY;
  if (file !== identity.path) return bytes;
  if (matches(bytes, identity.before) || identity.earlierApprovedOriginals.some(original => matches(bytes, original))) return bytes;
  if (!matches(bytes, identity.after)) reject();
  let restored = Buffer.from(bytes);
  for (const window of [...identity.windows].reverse()) {
    const after = Buffer.from(window.after, 'utf8');
    if (!restored.subarray(window.offset, window.offset + after.length).equals(after)) reject();
    restored = Buffer.concat([restored.subarray(0, window.offset), Buffer.from(window.before, 'utf8'), restored.subarray(window.offset + after.length)]);
  }
  if (!matches(restored, identity.before)) reject();
  return restored;
}
