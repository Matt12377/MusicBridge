import { execFileSync } from 'node:child_process';
import { constants as fsConstants, lstatSync, fstatSync, openSync, closeSync, readFileSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const V39_INTEGRATION_TASK = 'V39-INTEGRATION-001';
export const V39_INTEGRATION_BRANCH = 'codex/v39-integration-001';
export const V39_INTEGRATION_BASE = '9bfb5915c17e8b5770ece7ac9a0efc1998d54e72';
export const V39_INTEGRATION_BASE_TREE = 'ff19750436197660016a82145d5cb7855b85168a';
const domain = 'docs/integration/V39-INTEGRATION-001/';
export const V39_INTEGRATION_SCOPE_PATH = domain + 'EXECUTION_SCOPE.json';
export const V39_INTEGRATION_BASELINE_PATH = domain + 'SEALED_BASELINE.json';
export const V39_INTEGRATION_DONOR_PATH = domain + 'DONOR_READBACK.json';
export const V39_INTEGRATION_STATUS_PATH = domain + 'STATUS.json';
export const V39_INTEGRATION_LOCAL_EVIDENCE_PATH = domain + 'LOCAL_SOFTWARE_EVIDENCE.json';
export const V39_INTEGRATION_MATRIX_PATH = domain + 'FEATURE_BEHAVIOR_MATRIX.json';
export const V39_INTEGRATION_CI_EVIDENCE_PATH = domain + 'CI_EVIDENCE.json';
export const V39_INTEGRATION_GUARD_STEP = 'V3.9 Tape组合精确身份准入';
export const V39_INTEGRATION_GATE_STEP = 'V3.9 Tape当前组合 Gate';
export const V39_INTEGRATION_UPLOAD_STEP = '保留本次V3.9 Tape组合证据';
export const V39_INTEGRATION_REPOSITORY_ID = 1340424953;
export const V39_INTEGRATION_REPOSITORY = 'Matt12377/MusicBridge';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oidOf = (type, bytes) => createHash('sha1').update(type + ' ' + bytes.length + '\0').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const relative = value => typeof value === 'string' && value.length > 0 && value.length < 4096
  && !/[\u0000-\u001f\u007f\\]/u.test(value) && !value.startsWith('/')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function fail(code) { const error = new Error('V3.9 Tape集成准入拒绝。'); error.code = code; throw error; }
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const parse = bytes => JSON.parse(decode(bytes));
function canonical(value) {
  const active = new Set(); let count = 0;
  function copy(item, depth) {
    if (++count > 1_000_000 || depth > 96) fail('V39_JSON_BUDGET');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('V39_JSON_NUMBER'); return item; }
    if (typeof item !== 'object' || types.isProxy(item) || active.has(item) || Object.getOwnPropertySymbols(item).length
      || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) fail('V39_JSON_DATA_REQUIRED');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((key, i) => key !== String(i))) fail('V39_JSON_ARRAY_CLOSEDSET');
      result = keys.map(key => { const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !Object.hasOwn(d, 'value')) fail('V39_JSON_ACCESSOR'); return copy(d.value, depth + 1); });
    } else {
      result = {};
      for (const key of Object.keys(item).sort()) { const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail('V39_JSON_ACCESSOR');
        Object.defineProperty(result, key, { value: copy(d.value, depth + 1), enumerable: true }); }
    }
    active.delete(item); return result;
  }
  const bytes = Buffer.from(JSON.stringify(copy(value, 0)), 'utf8');
  if (bytes.length > 16 * 1024 * 1024) fail('V39_JSON_BUDGET'); return bytes;
}
export function v39IntegrationCanonicalPin(value) { const bytes = canonical(value); return { bytes: bytes.length, sha256: hash(bytes) }; }
const equal = (a, b) => canonical(a).equals(canonical(b));
function keys(value, expected, code) {
  if (!object(value) || !equal(Object.keys(value).sort(), [...expected].sort())) fail(code);
}
function base64(value, cap = 16 * 1024 * 1024) {
  if (typeof value !== 'string' || value.length > Math.ceil(cap / 3) * 4
    || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fail('V39_BASE64_NOT_CANONICAL');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > cap || bytes.toString('base64') !== value) fail('V39_BASE64_NOT_CANONICAL'); return bytes;
}
function lossless(bytes) {
  return JSON.parse(decode(bytes), (_key, value, context) => typeof value === 'number'
    ? { __v39_number_literal__: context.source } : value);
}
function without(value, names) { const result = { ...value }; for (const name of names) delete result[name]; return result; }
/** typed语义与原number token共同保护，不能把unsafe integer舍入当无变化。 */
function protectedJson(before, after, names, code) {
  if (!equal(without(parse(before), names), without(parse(after), names))
    || !equal(without(lossless(before), names), without(lossless(after), names))) fail(code);
}
function readWhole(filename, cap = 16 * 1024 * 1024) {
  const original = lstatSync(filename, { bigint: true });
  if (!original.isFile() || original.isSymbolicLink() || original.size > BigInt(cap)) fail('V39_FILE_NOT_CLOSED');
  const fd = openSync(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { const first = fstatSync(fd, { bigint: true }); const bytes = readFileSync(fd); const last = fstatSync(fd, { bigint: true });
    if (!first.isFile() || ['dev','ino','size','mtimeNs','ctimeNs','mode'].some(key => first[key] !== last[key])
      || first.dev !== original.dev || first.ino !== original.ino || first.size !== BigInt(bytes.length)) fail('V39_FILE_CHANGED');
    return bytes;
  } finally { closeSync(fd); }
}
export const V39_INTEGRATION_SOURCE_FILES = freeze([
  {
    "path": ".github/workflows/electron-e2e.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "51ba0995f0ae3d71bdc410e70f59b105ce84000d",
      "bytes": 9997,
      "sha256": "7a172406b41b6be8b3f564edb9d2b4dfd178304c2db491bb6729e0c7ef6ce69d"
    }
  },
  {
    "path": ".github/workflows/rust-core.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "2c00e1d1d8bee2731b472027fd4dbb3901f38e6a",
      "bytes": 4193,
      "sha256": "c54547680db2db7acf33870ff556ca96754089306dcd25645568eb8259e36c65"
    }
  },
  {
    "path": ".github/workflows/security.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "16660e2394a8bbaefefc27b8b1c561f6137c910f",
      "bytes": 1895,
      "sha256": "e643e3e7e3af84045e9dbfa9cd0dc364e0f8ce53b0498a7777afc7c1f0aefe41"
    }
  },
  {
    "path": ".github/workflows/verify.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "21423337de4d7ba40d0ade21dd64d5e813c9f931",
      "bytes": 25696,
      "sha256": "aad3799618275aff2c45353ad7819b892d8902b5c0426c3b63f557568410d902"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CassetteArchiveImportPanel.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "f58ea07116b5bbfef4f47c042c38256d8cfd0354",
      "bytes": 6951,
      "sha256": "6a94a8e7467909160b36f714b1cd3d47bc73cce78444585bdd870223759d0bf0"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogDetail.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "74680f02751654aad644fab5df54549d8fd9a8ac",
      "bytes": 12605,
      "sha256": "0cd22aa8ff76b28aaa85913a748310761057bbfcbee11ed5bb47b1bc21ac5064"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogView.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "20f905a432db9caa6aa930654b70001600fb1bcc",
      "bytes": 15887,
      "sha256": "d410d8a3e236259de4d97d8a6c5b870b7bee48ad986fee3a7543fbe460896e74"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CollectionView.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "e8069457feaead993ff8f3fe40b6ee7bb2e021d0",
      "bytes": 39258,
      "sha256": "7045d279a2e3902d02e16f469b8d04af1fe94994e20c1684b631a2f5f7f15252"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/reference-images.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "e0febb7c48468dde6289c069f3a8f38c47df7b78",
      "bytes": 9377,
      "sha256": "a1d3579551d2bbd06547f4a5ebf35861a5344a3bbee78b55351a04b9ee9ef14a"
    }
  },
  {
    "path": "apps/desktop/test/cassette-catalog-ui.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8f59d911d7543a0aa36ff9bad069e0f7dc34e89e",
      "bytes": 27565,
      "sha256": "68022d18fbadae9f92a93accbf04c723609ed5e0cfb3c91405d41679392fc6a7"
    }
  },
  {
    "path": "apps/desktop/test/collection-reference-images.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "fc02012c8e85be5a1a2909ba0c3353a731c5d7ee",
      "bytes": 4832,
      "sha256": "a9932cb10b7fd358745fa1e9b5b365d75c9aa0b703222abe956c42c9acfa1511"
    }
  },
  {
    "path": "docs/integration/V39-INTEGRATION-001/DONOR_READBACK.json",
    "status": "A",
    "role": "historical-donor-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "docs/integration/V39-INTEGRATION-001/EXECUTION_SCOPE.json",
    "status": "A",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "docs/integration/V39-INTEGRATION-001/FEATURE_BEHAVIOR_MATRIX.json",
    "status": "A",
    "role": "requirements",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "docs/integration/V39-INTEGRATION-001/LOCAL_SOFTWARE_EVIDENCE.json",
    "status": "A",
    "role": "evidence-specification",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "docs/integration/V39-INTEGRATION-001/SEALED_BASELINE.json",
    "status": "A",
    "role": "immutable-predecessor-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "docs/integration/V39-INTEGRATION-001/STATUS.json",
    "status": "A",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "packages/bridge-core/src/collection/reference-catalog-retention.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "packages/bridge-core/src/collection/reference-catalog-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "4fe9e51a6aab6c84427330d7a1c00e3462aa35eb",
      "bytes": 46960,
      "sha256": "0d197187345ef39897fb3dbf0be469e737a5de49b1733663b44b778ca8eccda1"
    }
  },
  {
    "path": "packages/bridge-core/test/reference-archive-catalog-store.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "0db2e3167c707f023ad8fc2aee396240b3f27c39",
      "bytes": 19643,
      "sha256": "cd29116df00bf415fac5276454472cef8f83a1702ee2baad11c602530f703b60"
    }
  },
  {
    "path": "packages/bridge-core/test/reference-catalog-retention.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "packages/contracts/src/reference-catalog.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "51143d386ae8722850d9f5d3b2859a0b3ab17db6",
      "bytes": 30579,
      "sha256": "0d8ea64fe9a3ae5ba234be2c4f7289e232f3dda975ec0cabec6f4d75c9ca61da"
    }
  },
  {
    "path": "packages/contracts/test/reference-catalog.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "7e8051cb1c6e25be530e9d14750cdd692f87dc3a",
      "bytes": 22893,
      "sha256": "0782732451e5e73f040bd2013402db4ce0f194a6dd5c3ad9bb5a783170af8482"
    }
  },
  {
    "path": "project/POSTRUST_PLAN.json",
    "status": "M",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "b9c7bd395b65980741ce50dbde55f7e6325d40fd",
      "bytes": 2899563,
      "sha256": "3fbcde859e3b34853a6bce4eda8b5ae247bf78939866cb7fcc8f169b00b98822"
    }
  },
  {
    "path": "project/POSTRUST_PROGRESS.md",
    "status": "M",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "d2124d9a4c0502e4df67aab015bf5d889de7eab7",
      "bytes": 127227,
      "sha256": "584bb65b4526ef43176116fba591b9b1100d217e24b055f242033f90eed67ac8"
    }
  },
  {
    "path": "project/POSTRUST_TODO.md",
    "status": "M",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "682da7b0e701ad68b23c7a725d6c5715de695b1b",
      "bytes": 40932,
      "sha256": "5b55783788e5fb49bb48b0d60643c9847d2ee14b179afa63370f05d8f4f5839a"
    }
  },
  {
    "path": "project/STATUS.json",
    "status": "M",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8c6972df1ed5b76b87c467c38c490b3a21ebce00",
      "bytes": 2658077,
      "sha256": "b3bb29f9c2ea708f94ee03de986c669af1f59ea947d7028a0e5451c0ae2d09a3"
    }
  },
  {
    "path": "reports/TAPE_CATALOG_HISTORY_COMPAT_EVIDENCE.json",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "reports/TAPE_CATALOG_HISTORY_COMPAT_RESULT.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "scripts/ci/report-only-admission.mjs",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "f7d316b2c0534f19eb868625902140eb26d2c285",
      "bytes": 29411,
      "sha256": "b9b6dc7755caabfa69e11d349be33ec589de9edb93bffac275e661e88c7f4c12"
    }
  },
  {
    "path": "scripts/ci/report-only-v39-integration.mjs",
    "status": "A",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "scripts/ci/task-applicability.mjs",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "c4fe07c327b66d849f751375a27fd70e7037aa8f",
      "bytes": 7495,
      "sha256": "d4a0835101911c833bf1b4372292b43f54fca2a68e6a6bf4e90aaa8bce0db28e"
    }
  },
  {
    "path": "scripts/ci/test/v39-integration-admission.test.mjs",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "scripts/ci/test/v39-integration-gate.test.mjs",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "scripts/ci/test/v39-integration-report-only.test.mjs",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "scripts/ci/v39-integration-admission.mjs",
    "status": "A",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "scripts/ci/verify-v39-integration.mjs",
    "status": "A",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  },
  {
    "path": "tasks/00_TASK_INDEX.md",
    "status": "M",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "4642f4cec2681ff6aee411179d57bd372c2488e1",
      "bytes": 29745,
      "sha256": "62ce5c2e563252986f81c057f534da19c8da644dbcbd3d95d874105f78a2338c"
    }
  },
  {
    "path": "tasks/V39-INTEGRATION-001.md",
    "status": "A",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    }
  }
]);
export const V39_INTEGRATION_REPORT_PATHS = freeze([
  'reports/V39-INTEGRATION-001_RESULT.json', 'reports/V39-INTEGRATION-001_RESULT.md',
  V39_INTEGRATION_CI_EVIDENCE_PATH, V39_INTEGRATION_STATUS_PATH,
  'project/STATUS.json', 'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md',
]);
export const V39_INTEGRATION_REPORT_FILES = freeze(V39_INTEGRATION_REPORT_PATHS.map((file, index) =>
  ({ path: file, status: index < 3 ? 'A' : 'M', oldMode: index < 3 ? '000000' : '100644', newMode: '100644' })));
const tapePins = freeze([
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CassetteArchiveImportPanel.vue",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "92f9f76125bb447f6c989ef36f6f53755b350800",
    "bytes": 7724,
    "sha256": "9b7b9bbcc1859684367df1060d02ebe5ebc423462584ec0eed6cf40b0540dbf2"
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogDetail.vue",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "b2b1fcfffb92e7535d5b1cfb55af9062f189a642",
    "bytes": 13038,
    "sha256": "e0b028c535ff41096a51904fd11c602220e03916a9922cc2825bc9d404b44963"
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogView.vue",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "310d8fe7950670d4200f759f6697d891bc8254cc",
    "bytes": 16917,
    "sha256": "37a52e4b5868151dfedec97b3271619e0a63ce00e33ba26ad1a1368a32bd2b8e"
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/CollectionView.vue",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "c192a21b3307ef4e2e8582f3ed160e4515553645",
    "bytes": 41843,
    "sha256": "4cd02ecf8dc45dfb34a8389edbd31372d6b8b92d3db1ee1252c8ab70e7a40efb"
  },
  {
    "path": "apps/desktop/src/renderer/src/components/collection/reference-images.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "5cf626eada544311c5e1a06c7d6403bde9250ae6",
    "bytes": 12370,
    "sha256": "ce000d3713cbf9f16a353a3cc7b68fc20c10560a751d506b7948541c6c05ff34"
  },
  {
    "path": "apps/desktop/test/cassette-catalog-ui.test.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "b59b6e28619df48579e3c9c003f5ae5702736bf2",
    "bytes": 38729,
    "sha256": "168e475056ca6474c994dea75f0243d2026a644a32d7b0a4bd152c00b888c8fa"
  },
  {
    "path": "apps/desktop/test/collection-reference-images.test.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "d31ae046294fbd60a553d6c89c3daa5fe88a1479",
    "bytes": 8247,
    "sha256": "edd150b4a6e1ccb295dd4458ae7f81bffb43c5e423f2b346e6e26c77f410a931"
  },
  {
    "path": "packages/bridge-core/src/collection/reference-catalog-retention.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "6520598410a88a686280421f7b0c0e9db45ce31a",
    "bytes": 3354,
    "sha256": "ee8531e696da2b8b7a6e8479bffeb674e6f10b5db519d367349ec1913f85e514"
  },
  {
    "path": "packages/bridge-core/src/collection/reference-catalog-store.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "fac1f8be7d299135e312c9193e0c7c023197a5c6",
    "bytes": 49492,
    "sha256": "cb20e8e4de0ae20be7a96944820252393ad95738bde04d8e2505c37bb13f3711"
  },
  {
    "path": "packages/bridge-core/test/reference-archive-catalog-store.test.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "83c749fcbfe2a4038c8868a687ddb5d7e8672868",
    "bytes": 20252,
    "sha256": "6f945ab5a572bc2d21063f269b5c86901c909fa3a3396d3514477f9789b3bab1"
  },
  {
    "path": "packages/bridge-core/test/reference-catalog-retention.test.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "671308f343d88a74cb11b29b5782dc762d7a7742",
    "bytes": 20800,
    "sha256": "a6df327894831798cf45f522a5e7fc32b770a8961f63317ebdd561ee84d1be03"
  },
  {
    "path": "packages/contracts/src/reference-catalog.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "fbbb9ccda1e88e492d0ce7a75f9d999b3cb4c827",
    "bytes": 31851,
    "sha256": "fe0682001b99dddb345ab785187f441efcb595d5ab7bdb17654f59d376de76e6"
  },
  {
    "path": "packages/contracts/test/reference-catalog.test.ts",
    "revision": "92956514474dc04c7100e52fe4138212278f1f9b",
    "mode": "100644",
    "blob": "f67aedced04852f6e63324ef4cb12647c94aa858",
    "bytes": 24452,
    "sha256": "d2b0127ba7e2b2cff93b53d881af57cacfd3ff5bc422e542816e4a151c3a4f97"
  },
  {
    "path": "reports/TAPE_CATALOG_HISTORY_COMPAT_EVIDENCE.json",
    "revision": "6356aa3215364327f8a08783e0367dce51683ca1",
    "mode": "100644",
    "blob": "4946e341f0356ed75ceb34cb28572d9935ebe3af",
    "bytes": 27177,
    "sha256": "4382f35711c311708e202d4afa73d48a32e2cf2e0ae0150e80b9d12847692f12"
  },
  {
    "path": "reports/TAPE_CATALOG_HISTORY_COMPAT_RESULT.md",
    "revision": "6356aa3215364327f8a08783e0367dce51683ca1",
    "mode": "100644",
    "blob": "211bd458ef44929af1026689b7df7b6157c13bec",
    "bytes": 4722,
    "sha256": "9d24b342cd4db310bbff2a61314db35ef10be83551d720b2c3135c72c4843a7e"
  }
]);
const baselineReceipts = freeze([
  { name: 'root211', bytes: 7041, sha256: '19639d66f1c1c861eea146b385ea7247d76b463e085f84fbfa2ac81c5d7bb0e0' },
  { name: 'source-first-natural-ci', bytes: 361956, sha256: '0d6ca143767ce2be0a94e724e780ac5af242b70ae54fe71350bf67a763368944' },
  { name: 'report-first-natural-ci', bytes: 344019, sha256: '3f571be809b583f390cdb3b57c1f347c00ca6e161a8ff5809d734eadc782f146' },
]);
const history = freeze([
  [
    "9bfb5915c17e8b5770ece7ac9a0efc1998d54e72",
    "0dffccb0b351e994ee19e0840e12f88481956c6f",
    "ff19750436197660016a82145d5cb7855b85168a"
  ],
  [
    "0dffccb0b351e994ee19e0840e12f88481956c6f",
    "dfad0c8e0e0f906c3a7456b0151b3aaba7e5547c",
    "a730aa91291804a26a24b98e58e526525475373a"
  ],
  [
    "dfad0c8e0e0f906c3a7456b0151b3aaba7e5547c",
    "1b5345d13d9617c1770a361841d805305d06d038",
    "63afd77199f9655510e2f87c179999018b159dae"
  ],
  [
    "1b5345d13d9617c1770a361841d805305d06d038",
    "d3d86c6db8d27485d2d763b81cd5e8925ee15af6",
    "932ba078c362d653febe49413b6bc767b88318b9"
  ],
  [
    "d3d86c6db8d27485d2d763b81cd5e8925ee15af6",
    "aebf9464dc080d1242c379db183f4424e62f0b40",
    "69adb883e18997ab019fc08c68a43989e217e08b"
  ],
  [
    "aebf9464dc080d1242c379db183f4424e62f0b40",
    "16507120ab52d4843012e6888ad521138d8336d6",
    "4e43bb4b272cba1289418fba6cafb935083c1097"
  ],
  [
    "16507120ab52d4843012e6888ad521138d8336d6",
    "78184e7849cc3b10191ea64af29ba8bc23162b0a",
    "18cf086fc3a527b4531f7e271f8893db8d60f8f5"
  ],
  [
    "78184e7849cc3b10191ea64af29ba8bc23162b0a",
    "479e746bb7106a4dac158fe616290220de03a53a",
    "1f5c4d00b68cc0cd3b2979fa4409bc8f5bc7afd8"
  ]
]);
const foundation = '479e746bb7106a4dac158fe616290220de03a53a';
const phases = ['BASELINE_READBACK','TAPE_IMPORT','EXACT_ROUTE_AND_GATE','SOURCE_FREEZE'];
export function assertV39IntegrationScope(scope, bytes) {
  keys(scope, ['schema','task','branch','baseSha','baseTree','sealedBaseline','frozen','executionStatus','currentPhase','scopeBoundary',
    'orderedPhases','allowedSourceFiles','finalFiles','reportPaths','nextTask','softwareQualificationFromSelfReport','requiredEvidenceRefs',
    'budgets','preserveOriginalLedger','realApplicationServiceDeviceAudio','ownerAcceptance'], 'V39_SCOPE_HEADER');
  if (scope.schema !== 'musicbridge.v39.integration.execution-scope.v1' || scope.task !== V39_INTEGRATION_TASK
    || scope.branch !== V39_INTEGRATION_BRANCH || scope.baseSha !== V39_INTEGRATION_BASE || scope.baseTree !== V39_INTEGRATION_BASE_TREE
    || scope.sealedBaseline !== V39_INTEGRATION_BASELINE_PATH || scope.frozen !== true || scope.executionStatus !== 'READY_FOR_SOURCE'
    || scope.currentPhase !== 'SOURCE_FREEZE' || scope.scopeBoundary !== 'TAPE_COMPOSITION_ONLY_FULL_FEEDBACK_COVERDROP_NEXT_INTEGRATION_TASK'
    || scope.nextTask !== 'V39-INTEGRATION-002' || scope.softwareQualificationFromSelfReport !== false
    || scope.realApplicationServiceDeviceAudio !== 'NOT_RUN' || scope.ownerAcceptance !== 'NOT_RUN'
    || !equal(scope.orderedPhases, phases.map(id => ({ id, implementation: 'COMPLETE' })))
    || !equal(scope.allowedSourceFiles, V39_INTEGRATION_SOURCE_FILES) || !equal(scope.reportPaths, V39_INTEGRATION_REPORT_PATHS)
    || !equal(scope.preserveOriginalLedger, { tasks:18, acceptanceCases:156, effectiveTasks:17, effectiveAcceptanceCases:150, cancelled015Cases:6 })
    || !equal(scope.budgets, { oldMbm004StageMs:180000, oldMbm004WholeMs:480000, ownerMs:2000, rawBytesPerStream:16777216 })
    || !equal(scope.requiredEvidenceRefs, { sourceGate:'ACTUAL_CURRENT_SOURCE_GATE_WHOLE_RAW',
      sourceCi:'FIRST_NATURAL_CURRENT_SOURCE_PRODUCT_CI', reportCi:'FIRST_NATURAL_UNIQUE_DIRECT_REPORT_CI' })
    || !Array.isArray(scope.finalFiles) || scope.finalFiles.length !== 39) fail('V39_SCOPE_NOT_FROZEN_COMPLETE');
  for (let i = 0; i < scope.finalFiles.length; i++) {
    const row = scope.finalFiles[i]; keys(row, ['path','mode','blob','bytes','sha256'], 'V39_SCOPE_FINAL_PIN');
    const self = row.path === V39_INTEGRATION_SCOPE_PATH;
    if (row.path !== V39_INTEGRATION_SOURCE_FILES[i].path || row.mode !== '100644' || !positive(row.bytes)
      || row.bytes > 16 * 1024 * 1024 || (self ? row.blob !== null || row.sha256 !== null || row.bytes !== bytes.length
        : !sha(row.blob) || !sha256(row.sha256))) fail('V39_SCOPE_FINAL_PIN');
  }
  return scope;
}
function gitContext(directory, env, options = {}) {
  keys(options, Object.keys(options).length ? ['deadline'] : [], 'V39_ADMISSION_BUDGET');
  const began = performance.now(), deadline = options.deadline ?? began + 60000;
  if (!Number.isFinite(deadline) || deadline <= began || deadline > began + 480000) fail('V39_ADMISSION_BUDGET');
  if (process.versions.node.split('.')[0] !== '22' || !['darwin','linux'].includes(process.platform) || env.NODE_OPTIONS || env.NODE_PATH)
    fail('V39_NODE_CONTEXT');
  const allowedGit = { GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0', GIT_NO_LAZY_FETCH:'1' };
  if (Object.entries(env).some(([key,value]) => key.startsWith('GIT_') && (allowedGit[key] !== value))) fail('V39_GIT_ENV_INJECTION');
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || realpathSync(directory) !== directory) fail('V39_DIRECTORY_NOT_CANONICAL');
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))); Object.assign(gitEnv, allowedGit);
  const check = () => { if (performance.now() >= deadline) fail('V39_ADMISSION_BUDGET'); };
  const git = (args, input) => { check(); let bytes;
    try { bytes = execFileSync('git', ['--no-replace-objects','-c','core.fsmonitor=false', ...args],
      { cwd:directory, env:gitEnv, input, timeout:Math.min(10000, Math.max(1, Math.ceil(deadline-performance.now()))),
        killSignal:'SIGKILL', maxBuffer:16*1024*1024, stdio:[input===undefined?'ignore':'pipe','pipe','pipe'] }); }
    catch { fail('V39_GIT_READ_FAILED'); } check(); return bytes; };
  const text = args => decode(git(args)).trim();
  const commonDir = text(['rev-parse','--path-format=absolute','--git-common-dir']);
  if (text(['rev-parse','--show-toplevel']) !== directory || commonDir !== path.join(directory,'.git')
    || text(['rev-parse','--path-format=absolute','--git-dir']) !== commonDir || realpathSync(commonDir) !== commonDir
    || !lstatSync(commonDir).isDirectory() || lstatSync(commonDir).isSymbolicLink()) fail('V39_INDEPENDENT_GIT_REQUIRED');
  if (text(['rev-parse','--is-shallow-repository']) !== 'false'
    || text(['for-each-ref','--format=%(refname)','refs/replace'])) fail('V39_GIT_OVERLAY_OR_SHALLOW');
  for (const name of ['info/grafts','shallow','objects/info/alternates','objects/info/http-alternates'])
    if (existsSync(text(['rev-parse','--path-format=absolute','--git-path',name]))) fail('V39_GIT_OVERLAY_OR_SHALLOW');
  if (decode(git(['ls-files','-v','-z'])).split('\0').filter(Boolean).some(row => !row.startsWith('H '))) fail('V39_INDEX_FLAGS');
  const head = text(['rev-parse','HEAD']), branch = text(['branch','--show-current']) || env.GITHUB_REF_NAME;
  if (!sha(head) || branch !== V39_INTEGRATION_BRANCH || env.GITHUB_SHA && env.GITHUB_SHA !== head
    || env.GITHUB_ACTIONS === 'true' && (env.GITHUB_REF_NAME !== V39_INTEGRATION_BRANCH
      || env.GITHUB_REPOSITORY !== V39_INTEGRATION_REPOSITORY)) fail('V39_HEAD_OR_BRANCH');
  const context = { directory, env, git, text, head, branch, commonDir, deadline, check, trees:new Map(), blobs:new Map(), cachedBytes:0 };
  if (text(['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'])) fail('V39_DIRTY_CHECKOUT');
  return context;
}
function tree(context, revision) {
  if (!sha(revision)) fail('V39_IMMUTABLE_REVISION_REQUIRED');
  if (context.trees.has(revision)) return context.trees.get(revision);
  const rows = new Map();
  for (const line of decode(context.git(['ls-tree','-r','-z',revision])).split('\0').filter(Boolean)) {
    const m = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    if (!m || !relative(m[3]) || rows.has(m[3])) fail('V39_TREE_CLOSEDSET'); rows.set(m[3], { path:m[3],mode:m[1],blob:m[2] });
  }
  if (!rows.size || rows.size > 32768) fail('V39_TREE_CLOSEDSET'); context.trees.set(revision,rows); return rows;
}
function batch(context, oids) {
  const missing = [...new Set(oids)].filter(oid => !context.blobs.has(oid));
  if (!missing.length) return;
  if (missing.some(oid => !sha(oid)) || missing.length > 512) fail('V39_BLOB_CLOSEDSET');
  const headers=decode(context.git(['cat-file','--batch-check'],Buffer.from(missing.join('\n')+'\n'))).split('\n');
  if(headers.pop()!==''||headers.length!==missing.length)fail('V39_BLOB_HEADER');
  const metadata=headers.map((line,i)=>{const m=/^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/u.exec(line),size=Number(m?.[2]);
    if(!m||m[1]!==missing[i]||!Number.isSafeInteger(size)||size>16777216)fail('V39_BLOB_HEADER');
    return {oid:missing[i],size,headerBytes:Buffer.byteLength(line)+1};});
  function retain(oid,bytes,size){context.check();
    if(bytes.length!==size||oidOf('blob',bytes)!==oid||context.cachedBytes+size>64*1024*1024)fail('V39_BLOB_BODY');
    context.blobs.set(oid,Buffer.from(bytes));context.cachedBytes+=size;}
  function group(rows){
    if(!rows.length)return;
    const raw=context.git(['cat-file','--batch'],Buffer.from(rows.map(row=>row.oid).join('\n')+'\n'));let position=0;
    for(const row of rows){const end=raw.indexOf(10,position);
      if(end<0||decode(raw.subarray(position,end))!==row.oid+' blob '+row.size||raw[end+row.size+1]!==10)fail('V39_BLOB_HEADER');
      retain(row.oid,raw.subarray(end+1,end+1+row.size),row.size);position=end+row.size+2;}
    if(position!==raw.length)fail('V39_BLOB_TRAILING_BYTES');
  }
  let rows=[],size=0;
  for(const row of metadata){const next=row.headerBytes+row.size+1;
    if(size+next>16777216){group(rows);rows=[];size=0;}
    // 极限单叶不让batch framing扩大16MiB输出预算；已核闭集type/size的immutable OID只读取blob正文。
    if(next>16777216){retain(row.oid,context.git(['cat-file','blob',row.oid]),row.size);continue;}
    rows.push(row);size+=next;
  }
  group(rows);
}
function blob(context, revision, file) {
  const row = tree(context,revision).get(file); if (!row) fail('V39_REQUIRED_LEAF_MISSING');
  batch(context,[row.blob]); return context.blobs.get(row.blob);
}
function rawDiff(context, before, after) {
  const parts=decode(context.git(['diff','--raw','--no-abbrev','-z','--no-renames','--no-ext-diff','--no-textconv',before,after])).split('\0');
  if (parts.pop() !== '' || parts.length%2) fail('V39_RAW_DIFF_CLOSEDSET');
  const rows=[], seen=new Set();
  for(let i=0;i<parts.length;i+=2){const m=/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])$/u.exec(parts[i]);
    if(!m || !relative(parts[i+1]) || seen.has(parts[i+1]))fail('V39_RAW_DIFF_CLOSEDSET');
    seen.add(parts[i+1]);rows.push({path:parts[i+1],oldMode:m[1],newMode:m[2],oldBlob:m[3],newBlob:m[4],status:m[5]});}
  return rows;
}
function exactDiff(rows, expected) {
  if(rows.length!==expected.length || expected.some(want=>{const found=rows.filter(row=>row.path===want.path);
    return found.length!==1 || Object.entries(want).some(([key,value])=>found[0][key]!==value);}))fail('V39_DELTA_NOT_EXACT');
}
function parents(context, revision, expected) {
  if (!equal(context.text(['rev-list','--parents','-n','1',revision]).split(' '),[revision,expected])) fail('V39_UNIQUE_PARENT');
}
function actualPins(context, revision, names, current=false) {
  const entries=names.map(file=>tree(context,revision).get(file)); if(entries.some(row=>!row))fail('V39_REQUIRED_LEAF_MISSING');
  batch(context,entries.map(row=>row.blob));
  return entries.map(row=>{context.check();const bytes=context.blobs.get(row.blob);
    if(current && !readWhole(path.join(context.directory,row.path)).equals(bytes))fail('V39_WORKTREE_BYTES_CHANGED');
    return {...row,bytes:bytes.length,sha256:hash(bytes)};});
}
function snapshot(context, names) {
  const head=context.text(['rev-parse','HEAD']), branch=context.text(['branch','--show-current'])||context.env.GITHUB_REF_NAME;
  const status=context.text(['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none']);
  if(head!==context.head || branch!==context.branch || status!=='')fail('V39_CURRENT_SNAPSHOT_CHANGED');
  const lineage=context.text(['rev-list','--parents','-n','1',head]).split(' ');
  if(lineage.length!==2)fail('V39_UNIQUE_PARENT');
  return {identity:{head,parent:lineage[1],branch,tree:context.text(['rev-parse',head+'^{tree}']),status},
    currentFiles:actualPins(context,head,names,true)};
}
function sealedBaseline(context, revision) {
  for(const [head,parent,commitTree] of history){parents(context,head,parent);
    if(context.text(['rev-parse',head+'^{tree}'])!==commitTree)fail('V39_SEALED_HISTORY_TREE');}
  const value=parse(blob(context,revision,V39_INTEGRATION_BASELINE_PATH));
  keys(value,['schema','baseReportSha','baseReportTree','sourceSha','reportUniqueParent','qualification','receipts',
    'oldProductArtifactsRedownloadedOrReplayed','realApplicationServiceDeviceAudio','ownerAcceptance'],'V39_SEALED_BASELINE_FIELDS');
  if(value.schema!=='musicbridge.v39.integration.sealed-baseline.v1'||value.baseReportSha!==V39_INTEGRATION_BASE
    ||value.baseReportTree!==V39_INTEGRATION_BASE_TREE||value.sourceSha!==history[1][0]||value.reportUniqueParent!==history[1][0]
    ||value.qualification!=='SOURCE_AND_UNIQUE_DIRECT_REPORT_FIRST_NATURAL_CI_SEALED'||value.oldProductArtifactsRedownloadedOrReplayed!==false
    ||value.realApplicationServiceDeviceAudio!=='NOT_RUN'||value.ownerAcceptance!=='NOT_RUN'
    ||!Array.isArray(value.receipts)||value.receipts.length!==3)fail('V39_SEALED_BASELINE');
  const decoded=[];
  for(let i=0;i<3;i++){const receipt=value.receipts[i];keys(receipt,['name','bytes','sha256','rawBase64'],'V39_SEALED_RECEIPT');
    const want=baselineReceipts[i],raw=base64(receipt.rawBase64);
    if(receipt.name!==want.name||receipt.bytes!==want.bytes||receipt.sha256!==want.sha256
      ||raw.length!==want.bytes||hash(raw)!==want.sha256)fail('V39_SEALED_RECEIPT');decoded.push(parse(raw));}
  if(decoded[0].source!==history[1][0]||decoded[0].report!==V39_INTEGRATION_BASE
    ||decoded[0].status!=='SOURCE_AND_UNIQUE_DIRECT_REPORT_FIRST_NATURAL_CI_SEALED'
    ||decoded[1].revision!==history[1][0]||decoded[1].phase!=='source'||decoded[2].revision!==V39_INTEGRATION_BASE
    ||decoded[2].phase!=='report'||decoded.slice(1).some(v=>v.status!=='SEALED_FIRST_NATURAL_TOOL_CI_WITH_ORIGINAL_S165_SOFTWARE_REUSE'
      ||!equal(v.before,v.after)||v.before.status!==''||v.compiledAndApp!=='SKIPPED_REUSED_S165'||v.reruns!==0||v.dispatches!==0))
    fail('V39_SEALED_RECEIPT_IDENTITY');
  return true;
}
/** 原始commit+全部递归tree离线重算；不fetch未push donor，也不读另仓路径。 */
function offlineTape(context, revision) {
  const value=parse(blob(context,revision,V39_INTEGRATION_DONOR_PATH)), proof=value.gitObjectEvidence;
  if(value.schema!=='musicbridge.v39.integration.donor-readback.v1'||value.task!==V39_INTEGRATION_TASK
    ||value.targetBase!==V39_INTEGRATION_BASE||value.oldValidationIsHistorical!==true
    ||value.realProfileBackup!=='NOT_RUN'||value.realPhotoAssetsImportedToGit!==false||!Array.isArray(value.donors)||value.donors.length!==2
    ||!object(proof)||proof.networkFetchRequired!==false||proof.localDonorPathRequired!==false
    ||proof.foundationCommit!==foundation||!Array.isArray(proof.objects)||proof.objects.length!==198)fail('V39_OFFLINE_DONOR_HEADER');
  const objects=new Map();
  for(const row of proof.objects){keys(row,['type','oid','bytes','sha256','rawBase64'],'V39_OFFLINE_OBJECT');
    const raw=base64(row.rawBase64);
    if(!['commit','tree'].includes(row.type)||!sha(row.oid)||objects.has(row.oid)||row.bytes!==raw.length
      ||row.sha256!==hash(raw)||oidOf(row.type,raw)!==row.oid)fail('V39_OFFLINE_OBJECT');
    objects.set(row.oid,{type:row.type,raw});}
  const used=new Set();
  function traverse(oid,prefix,result,active){
    context.check();if(active.has(oid))fail('V39_OFFLINE_TREE_CYCLE');
    const record=objects.get(oid);if(!record||record.type!=='tree')fail('V39_OFFLINE_TREE_MISSING');used.add(oid);active.add(oid);
    const raw=record.raw;let position=0, previous=null;
    while(position<raw.length){const space=raw.indexOf(32,position),nul=raw.indexOf(0,space+1);
      if(space<position||nul<0||nul+21>raw.length)fail('V39_OFFLINE_TREE_FORMAT');
      const mode=decode(raw.subarray(position,space)),name=decode(raw.subarray(space+1,nul)),id=raw.subarray(nul+1,nul+21).toString('hex');
      if(!/^(40000|100644|100755|120000)$/u.test(mode)||!relative(name)||name.includes('/')||name==='.git')fail('V39_OFFLINE_TREE_FORMAT');
      const sortKey=Buffer.concat([Buffer.from(name),mode==='40000'?Buffer.from('/'):Buffer.alloc(0)]);
      if(previous&&Buffer.compare(previous,sortKey)>=0)fail('V39_OFFLINE_TREE_ORDER');previous=sortKey;
      const file=prefix+name;
      if(mode==='40000')traverse(id,file+'/',result,active);
      else {if(result.has(file)||result.size>=32768)fail('V39_OFFLINE_TREE_DUPLICATE');result.set(file,{path:file,mode,blob:id});}
      position=nul+21;
    }active.delete(oid);
  }
  const revisions=[['92956514474dc04c7100e52fe4138212278f1f9b',foundation,'55cc7bb7190aadd6854834eb4766b6c8065075ba'],
    ['6356aa3215364327f8a08783e0367dce51683ca1','92956514474dc04c7100e52fe4138212278f1f9b','4cb4f626e158adfd55b0334963170f4559350fd6']];
  let previous=tree(context,foundation);
  for(let i=0;i<2;i++){const [id,parent,rootTree]=revisions[i],donor=value.donors[i],commit=objects.get(id);
    if(!commit||commit.type!=='commit')fail('V39_OFFLINE_COMMIT_MISSING');used.add(id);
    const lines=decode(commit.raw).split('\n\n')[0].split('\n');
    if(!equal(lines.filter(line=>line.startsWith('tree ')),['tree '+rootTree])
      ||!equal(lines.filter(line=>line.startsWith('parent ')),['parent '+parent])
      ||donor.revision!==id||donor.parent!==parent||donor.tree!==rootTree)fail('V39_OFFLINE_COMMIT_IDENTITY');
    const current=new Map();traverse(rootTree,'',current,new Set());
    const changed=[...new Set([...previous.keys(),...current.keys()])].filter(file=>!equal(previous.get(file)??null,current.get(file)??null)).sort();
    const expected=tapePins.filter(row=>row.revision===id);
    if(!equal(changed,expected.map(row=>row.path).sort())||!Array.isArray(donor.files)||donor.files.length!==expected.length)
      fail('V39_OFFLINE_DELTA_NOT_EXACT');
    for(const want of expected){const row=donor.files.find(r=>r.path===want.path),actual=current.get(want.path),prior=previous.get(want.path);
      const old=V39_INTEGRATION_SOURCE_FILES.find(r=>r.path===want.path).before;
      if(!row||!actual||row.newBlob!==want.blob||row.newBytes!==want.bytes||row.newSha256!==want.sha256
        ||row.newMode!==want.mode||row.status!==(prior?'M':'A')||row.oldMode!==(prior?.mode??'000000')
        ||row.oldBlob!==(prior?.blob??'0'.repeat(40))||row.oldBytes!==old.bytes||row.oldSha256!==old.sha256
        ||actual.mode!==want.mode||actual.blob!==want.blob)fail('V39_OFFLINE_LEAF_PIN');
      const bytes=blob(context,revision,want.path);
      if(bytes.length!==want.bytes||hash(bytes)!==want.sha256||oidOf('blob',bytes)!==want.blob)fail('V39_DONOR_IMPORTED_BYTES');
    }
    previous=current;
  }
  if(used.size!==objects.size)fail('V39_OFFLINE_OBJECT_UNUSED');return true;
}
function sourceStatus(context, source) {
  const s=parse(blob(context,source,V39_INTEGRATION_STATUS_PATH));
  if(s.schema!=='musicbridge.v39.integration.status.v1'||s.task!==V39_INTEGRATION_TASK||s.branch!==V39_INTEGRATION_BRANCH
    ||s.baseReportSha!==V39_INTEGRATION_BASE||s.state!=='READY_FOR_SOURCE'||s.phase!=='SOURCE_FREEZE'
    ||s.sourceCommit!==null||s.reportCommit!==null||s.software!=='PENDING_GATE'||s.sourceCi!=='NOT_RUN'||s.reportCi!=='NOT_RUN'
    ||s.realApplicationServiceDeviceAudio!=='NOT_RUN'||s.ownerAcceptance!=='NOT_RUN'||s.nextTask!=='V39-INTEGRATION-002')fail('V39_SOURCE_STATUS_SELF_QUALIFICATION');
  const spec=parse(blob(context,source,V39_INTEGRATION_LOCAL_EVIDENCE_PATH));
  if(spec.schema!=='musicbridge.v39.integration.local-software-specification.v1'||spec.task!==V39_INTEGRATION_TASK
    ||spec.status!=='PENDING_GATE'||spec.old189Repeated!==false||spec.realApplicationServiceDeviceAudio!=='NOT_RUN'
    ||spec.ownerAcceptance!=='NOT_RUN')fail('V39_SOURCE_LOCAL_SPEC');
  const matrix=parse(blob(context,source,V39_INTEGRATION_MATRIX_PATH));
  if(matrix.schema!=='musicbridge.v39.integration.feature-behavior-matrix.v1'||matrix.task!==V39_INTEGRATION_TASK
    ||!Array.isArray(matrix.requirements)||matrix.requirements.length!==6||matrix.oldDonorSoftwareIsHistorical!==true
    ||matrix.futureFullCoverDrop?.task!=='V39-INTEGRATION-002'||matrix.futureFullCoverDrop.state!=='NOT_STARTED'
    ||matrix.requirements.some(row=>row.realRuntime!=='NOT_RUN'||row.ownerAcceptance!=='NOT_RUN'
      ||!['NOT_RUN','PENDING_GATE'].includes(row.software)))fail('V39_SOURCE_BEHAVIOR_MATRIX');
}
function registry(context, revision, role) {
  const statusBytes=blob(context,revision,'project/STATUS.json'),planBytes=blob(context,revision,'project/POSTRUST_PLAN.json');
  const status=parse(statusBytes),plan=parse(planBytes),record=status.v39Integration,entry=plan.integration_tasks?.[0],next=plan.integration_tasks?.[1];
  if(status.currentIntegrationTask!==V39_INTEGRATION_TASK||!object(record)||record.task!==V39_INTEGRATION_TASK
    ||record.branch!==V39_INTEGRATION_BRANCH||record.baseReportSha!==V39_INTEGRATION_BASE||record.scope!==V39_INTEGRATION_SCOPE_PATH
    ||record.realApplicationServiceDeviceAudio!=='NOT_RUN'||record.ownerAcceptance!=='NOT_RUN'||record.nextTask!=='V39-INTEGRATION-002'
    ||!Array.isArray(plan.integration_tasks)||plan.integration_tasks.length!==2||entry.id!==V39_INTEGRATION_TASK
    ||entry.branch!==V39_INTEGRATION_BRANCH||entry.base_report_sha!==V39_INTEGRATION_BASE||entry.scope_ref!==V39_INTEGRATION_SCOPE_PATH
    ||next.id!=='V39-INTEGRATION-002'||next.status!=='NOT_STARTED'||next.base_report_sha!==null||next.scope_ref!==null
    ||!equal(plan.integration_execution_schedule,{schema:'musicbridge.v39.integration.schedule.v1',current_task:V39_INTEGRATION_TASK,
      remaining_sequence:[V39_INTEGRATION_TASK,'V39-INTEGRATION-002','MBRS-016','MBRS-017'],predecessor_report_sha:V39_INTEGRATION_BASE,
      original_tasks_and_acceptance_unchanged:true,owner_repeated_approval_required:false}))fail('V39_REGISTRY_OR_SCHEDULE');
  if(role==='source'&&(record.status!=='READY_FOR_SOURCE'||record.phase!=='SOURCE_FREEZE'||record.software!=='PENDING_GATE'
    ||entry.status!=='READY_FOR_SOURCE'))fail('V39_REGISTRY_SOURCE_SELF_QUALIFICATION');
  if(/https?:\/\/|(?:token|cookie|password|secret)\s*[:=]/iu.test(JSON.stringify(record)))fail('V39_STATUS_PRIVATE_OR_URL_DATA');
}
function sourceObject(context, source) {
  if(source===V39_INTEGRATION_BASE||history.some(row=>row[0]===source))fail('V39_OLD_SOURCE_NOT_CURRENT');
  parents(context,source,V39_INTEGRATION_BASE);
  exactDiff(rawDiff(context,V39_INTEGRATION_BASE,source),V39_INTEGRATION_SOURCE_FILES.map(row=>({path:row.path,status:row.status,
    oldMode:row.before.mode,oldBlob:row.before.blob,newMode:row.newMode})));
  const names=V39_INTEGRATION_SOURCE_FILES.map(row=>row.path),sourcePins=actualPins(context,source,names);
  const scopeRaw=blob(context,source,V39_INTEGRATION_SCOPE_PATH),scope=assertV39IntegrationScope(parse(scopeRaw),scopeRaw);
  for(let i=0;i<39;i++){const row=sourcePins[i],want=scope.finalFiles[i],old=V39_INTEGRATION_SOURCE_FILES[i];
    if(old.status==='M'){const raw=blob(context,V39_INTEGRATION_BASE,row.path);
      if(raw.length!==old.before.bytes||hash(raw)!==old.before.sha256)fail('V39_BASE_PIN_CHANGED');}
    if(row.mode!==want.mode||row.bytes!==want.bytes||row.path!==V39_INTEGRATION_SCOPE_PATH
      &&(row.blob!==want.blob||row.sha256!==want.sha256))fail('V39_FROZEN_SOURCE_PIN_CHANGED');}
  protectedJson(blob(context,V39_INTEGRATION_BASE,'project/STATUS.json'),blob(context,source,'project/STATUS.json'),
    ['currentIntegrationTask','v39Integration'],'V39_SOURCE_STATUS_OUTSIDE_DOMAIN');
  protectedJson(blob(context,V39_INTEGRATION_BASE,'project/POSTRUST_PLAN.json'),blob(context,source,'project/POSTRUST_PLAN.json'),
    ['integration_tasks','integration_execution_schedule'],'V39_SOURCE_PLAN_OUTSIDE_DOMAIN');
  for(const file of ['project/POSTRUST_TODO.md','project/POSTRUST_PROGRESS.md','tasks/00_TASK_INDEX.md']){
    if(!blob(context,source,file).subarray(0,blob(context,V39_INTEGRATION_BASE,file).length).equals(blob(context,V39_INTEGRATION_BASE,file)))
      fail('V39_SOURCE_MARKDOWN_NOT_APPEND');}
  if(!decode(blob(context,source,'tasks/00_TASK_INDEX.md')).includes(V39_INTEGRATION_TASK)
    ||!decode(blob(context,source,'tasks/V39-INTEGRATION-001.md')).includes(V39_INTEGRATION_BASE))fail('V39_SOURCE_TASK_INDEX');
  sourceStatus(context,source);registry(context,source,'source');
  sealedBaseline(context,source);offlineTape(context,source);
  return {sourceSha:source,sourceParentSha:V39_INTEGRATION_BASE,sourceTree:context.text(['rev-parse',source+'^{tree}']),
    sourcePins,scopeSha256:hash(scopeRaw),sealedBaselinePreserved:true,offlineTapeDonorVerified:true,exactSourceFiles:39};
}

export const V39_INTEGRATION_ADMISSION_CASE_NAMES = freeze([
  'V39 Tape Source只接受冻结39路径及真实单父基线',
  'V39 Tape 开发Scope与自报软件成功不能取得CI资格',
  'V39 Tape 多父错误前序及未知分支不能继承准入',
  'V39 Tape 第40路径删除重命名及模式漂移被拒绝',
  'V39 Tape 冻结新叶与Scope固定点字节漂移被拒绝',
  'V39 Tape 历史004及修复规则字节不进入新Scope',
  'V39 Tape 机器旧域大整数和原账本连续保留',
  'V39 Tape 离线donor完整树闭包与15叶身份连续验证',
  'V39 Tape dirty Git重定向浅clone及索引隐藏不能取得资格',
  'V39 Tape 真实准入结果不能由克隆对象签发workflow输出',
]);
export const V39_INTEGRATION_REPORT_CASE_NAMES = freeze([
  'V39 Tape 当前Source必须执行软件且不访问报告API',
  'V39 Tape 唯一直接Report精确3A5M继承当前Source产品证据',
  'V39 Tape 第9报告路径与产品叶变动不能跳软件',
  'V39 Tape Report旧机器数字与授权域外语义保持',
  'V39 Tape 旧165或修复工具CI不能替代当前产品Source',
  'V39 Tape 四workflow六job和五whole制品producer闭合',
  'V39 Tape 失败重试重复producer及假skipped产品不能复用',
  'V39 Tape summary原字节stage完整raw预算和物理关闭连续绑定',
  'V39 Tape 报告API仅接受当前同producer且身份读回不漂移',
  'V39 Tape 非公开hosted坏报告和API失败不签发复用资格',
]);
const fixedTapeNames=freeze(["合成634条完整目录包含16条缺主图，同书多来源只读一次当前版次，不创建库存","品牌→型号→原书年份仅做UI分组，同型号各年份与未知保留，IEC和系列差异可辨","完整目录搜索型号、原书页与说明，品牌和带型筛选不混入库存事实","读取身份已变化的目录不返回旧来源，当前发布来源不在首页时精确读取","26个同书历史来源按25条分页完整收集，同书当前版次只读一次","第二页的新书也读取当前条目，不把第一页结果静默当完整目录","来源超过总预算、后页缺条目或总数漂移时明确失败，不返回截断目录","归档原书图可作为同型号候选，缺主图与非法资产不补位，旧内嵌图继续可用","完整ZIP选择只预览，确认后绑定原预览和dataset，未知回执仅恢复同一命令","导入单飞，关闭后迟到回执不更新局部状态或触发目录导航","取消重新选择保留原预览；选择失败不暴露Main文件路径","实际关联审核面板接收资料条目后只读定位当前来源与review步骤，不触发库存写入","实际完整详情组件切换条目时旧全文回执不能覆盖新条目，年份保持原书证据","实际详情顶部优先原书原图，辅助画廊排除同一主图，兼容旧base资产","实际资料浏览组件层级可回退，搜索结果直接打开具体reference，无需三次点击","资料详情添加收藏只预填已知品牌型号和IEC，实物年份、版次、数量必须按原校验保存","实际完整ZIP预览展示同ID资料字段更新数量和完整ID，兼容旧delta没有更新字段","实际收藏页默认634新版，旧656可独立浏览且切换不丢库存参考候选","旧历史读取失败保留当前目录和已读参考，迟到的旧读取不覆盖较新刷新","历史头部缺根明确提示，已读历史与库存参考候选保留","较新当前目录读取失败结束历史加载状态，旧异步完成不能覆盖失败提示","资料范围切换清空旧详情与层级，历史详情阻止编辑关联但保留原库存入口与明确添加操作","完整ZIP预览准确显示634新版与656旧编号保留，预览阶段不调用导入","同型号参考候选保留多个版次，不把 SA 当 SA-X，也不改变库存","明确年份或版次不匹配时不拿相似图片补位","书中图名允许空格大小写差异，不接受缺品牌的泛匹配","只使用资料中明确登记的参考图别名，长度和颜色后缀不自动删除","收藏墙在实物照片缺席时显示带来源的参考候选，详情保留全部版次","参考图只读取每本书的当前发布版本，同书多个来源不重复读取","参考来源超出加载预算或读取失败时不伪装为空目录","历史目录严格按原revision和来源身份读取，旧关联不从当前目录回填","历史链循环、错序或缺根明确拒绝，合法链按最近版次顺序保留旧编号","634项完整档案一次原子登记发布，16缺主图保持unknown且全部既有个人数据逐行守恒","完整self mapping保留全部匹配状态和旧修订，资料字段变化明确列入preview delta","同一来源原子发布失败回滚所有表，既有sources/revisions/links原样保留，原命令可明确重试","相同ID身份改变在写入前阻断；缺席新版的ID须精确保留在原历史而不推测映射","NFKC与大小写身份相同仍可自映射，非身份字段变化显式预览而不改旧referenceId","档案哈希混用、超预算原文和附带未知字段均不能登记来源或写入目录","预览绑定原文、工作库、匹配和库存事实，任一改变均拒绝旧指纹而不产生半条来源","同ZIP同命令与新命令均幂等，后续用户改版后旧命令只返原回执且新导入禁止倒退","archive-import回执和完整绑定通过冷开/只读备份校验，原命令结果与个人资料继续保留","656旧编号和634新编号零交集，旧库存关联/愿望/进度与个人数据保留，新资料不推断拥有","部分交集仅沿用相同编号，退出当前版的关联保留在原修订而不自动迁移","退出编号再次出现时核对其最近历史身份，不回填更早历史或绕过身份保护","暖开库在预览后缺失旧快照时拒绝无证明导入，所有表相对故障注入后保持原值","合法形状但匹配事实错误的旧快照不能作为历史保留证明","旧库存合法变化允许新预览，预览后的库存变化使历史保留指纹失效","暖开目录注入循环修订链后停止导入，不能仅凭旧编号存在而放行","暖开目录注入错误顺序修订链后停止导入，不能仅凭旧编号存在而放行","暖开目录注入缺根修订链后停止导入，不能仅凭旧编号存在而放行","暖开目录注入跨书修订链后停止导入，不能仅凭旧编号存在而放行","参考图别名带核对说明且有界，不改变目录身份或默默吞掉冲突","带图修订接受有界多图内容，原资料入口仍为1MiB且超大修订拒绝","参考资料iec只接受字符串枚举，原JSON与IPC/outbox拒绝数组强制转换","参考资料confidence只接受字符串枚举，原JSON与IPC/outbox拒绝数组强制转换","目录审核status只接受字符串枚举，setMatch与IPC/outbox拒绝非字符串","目录审核availability只接受字符串枚举，setMatch与IPC/outbox拒绝非字符串","资料原文可保留BOM/空白，严格解析且不隐式生成来源","完整目录支持654至2000条，数量与字节预算仍独立生效","同参考项重复页及时长归并，冲突版次或重复canonical身份拒绝","参考图只允许明确参考来源与受限内嵌JPEG，无外网或私有路径","发布要求原基线指纹与确认；映射仅有限合并或拆分","未匹配不等于Missing，候选/拆分待审不伪装已确认拥有","snapshot是有界一致时点事实，不接受额外路径或不守恒counts","新增写命令均进入有限outbox且响应按命令校验，读命令不能重放","revision响应按字段事实比较match且历史snapshot不可串接其它canonical","UTF8按字节限额，未知字段和稀疏数组不能绕过有界输入","2000项完整目录响应保持关联保护，成员访问量随目录线性增长","目录修订映射的成员校验保持完整，访问量随条目与映射数量增长","档案绑定只携带完整ZIP哈希和安全逻辑主图编号，旧图片合同继续可用","634项档案目录包含16个明确缺主图项目，仍使用1MiB原文预算且不以图片增加身份","档案预览与导入请求绑定工作库和原基线，不接收路径、原文、图片或自定义映射","保留ID的资料变化可在delta明确列出，旧预览兼容且变化只能指向保留成员","历史保留证明只允许精确的退出编号集合和有界修订快照身份，写请求不能携带伪造证明"]);
const fixedIntegrationNames=freeze(["当前Main完整ZIP预览经真实Owner与持久outbox保留旧目录及个人关联","当前进度缓存仅单操作复用且Tape历史事实在冷开后重新核对","合成两库Owner自然关闭后隔离备份恢复保留回执与历史并释放真实资源","组合Gate精确Tape74名称与完整TAP不能被缺例重复或skip替代","组合Gate标准日志必须完整自然结束且原退出码与字节身份匹配","组合Gate拒绝输出复用路径越界符号链与Node覆盖","组合Gate当前准入与输入绑定不得以普通声明或漂移冒充","组合Gate真实子进程自然退出完整raw与物理关闭","组合Gate超时输出溢出与管道残留均不能写PASS","组合Gate报告继承产品证据明确区分本轮执行和Source复用"]);
export const V39_INTEGRATION_WORKFLOWS = freeze([
  '.github/workflows/verify.yml','.github/workflows/security.yml',
  '.github/workflows/rust-core.yml','.github/workflows/electron-e2e.yml',
]);
const jobsByWorkflow = freeze([['verify','dependency-audit'],['static-security'],
  ['rust-core (ubuntu-latest)','rust-core (macos-latest)'],['macos-electron-gate']]);
const productSteps = freeze({
  verify:['Install frozen workspace','Validate control plane','Validate security and product boundaries',
    'Scan workspace import cycles','Verify platform-independent workspace (typecheck, unit tests, build; no Electron)'],
  'dependency-audit':['Install frozen workspace','Production dependency audit'],
  'static-security':['Install frozen workspace','Validate machine control state',
    'Run boundary, loopback, secret and URL/query scans','Scan workspace import cycles',
    'Run directed platform-independent security tests (no Electron)'],
  'rust-core (ubuntu-latest)':['安装固定 Rust 工具链','安装冻结工作区依赖','验证实际 Rust 与 TypeScript 边界','保留编译器、测试及源码与二进制清单'],
  'rust-core (macos-latest)':['安装固定 Rust 工具链','安装冻结工作区依赖','验证实际 Rust 与 TypeScript 边界','保留编译器、测试及源码与二进制清单'],
  'macos-electron-gate':['Install frozen workspace','Prepare fresh Core fixed Worker before existing Electron gates',
    'Prepare Rust toolchain','Build and verify both Rust hosts once in this job',
    'Install Electron binary from locked tree (official installer only)','Verify official Electron archive and actual execution tree',
    'Electron startup, crash/restart, safeStorage vault and credential recovery gates',
    'Electron end-to-end flow (Playwright, production build)','Select declared synthetic Rust Host artifacts',
    'Preserve declared synthetic Rust Host compiled artifacts','Preserve Electron logs and synthetic test artifacts'],
});
const oldCurrentGateSteps = freeze(['验证报告CI准入正负例','CI报告镜像历史对象修复工具 Gate',
  'CI报告元数据修复工具 Gate','保留本次CI修复工具证据','保留本次CI报告元数据工具证据','Preserve full verification log']);
const stepIs = (job,name,conclusion) => {
  const selected=job.steps.filter(row=>row?.name===name);
  return selected.length===1&&selected[0].status==='completed'&&selected[0].conclusion===conclusion;
};
const artifactNames = source => [['verify-'+source],[],['rust-core-ubuntu-latest-'+source,'rust-core-macos-latest-'+source],
  ['rust-host-compiled-'+source,'electron-e2e-'+source]];
/** 六个本次实际产品job全部自然成功；旧修复Source的skipped产品不具备替代资格。 */
export function validateV39IntegrationParentCi(input) {
  try {
    const {task,repositoryId,parent,branch,runs,proofs,now=Date.now()}=input??{};
    canonical(input);
    if(task!==V39_INTEGRATION_TASK||repositoryId!==V39_INTEGRATION_REPOSITORY_ID||!sha(parent)
      ||history.some(row=>row[0]===parent)||branch!==V39_INTEGRATION_BRANCH||!Number.isFinite(now)
      ||!Array.isArray(runs)||runs.length!==4||!Array.isArray(proofs)||proofs.length!==4)return false;
    const runIds=new Set(),jobIds=new Set(),artifactIds=new Set(),names=artifactNames(parent);
    for(let i=0;i<4;i++){
      const selected=runs.filter(run=>run?.path===V39_INTEGRATION_WORKFLOWS[i]);if(selected.length!==1)return false;
      const run=selected[0],found=proofs.filter(proof=>proof?.runId===run.id);if(found.length!==1)return false;
      const proof=found[0];
      if(!positive(run.id)||runIds.has(run.id)||run.repository?.id!==repositoryId||run.head_repository?.id!==repositoryId
        ||run.repository.full_name!==V39_INTEGRATION_REPOSITORY||run.head_repository.full_name!==V39_INTEGRATION_REPOSITORY
        ||run.head_sha!==parent||run.head_branch!==branch||run.event!=='push'||run.run_attempt!==1
        ||run.status!=='completed'||run.conclusion!=='success'||!Array.isArray(proof.jobs)
        ||!equal(proof.jobs.map(job=>job.name).sort(),[...jobsByWorkflow[i]].sort())
        ||!Array.isArray(proof.artifacts)||!equal(proof.artifacts.map(artifact=>artifact.name).sort(),[...names[i]].sort()))return false;
      runIds.add(run.id);
      for(const job of proof.jobs){
        if(!positive(job.id)||jobIds.has(job.id)||job.run_id!==run.id||job.head_sha!==parent
          ||job.status!=='completed'||job.conclusion!=='success'||!Array.isArray(job.steps)
          ||new Set(job.steps.map(step=>step.name)).size!==job.steps.length
          ||!stepIs(job,V39_INTEGRATION_GUARD_STEP,'success')
          ||!stepIs(job,'CI报告元数据精确身份与原软件复用准入','skipped')
          ||!stepIs(job,'CI修复精确身份与原软件复用准入','skipped')
          ||!stepIs(job,'复用165已封存产品软件证据','skipped')
          ||!stepIs(job,'复用本次精确父Source产品软件证据','skipped')
          ||productSteps[job.name].some(name=>!stepIs(job,name,'success')))return false;
        if(job.name==='verify'&&([V39_INTEGRATION_GATE_STEP,V39_INTEGRATION_UPLOAD_STEP,
          'Prepare source-pinned build workspace mirror','准备准入正负例的精确历史Git对象',
          '判定精确父源码CI可复用的报告提交','组合任务与精确前序证据准入','Diff whitespace'].some(name=>!stepIs(job,name,'success'))
          ||oldCurrentGateSteps.some(name=>!stepIs(job,name,'skipped'))))return false;
        jobIds.add(job.id);
      }
      for(const artifact of proof.artifacts){
        if(!positive(artifact.id)||artifactIds.has(artifact.id)||artifact.expired!==false
          ||!positive(artifact.size_in_bytes)||artifact.size_in_bytes>4*1024*1024*1024
          ||!/^sha256:[a-f0-9]{64}$/u.test(artifact.digest??'')
          ||!Number.isFinite(Date.parse(artifact.expires_at))||Date.parse(artifact.expires_at)<=now
          ||artifact.workflow_run?.id!==run.id||artifact.workflow_run.head_sha!==parent
          ||artifact.workflow_run.repository_id!==repositoryId||artifact.workflow_run.head_repository_id!==repositoryId)return false;
        artifactIds.add(artifact.id);
      }
    }
    return runIds.size===4&&jobIds.size===6&&artifactIds.size===5;
  }catch{return false;}
}
const pinValid = value => object(value)&&typeof value.path==='string'&&value.path.length>0
  &&!/\p{Cc}/u.test(value.path)&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&sha256(value.sha256);
const digestPinValid=value=>object(value)&&equal(Object.keys(value).sort(),['bytes','sha256'])
  &&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&sha256(value.sha256);
const emptyHash=hash(Buffer.alloc(0));
function completeStage(stage) {
  return object(stage)&&stage.passed===true&&stage.exitCode===0&&stage.signal===null&&stage.timedOut===false
    &&stage.overflow===false&&stage.cleanupFailed===false&&stage.exitObserved===true&&stage.closeObserved===true
    &&stage.spawnFailed===false&&stage.interrupted===false&&stage.lingeringOwnedGroup===false
    &&stage.physicalShutdown?.pidAbsent===true&&stage.physicalShutdown.processGroupAbsent===true
    &&stage.observedDescendantsAbsent===true&&Array.isArray(stage.observedDescendants)
    &&stage.observedDescendants.every(row=>row?.physicallyAbsent===true)
    &&stage.descendantScanFailed===false&&stage.rawForcedClosed===false&&stage.boundedSettleObserved===false
    &&stage.unexpectedPipeHolder===false&&stage.terminationRequested===false&&stage.rawCaptureComplete===true
    &&stage.rawCaptureScope==='FULL_SEPARATE_STDOUT_STDERR_BYTES_UNTIL_CLOSE_WITH_FIXED_BOUNDS'
    &&Number.isFinite(stage.durationMs)&&stage.durationMs>=0&&Number.isFinite(stage.budgetMs)
    &&stage.budgetMs>0&&stage.budgetMs<=90000&&stage.durationMs<=stage.budgetMs
    &&object(stage.raw)&&equal(Object.keys(stage.raw).sort(),['stderr','stdout']);
}
function wholeArtifact(artifact, platform) {
  if(!object(artifact)||artifact.id!==platform.id||artifact.name!==platform.name||!pinValid(artifact.zip)
    ||artifact.zip.bytes!==platform.size_in_bytes||'sha256:'+artifact.zip.sha256!==platform.digest
    ||artifact.allMembersBytesAndCrcRead!==true||artifact.credentialsArchived!==false
    ||artifact.signedRedirectArchived!==false||artifact.authorizationForwardedAcrossHosts!==false
    ||!Array.isArray(artifact.members)||!artifact.members.length||artifact.members.length>32768
    ||new Set(artifact.members.map(row=>row.path)).size!==artifact.members.length
    ||!Number.isSafeInteger(artifact.expandedBytes)||artifact.expandedBytes<0||artifact.expandedBytes>4*1024*1024*1024
    ||artifact.expandedBytes!==artifact.members.reduce((total,row)=>total+row.bytes,0))return false;
  return artifact.members.every(row=>pinValid(row)&&relative(row.path.endsWith('/')?row.path.slice(0,-1):row.path)
    &&equal(Object.keys(row).sort(),['bytes','crc32','path','sha256'])&&Number.isSafeInteger(row.crc32)
    &&row.crc32>=0&&row.crc32<=0xffffffff);
}
function fixedSourcePins(pins) {
  return Array.isArray(pins)&&pins.length===39&&pins.every((pin,i)=>pin.path===V39_INTEGRATION_SOURCE_FILES[i].path
    &&pinValid(pin)&&pin.mode==='100644'&&sha(pin.blob));
}
const toolStages=freeze(['original-173','tape-74','integration-safety','admission-safety','control-plane','boundaries','cycles']);
const toolFrameMagic=Buffer.from('MusicBridgeV39RootRecords\0v1\n','utf8');
export const V39_INTEGRATION_TOOL_ROOT_LIMITS=freeze({recordBytes:16777216,frameBytes:67108864,canonicalBytes:16777216});
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let bit=0;bit<8;bit++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function toolCrc(bytes) { let c=0xffffffff;for(const byte of bytes)c=crcTable[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0; }
function toolRootNames(phase) {
  if(!['source','report'].includes(phase))fail('V39_TOOL_PHASE');
  return ['summary.json','source-before.json','source-after.json','integration-case-proof.json',
    ...(phase==='source'?['fresh-reader.json','verify.log','standard-verification.json']:[]),
    ...toolStages.filter(name=>phase==='source'||name!=='tape-74')
      .flatMap(name=>[name+'.json',name+'.stdout.log',name+'.stderr.log'])].sort();
}
/** 压缩完整原件只减少重复表示；单件、整体展开和外层JSON均保留固定边界。 */
export function encodeV39IntegrationToolContent(records,phase) {
  const expected=toolRootNames(phase);
  if(!Array.isArray(records)||types.isProxy(records)||records.length!==expected.length||Object.getOwnPropertySymbols(records).length
    ||!equal(Object.getOwnPropertyNames(records),[...Array.from({length:records.length},(_row,i)=>String(i)),'length']))fail('V39_TOOL_ROOT_CLOSEDSET');
  const sorted=[];
  for(let i=0;i<records.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(records,String(i));
    if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('V39_TOOL_ROOT_FIELDS');
    const row=descriptor.value;
    if(!object(row)||types.isProxy(row)||Object.getOwnPropertySymbols(row).length
      ||![Object.prototype,null].includes(Object.getPrototypeOf(row)))fail('V39_TOOL_ROOT_FIELDS');
    keys(row,['path','bytes'],'V39_TOOL_ROOT_FIELDS');
    for(const key of ['path','bytes'])if(!Object.hasOwn(Object.getOwnPropertyDescriptor(row,key),'value'))fail('V39_TOOL_ROOT_FIELDS');
    if(!relative(row.path)||!Buffer.isBuffer(row.bytes)||types.isProxy(row.bytes)
      ||row.bytes.length>V39_INTEGRATION_TOOL_ROOT_LIMITS.recordBytes)fail('V39_TOOL_ROOT_FIELDS');
    sorted.push({path:row.path,bytes:Buffer.from(row.bytes)});
  }
  sorted.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(!equal(sorted.map(row=>row.path),expected))fail('V39_TOOL_ROOT_CLOSEDSET');
  const count=Buffer.alloc(2);count.writeUInt16BE(sorted.length);
  let rawBytes=toolFrameMagic.length+count.length;
  const parts=[toolFrameMagic,count],entries=[];
  for(const row of sorted){
    const name=Buffer.from(row.path,'utf8'),header=Buffer.alloc(6);
    header.writeUInt16BE(name.length);header.writeUInt32BE(row.bytes.length,2);
    rawBytes+=header.length+name.length+row.bytes.length;
    if(rawBytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.frameBytes)fail('V39_TOOL_FRAME_BUDGET');
    parts.push(header,name,row.bytes);entries.push({path:row.path,bytes:row.bytes.length,sha256:hash(row.bytes),crc32:toolCrc(row.bytes)});
  }
  const frame=Buffer.concat(parts,rawBytes),compressed=gzipSync(frame,{level:9});
  const result={entry:'summary.json',phase,encoding:'gzip-root-records-v1',rootArchive:{
    schema:'musicbridge.v39.integration.gzip-root-records.v1',entries,rawBytes,sha256:hash(frame),
    gzip:{bytes:compressed.length,sha256:hash(compressed),base64:compressed.toString('base64')}}};
  canonical(result);
  return freeze(result);
}
/** 返回从原始summary字节解析的正文与独立原件Buffer，不接受额外或伪造继承文件。 */
export function decodeV39IntegrationToolContent(content) {
  canonical(content);
  keys(content,['entry','phase','encoding','rootArchive'],'V39_TOOL_CONTENT_FIELDS');
  if(content.entry!=='summary.json'||content.encoding!=='gzip-root-records-v1')fail('V39_TOOL_CONTENT_ENCODING');
  const expected=toolRootNames(content.phase),archive=content.rootArchive;
  keys(archive,['schema','entries','rawBytes','sha256','gzip'],'V39_TOOL_ARCHIVE_FIELDS');
  keys(archive.gzip,['bytes','sha256','base64'],'V39_TOOL_GZIP_FIELDS');
  if(archive.schema!=='musicbridge.v39.integration.gzip-root-records.v1'||!Array.isArray(archive.entries)
    ||!equal(archive.entries.map(row=>row.path),expected)||!positive(archive.rawBytes)
    ||archive.rawBytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.frameBytes||!sha256(archive.sha256)
    ||!positive(archive.gzip.bytes)||archive.gzip.bytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.canonicalBytes
    ||!sha256(archive.gzip.sha256))fail('V39_TOOL_ARCHIVE_BUDGET');
  for(const entry of archive.entries){
    keys(entry,['path','bytes','sha256','crc32'],'V39_TOOL_ARCHIVE_ENTRY');
    if(!pinValid(entry)||entry.bytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.recordBytes
      ||!Number.isSafeInteger(entry.crc32)||entry.crc32<0||entry.crc32>0xffffffff)fail('V39_TOOL_ARCHIVE_ENTRY');
  }
  const expectedFrameBytes=toolFrameMagic.length+2+archive.entries.reduce((sum,entry)=>sum+6+Buffer.byteLength(entry.path,'utf8')+entry.bytes,0);
  if(expectedFrameBytes!==archive.rawBytes)fail('V39_TOOL_FRAME_LENGTH');
  const compressed=base64(archive.gzip.base64);
  if(compressed.length!==archive.gzip.bytes||hash(compressed)!==archive.gzip.sha256)fail('V39_TOOL_GZIP_HASH');
  let expanded;
  try { expanded=gunzipSync(compressed,{maxOutputLength:archive.rawBytes,info:true}); }
  catch { fail('V39_TOOL_GZIP_BOUNDED_DECODE'); }
  const frame=expanded.buffer;
  if(expanded.engine.bytesWritten!==compressed.length||frame.length!==archive.rawBytes||hash(frame)!==archive.sha256
    ||!frame.subarray(0,toolFrameMagic.length).equals(toolFrameMagic)
    ||frame.length<toolFrameMagic.length+2||frame.readUInt16BE(toolFrameMagic.length)!==expected.length)fail('V39_TOOL_FRAME_HEADER');
  const rootRecords=new Map();let position=toolFrameMagic.length+2;
  for(const entry of archive.entries){
    if(position+6>frame.length)fail('V39_TOOL_FRAME_LENGTH');
    const nameLength=frame.readUInt16BE(position),size=frame.readUInt32BE(position+2);position+=6;
    if(nameLength===0||nameLength>4096||size>V39_INTEGRATION_TOOL_ROOT_LIMITS.recordBytes
      ||position+nameLength+size>frame.length)fail('V39_TOOL_FRAME_LENGTH');
    const name=decode(frame.subarray(position,position+nameLength));position+=nameLength;
    const bytes=frame.subarray(position,position+size);position+=size;
    if(name!==entry.path||size!==entry.bytes||hash(bytes)!==entry.sha256||toolCrc(bytes)!==entry.crc32)fail('V39_TOOL_ROOT_HASH');
    rootRecords.set(name,Buffer.from(bytes));
  }
  if(position!==frame.length)fail('V39_TOOL_FRAME_TRAILING_BYTES');
  const summary=parse(rootRecords.get('summary.json'));canonical(summary);
  return {summary,rootRecords};
}
export function v39IntegrationSourceSummary(fullCi) {
  if(!sha(fullCi?.revision)||!Array.isArray(fullCi.artifacts))fail('V39_TOOL_ARTIFACT');
  const artifacts=fullCi.artifacts.filter(row=>row?.name==='verify-'+fullCi.revision);
  if(artifacts.length!==1||artifacts[0].toolContent?.phase!=='source')fail('V39_TOOL_ARTIFACT');
  return decodeV39IntegrationToolContent(artifacts[0].toolContent).summary;
}
function toolBytes(artifact, summary, decoded=decodeV39IntegrationToolContent(artifact.toolContent)) {
  const {rootRecords:root,summary:actual}=decoded,expected=toolRootNames(artifact.toolContent.phase);
  if(!equal(actual,summary)||!equal(artifact.members.map(row=>row.path).sort(),expected))fail('V39_TOOL_ROOT_CLOSEDSET');
  const manifest=new Map(artifact.members.map(row=>[row.path,row]));
  for(const [name,bytes] of root){const pin=manifest.get(name);
    if(!pin||pin.bytes!==bytes.length||pin.sha256!==hash(bytes)||pin.crc32!==toolCrc(bytes))fail('V39_TOOL_ROOT_HASH');}
  if(!equal(parse(root.get('source-before.json')),summary.sourceBefore)
    ||!equal(parse(root.get('source-after.json')),summary.sourceAfter))fail('V39_TOOL_SOURCE_RAW');
  for(const stage of summary.stages){
    if(!equal(parse(root.get(stage.name+'.json')),stage))fail('V39_TOOL_STAGE_RAW');
    for(const stream of ['stdout','stderr']){
      const pin=stage.raw[stream],bytes=root.get(stage.name+'.'+stream+'.log');
      if(!pinValid(pin)||pin.path!==stage.name+'.'+stream+'.log'||pin.bytes!==bytes.length||pin.sha256!==hash(bytes)
        ||bytes.length>16777216)fail('V39_TOOL_STAGE_RAW');
    }
  }
  return root;
}
function freshReaderValid(reader, productInputs) {
  const receipt=reader?.receipt;
  if(!object(reader)||!object(receipt)||receipt.schema!=='core-test.reader-preparation.v1'
    ||receipt.status!=='FRESH_READER_PREPARED'||receipt.inputsUnchanged!==true||receipt.outputsUnchanged!==true
    ||!pinValid(reader.receiptPin)||!pinValid(reader.bindingPin)||!pinValid(reader.fixedWorkerReceiptPin)
    ||receipt.readerBindingSha256!==reader.bindingPin.sha256||!object(reader.binding)||!object(reader.fixedWorkerReceipt)
    ||reader.currentOutputBytesChecked!==true||reader.preparationIntervalsClaimedOnlyForTheirOriginalStages!==true
    ||reader.currentWorkerIndependentlyVerified!==true||!Array.isArray(receipt.sourceInputs)||!receipt.sourceInputs.length
    ||reader.sourceInputsIndependentlyMatchedToActualGit!==receipt.sourceInputs.length
    ||!Array.isArray(receipt.outputs)||!receipt.outputs.length||receipt.outputs.some(row=>!pinValid(row))
    ||!Array.isArray(reader.currentOutputs)||reader.currentOutputs.length!==receipt.outputs.length
    ||reader.currentOutputs.some(row=>!pinValid(row)||!sha(row.blob)||!['100644','100755'].includes(row.mode))
    ||!Array.isArray(receipt.stages)||!equal(receipt.stages.map(row=>row.name),
      ['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'])
    ||receipt.stages.some(row=>row.compilerExit!==0||!Number.isFinite(row.startedMs)||!Number.isFinite(row.finishedMs)
      ||row.finishedMs<row.startedMs)||!Array.isArray(productInputs)||!productInputs.length)return false;
  for(const pin of receipt.sourceInputs){
    if(!pinValid(pin))return false;
    const matching=productInputs.filter(row=>row.path===pin.path);
    if(matching.length!==1||matching[0].bytes!==pin.bytes||matching[0].sha256!==pin.sha256)return false;
  }
  for(const row of reader.currentOutputs){
    const previous=receipt.outputs.filter(pin=>pin.path===row.path);
    if(previous.length!==1||!row.path.endsWith('.bundle.build.json')
      &&(row.bytes!==previous[0].bytes||row.sha256!==previous[0].sha256))return false;
  }
  return true;
}
function standardValid(standard, summary, root) {
  const r=standard?.receipt;
  if(standard?.status!=='PASSED_CURRENT_SOURCE_STANDARD_VERIFICATION'||!object(r)
    ||r.schema!=='musicbridge.v39.integration.standard-verification.v1'
    ||r.status!==standard.status||r.task!==V39_INTEGRATION_TASK||r.sourceSha!==summary.sourceSha
    ||r.scopeSha256!==summary.sourceBefore.admission.scopeSha256||!pinValid(standard.receiptPin)
    ||!pinValid(standard.artifactRaw)||standard.artifactRaw.path!=='verify.log'
    ||!pinValid(standard.artifactReceipt)||standard.artifactReceipt.path!=='standard-verification.json'
    ||standard.artifactRaw.bytes!==root.get('verify.log').length||standard.artifactRaw.sha256!==hash(root.get('verify.log'))
    ||standard.artifactReceipt.bytes!==root.get('standard-verification.json').length
    ||standard.artifactReceipt.sha256!==hash(root.get('standard-verification.json'))
    ||standard.receiptPin.bytes!==standard.artifactReceipt.bytes||standard.receiptPin.sha256!==standard.artifactReceipt.sha256
    ||!equal(parse(root.get('standard-verification.json')),r)||!pinValid(r.raw)||r.raw.bytes!==standard.artifactRaw.bytes
    ||r.raw.sha256!==standard.artifactRaw.sha256||r.verifyExit!==0||r.teeExit!==0||r.pipelineNaturallyEnded!==true
    ||r.physicalClosureClaim!=='NATURAL_PNPM_AND_TEE_PIPELINE_EXIT_NOT_TOOL_GATE_PID_ATTESTATION'
    ||r.complete!==true||r.typesTestsAndBuildsNaturallySucceeded!==true||r.mergedStandardRaw!==true
    ||!equal(r.before,r.after)||r.before?.identity?.head!==summary.sourceSha||r.before.identity.status!==''
    ||r.before.identity.tree!==summary.sourceBefore.identity.tree
    ||!equal(r.before.currentFiles,summary.sourceBefore.currentFiles)||!equal(r.before.productInputs,summary.sourceBefore.productInputs)
    ||!Array.isArray(r.tapRuns)||r.tapRuns.length!==4||!Array.isArray(r.skippedCases)
    ||r.tapRuns.some(t=>!Number.isSafeInteger(t.tests)||t.tests<=0||t.suites!==0||t.fail!==0||t.cancelled!==0||t.todo!==0
      ||t.pass+t.skipped!==t.tests)||!Number.isFinite(r.startedAtMs)||!Number.isFinite(r.finishedAtMs)
    ||r.finishedAtMs<r.startedAtMs||!equal(r.freshReader,summary.sourceBefore.freshReader))return false;
  const totals=Object.fromEntries(['tests','suites','pass','fail','cancelled','skipped','todo']
    .map(label=>[label,r.tapRuns.reduce((sum,t)=>sum+t[label],0)]));
  if(!equal(totals,r.totals)||totals.skipped!==r.skippedCases.length)return false;
  const text=decode(root.get('verify.log')),labels=['tests','suites','pass','fail','cancelled','skipped','todo'];
  const columns=Object.fromEntries(labels.map(label=>[label,[...text.matchAll(new RegExp('^# '+label+' (\\d+)\\s*$','gmu'))].map(m=>Number(m[1]))]));
  if(labels.some(label=>!equal(columns[label],r.tapRuns.map(row=>row[label])))
    ||[...text.matchAll(/^1\.\.(\d+)\s*$/gmu)].length!==4
    ||!['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker','electron-vite build','built in'].every(s=>text.includes(s)))return false;
  return true;
}
function tapRawMatches(stage, bytes) {
  const text=decode(bytes),labels=['tests','pass','fail','cancelled','skipped','todo'],counts={};
  for(const label of labels){const matches=[...text.matchAll(new RegExp('^# '+label+' (\\d+)\\s*$','gmu'))];
    if(matches.length!==1)return false;counts[label]=Number(matches[0][1]);}
  const cases=[...text.matchAll(/^(ok|not ok) (\d+) - (.*)$/gmu)].map(m=>({status:m[1],ordinal:Number(m[2]),name:m[3]}));
  const plans=[...text.matchAll(/^1\.\.(\d+)\s*$/gmu)];
  return plans.length===1&&Number(plans[0][1])===cases.length&&counts.tests===cases.length
    &&cases.every((row,i)=>row.status==='ok'&&row.ordinal===i+1&&!/ # SKIP(?: |$)/u.test(row.name))
    &&labels.every(label=>counts[label]===stage.testCounts[label])
    &&equal(cases.map(row=>row.name),stage.actualCaseNames);
}
const reportProductSkip='EXACT_PARENT_CURRENT_SOURCE_PRODUCT_EVIDENCE_REUSED_NOT_REPEATED';
function integrationProofValid(summary,root) {
  const stage=summary.stages.find(row=>row.name==='integration-safety'),role=summary.repairRole;
  const bytes=root.get('integration-safety.stdout.log'),text=decode(bytes),counts={};
  for(const label of ['tests','suites','pass','fail','cancelled','skipped','todo']){
    const rows=[...text.matchAll(new RegExp('^# '+label+' (\\d+)\\s*$','gmu'))];
    if(rows.length!==1)return false;counts[label]=Number(rows[0][1]);}
  const cases=[...text.matchAll(/^(ok|not ok) (\d+) - (.*)$/gmu)].map(m=>{
    const skip=/ # SKIP(?: (.*))?$/u.exec(m[3]);
    return {status:m[1],ordinal:Number(m[2]),name:skip?m[3].slice(0,skip.index):m[3],skip:skip?.[1]??null};});
  const plans=[...text.matchAll(/^1\.\.(\d+)\s*$/gmu)],report=role==='report';
  if(plans.length!==1||plans[0][1]!=='10'||cases.length!==10
    ||!equal(cases.map(row=>row.name),fixedIntegrationNames)
    ||cases.some((row,i)=>row.status!=='ok'||row.ordinal!==i+1||row.skip!==(report&&i<3?reportProductSkip:null))
    ||!equal(counts,{tests:10,suites:0,pass:report?7:10,fail:0,cancelled:0,skipped:report?3:0,todo:0}))return false;
  const expected={schema:'musicbridge.v39.integration.current-composition-cases.v1',role,sourceSha:summary.sourceSha,
    raw:stage.raw.stdout,counts,cases,complete:true,sourceControlledProductCases:report?0:3,
    inheritedSourceProductCases:report?3:0,actualDeviceProviderAudioOwnerAcceptance:'NOT_RUN'};
  return equal(parse(root.get('integration-case-proof.json')),expected);
}
/** 只消费完整本次Source软件/产品producer证据；失败ZIP或range诊断不构成PASS。 */
export function validateV39IntegrationSourceReceipt(value, sourceSha) {
  try {
    canonical(value);
    if(!object(value)||!sha(sourceSha)||value.schema!=='musicbridge.root.v39-integration.first-natural-ci.v1'
      ||value.status!=='SEALED_FIRST_NATURAL_CURRENT_PRODUCT_CI'||value.phase!=='source'||value.task!==V39_INTEGRATION_TASK
      ||value.revision!==sourceSha||value.branch!==V39_INTEGRATION_BRANCH||value.repository!==V39_INTEGRATION_REPOSITORY
      ||value.repositoryId!==V39_INTEGRATION_REPOSITORY_ID||value.code!==null||!equal(value.before,value.after)
      ||value.before?.head!==sourceSha||value.before.parent!==V39_INTEGRATION_BASE||value.before.branch!==V39_INTEGRATION_BRANCH
      ||value.before.status!==''||!sha(value.before.tree)||value.compiledAndApp!=='PASSED_CURRENT_SOURCE'
      ||value.reruns!==0||value.dispatches!==0||value.credentialsOrSignedRedirectArchived!==false
      ||value.realApplicationServiceDeviceAudio!=='NOT_RUN'||value.ownerAcceptance!=='NOT_RUN'
      ||!Number.isFinite(Date.parse(value.recordedAt))
      ||!validateV39IntegrationParentCi({task:value.task,repositoryId:value.repositoryId,parent:sourceSha,
        branch:value.branch,runs:value.runs,proofs:value.proofs,now:Date.parse(value.recordedAt)})
      ||!Array.isArray(value.logs)||value.logs.length!==6||!Array.isArray(value.artifacts)||value.artifacts.length!==5)return false;
    const jobs=value.proofs.flatMap(proof=>proof.jobs),seenLogs=new Set();
    for(const log of value.logs){
      const producer=jobs.find(job=>job.id===log?.jobId);
      if(!producer||seenLogs.has(log.jobId)||log.runId!==producer.run_id||log.jobName!==producer.name
        ||!pinValid(log.raw)||!positive(log.raw.bytes)||log.raw.bytes>16777216||log.redirectLocationArchived!==false
        ||log.credentialsArchived!==false||log.authorizationForwardedAcrossHosts!==false)return false;
      seenLogs.add(log.jobId);
    }
    if(new Set(value.logs.map(row=>row.raw.path)).size!==6)return false;
    const platforms=value.proofs.flatMap(proof=>proof.artifacts);
    if(new Set(value.artifacts.map(row=>row.id)).size!==5||value.artifacts.some(artifact=>{
      const platform=platforms.find(row=>row.id===artifact.id);return !platform||!wholeArtifact(artifact,platform);} ))return false;
    const artifact=value.artifacts.find(row=>row.name==='verify-'+sourceSha);
    const decoded=decodeV39IntegrationToolContent(artifact?.toolContent),summary=decoded.summary;
    if(!object(summary)||artifact.toolContent.phase!=='source'||summary.schema!=='musicbridge.v39.integration.software-gate.v1'
      ||summary.status!=='PASSED_CURRENT_SOFTWARE_GATE'||summary.passed!==true||summary.currentSoftwareGateExitCode!==0
      ||summary.failureCode!==null||summary.task!==V39_INTEGRATION_TASK||summary.head!==sourceSha
      ||summary.sourceSha!==sourceSha||summary.sourceParentSha!==V39_INTEGRATION_BASE||summary.baseSha!==V39_INTEGRATION_BASE
      ||summary.repairRole!=='source'||!equal(summary.limits,{stageMs:180000,wholeMs:480000,rawBytesPerStream:16777216,
        gitBytes:16777216,gitMs:10000,ownerRequestMs:2000})
      ||!Number.isFinite(summary.durationMs)||summary.durationMs<0||summary.durationMs>=480000
      ||summary.temporaryCleanup?.ownedFreshTemporaryRoot!==true||summary.temporaryCleanup.removed!==true
      ||summary.temporaryCleanup.sourceAndEvidenceNeverDeleted!==true||summary.temporaryCleanup.allStageProcessesPhysicallyClosed!==true
      ||summary.currentProductTestsRepeated!==true||summary.historicalResultsUsedAsCurrentPass!==false
      ||summary.effectiveCaptureStageMs!==90000||summary.expectedRegisteredTests!==277||summary.expectedPassedTests!==277
      ||summary.expectedSkippedTests!==0||summary.softwareEvidenceLayer!=='SYNTHETIC_CURRENT_SOURCE_ONLY'
      ||summary.realAppDeviceAudioOwner!=='NOT_RUN'||!equal([...summary.artifactFiles].sort(),toolRootNames('source'))
      ||summary.sourceUnchanged!==true||!equal(summary.sourceBefore,summary.sourceAfter)
      ||summary.sourceBefore?.identity?.head!==sourceSha||summary.sourceBefore.identity.parent!==V39_INTEGRATION_BASE
      ||summary.sourceBefore.identity.tree!==value.before.tree||summary.sourceBefore.identity.status!==''
      ||summary.sourceBefore.identity.branch!==V39_INTEGRATION_BRANCH||!fixedSourcePins(summary.sourceBefore.currentFiles)
      ||summary.sourceBefore.admission?.sourceSha!==sourceSha||summary.sourceBefore.admission.sourceParentSha!==V39_INTEGRATION_BASE
      ||summary.sourceBefore.admission.repairRole!=='source'||summary.sourceBefore.admission.exactSourceFiles!==39
      ||summary.sourceBefore.admission.sealedBaselinePreserved!==true||summary.sourceBefore.admission.offlineTapeDonorVerified!==true
      ||!sha256(summary.sourceBefore.admission.scopeSha256)||!fixedSourcePins(summary.sourceBefore.admission.sourcePins)
      ||!equal(summary.sourceBefore.currentFiles,summary.sourceBefore.admission.sourcePins)
      ||summary.originalTests!==173||summary.tapeTests!==74||summary.integrationTests!==10||summary.admissionTests!==20
      ||!Array.isArray(summary.stages)||!equal(summary.stages.map(stage=>stage.name),
        ['original-173','tape-74','integration-safety','admission-safety','control-plane','boundaries','cycles']))return false;
    const root=toolBytes(artifact,summary,decoded);
    if(!freshReaderValid(summary.sourceBefore.freshReader,summary.sourceBefore.productInputs)
      ||!equal(parse(root.get('fresh-reader.json')),summary.sourceBefore.freshReader))return false;
    if(!standardValid(summary.standardVerification,summary,root))return false;
    if(!integrationProofValid(summary,root))return false;
    const tapeNames=summary.stages.find(stage=>stage.name==='tape-74')?.expectedCaseNames;
    if(!equal(tapeNames,fixedTapeNames))return false;
    for(const stage of summary.stages){
      if(!completeStage(stage))return false;
      const expected={'original-173':173,'tape-74':74,'integration-safety':10,'admission-safety':20}[stage.name];
      if(expected){
        if(!tapRawMatches(stage,root.get(stage.name+'.stdout.log')))return false;
        if(stage.testCounts?.tests!==expected||stage.testCounts.pass!==expected
          ||['fail','cancelled','skipped','todo'].some(key=>stage.testCounts[key]!==0)||stage.tapComplete!==true
          ||stage.caseNamesMatched!==true||!Array.isArray(stage.actualCaseNames)||stage.actualCaseNames.length!==expected
          ||new Set(stage.actualCaseNames).size!==expected)return false;
        if(stage.name==='original-173'?stage.expectedTests!==173||stage.expectedCaseNames!==null
          :stage.name==='integration-safety'?stage.expectedTests!==10
          :stage.expectedTests!==expected)return false;
        if(stage.name==='admission-safety'&&!equal(stage.actualCaseNames,
          [...V39_INTEGRATION_ADMISSION_CASE_NAMES,...V39_INTEGRATION_REPORT_CASE_NAMES]))return false;
        if(stage.name==='integration-safety'&&!equal(stage.actualCaseNames,fixedIntegrationNames))return false;
        if(stage.name!=='original-173'&&!equal(stage.expectedCaseNames,stage.actualCaseNames))return false;
      }else if(stage.expectedTests!==null||stage.testCounts!==null||stage.expectedCaseNames!==null||!equal(stage.actualCaseNames,[])
        ||stage.raw.stderr.bytes!==0||stage.raw.stderr.sha256!==emptyHash)return false;
    }
    const control=Buffer.from('CONTROL_PLANE=PASS\n');
    const controlStage=summary.stages.find(stage=>stage.name==='control-plane');
    if(controlStage.raw.stdout.bytes!==control.length||controlStage.raw.stdout.sha256!==hash(control))return false;
    return true;
  }catch{return false;}
}
/** 只核Report工具原件的实际22项格式与三例声明继承，不代替其自然CI或父Source准入。 */
export function validateV39IntegrationReportToolContent(artifact,sourceSha,reportSha) {
  try {
    canonical(artifact.toolContent);
    if(!sha(sourceSha)||!sha(reportSha)||artifact.name!=='verify-'+reportSha||artifact.toolContent.phase!=='report')return false;
    const decoded=decodeV39IntegrationToolContent(artifact.toolContent),summary=decoded.summary;
    if(summary.schema!=='musicbridge.v39.integration.software-gate.v1'||summary.status!=='PASSED_CURRENT_SOFTWARE_GATE'
      ||summary.passed!==true||summary.currentSoftwareGateExitCode!==0||summary.failureCode!==null
      ||summary.task!==V39_INTEGRATION_TASK||summary.branch!==V39_INTEGRATION_BRANCH||summary.repairRole!=='report'
      ||summary.sourceSha!==sourceSha||summary.head!==reportSha||summary.baseSha!==V39_INTEGRATION_BASE
      ||summary.sourceParentSha!==V39_INTEGRATION_BASE||summary.sourceUnchanged!==true
      ||!equal(summary.sourceBefore,summary.sourceAfter)||summary.sourceBefore?.identity?.head!==reportSha
      ||summary.sourceBefore.identity.parent!==sourceSha||summary.sourceBefore.identity.status!==''
      ||summary.sourceBefore.identity.branch!==V39_INTEGRATION_BRANCH||!sha(summary.sourceBefore.identity.tree)
      ||summary.sourceBefore.admission?.sourceSha!==sourceSha||summary.sourceBefore.admission.sourceParentSha!==V39_INTEGRATION_BASE
      ||summary.sourceBefore.admission.repairRole!=='report'||summary.sourceBefore.admission.exactSourceFiles!==39
      ||summary.sourceBefore.admission.exactReportFiles!==8||!fixedSourcePins(summary.sourceBefore.admission.sourcePins)
      ||summary.sourceBefore.admission.sealedBaselinePreserved!==true||summary.sourceBefore.admission.offlineTapeDonorVerified!==true
      ||!sha256(summary.sourceBefore.admission.scopeSha256)||summary.currentProductTestsRepeated!==false
      ||summary.historicalResultsUsedAsCurrentPass!==false||summary.freshReader!==null||Object.hasOwn(summary.sourceBefore,'freshReader')
      ||!equal(summary.standardVerification,{status:'NOT_REPEATED_EXACT_PARENT_CURRENT_PRODUCT_REUSE',sourceSha,
        currentReportStandardRepeated:false,parentSourceReceiptValidatedByActualAdmission:true})
      ||!equal(summary.limits,{stageMs:180000,wholeMs:480000,rawBytesPerStream:16777216,gitBytes:16777216,gitMs:10000,ownerRequestMs:2000})
      ||summary.effectiveCaptureStageMs!==90000||!Number.isFinite(summary.durationMs)||summary.durationMs<0||summary.durationMs>=480000
      ||summary.temporaryCleanup?.ownedFreshTemporaryRoot!==true||summary.temporaryCleanup.removed!==true
      ||summary.temporaryCleanup.sourceAndEvidenceNeverDeleted!==true||summary.temporaryCleanup.allStageProcessesPhysicallyClosed!==true
      ||summary.originalTests!==173||summary.tapeTests!==0||summary.integrationTests!==10||summary.admissionTests!==20
      ||summary.expectedRegisteredTests!==203||summary.expectedPassedTests!==200||summary.expectedSkippedTests!==3
      ||summary.softwareEvidenceLayer!=='SYNTHETIC_CURRENT_SOURCE_ONLY'||summary.realAppDeviceAudioOwner!=='NOT_RUN'
      ||!Array.isArray(summary.stages)||!equal(summary.stages.map(row=>row.name),toolStages.filter(name=>name!=='tape-74'))
      ||!equal([...summary.artifactFiles].sort(),toolRootNames('report')))return false;
    const root=toolBytes(artifact,summary,decoded);
    if(!integrationProofValid(summary,root))return false;
    for(const stage of summary.stages){
      if(!completeStage(stage))return false;
      if(stage.name==='integration-safety'){
        if(stage.expectedTests!==null||stage.expectedCaseNames!==null||stage.testCounts!==null||stage.tapComplete!==true
          ||stage.caseNamesMatched!==true||!equal(stage.actualCaseNames,fixedIntegrationNames.map((name,i)=>name+(i<3?' # SKIP '+reportProductSkip:''))))return false;
      }else if(['original-173','admission-safety'].includes(stage.name)){
        const n=stage.name==='original-173'?173:20;
        if(stage.expectedTests!==n||stage.testCounts?.tests!==n||stage.testCounts.pass!==n
          ||['fail','cancelled','skipped','todo'].some(key=>stage.testCounts[key]!==0)||stage.tapComplete!==true
          ||stage.caseNamesMatched!==true||!tapRawMatches(stage,root.get(stage.name+'.stdout.log'))
          ||(stage.name==='original-173'?stage.expectedCaseNames!==null:!equal(stage.actualCaseNames,
            [...V39_INTEGRATION_ADMISSION_CASE_NAMES,...V39_INTEGRATION_REPORT_CASE_NAMES])||!equal(stage.actualCaseNames,stage.expectedCaseNames)))return false;
      }else if(stage.expectedTests!==null||stage.expectedCaseNames!==null||stage.testCounts!==null
        ||!equal(stage.actualCaseNames,[])||stage.raw.stderr.bytes!==0||stage.raw.stderr.sha256!==emptyHash)return false;
    }
    return root.get('control-plane.stdout.log').equals(Buffer.from('CONTROL_PLANE=PASS\n'));
  }catch{return false;}
}
export function v39IntegrationPublicSourceCi(value, sourceSha=value?.revision) {
  if(!validateV39IntegrationSourceReceipt(value,sourceSha))fail('V39_PUBLIC_SOURCE_CI_NOT_COMPLETE');
  const summary=v39IntegrationSourceSummary(value);
  return freeze({
    schema:'musicbridge.v39.integration.public-source-ci.v1',task:V39_INTEGRATION_TASK,sourceSha,
    sourceParentSha:V39_INTEGRATION_BASE,branch:V39_INTEGRATION_BRANCH,repositoryId:V39_INTEGRATION_REPOSITORY_ID,
    firstNaturalPush:true,attempt:1,compiledAndApp:'PASSED_CURRENT_SOURCE',software:'PASSED_CURRENT_SOFTWARE_GATE',
    fullReceipt:{path:V39_INTEGRATION_CI_EVIDENCE_PATH,jsonPointer:'/sourceCi',canonical:v39IntegrationCanonicalPin(value)},
    producerRuns:value.runs.map(run=>({path:run.path,id:run.id,head:run.head_sha,attempt:run.run_attempt,
      jobs:value.proofs.find(proof=>proof.runId===run.id).jobs.map(job=>({id:job.id,name:job.name,conclusion:job.conclusion}))})),
    artifacts:value.artifacts.map(artifact=>({id:artifact.id,name:artifact.name,zip:{bytes:artifact.zip.bytes,sha256:artifact.zip.sha256},
      memberManifest:{count:artifact.members.length,expandedBytes:artifact.expandedBytes,canonical:v39IntegrationCanonicalPin(artifact.members)},
      allMembersBytesAndCrcRead:true})),
    toolGate:{scopeSha256:summary.sourceBefore.admission.scopeSha256,tests:277,originalTests:173,tapeTests:74,
      integrationTests:10,admissionTests:20,sourceInputsUnchanged:true,wholeBudgetMs:480000},
    reruns:0,dispatches:0,realApplicationServiceDeviceAudio:'NOT_RUN',ownerAcceptance:'NOT_RUN',
  });
}
export function v39IntegrationReportIdentity(sourceSha, sourceCi) {
  v39IntegrationPublicSourceCi(sourceCi,sourceSha);
  return freeze({schema:'musicbridge.v39.integration.ci-evidence.v1',task:V39_INTEGRATION_TASK,
    branch:V39_INTEGRATION_BRANCH,baseSha:V39_INTEGRATION_BASE,sourceParentSha:V39_INTEGRATION_BASE,
    sourceSha,sourceCi,reportSha:null,reportCi:null,nextTask:'V39-INTEGRATION-002',
    realApplicationServiceDeviceAudio:'NOT_RUN',ownerAcceptance:'NOT_RUN'});
}
export function v39IntegrationReportState(sourceSha,sourceCi) {
  return freeze({state:'SOURCE_SOFTWARE_AND_FIRST_NATURAL_CI_PASSED_REPORT_OWN_CI_PENDING',phase:'REPORT',
    sourceCommit:sourceSha,reportCommit:null,software:'PASSED_CURRENT_SOURCE_SOFTWARE',
    sourceCi:v39IntegrationPublicSourceCi(sourceCi,sourceSha),reportCi:'NOT_RUN'});
}
function reportObject(context, source) {
  exactDiff(rawDiff(context,source,context.head),V39_INTEGRATION_REPORT_FILES.map(row=>({path:row.path,status:row.status,
    oldMode:row.status==='A'?'000000':'100644',newMode:'100644'})));
  const identity=parse(blob(context,context.head,V39_INTEGRATION_CI_EVIDENCE_PATH));
  keys(identity,['schema','task','branch','baseSha','sourceParentSha','sourceSha','sourceCi','reportSha','reportCi','nextTask',
    'realApplicationServiceDeviceAudio','ownerAcceptance'],'V39_REPORT_EVIDENCE_FIELDS');
  if(identity.sourceSha!==source||!equal(identity,v39IntegrationReportIdentity(source,identity.sourceCi)))fail('V39_REPORT_SOURCE_CI_INVALID');
  if(!equal(parse(blob(context,context.head,'reports/V39-INTEGRATION-001_RESULT.json')),identity))fail('V39_REPORT_RESULT_JSON_NOT_BOUND');
  const receipt=identity.sourceCi,sourcePins=actualPins(context,source,V39_INTEGRATION_SOURCE_FILES.map(row=>row.path));
  const sourceInput=v39IntegrationSourceSummary(receipt).sourceBefore;
  if(receipt.before.tree!==context.text(['rev-parse',source+'^{tree}'])||!equal(sourceInput.currentFiles,sourcePins)
    ||sourceInput.admission.scopeSha256!==hash(blob(context,source,V39_INTEGRATION_SCOPE_PATH)))fail('V39_REPORT_CI_SOURCE_BYTES_NOT_BOUND');
  const state=v39IntegrationReportState(source,receipt);
  const before=parse(blob(context,source,V39_INTEGRATION_STATUS_PATH)),after=parse(blob(context,context.head,V39_INTEGRATION_STATUS_PATH));
  if(!equal(after,{...before,...state}))fail('V39_REPORT_STATUS_NOT_BOUND');
  const oldStatus=blob(context,source,'project/STATUS.json'),newStatus=blob(context,context.head,'project/STATUS.json');
  protectedJson(oldStatus,newStatus,['v39Integration'],'V39_REPORT_STATUS_OUTSIDE_DOMAIN');
  const oldRecord=parse(oldStatus).v39Integration,newRecord=parse(newStatus).v39Integration;
  if(!equal(newRecord,{...oldRecord,status:state.state,phase:state.phase,sourceCommit:state.sourceCommit,
    reportCommit:null,software:state.software,sourceCi:state.sourceCi,reportCi:state.reportCi}))fail('V39_REPORT_MACHINE_DOMAIN');
  const oldPlan=blob(context,source,'project/POSTRUST_PLAN.json'),newPlan=blob(context,context.head,'project/POSTRUST_PLAN.json');
  protectedJson(oldPlan,newPlan,['integration_tasks'],'V39_REPORT_PLAN_OUTSIDE_DOMAIN');
  const prior=parse(oldPlan).integration_tasks,actual=parse(newPlan).integration_tasks;
  if(!equal(actual,[{...prior[0],status:state.state,source_commit:source,report_commit:null,
    validation_status:state.software,source_ci:state.sourceCi,report_ci:'NOT_RUN'},prior[1]]))fail('V39_REPORT_PLAN_DOMAIN');
  for(const file of ['project/POSTRUST_TODO.md','project/POSTRUST_PROGRESS.md']){
    const previous=blob(context,source,file),current=blob(context,context.head,file);
    if(current.length<=previous.length||!current.subarray(0,previous.length).equals(previous)
      ||!decode(current.subarray(previous.length)).includes(source))fail('V39_REPORT_MARKDOWN_NOT_APPEND');
  }
  const md=decode(blob(context,context.head,'reports/V39-INTEGRATION-001_RESULT.md'));
  if(!md.includes(source)||!md.includes(V39_INTEGRATION_BASE)||!md.includes(V39_INTEGRATION_CI_EVIDENCE_PATH)
    ||!md.includes('NOT_RUN'))fail('V39_REPORT_RESULT_MD');
  registry(context,context.head,'report');
  return {sourceCi:receipt,exactReportFiles:8,publicSourceCi:state.sourceCi};
}
const admitted=new WeakSet(), admittedContexts=new WeakMap();
function admission(context, role, source, sourceResult, reportResult) {
  const names=role==='source'?V39_INTEGRATION_SOURCE_FILES.map(row=>row.path):
    [...new Set([...V39_INTEGRATION_SOURCE_FILES.map(row=>row.path),...V39_INTEGRATION_REPORT_PATHS])].sort();
  const before=snapshot(context,names),after=snapshot(context,names);
  if(!equal(before,after))fail('V39_INPUTS_CHANGED');
  const result=freeze({schema:'musicbridge.v39.integration.admission.v1',task:V39_INTEGRATION_TASK,
    branch:V39_INTEGRATION_BRANCH,baseSha:V39_INTEGRATION_BASE,headAtAdmission:context.head,
    repairRole:role,...sourceResult,exactReportFiles:role==='source'?0:8,
    currentProductSoftwareRequired:true,identity:after.identity,currentFiles:after.currentFiles,
    ...(role==='report'?{publicSourceCi:reportResult.publicSourceCi}:{} )});
  context.check();admitted.add(result);admittedContexts.set(result,context);return result;
}
export function inspectV39IntegrationAdmission(directory=repository,env=process.env,options={}) {
  const context=gitContext(directory,env,options);
  const before=snapshot(context,V39_INTEGRATION_SOURCE_FILES.map(row=>row.path));
  const source=sourceObject(context,context.head);
  const result=admission(context,'source',context.head,source,null);
  if(!equal(before.identity,result.identity)||!equal(before.currentFiles,result.currentFiles))fail('V39_INPUTS_CHANGED');
  return result;
}
export function inspectV39IntegrationReportAdmission(directory=repository,env=process.env,options={}) {
  const context=gitContext(directory,env,options),lineage=context.text(['rev-list','--parents','-n','1',context.head]).split(' ');
  if(lineage.length!==2||lineage[1]===V39_INTEGRATION_BASE)fail('V39_REPORT_NOT_UNIQUE_DIRECT_PARENT');
  const source=lineage[1];
  const before=snapshot(context,[...new Set([...V39_INTEGRATION_SOURCE_FILES.map(row=>row.path),...V39_INTEGRATION_REPORT_PATHS])].sort());
  const sourceResult=sourceObject(context,source),reportResult=reportObject(context,source);
  const result=admission(context,'report',source,sourceResult,reportResult);
  if(!equal(before.identity,result.identity)||!equal(before.currentFiles,result.currentFiles))fail('V39_INPUTS_CHANGED');
  return result;
}
export function v39IntegrationWorkflowOutputs(result) {
  if(!admitted.has(result))fail('V39_RESULT_NOT_ACTUALLY_ADMITTED');
  const observed=snapshot(admittedContexts.get(result),result.currentFiles.map(row=>row.path));
  if(!equal(observed.identity,result.identity)||!equal(observed.currentFiles,result.currentFiles))fail('V39_OUTPUT_IDENTITY_CHANGED');
  return freeze({integrationMode:'qualified',integrationRole:result.repairRole,
    productVerificationMode:result.repairRole==='source'?'fresh-source':'exact-parent-current-product-reuse',
    task:V39_INTEGRATION_TASK,branch:V39_INTEGRATION_BRANCH,baseSha:V39_INTEGRATION_BASE,
    sourceSha:result.sourceSha,scopeSha256:result.scopeSha256});
}
/** Gate快照仅含稳定身份；完整CI正文通过已真实准入的私有资格读取，避免Report递归膨胀。 */
export function v39IntegrationAdmittedSourceCi(result) {
  if(!admitted.has(result)||result.repairRole!=='report')fail('V39_SOURCE_CI_NOT_ACTUALLY_ADMITTED');
  const context=admittedContexts.get(result);context.check();
  return freeze(parse(blob(context,context.head,V39_INTEGRATION_CI_EVIDENCE_PATH)).sourceCi);
}
export function v39IntegrationRouteRequested(branch,authorityPresent) {
  return branch===V39_INTEGRATION_BRANCH||authorityPresent===true;
}
export function v39IntegrationHasAuthority(directory) {
  try{
    if(lstatSync(path.join(directory,V39_INTEGRATION_SCOPE_PATH),{throwIfNoEntry:false}))return true;
    const status=readWhole(path.join(directory,'project/STATUS.json'));
    return Object.hasOwn(parse(status),'v39Integration')||Object.hasOwn(parse(status),'currentIntegrationTask');
  }catch(error){return error?.code==='ENOENT'?false:true;}
}
export function inspectV39IntegrationWorkflowGuard(directory=repository,env=process.env,options={}) {
  const gitEnvironment=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('GIT_')));
  Object.assign(gitEnvironment,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'});
  let branch;
  try{branch=execFileSync('git',['--no-replace-objects','-c','core.fsmonitor=false','branch','--show-current'],
    {cwd:directory,env:gitEnvironment,encoding:'utf8',timeout:10000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']}).trim()||env.GITHUB_REF_NAME;}
  catch{fail('V39_GIT_READ_FAILED');}
  if(!v39IntegrationRouteRequested(branch,v39IntegrationHasAuthority(directory)))return freeze({integrationMode:'not-applicable'});
  const context=gitContext(directory,env,options),lineage=context.text(['rev-list','--parents','-n','1',context.head]).split(' ');
  const result=lineage[1]===V39_INTEGRATION_BASE?inspectV39IntegrationAdmission(directory,env,{deadline:context.deadline})
    :inspectV39IntegrationReportAdmission(directory,env,{deadline:context.deadline});
  return v39IntegrationWorkflowOutputs(result);
}
export function v39IntegrationProducerIdentity(value) {
  if(!validateV39IntegrationParentCi({task:V39_INTEGRATION_TASK,repositoryId:V39_INTEGRATION_REPOSITORY_ID,
    parent:value?.runs?.[0]?.head_sha,branch:V39_INTEGRATION_BRANCH,runs:value?.runs,proofs:value?.proofs,
    now:value?.recordedAt?Date.parse(value.recordedAt):Date.now()}))fail('V39_PRODUCER_NOT_CURRENT');
  return V39_INTEGRATION_WORKFLOWS.map(file=>{
    const run=value.runs.find(row=>row.path===file),proof=value.proofs.find(row=>row.runId===run.id);
    return {path:file,runId:run.id,head:run.head_sha,branch:run.head_branch,attempt:run.run_attempt,
      jobs:[...proof.jobs].sort((a,b)=>a.id-b.id).map(job=>({id:job.id,name:job.name,head:job.head_sha,
        steps:job.steps.map(step=>({name:step.name,status:step.status,conclusion:step.conclusion}))})),
      artifacts:proof.artifacts.map(row=>({id:row.id,name:row.name,bytes:row.size_in_bytes,digest:row.digest}))};
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--workflow-guard')fail('V39_UNKNOWN_ARGUMENT');
    const outputs=inspectV39IntegrationWorkflowGuard();
    if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(outputs).map(([key,value])=>key+'='+value+'\n').join(''),{flag:'a'});
    process.stdout.write(JSON.stringify({schema:'musicbridge.v39.integration.workflow-guard.v1',...outputs})+'\n');
  }catch(error){
    process.stderr.write('V3.9 Tape身份准入拒绝：'+(/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'V39_ADMISSION_FAILED')+'\n');
    process.exitCode=1;
  }
}
