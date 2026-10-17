import { spawnSync } from 'node:child_process';
import { constants as fsConstants, lstatSync, fstatSync, openSync, closeSync, readSync, readFileSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const V39_INTEGRATION_TASK = 'V39-INTEGRATION-002';
export const V39_INTEGRATION_BRANCH = 'codex/v39-integration-002';
export const V39_INTEGRATION_BASE = '4c1c6c78d965260a56c3f5bf51f1d6c83ddb9870';
export const V39_INTEGRATION_BASE_TREE = '3991e44a5d1d01a4132891cf2e2b20926d7c8871';
const domain = 'docs/integration/V39-INTEGRATION-002/';
export const V39_INTEGRATION_SCOPE_PATH = domain + 'EXECUTION_SCOPE.json';
export const V39_INTEGRATION_BASELINE_PATH = domain + 'SEALED_BASELINE.json';
export const V39_INTEGRATION_DONOR_PATH = domain + 'DONOR_READBACK.json';
export const V39_INTEGRATION_STATUS_PATH = domain + 'STATUS.json';
export const V39_INTEGRATION_LOCAL_EVIDENCE_PATH = domain + 'LOCAL_SOFTWARE_EVIDENCE.json';
export const V39_INTEGRATION_MATRIX_PATH = domain + 'FEATURE_BEHAVIOR_MATRIX.json';
export const V39_INTEGRATION_CI_EVIDENCE_PATH = domain + 'CI_EVIDENCE.json';
export const V39_INTEGRATION_GUARD_STEP = 'V3.9 完整集成精确身份准入';
export const V39_INTEGRATION_GATE_STEP = 'V3.9 本地音乐与CoverDrop完整组合 Gate';
export const V39_INTEGRATION_UPLOAD_STEP = '保留本次V3.9 完整集成证据';
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
function fail(code) { const error = new Error('V3.9 完整集成准入拒绝。'); error.code = code; throw error; }
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const parse = bytes => JSON.parse(decode(bytes));
function canonical(value) {
  const active = new Set(); let count = 0;
  function copy(item, depth) {
    if (++count > 1_000_000 || depth > 96) fail('V39_002_JSON_BUDGET');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('V39_002_JSON_NUMBER'); return item; }
    if (typeof item !== 'object' || types.isProxy(item) || active.has(item) || Object.getOwnPropertySymbols(item).length
      || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) fail('V39_002_JSON_DATA_REQUIRED');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((key, i) => key !== String(i))) fail('V39_002_JSON_ARRAY_CLOSEDSET');
      result = keys.map(key => { const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !Object.hasOwn(d, 'value')) fail('V39_002_JSON_ACCESSOR'); return copy(d.value, depth + 1); });
    } else {
      result = {};
      for (const key of Object.keys(item).sort()) { const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail('V39_002_JSON_ACCESSOR');
        Object.defineProperty(result, key, { value: copy(d.value, depth + 1), enumerable: true }); }
    }
    active.delete(item); return result;
  }
  const bytes = Buffer.from(JSON.stringify(copy(value, 0)), 'utf8');
  if (bytes.length > 16 * 1024 * 1024) fail('V39_002_JSON_BUDGET'); return bytes;
}
export function v39IntegrationCanonicalPin(value) { const bytes = canonical(value); return { bytes: bytes.length, sha256: hash(bytes) }; }
const equal = (a, b) => canonical(a).equals(canonical(b));
function keys(value, expected, code) {
  if (!object(value) || !equal(Object.keys(value).sort(), [...expected].sort())) fail(code);
}
function base64(value, cap = 16 * 1024 * 1024) {
  if (typeof value !== 'string' || value.length > Math.ceil(cap / 3) * 4
    || value.length % 4 || /[^A-Za-z0-9+/=]/u.test(value)) fail('V39_002_BASE64_NOT_CANONICAL');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > cap || bytes.toString('base64') !== value) fail('V39_002_BASE64_NOT_CANONICAL'); return bytes;
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
/** 同一NOFOLLOW FD有界全读；身份与时间前后重验，绝不返回历史代替当前字节。 */
export function readV39Integration002Whole(filename, cap = 16 * 1024 * 1024) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || realpathSync(filename) !== filename) fail('V39_002_FILE_CANONICAL');
  const original = lstatSync(filename, { bigint: true });
  if (!original.isFile() || original.isSymbolicLink() || original.size > BigInt(cap)) fail('V39_002_FILE_BUDGET');
  const fd = openSync(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd, { bigint: true }), chunks = []; let total = 0;
    for (;;) { const chunk = Buffer.alloc(Math.min(65536, cap + 1 - total)); const size = readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break; total += size; if (total > cap) fail('V39_002_FILE_BUDGET'); chunks.push(chunk.subarray(0, size)); }
    const last = fstatSync(fd, { bigint: true }), current = lstatSync(filename, { bigint: true });
    if (!first.isFile() || ['dev','ino','size','mtimeNs','ctimeNs','mode'].some(k => first[k] !== last[k] || first[k] !== current[k])
      || first.dev !== original.dev || first.ino !== original.ino || first.size !== BigInt(total)) fail('V39_002_FILE_CHANGED');
    return Buffer.concat(chunks, total);
  } finally { closeSync(fd); }
}
const readWhole = readV39Integration002Whole;

export const V39_INTEGRATION_SOURCE_PARENT = freeze("4c1c6c78d965260a56c3f5bf51f1d6c83ddb9870");
export const V39_INTEGRATION_AUTHORIZATION = freeze([
  {
    "path": ".github/workflows/electron-e2e.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "380eac659d5d177e087933a5d50152c02ce58a15",
      "bytes": 11536,
      "sha256": "d378e668aeb6ef5ad1424f3de5db8b447a84d77add8f04a2982db1482b13e6c5"
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": ".github/workflows/rust-core.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "d5a1fcfd4c795947cf4f99ad1bf1a94794feb014",
      "bytes": 5403,
      "sha256": "c145aac8e5724c85a5611f324fbe057be42dfe8f1a34b236f27ab381ee52909a"
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": ".github/workflows/security.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "468508312cea0db9421cdb7bdd9df84b8549028d",
      "bytes": 3011,
      "sha256": "bfd8ad30270b166a7bae2efe1bd286a8312ea77c5da98ecc9f3b2a95e98b58d0"
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": ".github/workflows/verify.yml",
    "status": "M",
    "role": "ci",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "fa972737458ee8261ec2796a3778dcde08fcbfe1",
      "bytes": 33291,
      "sha256": "ebc47805043511eb0d814780bd0daf2a613a0321f392e2624cf9eaf5d588a13c"
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "apps/desktop/e2e/mbrs009-local-library.spec.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "feadcd28a3fc9d990c13b9b2447f0d77ee87f036",
      "bytes": 10775,
      "sha256": "4b37706530de793b0dc83d0d4ea51589324fcfac674863aa47914b1d2dc702ab"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/e2e/v39-coverdrop-original-features.spec.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/package.json",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "31f77dbb619eae14ae8784f19abfe868509420d5",
      "bytes": 6564,
      "sha256": "6961ac276510c8df5fda8dc2d064828a659672600a0fe998bcffccb547e20add"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/scripts/native-cue-package.mjs",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/scripts/native-local-audio-tags-package.mjs",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/core-host.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "210b30e9de914239e816ea913937882ac02d421b",
      "bytes": 5033,
      "sha256": "67087bd2418d6e2ecec3a4ea8d8bbf275def6c85cd164353d19fb217cdfb781c"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/core-supervisor.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "cf2c702cf606f038d3fbea083a08c6035cd92864",
      "bytes": 51418,
      "sha256": "a06f81f147d15ba126a355518a7c6d528009614589e97859507efb1df9efd5ab"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/credential-vault.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "86e0bc6b26ba4b82ae4761a15aca483a0f328354",
      "bytes": 6069,
      "sha256": "9f1e6719b374b4ff261874686744c6138b0cf94e9b817397eed9e20ef55f830e"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/dataset-owner-bootstrap.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "194335c3921eebac6373a509ca086830a9b54ac6",
      "bytes": 2657,
      "sha256": "5554d606531a6e67c81303c0f1af17080f9e6c7bbe67a9501e75d5207c7c78ab"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/dataset-owner-entry.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "ff093376a206ec535a3de4d5dfce801e0d871e05",
      "bytes": 2080,
      "sha256": "b46f34900205ee02b846e0b55f5ce65591f864687d67626fe184192e56ec5e3d"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/diagnostics.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "eb603e0ebe472dd33353e6bcdf066be05efc4fed",
      "bytes": 4992,
      "sha256": "31d2ffb30dbc56a4ba18d58db455334ab0cc8d95342edf7d3ba29dc40460f61d"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/index.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "40a731861b3ade742869debc079021e4d0451620",
      "bytes": 113892,
      "sha256": "455d3721bff96a0d12b70826b180bccbce2e0d1cd9a49d6e039ab3635b682f4d"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-artwork-image.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "09914487c4ea21cf56cdf03de98f277a93f815cc",
      "bytes": 16413,
      "sha256": "a9049d5956d75cac4b356fd3c27a740f6dffad191f0751526c2409cf6b3b2b08"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-artwork-ipc.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "99f8bf814ac8bceb4297078bdc3003bf6c3ab3a9",
      "bytes": 11860,
      "sha256": "c51568239929682f6e9604dab36b358df40c58baa6b267dfeb9da013fa9cf136"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-library-ipc.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "f9d5dfa984be7e1c83929bb784399d3217789fd2",
      "bytes": 4487,
      "sha256": "934744445b3b5abde19089a24ad596864290eecdec1ec8a0a349fa3067268343"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/album-artwork-normalizer.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/album-artwork-normalizer.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "03c6b893b5b7b274514cd47dc0dcda7e3653d298",
      "bytes": 1948,
      "sha256": "81701b3db133fa0dbd56290e9a3f82bdc45f5fcd5a2b1bfad92d4939618a5173",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/album-ipc.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/album-ipc.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "36d5a5c0848f700af0ba00f3ecbf65cc2808d20b",
      "bytes": 2611,
      "sha256": "7bb2961df17fe6d1b1f87f8b9e09899a66b6044032fafe8d32c15675d7d7b99e",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/artwork-import-normalizer.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/artwork-import-normalizer.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "703ac86b5f73dcc892085820f8912b35148f7251",
      "bytes": 23451,
      "sha256": "bbbdda704936a2d29fec96aab2a1f0bbce4c61fffee1bd6475e2189adaabe02d",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/lyrics-service.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/name-settings.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/native-chooser.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-providers.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-providers.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "63e528f00d3bc548eec70d2457997ffefef523c0",
      "bytes": 20903,
      "sha256": "9a943e3befd3c0a3856875733066251f877ebc5d9e1b7fbcf928d1b51f48d9c5",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-urls.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-urls.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "5c016c1b25ec44447a1037e6ad86fef1137d89a5",
      "bytes": 4180,
      "sha256": "f81749696ceeec1ff4fb9e9ff1acb1cf9043a4c1cd7825f81483d064d1adbe88",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-web-navigation.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-web-navigation.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "87e4dca6fe117dd797937c8ba6499e08a34c0f4c",
      "bytes": 2134,
      "sha256": "5794f42523c56bff4d897aafba1db54af919d32fc388c414502533534b5485ac",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/providers/boundaries.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/providers/boundaries.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "3ac344523fdec7911b1aeef59129005148f22c0d",
      "bytes": 4762,
      "sha256": "50f15dcadf11e583dbeb00a15a1ef799f84b112b9975f034e5afe53ac90993d4",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/providers/index.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/providers/index.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "cd5948a7b1b19d7213fa72c40595e9c4da31d868",
      "bytes": 1019,
      "sha256": "4b70140ac3ab698639290661008922fa4ca6ebf726c88b439fea49e131c06fa0",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/providers/name-transport.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/providers/name-transport.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "c2cb5daa90c00e67a2ca7583ccf6f51bcfda2a8b",
      "bytes": 14744,
      "sha256": "064bffc24d3b31534ba54b1f662e7ce826c00e3285e40dde0f2f36ab692387bf",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/providers/pinned-transport-review.patch",
    "status": "A",
    "role": "historical-proposal-not-active-code",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/providers/pinned-transport-review.patch",
      "status": "A",
      "role": "historical-proposal-not-active-code",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "25ff8e0973ab0d83ea22f04457846242d057b48e",
      "bytes": 1959,
      "sha256": "43e3d606569d54494988af7d2c3f4abb1ec94e7dce4ab1039fd76a00ae48c0ad",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/service.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/service.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "36588c5ff81415e6e73938463b1b218cc036d2bd",
      "bytes": 45856,
      "sha256": "ab15051640967b4d67ecafc6a2a67d74345b57c257f58a40730d3c2af5232f48",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-library-workbench/workbench-ipc.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/main/local-library-workbench/workbench-ipc.ts",
      "status": "A",
      "role": "product",
      "revision": "3175d272bdb64ff14869581927241032887b32e9",
      "blob": "06b327be003e9964bc2853571a61ce8ee53d7ec7",
      "bytes": 10834,
      "sha256": "83ee01e528d64c8a6908450393a37078f163583814b2a38ad2fec2db0636531d",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/main/local-playback-evidence.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/main/local-source-writes-ipc.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8d1335fd7fed3a548ebc3c1621805cdcfe11baf1",
      "bytes": 6500,
      "sha256": "43f3aa72cce510e441108a8b994061980217b4648b5c0c1f5e27445fab3c960d"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/preload/api.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "1ec8541d1e32dc0de473b0b37a3f77f68d81f73e",
      "bytes": 44738,
      "sha256": "6748d8a7886abe9adff4ec2ea73d179ef0e874982c4e32c6e2217d38eebdda40"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/preload/index.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "ee21096670d13155ff74f1b977a07cbbf7f7e538",
      "bytes": 28597,
      "sha256": "eccce4486969ee84d080d7623b54d28b865c431244ab74bb672894fa5e87dee7"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/preload/local-album-client.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/preload/local-album-client.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a3f0cd15b703844169a12a4d2b5f53f3bff28492",
      "bytes": 1878,
      "sha256": "2736c8416d246314cc22a02bcd4f8b91bf6a5869564e1134c4c6d9f7b1aa81d4",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/preload/local-library-client.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "71267c36d3fd17a934f7e6fc05045a452fdb398a",
      "bytes": 3805,
      "sha256": "f57126d86cfc125ef27aee6799c7c9ab4a8555c4a16d1096b88c566df8954cd9"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/preload/local-workbench-client.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/src/preload/local-workbench-client.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "57a586ab75edf0074a39859d5d56b22071e57b50",
      "bytes": 4696,
      "sha256": "ecda456e5df9212e6881f2592011fab6ba3cd5c3b9fa7048472e80388ed42bae",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/App.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "5424515f6cf386651f695e97977f9310d7ff12a0",
      "bytes": 72331,
      "sha256": "689d6eb509736f5dc198435f2f81a5c99223433443955067c6f4b029b69d8339"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/CoverDropView.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/LocalLibraryView.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "42b49d7ca9299d36210e33f5a2e02a3de86ed5b1",
      "bytes": 26397,
      "sha256": "69f968e4a2b2526d2e34ab1460a67607d6eb6ce788b3c434346b18fd00dfde99"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumArtwork.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumArtwork.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "be0f9292dc7dbc17380840f6c3e33ae6ef384c44",
      "bytes": 2900,
      "sha256": "09d35df6d6f44062db2a345076ee6a8e456aac932adf5f781f5ac763818069cb",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumBrowser.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumBrowser.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a73b23c2b60c93ae6de378cb2728910a92155b0f",
      "bytes": 16881,
      "sha256": "ac890affce106410b921958ee40ed442727be8c2dca453ac2ed809753d96f67d",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumDetail.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumDetail.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "25c9b3df2ebd64ed09acdd29b0b9f2a3e897efc5",
      "bytes": 11922,
      "sha256": "031a388bc919322dc667ed7cb0e86df0960cc4248cc2bc2a5e2187edbaf46fab",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumGrid.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumGrid.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "de25f59f45fcd9f7b4f29a38f844e6f121460224",
      "bytes": 12434,
      "sha256": "43e052ac690f73a0a1b595ac0e12648cead20ad78e2bea74345eb0514d92b165",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-browser/presentation.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/presentation.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "470eec8e0bc0e60d45d0241a85601e0a2393c5e2",
      "bytes": 2705,
      "sha256": "bfc963bdbf99566c6812ef7056012103840bbf66cc7a375f7028c28adb25fa88",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalAiReview.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalAiReview.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a0a00f552aa35b42b76d4bb98097c94e20604fbb",
      "bytes": 5175,
      "sha256": "42a067a3e6a2a0d69793534d74d7f4bf162900744ce45fb10e15d76c88508c6a",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalCueSplitReview.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalCueSplitReview.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "82131027755aa1b3ff73b7994c29634f6d8fef0a",
      "bytes": 5778,
      "sha256": "e1ba2df68d469cc47fe2603c0c5819669f0ea5517675d451063277e13e595b6e",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "be209fbce0f0e52bef5380c0bcfc56d0f3232c7f",
      "bytes": 20219,
      "sha256": "b947fe5e5a3206aac6e713df446c34d58810a2460ac94b3f60f592ab2b06f17c",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalLyricsBatchControl.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalLyricsReview.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/library/local-workbench/workbench.css",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/workbench.css",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "2a6318d566009c6d9a95509b5d16fed4d6ed3a96",
      "bytes": 7478,
      "sha256": "030f36d41d9fc30ce2d3fa86a8ce30701bd21baa466146b2c5df5052fb37493d",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/media/TrackTable.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "35646c94d8019339cc2debb7e08f5fbb76263cbd",
      "bytes": 14058,
      "sha256": "6eaa180c2ca488e2c38135cbb066e95794a0dafd39352a18e90748497828d26c"
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/components/media/TrackTable.vue",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "99c7d6e62731153a061ccf083ada96bc2c798a15",
      "bytes": 14707,
      "sha256": "8022bf6a8c2dcd45a465fed793f0c8e310b34a5aae41c67284194b20123a34c9",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/components/navigation.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "bc1610377e0237701e88e5dad0743e7873e199c0",
      "bytes": 997,
      "sha256": "a86db9d86b15c33e9cfe43982f4f14c65fc802ec462572545c340aa8a7fa5a85"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/settings/LocalAiSettings.vue",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/settings/LocalLibrarySettings.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "6cdf602f6778a72abeeaa9107ec11a9d62c4498a",
      "bytes": 11830,
      "sha256": "c951cf6de5060ff42ac8b94d1104155cdb7791c137cc68f0cbf9f4c5e0cf9c88"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/settings/SettingsView.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "864353f1544ded6e2fb32d79d6030a10770aad87",
      "bytes": 14392,
      "sha256": "d077523d2fa9664514e56811e7892faa6cd3a954d7614aa87fb372a71460573c"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/components/sidebar/MusicSidebar.vue",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "bfca055b9ce45b8d4d6c49d758f1da392bf94199",
      "bytes": 7003,
      "sha256": "374590db1dc8d8b6e7e1fde6e21dcc7999e61b543591187f8f976d9ca4486477"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/model.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/model.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9f4e7907f75eb6ff03d028091383a6df9908fe65",
      "bytes": 26141,
      "sha256": "048dc8a31fb5b48d76657fb8936ba085f6362423e8817727adb52539f9858d28",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/presentation.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/presentation.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "39d7b67a0b66a6659f559113ff8bd9750a9671d4",
      "bytes": 1032,
      "sha256": "127a25431e5a8d5baea9dfd4ba212651eff89b313aabdb121bdfe738fec371a9",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/types.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9237dbac60b01669e669f14e8326f9f81968d1d5",
      "bytes": 2280,
      "sha256": "4e165b77d9588e64d293181692612af00080749ea2f5b3b89bf59de9a0070a2d",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "13d7ca2cbc6da89f28a88b181f6abd734d8aad8d",
      "bytes": 2430,
      "sha256": "5f7a63883e1d8598597fd535169da594284acd51778f2abcdcb8e8beaa493c97",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/controller.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/controller.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "fcddcb1683627cae6bb23bd155cc15c60c1c566c",
      "bytes": 42823,
      "sha256": "d059001d1e7c215cf7f4e2eed4744f910f89263eef4434b50544278811facd70",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/library.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/lyrics.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/ports.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/ports.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "6b2f66ede10fcfdc0d40322f4cf8559d474b9fcd",
      "bytes": 3888,
      "sha256": "4451a3ef9ac4965eee25cacb495a02d279229b9a8e30faa2ef753d0f9fcdaf0e",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/types.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "c63d49d9b51f20c665d90ef82fbe23a56ce61ccd",
      "bytes": 4493,
      "sha256": "00206816111c9c160627d939ffc499eea3d810e38564333e0a3e036bd54e1613",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/useLocalArtwork.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "2482de122ef4fd5e754249e8ab60de0855e8b676",
      "bytes": 26044,
      "sha256": "d2bc4140b51ff71cfa796a83c7ed0973fb4ce8b006c85ac41da4d8e7c16e6b0d"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/useLocalLibrary.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "eddfec9b0e9661858bd59d223193114673310c21",
      "bytes": 38769,
      "sha256": "db7df12f10c6d2fd6b52a9b4b0e32524fbfe16d36a0b896c6da37653e9109114"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/useLocalOrganizer.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "69d11a772a079bf51bc60df67239b54d906850d9",
      "bytes": 25955,
      "sha256": "23a37f6dde7a5c355e289e4d07939bb832b8c31b3850a878119a574580facc12"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/useLocalRelocationPlans.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8b5d426da38c6c262b4981fa5b64d0c6bcc1b80f",
      "bytes": 34473,
      "sha256": "3f638d3eb9c1a73cb167cce9859798ab21d719110c465cb61ee3f354dff39410"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/useLocalSourceWrites.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "7410e7ae75f04e8f08ae968b1c6fdac98806e940",
      "bytes": 25734,
      "sha256": "c97235268343ebf7956a976509643809fb40aa53513ff967f1563d2c60c54a99"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/usePageJourney.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "69456eadc7ca58b6a3a560edf299e28b60c4ce51",
      "bytes": 22367,
      "sha256": "49f593d1266d49484b3391372713e301cd550b517d5bef9ef82d391e6df0cb20"
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/src/renderer/src/composables/application/usePlaybackSession.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "11bab9672fc9817e6efaf703bbf134c44e9da636",
      "bytes": 51479,
      "sha256": "415c3c28d5cedfecd48880d573e75e5f85e8801fe5973c1ed2aac738b556d668"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/core-supervisor-compact.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8ed04ccda4d3292c7c8cb8e1e239d2c0942f6c3a",
      "bytes": 12327,
      "sha256": "1cabef4aeb05e85a053602c0bea0024a1e355bab4838f7b5c71bb8f790a611a1"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/core-supervisor.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "6e0902a3508a31c6146478fd20fc72539a64b46a",
      "bytes": 47301,
      "sha256": "5ed7883682499ff095409a0b42e23125443e829cfea1dd1cfc94334f1d68e601"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/diagnostics.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "7a493a71a060e8f107ac0cddcf5c79ff64c4596d",
      "bytes": 4597,
      "sha256": "238c04e6081febe76a04156e979f173b0ce17e5d230bef0f516473a8bfa5b3cc"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/library-cache-transport.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "ae571f499953ce46ff04be9ce1b4353cbd2e38a0",
      "bytes": 4664,
      "sha256": "c8f20e8c140071e521976820c531347076bbb6f61be94e5ee32befb6f3fffef3"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/library-read-terminal.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "61489da5fb9e6c19576947a1e007d0c4123aab13",
      "bytes": 13174,
      "sha256": "e9977b6a41e43c408cde8014dbb9b1bb3a58330bd4e9ab594bfe60a4499015f5"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/local-artwork-image.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "9d8d302e3f6a65f0cd0502fb9b383898d89cfa16",
      "bytes": 19382,
      "sha256": "d914bb81affd0c07dea676b18b34541848322116a2387e7564ca2703699f5156"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/local-playback-evidence.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/local-playback-main-timeout.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8f987d0c69b4a48f7c81ce87c57ccd738d0aca7e",
      "bytes": 5068,
      "sha256": "09117f77732b64f07b5c1ecb8a08997ce62aaafdbeeb349dfb9e21c7bfd20f14"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/local-playback-recovery.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "1244d96626de455eef502712c1d0add5caecb06e",
      "bytes": 59035,
      "sha256": "a54009bc9a885afba579f97d412b1b9b4593d046f5c22ad148db83f75acf5880"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/mbf-coverdrop-library.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/test/mbf-coverdrop-lyrics.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/test/mbf-coverdrop-router.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/test/mbf-coverdrop-save-gate.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/test/mbf-local-album-browser.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/test/mbf-local-album-browser.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "7427d96eddf4c9e6ff667b272f9797af050da2e1",
      "bytes": 27990,
      "sha256": "e4618c4abe96f955e02abd9d58d3da356f82c59785ec3c52c89205ab663a7144",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-album-components.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/test/mbf-local-album-components.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "39a3cf484eaed1e2e4578a13f6a6cbce0bfc9baa",
      "bytes": 28804,
      "sha256": "f67881b01fc5b8ffdf43d319dc79955c00f6d600c356f9bb84130a34a0e9d434",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-album-ipc.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/test/mbf-local-album-ipc.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "28b67363cbfa6869bfacd4886306dfc1a648888d",
      "bytes": 6141,
      "sha256": "16f03a3cc986c013190c27328c6daa11670d82e3c61e9d5cc11946a42b6d1367",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-artwork-import-normalizer.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/test/mbf-local-artwork-import-normalizer.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9a2e1c9c57907c2fe33c490dba14a8e56b5175f9",
      "bytes": 17829,
      "sha256": "615885ac27b56af9d5a0d3c013414205114826b044753db401ab3f62f731da19",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-artwork-providers.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/test/mbf-local-artwork-providers.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "e78c2318829a866233a5f2bb004050dcd76c57e6",
      "bytes": 22308,
      "sha256": "54a58cd59555793e999ed0e16b1eb6e897daa5dbcab0e3f9414f0dea51a0b94b",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-name-transport.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/test/mbf-local-name-transport.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "97e944a65af6c5a84916e6ffa394fe9278a6a7e4",
      "bytes": 13700,
      "sha256": "fc87f8230ebf5a1c596f09794408e17cbc684468d091d4da0fd3c7e5b45c753d",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-track-table.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/test/mbf-local-track-table.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "708805415dbdf54bf8af3b84ae311f3cd16e1f65",
      "bytes": 7260,
      "sha256": "0bd53c14d7cf8b361ac427d82b0cedafe2f75d7259cdabe154fba7ad64d6efe9",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-workbench-ipc.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/test/mbf-local-workbench-ipc.test.ts",
      "status": "A",
      "role": "test",
      "revision": "3175d272bdb64ff14869581927241032887b32e9",
      "blob": "5ad556195aa30a84bab74b8b716a89b558b53e5f",
      "bytes": 20574,
      "sha256": "6e6d4fa05c60f9cde085d22b75b478bacdbc9ee74a29303fa4ad891389cc16ac",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-workbench-service.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "apps/desktop/test/mbf-local-workbench-service.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "e51396f1b3db7957e5bebb424ad8dcd6f212ea2d",
      "bytes": 46991,
      "sha256": "05ef0d07fac0bd457978a2c814af8da4479773fcd8c5c5b2e4e726d7a4ffc912",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbf-local-workbench.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/test/mbf-local-workbench.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "195f87da4a83b29b1ae3779826f1a962e7c31762",
      "bytes": 30822,
      "sha256": "04abcaa7a866b91a56e4ed1777bde5bc0d0f76cac57b2a99e6049823eb0bcfcf",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/mbrs009-local-library-ui.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "df1d62451f5c8f46f148437b6867b60d107815e9",
      "bytes": 26687,
      "sha256": "414928f85d0e2dc4cd6df0b16b311243dc037ffc543acc1bfb404ee29e9d6e41"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/mbrs011-organizer-ui.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "985de5a5ae7a4968749cee8aefc50d75d8e95a80",
      "bytes": 29493,
      "sha256": "6dade2fa5ec73b2667ebd3eb0265296f820b2bc51bf0f4e8e8536a8fb8c2d099"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/mobile-content-rpc-main.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "e7bf91b074b3dae02086a33a0d2b8e5f7d0c7df1",
      "bytes": 29775,
      "sha256": "c3c2826bc9377d6b35dd7a8e7f5146c262699a83ce93ca1e1599e3d89b819886"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/preload.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "3aa3364c7a1a991d670ed2f9d7a7f9a9718a3990",
      "bytes": 37258,
      "sha256": "91ba4beb8478bc651383cddb71ab6cdd84b930c03a1b6ba58db73fc8167391d1"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/recording-print-worker.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "e2bc257dba9e3b4dd88efefa6bcc074e8ee2d649",
      "bytes": 5551,
      "sha256": "5523221d163b3eada6d02a2362ec2292bb84a9ba748e9ebe9bd242ec09cd4159"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/sidebar-controls.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "5aa15b80bdffb792ba9d8ea09317b1b40061f49c",
      "bytes": 10949,
      "sha256": "8c7b37c68ca970595734ce549acd7bbaa481eb038e542efdb15f44e56b5ce8ca"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "apps/desktop/test/support/mbf-vue-host.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": {
      "path": "apps/desktop/test/support/mbf-vue-host.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "87caabc07f9b7163dd34b0dfcf4b72306e3c61ca",
      "bytes": 7838,
      "sha256": "7fe5ca9d3411fa987a3393a12027e1b74726e173449c26774c7332ef609ccc0d",
      "mode": "100644"
    }
  },
  {
    "path": "apps/desktop/test/v39/local-workbench-lyrics-ui.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "apps/desktop/test/v39/local-workbench-native-settings.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Renderer",
    "donor": null
  },
  {
    "path": "docs/feedback/MBF-002-003/ALBUM_SQL_CAPACITY_EVIDENCE.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/ALBUM_SQL_CAPACITY_EVIDENCE.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "17dccd1c078c38bcb17b3db9b2e8170e2fa7020c",
      "bytes": 16985,
      "sha256": "72f41780ea9492d2a5938bfd989c3cccc183cf0f613a83f718efb7d43aea31a6",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/ALBUM_SQL_PERFORMANCE_REVIEW.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/ALBUM_SQL_PERFORMANCE_REVIEW.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "93b1afb13281bfb8b3d3cb20f67c7efc6915574b",
      "bytes": 19966,
      "sha256": "3053066dc68e687839c4104d3f54e02199b52452cf477c3e82e56edef425f187",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/ASYNC_DATASET_FENCE_RESULT.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/ASYNC_DATASET_FENCE_RESULT.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "776924edb128d5fa3b3f86c3265c2ba02760d248",
      "blob": "bc036b58b36b12e3424b4528baf77da83688c6d7",
      "bytes": 4810,
      "sha256": "36d369f5da5f04ea70b144a04be99aa2b16efee812202e0570ef9c3b4fdad7e1",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/COVERDROP_FEATURE_MAP.json",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/COVERDROP_FEATURE_MAP.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "9625d8627c23deac282366ff6b4417a7dca93e09",
      "bytes": 57669,
      "sha256": "e6b87068debcd737dc701ee477c4d185be755eda0695085961c37fd3d3ffaa6b",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/COVERDROP_FEATURE_MAP.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/COVERDROP_FEATURE_MAP.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "cea05e3869f46bf71399e510019c629cd2a47629",
      "bytes": 34004,
      "sha256": "2c6fa824b54b1ddf4f5a30d2e20a9a517b83d8bdb5aff190c7a316f0eb49e545",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/RESULT.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/RESULT.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "454d06e5043e25746621aea145dd7c91e853a53b",
      "bytes": 10667,
      "sha256": "b8b6baceae5714d8c3b9b2d5ba0ae9857d2005aeffd9756e763fd95815634a64",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/V39_ATOMIC_WRITER_INTEGRATION.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/V39_ATOMIC_WRITER_INTEGRATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "fc92209148c6abd34cd2d0e15d7f77d1dea3e3a6",
      "bytes": 30617,
      "sha256": "2ab780ad336e070dbb7d88aac5e04d60a09ee74dada0f8462677c390129ad3e4",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/V39_NATIVE_SETTINGS_INTEGRATION.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/V39_NATIVE_SETTINGS_INTEGRATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "29a889c520ece47e9251aff8264a7013e2bc0d9a",
      "bytes": 36692,
      "sha256": "a888598c3f8be8924a6b1e6046cfb07512f99fccc40c7935ba1f855ee945a19c",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/V39_ROUTE_AND_PAGE_INTEGRATION.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/V39_ROUTE_AND_PAGE_INTEGRATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "865846c1c4572266758f435844f73c7374163a95",
      "bytes": 17090,
      "sha256": "8f06b3c395fc3e31c5031d578b37b8f9f574a34ae551f03db1ef5db2d0bdc105",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/VERIFICATION_MANIFEST.json",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/VERIFICATION_MANIFEST.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "a2d952018c867ce042c8cf5d9978c3e51d10c7a8",
      "bytes": 211686,
      "sha256": "bd3f8001308124119d7faed2a01d60321b10e2703c5962cc597781bfc70c629b",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/WORKBENCH_IMPLEMENTATION.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/WORKBENCH_IMPLEMENTATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "30c17cc6f9c6fdf091febe7e74ad65e5c642c7e1",
      "bytes": 17599,
      "sha256": "46f3d79c92627453331d24a9b865203d6e01a0a456f46c035c8f7c93a2ac7b00",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/WORKBENCH_SHARED_PORTS.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/WORKBENCH_SHARED_PORTS.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "f61a878514de0e88271c0c6c60d2e4068c78a618",
      "bytes": 17924,
      "sha256": "1733eb2632fb916b3554e3e82edd96c187c990fcfbbffacd58010fe480cbd247",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/proposals/README.md",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/proposals/README.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "23f0543bb355e160192b9d3653841a0fee8e68c1",
      "bytes": 829,
      "sha256": "a4eb0f6e83dd9aa205b273a40d1471c7d5bddadde90914302f0cfceff5ef967d",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL.json",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "03c2a1a666b17812f7398dcdc7283125d6de6a5a",
      "bytes": 1266,
      "sha256": "3ceb5b61cf798b1169f4b872cdd2ca88183cf4dd4c95ed20ab3ace8e9a10d0ce",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL.patch.gz",
    "status": "A",
    "role": "historical-proposal-not-active-code",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL.patch.gz",
      "status": "A",
      "role": "historical-proposal-not-active-code",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "ce24f06a75ff44a7d35bcb1c83911877c6844a64",
      "bytes": 3870,
      "sha256": "9601be79b90c8059cec99188868c134ffe38ede59ca7fa9b0df977cd0e153178",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL_V2.json",
    "status": "A",
    "role": "historical-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL_V2.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "d5255f253e23f182f54b731e58b439c6747873fd",
      "bytes": 1266,
      "sha256": "67279769375d21a31325681e409d92f1a7530683d363700d6901711e39f5f572",
      "mode": "100644"
    }
  },
  {
    "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL_V2.patch.gz",
    "status": "A",
    "role": "historical-proposal-not-active-code",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL_V2.patch.gz",
      "status": "A",
      "role": "historical-proposal-not-active-code",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "502459d84d9d4f5e684702c25b8476fd0ffc489d",
      "bytes": 4075,
      "sha256": "e9d4aaee0b9799307a2249c265fc3b4be7d57f7598ba0c7a7bad92e9ec3432af",
      "mode": "100644"
    }
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/DONOR_READBACK.json",
    "status": "A",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/EXECUTION_SCOPE.json",
    "status": "A",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/FEATURE_BEHAVIOR_MATRIX.json",
    "status": "A",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/LOCAL_SOFTWARE_EVIDENCE.json",
    "status": "A",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/NATIVE_BUILD_INPUTS.json",
    "status": "A",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/SEALED_BASELINE.json",
    "status": "A",
    "role": "authority",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/STATUS.json",
    "status": "A",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "native/library-watch/fsevents-helper.cpp",
    "status": "A",
    "role": "native-build",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "native/local-audio-tags/taglib-helper.cpp",
    "status": "A",
    "role": "native-build",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/application/bridge-controller.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "cd6fa963cf50c1d712b84deae738d414d8ffbbed",
      "bytes": 150785,
      "sha256": "8e1e3f8cc8f5774ee9c09b08691e794fb86c33a2b0bf44a8539aae85e059b6f8"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-dispatch.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "31390c6dba3604836bdc2204d5414c9e046ee011",
      "bytes": 59157,
      "sha256": "32f43b5dda5766bfa2b50d4c1c1f00e979993b50f2ed494444cd4cdcf81e44b3"
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/dataset-dispatch.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "13866409e551d41c06ea98fcc2e342acdb7922de",
      "bytes": 60122,
      "sha256": "961f386beb9b359f3594913ecdd914d37b371974206088ffada35a9b2f35bae8",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-domain.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "16b5336384121b0d0ebd59bafcba973f64ae1223",
      "bytes": 30949,
      "sha256": "4542f5669f766419e029c3111b2b848ebdf737675cdffb60ffd91fb5b41d969a"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-owner-client.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "50df05859a37fcf43e0a842f70768c210220bf1e",
      "bytes": 22836,
      "sha256": "cef49cbb448c1283b82e61ed1962dff79106c56d505d372a4f0be726421ec86c"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-owner-protocol.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "3990b5337b5d89b073d97513c09ec2c4cf5b2024",
      "bytes": 30338,
      "sha256": "fa070d9383c8913d27e9ff23f59e2417b7402c19f13d7ec57d09b09e64823c5b"
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/dataset-owner-protocol.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "de338b307820c0f2842e4eaf9f2fa3df04d67726",
      "bytes": 32487,
      "sha256": "1d43c3e4f9277524b51bff59315d74f470ae91f580a55ada1e169b6631c763d8",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-owner-worker.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "c6f2a1702bcf6fb490155dacf4d5736766648681",
      "bytes": 23431,
      "sha256": "ed445977acb0b85174c3b1956d1f72c2dfa7be492a5800bc646452f94ad741c0"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-services.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "7d3113f1ef2efee9a7b231b380f57226a7b20d70",
      "bytes": 3776,
      "sha256": "25aa186cc1e73e16447c972bdda28e0b99aa9eb0ec70121c58647ed3f0a6da7e"
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/dataset-services.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bfbd1cf8ca6a38dbc10259aac9942adc847b2dba",
      "bytes": 3899,
      "sha256": "967267d6d0dff6144bd7e40349ccdfb48b041aa30a41e1fabc9a7a8f3a1c1014",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/artwork-read-port.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/artwork-read-port.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0aaf8d7c24a13e4b5ec92156df69e9d3727ec508",
      "bytes": 11134,
      "sha256": "e8d2d01a7ab972b826d43d19474847b51c993d0165d258b49f04d3eda5158bd2",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/grouping.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/grouping.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9b91146090c2b4da1df48ca39d8855c725a71c87",
      "bytes": 20808,
      "sha256": "fef0cf19b5fbca7e030813aed34a60bbbab4a0d4d6a52f6141377b5c9185bc31",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/main-protocol.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/main-protocol.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "eb4720ba35951deefa7c09a933d1336496244036",
      "bytes": 3600,
      "sha256": "0afd5768c52777cc103f6a6794dcbde7b76ead127d4e9886754a3f9937c1bfd7",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/owner-port.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-port.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "1351bf7cc3b1f0687adbde6b30f4c363d6583565",
      "bytes": 13937,
      "sha256": "85471c6f59882ea12c2f2697066389b95f9dc0c0805635504e8033237f7b2f3e",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/owner-protocol.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-protocol.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0d6024d022186fffb676500ad1223bb6f9cace4d",
      "bytes": 1772,
      "sha256": "0cc1abd8f469c0ac009d7eeb751aabe361504b83170613f2a320b450f328b0d7",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/owner-runtime.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-runtime.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bad231f9c7effb53f22fc24cbe34fadf4a76c49c",
      "bytes": 1747,
      "sha256": "ea047f7aeb5bf723d7c70519b70a33cb2759906e4df071ca5ca4b334066574ff",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/owner-store.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-store.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "b5dee3a90a2537f6a9c832aa955ae98302067198",
      "bytes": 1664,
      "sha256": "ed230250a1f43b1a34f3f6c6163e1acef51fa6b0ed5c02c6fb50c5eea4ca3567",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/read-service.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/read-service.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "6cd2aadb1c7672b3b00eae109677162e91f92878",
      "bytes": 10841,
      "sha256": "3911f59f4a2456126848150516bc0dce36204230cb26098afa580f25f1eb522e",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/sql-read.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/sql-read.ts",
      "status": "A",
      "role": "product",
      "revision": "b535ed79ae31abacdf92668d983b8af89a584be1",
      "blob": "e454597e401d13a6cd3a95e768a420c1e3193e12",
      "bytes": 38788,
      "sha256": "cd01f6e7aeeda4d5406b1645847394e2a8873dd51850c8036be25e25cbd6211b",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/sql-types.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/sql-types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a4b6f34bfcccac8e9abfc6f9ee3a8200d46e7125",
      "bytes": 2922,
      "sha256": "b95088c9694d853d3591f07bea4f2890e0f300fb2a1dbfd3333be031185e2c06",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-album-browser/types.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-album-browser/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "5e38f92c5438be126a588d28e4ea0e5031f69b7b",
      "bytes": 3983,
      "sha256": "17136251989b5dc7fc62858b77d79d5282aa7f71c84b4e6a0a06a0fda0c1b1c2",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-artwork-service.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "04fd099b37a9e5b98f982ed26d2a2052d63500d2",
      "bytes": 12934,
      "sha256": "bcbbcdb4c8d534712005e9f182603e9bee5dbcf8200d2c20f9eeed5292889f96"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-artwork-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "fe3830c7bbbeb60a230748c8f9217cb42b9f0d8d",
      "bytes": 20484,
      "sha256": "b09bf9d744e7f851423a563d9453f83b0096d3354f789730f72cbe0746fb0ba1"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-catalog-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "5537d6aac291010a4543bc17d975e120de169f1f",
      "bytes": 115384,
      "sha256": "4485d96516b807433c0a3e318ebc662738ed9281431840feb29546025e7040ab"
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-catalog-store.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "f1b9ff8cd51974174f1a8ffd8682a08f1a319cfa",
      "bytes": 121945,
      "sha256": "bc6437c90b3dde653d3eb0c6edc4dcb46cf5c8c13834c8e40b16a039f807d531",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-cue-output-actor.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-cue-output-protocol.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-lyrics/inventory.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-lyrics/job.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-lyrics/providers.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-lyrics/save-coordinator.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-lyrics/service.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-lyrics/types.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/cue-plan.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-library-workbench/cue-plan.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "cad2f6c7d5d70abfede1333830307001d70d5654",
      "bytes": 12641,
      "sha256": "ab257d45fe717c306d8e5221eaa57d306ef05c7c21d3000addf2eb33fba7d41d",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/lyrics-service.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/lyrics-writer.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/name-proposal.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-library-workbench/name-proposal.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0ca376c911c32ec02dfaacfe2657ce9c27585088",
      "bytes": 13171,
      "sha256": "9c840394f15af2b4edb9e137083c3363524fd8c012843dbf980dd35780751140",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/owner-journal.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-library-workbench/owner-journal.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "7a58c2322fef5b9fc30bc17cd80c3f6406b52ac4",
      "bytes": 11270,
      "sha256": "ff28bd500fd8fa5a7f44c4e87782e27aab10d0ec16e032f2d3b6b85ea17b63d5",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/owner-writer.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/plan-registry.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-library-workbench/plan-registry.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0f174e586cd287204e1daced6e55c8027f2e1558",
      "bytes": 30544,
      "sha256": "d1c2dfd7311e5f676f0dd24414cac81555448e6f11a033996527e527709840d2",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/read-service.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-library-workbench/read-service.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "3baf0f520cd3f7d1289aabe391007889f0792735",
      "bytes": 36128,
      "sha256": "2ecc8582ea912e5f69fe076fa13db6bbca901610dbe61387ba752d3b059a21d9",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-library-workbench/types.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-library-workbench/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "257b67728cdaa5c65b2aa29f9a5e3d4a466fda31",
      "bytes": 9345,
      "sha256": "ecaf9f741d28c0d225381e513ae7e5988cb98f6df56989e2a03bb1aa17a76340",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-organizer-service.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "87ee9b5ca9fbb081c42a13110aa5fac2707c1648",
      "bytes": 9708,
      "sha256": "957cb7cfe9a1f33c7cdaf3a3af38a739839a86efd289215f2087d4293c82de8b"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-organizer-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "f4f67e2b0ff09f9e11dd45c1a87bd29dd4b88a81",
      "bytes": 20130,
      "sha256": "f20c01e26f64222f1955ec777bf505bfa375373b6517e08d7a001315e746e549"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-relocation-coordinator.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "6e884b7d4ce58f44a7ccd92305f9b22603b92b95",
      "bytes": 9644,
      "sha256": "05acb43a9486bf3c33ce06fd4e2d13908668b67125ef362c751fd03beaffd98c"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-scan-coordinator.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "b3efabd584bf405d98feae0dfb2be9a03c7a7732",
      "bytes": 36729,
      "sha256": "9ec5da721ddd6ad8ff46717dab5046997f8be5ee710aecfcdcbea8c3c936a3d3"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-scan-facts.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "9bba7ecb2a4930505f9c04129896638bc313b606",
      "bytes": 724,
      "sha256": "265b5332f8e0eeded29892410650f61afd7b0f137bcaf67af362c4a876cb2ae9"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-scan-settings.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-scan-snapshot-view.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-scan-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "62e1ba5630eb65e5e42ce8ed4111368534704cde",
      "bytes": 96652,
      "sha256": "0d67d169b015ea4af3cb730275126ad899aff3046190c4b17ffb61d96b8cbe7c"
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/src/collection/local-scan-store.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0ee507bb1040c260488177bb73107266f71e5055",
      "bytes": 102853,
      "sha256": "79871706ebb0e1ee2dd5f4bd6221262387f3e364991a2480efe90999b86d6051",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-source-writes-journal.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "4e4505b0725b7a66ebd5fc0a9bce27cb8488ab87",
      "bytes": 36495,
      "sha256": "b4b2f6ff102113d2a65c6c13c0e20aa800e393f4d7ff92e84f5d52fb06d222ad"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-source-writes-service.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "4628d74e2b4991b7c506cfb7ed730f143911d0cb",
      "bytes": 98065,
      "sha256": "1fedb95e6a671d900f9613bb01ba9ff7b353ca44fc1f5282a1b0420f45ba8ed8"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/local-source-writes-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8cd9382bc911382a55126d21d3c3151b56f536d5",
      "bytes": 8892,
      "sha256": "f74590976d0d9e2fd079f87d8efa98e4158d9da5f290df19d15d529ec32dc8b0"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/source-relocation-companions.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "49b17e8c08a68301e448aec0b0285a87797e2e51",
      "bytes": 13373,
      "sha256": "de5cc1eb04652994cf1b7b8c834eed440e02527c1a443ce4ddc86bb83de5674e"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/source-write-format.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "9bb61f0ad6fd1f5fd167437c34a95ce8c459ddd2",
      "bytes": 14079,
      "sha256": "a72b0e121097538c24411f3c19d398dae0aca33b68432aa823923d9b6e5b7fc5"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/source-write-metadata.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "cd66f51048ca79d38d1ddce5e9e1fdc0ea1fd3e0",
      "bytes": 4405,
      "sha256": "ad20632d907047540f9cb5ce8327665c49ef245403e3eaf5df4db72724747fbe"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/source-write-verify.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "54c3013ab1462689cdbfa2e2875337dac76eacf7",
      "bytes": 8967,
      "sha256": "7b5a4ca527609219bb2f449c059d41293b1f09bb932309735cc461edbff0ee4f"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/source-writes-authority.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "d348abf035d44787808cca1a7661e840cc9c685c",
      "bytes": 1039,
      "sha256": "90afc5376c43bb5242ae582517708cc569dc942351ede7b91ea202b23ed3be10"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/collection/source-writes-publisher.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "4d59e460d42cec7591dda477b3732548713cdd99",
      "bytes": 49191,
      "sha256": "96121162fb48220cba9a2ab91a7ac3b64fa184675a9fb14f5832228cff9a142a"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/bundled-cue-converter.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/cue-ffmpeg-build-policy.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/fsevents-library-monitor.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/local-artwork-embedded-reader.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "09f0c1c61b7964aef5d8180f1c707a0de7f3093c",
      "bytes": 9922,
      "sha256": "90b24db944acbc1241fb6113e9e3c713190a5fa31d703bb3550c3ad0c516ec32"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/local-audio-tags-actor.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/local-cue-format-qualification.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/lyrics-source-format.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/metadata-reader-types.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "51fef658b1921928896123a03304c7dc7c67b1da",
      "bytes": 4680,
      "sha256": "73cba2633c2a0e2279e479cfd9fa55574128858405f71d835cc3c3314f967ae4"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/metadata-reader-worker.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "339e351ed84373a41a69cdbb34ae0c97cb7c854b",
      "bytes": 25164,
      "sha256": "69dbe124e98d84b6b542d0e43bf459a6d122d4c1e074e2f2b7e8745543fd66e5"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/metadata-reader.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "c166a5e6919ff352844b1b32868a3a3254aea68a",
      "bytes": 14112,
      "sha256": "9e3588d6dedc2c65a4e81b8eb5967d790be13b26702d4e65ae874f684ae80f0c"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/library/scan-read-admission.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "775ef8a4e210d8d60853364fb1cf3e8ceee2a130",
      "bytes": 4825,
      "sha256": "d87f0c541c8eb9978661d15503a0e2f7a5cf2b490bd13d267b98732c017bb3b8"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/recording/source-files.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "5804e480219c884de4354fe84748a3dbb760faee",
      "bytes": 46157,
      "sha256": "3ccafec70017b883c3709a72b6715b3ca6b367b663a71d858b0279424e7de898"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/recording/source-protection-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "853b510d9b06d6d3ae529c662dfb0f9d9bf87e9b",
      "bytes": 28518,
      "sha256": "486b7b1b3a92e01c1d3b6b387d4d3c5a5e58573b3767dc13d743b5697b013d94"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/recording/source-protection.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "972fc9d2a48167f916cf13989fa377d9bce4b701",
      "bytes": 10752,
      "sha256": "5057c3e693c99a86fc9969c040751ab3230950469d6d07f081494047043cffbe"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/recording/source-store.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "c3ea2fafa28e109a85d6ad9279352388fc991ddf",
      "bytes": 13849,
      "sha256": "1cdd230ed40b5907921a02427e76752b0e4660187cdeac870d3fd568bb5561ca"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/runtime.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "b27c871dfb3124e4c89881d7b40c481aba9fda81",
      "bytes": 103348,
      "sha256": "fa8e446821b69718636ffae019703feeebe879467c39e850684c3f033839158c"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/shared/library-read-trace.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "90e508c46a108cdd7b1649e7d9e1671f5ba049cf",
      "bytes": 10989,
      "sha256": "6ae6397cade18c5210fa4a61f53e760dfa55cdd74383a615f567ed91388339e9"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/shared/local-album-read-trace-node.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/shared/source-writes-utility-port.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "72dcc9584cfd82fdbb1145f254e9cdf10f9f236f",
      "bytes": 5077,
      "sha256": "a3a665b3a2ef2b40b93fa7615dbb90551df1fb34eac35d60d1600040772ca720"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/stream/gateway.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "f779c68fddf5c576b5fc2f168ef0ac182b7a321d",
      "bytes": 25286,
      "sha256": "85c443c0fa015dce41eaf897b403aa96628f0c1460f48854dac365a6ff8fad47"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/stream/local-file-http.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "6a17e41d5b1ae7f0f7025820ab2403005d99c1d5",
      "bytes": 4187,
      "sha256": "b925c0e6d339f33a80ff3d3c406261445860a2f0e3b09fc83f6746c62951bf1d"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/stream/physical-resource-claims.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "38b3e563995f75af7b334ea1b2000ce745390d0b",
      "bytes": 14918,
      "sha256": "8b1f47063435521135b5bfaf61951b6486d355fdcea6bb9bdfe3fdff5cd4cdba"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/stream/physical-resource-locks.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "a7f9fd18088bce4986269072b942ae119b5ca5a6",
      "bytes": 15391,
      "sha256": "79052d83b6c602de784da7002f975aaf71e91c84f11bb9acc7d913fbf2fff2b8"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/stream/source-namespace-claims.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "1a4623a32f5f98999cd7233cfc47d9e651e8edeb",
      "bytes": 24762,
      "sha256": "c7810434565cdb4b5c8fe394ca70d50442327e158a1439b54dcf3ae15e35d715"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/src/utility-main.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "0048c8b67ced952ec4cc55474cf6216ef940acea",
      "bytes": 55979,
      "sha256": "ad8101eb0600a0c896803100281b3a654b7f589a3982959a0fefa88b35bfaa1d"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/command-outbox-core.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "d5eb2c1f5d10de8ec7f1ae2cbf29e31f3c9eb967",
      "bytes": 11323,
      "sha256": "59e8850b221d19a57841a2ec4e52c09c0e23c913917cb4aab40dab7e45295575"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/dataset-domain.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "3df550fe4b9874c3a5a6bd467ad8f8512d5575c3",
      "bytes": 14941,
      "sha256": "370fa4439aff932b89c147acfc59a7910fb0c101534fefbef7c4bea24f3eb082"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/dataset-owner-integration.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "0ab0615f1a681d10fa8a2920533cf32f6decb429",
      "bytes": 7292,
      "sha256": "8c98ada211df8b3ffc00c91efac0e28cb1ef9f57dbe25e1c4e5dfee0b57b2a98"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/dataset-owner.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "b61447e2333a1d0b8347283f44d0793f9fd0330e",
      "bytes": 10466,
      "sha256": "57053a6ecfab9c7eabcf09d548fe47644acafef21d7861b6a4c7f63256d57b22"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/local-artwork-embedded-reader.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "247afacaf3b1ae3239bbc0bc64a754c9bdec2b58",
      "bytes": 17539,
      "sha256": "f84041155e33f0c873a85409e3a1a9f4278ab67c8b86b6cf6e5ab478efe09fd9"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/local-file-gateway.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "b9286d1abc7eb57477fbf34d4df8e47c0ebe9edb",
      "bytes": 200,
      "sha256": "1285e8dcf7d9e74fb5a0ef79428061c69dc43354a3fe1aeb2b6907bfa3ebb550"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/local-library-wave-empty-list.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "873b53a672c99a1d51f63b78d8d0623c3d486dac",
      "bytes": 39307,
      "sha256": "f37f380973349221960b03720085771aa82c2f5457e61b9c05cb1be0ced2f0e7"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/local-library-wave-extensible.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "f0c126d410ff9525abcbd1e107a2d3ec0a410a80",
      "bytes": 17269,
      "sha256": "98f8d361cf4efb3f5c18bc8713670d12044453a494db0cfdcfe8368bc6f164e0"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/local-playback.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "b8bc9c603fe8e980c10c012c8e743a01b050fe23",
      "bytes": 335,
      "sha256": "9381c2b4600da8efae7c5198803baf4a829a749464c99e5d515cb280bcabf3e8"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-group-markers.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-group-markers.test.ts",
      "status": "A",
      "role": "test",
      "revision": "72e5e913e187cb558805c2c5f5faa3d2ce4b2bf3",
      "blob": "592570a06fc0bedbcad78afef90b65613329e6d1",
      "bytes": 39326,
      "sha256": "fbc88aa8e246cce55b83dbf59cc2e69e3c11ee523e8241a834272785e8d48606",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-main-protocol.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-main-protocol.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "2a901f9980d695c46cf32d4b60acb26b47a7f582",
      "bytes": 2562,
      "sha256": "76d61dc4b25000bc58a7cc22064db698678b36e909e1c03b6e9903fc005282dc",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-owner-protocol.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-owner-protocol.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "d2f276cad6771d49ed14b55eae3f77fd2d30387b",
      "bytes": 1352,
      "sha256": "931cc681741a9d78c3e883ec58f14b13b82749ce820e664e77cb4a6d70159428",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-owner.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-owner.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "6487f29211678188d65b4e37b2cb8884b0a9d298",
      "bytes": 10847,
      "sha256": "11ed4fdcf31c70172ef350306e6e84fbfd2eb85b0e023857ac56b0b64c5efe5b",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-read-model.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-read-model.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bcd9b649d2edec593fa2af476a7e92ebf3d5f130",
      "bytes": 29710,
      "sha256": "f4aa7f7071c8ae0bf4ce13d26b974d49c5f935f895396136b57a3c2a8bcd521f",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-scan-evidence.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-scan-evidence.test.ts",
      "status": "A",
      "role": "test",
      "revision": "54887cd5a26156d19903ee4116eca507d247debf",
      "blob": "048aacb583dcf41e734d625331fcd5744c0c1795",
      "bytes": 35958,
      "sha256": "d9ae7f529721ae919c3101bed0c1b752c99a82cf66ea3180ff5504974fee908a",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-source-marker.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-source-marker.test.ts",
      "status": "A",
      "role": "test",
      "revision": "43036e7ac9c322098782aaa9ec3d6d2d22002f5b",
      "blob": "6159068a116620785f198c17f55ec2a81777fe3f",
      "bytes": 45674,
      "sha256": "7bc747789c6f5ed0c7e1c9f64710599e0de1fb485b5ff4cf93dea3c6aa4fcab2",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-source-revision.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-source-revision.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "8c7b6a84f5cf1caa93dff92390099b495d34d2ae",
      "bytes": 7583,
      "sha256": "3c2aad87386554517379cc9d7583f9799f6edbc8cbd1f4718aeacb07accf9a2a",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-album-sql-read.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-album-sql-read.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "cad12ba20bea9d0e9a065cfcd585f194312dfd9f",
      "bytes": 40493,
      "sha256": "fef5c7223469e571677ccc3e92a47bd78a97a1a201e1fe1b546eb9882f8362ff",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-library-organizations.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": null,
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-lyrics-inventory.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-lyrics-job.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-lyrics-providers.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-lyrics-save-coordinator.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-lyrics-service.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-source-root-null.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": null,
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbf-local-workbench-contract.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-workbench-contract.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "b92a1a42aa39292fe0a5a6ac0a1002eb741c4f97",
      "bytes": 11936,
      "sha256": "8814f9ad56fd9576e86a9f4f2c2bef4b88a9cc2632cb5527352449415a1aa95a",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-workbench-cue.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-workbench-cue.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "937b6c71c0a12cb8a44cf6d2449756b67a7adf63",
      "bytes": 7382,
      "sha256": "330cbaf09f5cad52b9f55a07febe386ed895f443d4e82f93d763859e4f8cefb3",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-workbench-name.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-workbench-name.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "80a57c8e788e46fa7ac06ebcec9e0210919ac7fe",
      "bytes": 9016,
      "sha256": "d646c710559d9f548de2b648a505777737fdbb2f68f205a3e2bc2a987670b6db",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-workbench-owner-journal.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-workbench-owner-journal.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "911bf382b540956ebe8f8e60ef408505b9e34721",
      "bytes": 10321,
      "sha256": "7a5d63df92fc54a2979e6e1fd8c6629306f0d534c1edb9d9e80f910720b8c0cc",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-workbench-read.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-workbench-read.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "28f39f376ce911168bc94f6eebf00e94326d7bd5",
      "bytes": 21368,
      "sha256": "bec484dc923a19f948d338d29abc885b04aacf2c0254b83c5e2db096d9698618",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbf-local-workbench-registry.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/bridge-core/test/mbf-local-workbench-registry.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "67300a055a477550133665546eb3fde0ee6866a4",
      "bytes": 23017,
      "sha256": "fec67871f836284663e586570ad37e9d990288a53bf3b6fd1e2698663b0432fc",
      "mode": "100644"
    }
  },
  {
    "path": "packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "816967b85e19d5ba19d2996f1adf9869e60b6c13",
      "bytes": 26566,
      "sha256": "c4d4aba1f47b3d06f2b1fbc1d1d26aa7ba45f234b4da666c792fc78f824c30ca"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbrs004/name-rules-scan-integration.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "7e8a67f364291ec2c8d4241cceb62061ece46a16",
      "bytes": 9010,
      "sha256": "457292294c2a028315f768cd3aa85103f759632e67e70255fe9888db0b6c3445"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbrs005/config-integration.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "fa8a90784419484b884cdc72f63343f5cbcb8861",
      "bytes": 8337,
      "sha256": "85862bbe07da5b1ed57eaabd8947bb209e72a32d13782fbec13a097dcbc4f549"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbrs005/http.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "4b98c5b7979040f260324e80b91297690f68348d",
      "bytes": 12173,
      "sha256": "dd5c0f99003ac6848719850c0166814f969c630f12622e39c9c40bd6cfac7137"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/mbrs006/controller-local.test.ts",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "fad363c24034836fbaa6508a5780ba75d5fcfe89",
      "bytes": 18103,
      "sha256": "452d35c0d5b2717ad902cc098ecd0c5b789608ee0e058d065b56415bd12e5364"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/fsevents-library-monitor.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-album-capacity.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-audio-tags-native.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-cue-bundle.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-cue-input-formats.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-cue-native.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-cue-output-recovery.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-scan-album-scheduler.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-scan-completed-snapshot.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-workbench-capacity.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-workbench-lyrics-write-recovery.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-workbench-lyrics.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/test/v39/local-workbench-shared-owner.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/bridge-core/tsconfig.test.json",
    "status": "M",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "4bceb0b5e8bf1b57c2c216a253d9c0ef8471925b",
      "bytes": 231,
      "sha256": "95cdbf6bc8ef63d2a5823f512752d109aa9afd5de08454c20f449e2160164c69"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/src/command-outbox.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "45feab54cd57aeec5d1f4b7e372323365fd34ab8",
      "bytes": 33600,
      "sha256": "276f6f1eef08931a1051c172217f663c47402ea4c5f15177214a705de680f892"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/src/index.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "b78f996e3df99ec414087c36871ebac172bad0b7",
      "bytes": 2767,
      "sha256": "334a85a4b8304102635c128a3c844917ba07606273388342dca9b8f0015245ad"
    },
    "owner": "Root",
    "donor": {
      "path": "packages/contracts/src/index.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bb6a1897980d6e7f237192a6531b2415b9811730",
      "bytes": 2855,
      "sha256": "03007c4852cf7e39539261c520c8c02f9f15a97378e03a4611e2b8680f38f68f",
      "mode": "100644"
    }
  },
  {
    "path": "packages/contracts/src/ipc-names.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "28b42796a4816b001916254106869d3a9f8ce546",
      "bytes": 9535,
      "sha256": "e67f6f36886a5164efb6e9682429b22c8fb9988be126902d500ef7356bca261f"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/src/ipc.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "d0f69f3d45d22c51567c6d0ad0ed39d70873bb9d",
      "bytes": 47055,
      "sha256": "0b32da0a19968da807a62ba3f49f1f146345eea81a6975a042cae2c883abb911"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/src/local-album-library.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/contracts/src/local-album-library.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "91681e594939b75ece23dff6f5b531060fde3654",
      "bytes": 15401,
      "sha256": "429d403d23bd20c0c3eab141971b9187ba4416622535a021e0eeecbc3ecc9e66",
      "mode": "100644"
    }
  },
  {
    "path": "packages/contracts/src/local-artwork.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "a6b3c75f53d0ee8513164f1bad489263562e2142",
      "bytes": 18065,
      "sha256": "2149ab50ba40113491cd4149e80caa45287c7fad72021e71dec21c16754848ae"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/src/local-catalog.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "facaa9766cbfe0ea225de57b2e932a6020b461dd",
      "bytes": 30109,
      "sha256": "8796cce24bec3b10cabdcde05fe24fa536eef23755cc61389977959a0b2e54e6"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/src/local-library-lyrics.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "packages/contracts/src/local-library-workbench.ts",
    "status": "A",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": {
      "path": "packages/contracts/src/local-library-workbench.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "433520190cb95de24eddcb0fc762fe572a91eab6",
      "bytes": 42769,
      "sha256": "4b08388901ef35565e98374454d03e518ddb819c5b8f1b0f348b1fc913f6b910",
      "mode": "100644"
    }
  },
  {
    "path": "packages/contracts/src/local-scan.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "5ed7bb3975bc38104530272a36b65537538b8ffa",
      "bytes": 17948,
      "sha256": "232cc3c0423f30377b3f04f8ee12a9c96c85192077d618394bd3f7eb273c53ca"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/src/local-source-writes.ts",
    "status": "M",
    "role": "product",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "167839eaa10edf727141cd836d849e3333f27790",
      "bytes": 44593,
      "sha256": "af8497cfe7b79b478325910bbd2b543d9c25a9bf8c5b48988ec79fe874de21c6"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "packages/contracts/test/local-library-lyrics.test.ts",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "CoreLyrics",
    "donor": null
  },
  {
    "path": "project/POSTRUST_PLAN.json",
    "status": "M",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "8d5ec6e5ca6958f5acaa59709462de9dbdad6833",
      "bytes": 2907206,
      "sha256": "6c78cf5ee96883418dcdeca26da87fb1bd6947b8638b3ec58fb0a5a2fa4b5795"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "project/POSTRUST_PROGRESS.md",
    "status": "M",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "f3b949793992709e1509edbefd09e19cf5f244c2",
      "bytes": 128203,
      "sha256": "4adc3de44b1014c0e8289925b3bb44644f241c0230029b2bf586c024ffc73f06"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "project/STATUS.json",
    "status": "M",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "cd39e953fa2a6305a9a1af7c7dafa9a7b9a4fc42",
      "bytes": 2664769,
      "sha256": "2c1b745116f29e08eae60547db3077d152fe09fdab46416da26e26f8dbfe74da"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "scripts/ci/prepare-v39-integration-002-artifacts.mjs",
    "status": "A",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/report-only-admission.mjs",
    "status": "M",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "9ad6b253ebbc6551ffdc38d6f4110805eb7601b9",
      "bytes": 29630,
      "sha256": "d5b7c2f5ca9d743e77cb83fc7c6cfe25d7bea3b02f1726d02b4e3b1cd36c24c1"
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/report-only-v39-integration-002.mjs",
    "status": "A",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/task-applicability.mjs",
    "status": "M",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "12c1b6fb0b654f20fc9b4d67378a9c6dc3b88370",
      "bytes": 8575,
      "sha256": "be86e4cc7dd45e7ac360945083ecd4677fe8aab5536a9e57e56d818c96a0a4de"
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/test/v39-integration-002-admission.test.mjs",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/test/v39-integration-002-artifacts.test.mjs",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/test/v39-integration-002-gate.test.mjs",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/test/v39-integration-002-report-only.test.mjs",
    "status": "A",
    "role": "test",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/v39-integration-002-admission.mjs",
    "status": "A",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/verify-v39-integration-002-capacity.mjs",
    "status": "A",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/verify-v39-integration-002-native.mjs",
    "status": "A",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/ci/verify-v39-integration-002.mjs",
    "status": "A",
    "role": "admission-gate",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Wave",
    "donor": null
  },
  {
    "path": "scripts/native/build-cue-ffmpeg.mjs",
    "status": "A",
    "role": "native-build",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "scripts/native/build-library-watch.mjs",
    "status": "A",
    "role": "native-build",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "scripts/native/build-local-audio-tags.mjs",
    "status": "A",
    "role": "native-build",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "tasks/00_TASK_INDEX.md",
    "status": "M",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "100644",
      "blob": "d6c7ac5e2192489795527b70bd0f783b67c47108",
      "bytes": 30187,
      "sha256": "f87a99b8d2160e6b44d7e54509660f60f4cfa84e7d9012b3bff8748faff2792b"
    },
    "owner": "Root",
    "donor": null
  },
  {
    "path": "tasks/V39-INTEGRATION-002.md",
    "status": "A",
    "role": "state-evidence",
    "newMode": "100644",
    "before": {
      "mode": "000000",
      "blob": "0000000000000000000000000000000000000000",
      "bytes": 0,
      "sha256": null
    },
    "owner": "Root",
    "donor": null
  }
]);
export const V39_INTEGRATION_ORDERED_INPUTS = freeze([
  {
    "phase": "feedback-source",
    "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
    "parent": "479e746bb7106a4dac158fe616290220de03a53a",
    "tree": "34f4b0707b0c710adac4950fa8de39153d059e11",
    "changedFiles": 78,
    "commitRaw": {
      "bytes": 664,
      "sha256": "c0ddb66801ccf544824ace9c8853354b84434bed33b6a969ad434d92c8811a81"
    }
  },
  {
    "phase": "feedback-report",
    "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
    "parent": "c9398af851d7b8ddebe83db049e643818eff7659",
    "tree": "3ecc24fcd574cba9461ce2ce3dfb2392b571d186",
    "changedFiles": 17,
    "commitRaw": {
      "bytes": 275,
      "sha256": "2369040ac5c2c303de55a9f06caab4f828817efdb33e20e389e9757b924baf31"
    }
  },
  {
    "phase": "async-source",
    "revision": "3175d272bdb64ff14869581927241032887b32e9",
    "parent": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
    "tree": "5a41b86f3537ae8bdbd4fa7b3892e432076f541f",
    "changedFiles": 2,
    "commitRaw": {
      "bytes": 257,
      "sha256": "705e27e3121a0ebad161ce6dea34e1045ec044939175cf4457682dd23e8c2cd0"
    }
  },
  {
    "phase": "async-report",
    "revision": "776924edb128d5fa3b3f86c3265c2ba02760d248",
    "parent": "3175d272bdb64ff14869581927241032887b32e9",
    "tree": "910d5a63f9ac02f3f7d90e23e487a2c831b501e7",
    "changedFiles": 1,
    "commitRaw": {
      "bytes": 263,
      "sha256": "ca9c51097b66c65b566eabbdcf1f1534c43ec84832097507e8f343a39753e47e"
    }
  },
  {
    "phase": "scan-evidence-source",
    "revision": "54887cd5a26156d19903ee4116eca507d247debf",
    "parent": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
    "tree": "f2ac7a34d2c69e70e50db7feb140fb8d060afabe",
    "changedFiles": 2,
    "commitRaw": {
      "bytes": 272,
      "sha256": "aed1a5960d48fede5a5d714a9925b6c3a187453117e195fd6fb14e39745b23f5"
    }
  },
  {
    "phase": "source-marker-source",
    "revision": "43036e7ac9c322098782aaa9ec3d6d2d22002f5b",
    "parent": "54887cd5a26156d19903ee4116eca507d247debf",
    "tree": "573af239969cfab1f0e03827b301021293b7fa0d",
    "changedFiles": 2,
    "commitRaw": {
      "bytes": 260,
      "sha256": "dbd9c593bf7fe191566b31f259a5e8a9ac5b5070c822c0b9d5817bb4e0322d43"
    }
  },
  {
    "phase": "group-markers-source",
    "revision": "b535ed79ae31abacdf92668d983b8af89a584be1",
    "parent": "43036e7ac9c322098782aaa9ec3d6d2d22002f5b",
    "tree": "c193a2bb1e261b96e6a901ecf8401daa5b58c47e",
    "changedFiles": 2,
    "commitRaw": {
      "bytes": 275,
      "sha256": "7729194c04a692fba9febc70aa8147b04ddae67700d9f316d5ae96af4970baa9"
    }
  },
  {
    "phase": "group-markers-type-source",
    "revision": "72e5e913e187cb558805c2c5f5faa3d2ce4b2bf3",
    "parent": "b535ed79ae31abacdf92668d983b8af89a584be1",
    "tree": "c9ee0e1e770609ce969ebc04a12e57ce61b061e6",
    "changedFiles": 1,
    "commitRaw": {
      "bytes": 260,
      "sha256": "0dbbcffb6bd4091ab3c8cd525a541ce86a15665050cb48d8777d5045717b8cba"
    }
  }
]);
export const V39_INTEGRATION_REPORT_PATHS = freeze([
  {
    "path": "reports/V39-INTEGRATION-002_RESULT.json",
    "status": "A"
  },
  {
    "path": "reports/V39-INTEGRATION-002_RESULT.md",
    "status": "A"
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/CI_EVIDENCE.json",
    "status": "A"
  },
  {
    "path": "docs/integration/V39-INTEGRATION-002/STATUS.json",
    "status": "M"
  },
  {
    "path": "project/STATUS.json",
    "status": "M"
  },
  {
    "path": "project/POSTRUST_PLAN.json",
    "status": "M"
  },
  {
    "path": "project/POSTRUST_TODO.md",
    "status": "M"
  },
  {
    "path": "project/POSTRUST_PROGRESS.md",
    "status": "M"
  }
]);
export const V39_INTEGRATION_BUDGETS = freeze({
  "ordinaryToolStageMs": 90000,
  "ordinaryToolWholeMs": 480000,
  "nativeOwnerMs": 2000,
  "nativeProductStageMs": 180000,
  "nativeProductWholeMs": 480000,
  "rawStreamBytes": 16777216,
  "gitInputOutputBytes": 16777216,
  "stdinBytes": 16777216,
  "canonicalReceiptBytes": 16777216,
  "toolFrameExpandedBytes": 67108864,
  "readerConcurrency": [
    1,
    2
  ],
  "readerTotalReadBytes": 33554432,
  "readerSingleReadBytes": 8388608,
  "readerTotalAllocationBytes": 67108864,
  "readerTimeoutMs": 3000,
  "completeCapture": {
    "items": 10000,
    "bytes": 33554432,
    "policy": "全组原子捕获；不按filter/page截组或拆业务事务绕限"
  },
  "boundedSmallGroup": {
    "items": 2048,
    "bytes": 131072,
    "policy": "保留此组规则；不是把全部逻辑成员或原2s期限扩大"
  },
  "physicalClaimResources": 2048,
  "capacityWindowWholeMs": 600000,
  "capacityRequestMs": 30000,
  "capacityOwnerMs": 2000,
  "note": "Native180/480与普通工具90/480各原预算分域；90秒捕获器若被复用，实际较小子限须如实记录。原单命令/编译既有更小/独立期限继续保留，不能通过新包装累计重置整Gate起点。",
  "lyrics": {
    "providerCandidates": 12,
    "totalCandidates": 60,
    "providerRawBytes": 1048576,
    "candidateBodyBytes": 65536,
    "sessionBodyBytes": 8388608,
    "publicDetailBytes": 131072,
    "singleProviderDeadlineMs": 15000,
    "note": "Owner接受/查原回执2000ms不变；15秒Provider actor属于异步任务，不重置全job或Native期限。"
  }
});
export const V39_INTEGRATION_REQUIREMENTS = freeze({
  "original35": 35,
  "increments": 9,
  "total": 44,
  "lyrics": 7,
  "historicalMappingRows": 37,
  "retained": "CD-36",
  "oldAbsentOnly": "CD-37"
});
export const V39_INTEGRATION_SEALED_001 = freeze({
  "source": "744c29af17e7f587a635810c4f45e327c7132705",
  "report": "4c1c6c78d965260a56c3f5bf51f1d6c83ddb9870",
  "frozen52AndDirect7": "HISTORICAL_EXACT",
  "originalTests": 173,
  "reportTests": {
    "registered": 203,
    "passed": 200,
    "inheritedSkipped": 3
  },
  "coreEnvironmentBytes": 5714,
  "newSharedChangesOnlyUnder002": true
});
export const V39_INTEGRATION_LEDGER = freeze({
  "tasks": 18,
  "acceptanceCases": 156,
  "effectiveTasks": 17,
  "effectiveAcceptanceCases": 150,
  "cancelled015NaCases": 6,
  "MBRS016Cases": 9,
  "MBRS017Cases": 8
});
export const V39_INTEGRATION_NEXT_ORDER = freeze([
  "V39-INTEGRATION-002",
  "V39-INTEGRATION-003",
  "V39-INTEGRATION-004",
  "MBRS-016",
  "MBRS-017"
]);
export const V39_INTEGRATION_WAVE_PATHS = freeze([
  ".github/workflows/electron-e2e.yml",
  ".github/workflows/rust-core.yml",
  ".github/workflows/security.yml",
  ".github/workflows/verify.yml",
  "scripts/ci/prepare-v39-integration-002-artifacts.mjs",
  "scripts/ci/report-only-admission.mjs",
  "scripts/ci/report-only-v39-integration-002.mjs",
  "scripts/ci/task-applicability.mjs",
  "scripts/ci/test/v39-integration-002-admission.test.mjs",
  "scripts/ci/test/v39-integration-002-artifacts.test.mjs",
  "scripts/ci/test/v39-integration-002-gate.test.mjs",
  "scripts/ci/test/v39-integration-002-report-only.test.mjs",
  "scripts/ci/v39-integration-002-admission.mjs",
  "scripts/ci/verify-v39-integration-002-capacity.mjs",
  "scripts/ci/verify-v39-integration-002-native.mjs",
  "scripts/ci/verify-v39-integration-002.mjs"
]);
export const V39_INTEGRATION_DONOR_IDENTITY = freeze({
  "schema": "musicbridge.v39.integration002.donor-readback.v1",
  "baseSha": "4c1c6c78d965260a56c3f5bf51f1d6c83ddb9870",
  "branch": "codex/v39-integration-002",
  "orderedInputs": [
    {
      "phase": "feedback-source",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "parent": "479e746bb7106a4dac158fe616290220de03a53a",
      "tree": "34f4b0707b0c710adac4950fa8de39153d059e11",
      "changedFiles": 78,
      "commitRaw": {
        "bytes": 664,
        "sha256": "c0ddb66801ccf544824ace9c8853354b84434bed33b6a969ad434d92c8811a81"
      }
    },
    {
      "phase": "feedback-report",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "parent": "c9398af851d7b8ddebe83db049e643818eff7659",
      "tree": "3ecc24fcd574cba9461ce2ce3dfb2392b571d186",
      "changedFiles": 17,
      "commitRaw": {
        "bytes": 275,
        "sha256": "2369040ac5c2c303de55a9f06caab4f828817efdb33e20e389e9757b924baf31"
      }
    },
    {
      "phase": "async-source",
      "revision": "3175d272bdb64ff14869581927241032887b32e9",
      "parent": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "tree": "5a41b86f3537ae8bdbd4fa7b3892e432076f541f",
      "changedFiles": 2,
      "commitRaw": {
        "bytes": 257,
        "sha256": "705e27e3121a0ebad161ce6dea34e1045ec044939175cf4457682dd23e8c2cd0"
      }
    },
    {
      "phase": "async-report",
      "revision": "776924edb128d5fa3b3f86c3265c2ba02760d248",
      "parent": "3175d272bdb64ff14869581927241032887b32e9",
      "tree": "910d5a63f9ac02f3f7d90e23e487a2c831b501e7",
      "changedFiles": 1,
      "commitRaw": {
        "bytes": 263,
        "sha256": "ca9c51097b66c65b566eabbdcf1f1534c43ec84832097507e8f343a39753e47e"
      }
    },
    {
      "phase": "scan-evidence-source",
      "revision": "54887cd5a26156d19903ee4116eca507d247debf",
      "parent": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "tree": "f2ac7a34d2c69e70e50db7feb140fb8d060afabe",
      "changedFiles": 2,
      "commitRaw": {
        "bytes": 272,
        "sha256": "aed1a5960d48fede5a5d714a9925b6c3a187453117e195fd6fb14e39745b23f5"
      }
    },
    {
      "phase": "source-marker-source",
      "revision": "43036e7ac9c322098782aaa9ec3d6d2d22002f5b",
      "parent": "54887cd5a26156d19903ee4116eca507d247debf",
      "tree": "573af239969cfab1f0e03827b301021293b7fa0d",
      "changedFiles": 2,
      "commitRaw": {
        "bytes": 260,
        "sha256": "dbd9c593bf7fe191566b31f259a5e8a9ac5b5070c822c0b9d5817bb4e0322d43"
      }
    },
    {
      "phase": "group-markers-source",
      "revision": "b535ed79ae31abacdf92668d983b8af89a584be1",
      "parent": "43036e7ac9c322098782aaa9ec3d6d2d22002f5b",
      "tree": "c193a2bb1e261b96e6a901ecf8401daa5b58c47e",
      "changedFiles": 2,
      "commitRaw": {
        "bytes": 275,
        "sha256": "7729194c04a692fba9febc70aa8147b04ddae67700d9f316d5ae96af4970baa9"
      }
    },
    {
      "phase": "group-markers-type-source",
      "revision": "72e5e913e187cb558805c2c5f5faa3d2ce4b2bf3",
      "parent": "b535ed79ae31abacdf92668d983b8af89a584be1",
      "tree": "c9ee0e1e770609ce969ebc04a12e57ce61b061e6",
      "changedFiles": 1,
      "commitRaw": {
        "bytes": 260,
        "sha256": "0dbbcffb6bd4091ab3c8cd525a541ce86a15665050cb48d8777d5045717b8cba"
      }
    }
  ],
  "files": [
    {
      "path": "apps/desktop/src/main/local-library-workbench/album-artwork-normalizer.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "03c6b893b5b7b274514cd47dc0dcda7e3653d298",
      "bytes": 1948,
      "sha256": "81701b3db133fa0dbd56290e9a3f82bdc45f5fcd5a2b1bfad92d4939618a5173",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/album-ipc.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "36d5a5c0848f700af0ba00f3ecbf65cc2808d20b",
      "bytes": 2611,
      "sha256": "7bb2961df17fe6d1b1f87f8b9e09899a66b6044032fafe8d32c15675d7d7b99e",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/artwork-import-normalizer.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "703ac86b5f73dcc892085820f8912b35148f7251",
      "bytes": 23451,
      "sha256": "bbbdda704936a2d29fec96aab2a1f0bbce4c61fffee1bd6475e2189adaabe02d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-providers.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "63e528f00d3bc548eec70d2457997ffefef523c0",
      "bytes": 20903,
      "sha256": "9a943e3befd3c0a3856875733066251f877ebc5d9e1b7fbcf928d1b51f48d9c5",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-urls.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "5c016c1b25ec44447a1037e6ad86fef1137d89a5",
      "bytes": 4180,
      "sha256": "f81749696ceeec1ff4fb9e9ff1acb1cf9043a4c1cd7825f81483d064d1adbe88",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/providers/artwork-web-navigation.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "87e4dca6fe117dd797937c8ba6499e08a34c0f4c",
      "bytes": 2134,
      "sha256": "5794f42523c56bff4d897aafba1db54af919d32fc388c414502533534b5485ac",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/providers/boundaries.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "3ac344523fdec7911b1aeef59129005148f22c0d",
      "bytes": 4762,
      "sha256": "50f15dcadf11e583dbeb00a15a1ef799f84b112b9975f034e5afe53ac90993d4",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/providers/index.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "cd5948a7b1b19d7213fa72c40595e9c4da31d868",
      "bytes": 1019,
      "sha256": "4b70140ac3ab698639290661008922fa4ca6ebf726c88b439fea49e131c06fa0",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/providers/name-transport.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "c2cb5daa90c00e67a2ca7583ccf6f51bcfda2a8b",
      "bytes": 14744,
      "sha256": "064bffc24d3b31534ba54b1f662e7ce826c00e3285e40dde0f2f36ab692387bf",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/service.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "36588c5ff81415e6e73938463b1b218cc036d2bd",
      "bytes": 45856,
      "sha256": "ab15051640967b4d67ecafc6a2a67d74345b57c257f58a40730d3c2af5232f48",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/workbench-ipc.ts",
      "status": "A",
      "role": "product",
      "revision": "3175d272bdb64ff14869581927241032887b32e9",
      "blob": "06b327be003e9964bc2853571a61ce8ee53d7ec7",
      "bytes": 10834,
      "sha256": "83ee01e528d64c8a6908450393a37078f163583814b2a38ad2fec2db0636531d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/preload/local-album-client.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a3f0cd15b703844169a12a4d2b5f53f3bff28492",
      "bytes": 1878,
      "sha256": "2736c8416d246314cc22a02bcd4f8b91bf6a5869564e1134c4c6d9f7b1aa81d4",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/preload/local-workbench-client.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "57a586ab75edf0074a39859d5d56b22071e57b50",
      "bytes": 4696,
      "sha256": "ecda456e5df9212e6881f2592011fab6ba3cd5c3b9fa7048472e80388ed42bae",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumArtwork.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "be0f9292dc7dbc17380840f6c3e33ae6ef384c44",
      "bytes": 2900,
      "sha256": "09d35df6d6f44062db2a345076ee6a8e456aac932adf5f781f5ac763818069cb",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumBrowser.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a73b23c2b60c93ae6de378cb2728910a92155b0f",
      "bytes": 16881,
      "sha256": "ac890affce106410b921958ee40ed442727be8c2dca453ac2ed809753d96f67d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumDetail.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "25c9b3df2ebd64ed09acdd29b0b9f2a3e897efc5",
      "bytes": 11922,
      "sha256": "031a388bc919322dc667ed7cb0e86df0960cc4248cc2bc2a5e2187edbaf46fab",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumGrid.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "de25f59f45fcd9f7b4f29a38f844e6f121460224",
      "bytes": 12434,
      "sha256": "43e052ac690f73a0a1b595ac0e12648cead20ad78e2bea74345eb0514d92b165",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-browser/presentation.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "470eec8e0bc0e60d45d0241a85601e0a2393c5e2",
      "bytes": 2705,
      "sha256": "bfc963bdbf99566c6812ef7056012103840bbf66cc7a375f7028c28adb25fa88",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalAiReview.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a0a00f552aa35b42b76d4bb98097c94e20604fbb",
      "bytes": 5175,
      "sha256": "42a067a3e6a2a0d69793534d74d7f4bf162900744ce45fb10e15d76c88508c6a",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalCueSplitReview.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "82131027755aa1b3ff73b7994c29634f6d8fef0a",
      "bytes": 5778,
      "sha256": "e1ba2df68d469cc47fe2603c0c5819669f0ea5517675d451063277e13e595b6e",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/LocalLibraryWorkbench.vue",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "be209fbce0f0e52bef5380c0bcfc56d0f3232c7f",
      "bytes": 20219,
      "sha256": "b947fe5e5a3206aac6e713df446c34d58810a2460ac94b3f60f592ab2b06f17c",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/library/local-workbench/workbench.css",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "2a6318d566009c6d9a95509b5d16fed4d6ed3a96",
      "bytes": 7478,
      "sha256": "030f36d41d9fc30ce2d3fa86a8ce30701bd21baa466146b2c5df5052fb37493d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/components/media/TrackTable.vue",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "99c7d6e62731153a061ccf083ada96bc2c798a15",
      "bytes": 14707,
      "sha256": "8022bf6a8c2dcd45a465fed793f0c8e310b34a5aae41c67284194b20123a34c9",
      "mode": "100644",
      "targetBefore": {
        "mode": "100644",
        "blob": "35646c94d8019339cc2debb7e08f5fbb76263cbd",
        "bytes": 14058,
        "sha256": "6eaa180c2ca488e2c38135cbb066e95794a0dafd39352a18e90748497828d26c"
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/model.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9f4e7907f75eb6ff03d028091383a6df9908fe65",
      "bytes": 26141,
      "sha256": "048dc8a31fb5b48d76657fb8936ba085f6362423e8817727adb52539f9858d28",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/presentation.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "39d7b67a0b66a6659f559113ff8bd9750a9671d4",
      "bytes": 1032,
      "sha256": "127a25431e5a8d5baea9dfd4ba212651eff89b313aabdb121bdfe738fec371a9",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9237dbac60b01669e669f14e8326f9f81968d1d5",
      "bytes": 2280,
      "sha256": "4e165b77d9588e64d293181692612af00080749ea2f5b3b89bf59de9a0070a2d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-browser/useLocalAlbumBrowser.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "13d7ca2cbc6da89f28a88b181f6abd734d8aad8d",
      "bytes": 2430,
      "sha256": "5f7a63883e1d8598597fd535169da594284acd51778f2abcdcb8e8beaa493c97",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/controller.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "fcddcb1683627cae6bb23bd155cc15c60c1c566c",
      "bytes": 42823,
      "sha256": "d059001d1e7c215cf7f4e2eed4744f910f89263eef4434b50544278811facd70",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/ports.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "6b2f66ede10fcfdc0d40322f4cf8559d474b9fcd",
      "bytes": 3888,
      "sha256": "4451a3ef9ac4965eee25cacb495a02d279229b9a8e30faa2ef753d0f9fcdaf0e",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/renderer/src/composables/application/local-library-workbench/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "c63d49d9b51f20c665d90ef82fbe23a56ce61ccd",
      "bytes": 4493,
      "sha256": "00206816111c9c160627d939ffc499eea3d810e38564333e0a3e036bd54e1613",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-album-browser.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "7427d96eddf4c9e6ff667b272f9797af050da2e1",
      "bytes": 27990,
      "sha256": "e4618c4abe96f955e02abd9d58d3da356f82c59785ec3c52c89205ab663a7144",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-album-components.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "39a3cf484eaed1e2e4578a13f6a6cbce0bfc9baa",
      "bytes": 28804,
      "sha256": "f67881b01fc5b8ffdf43d319dc79955c00f6d600c356f9bb84130a34a0e9d434",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-album-ipc.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "28b67363cbfa6869bfacd4886306dfc1a648888d",
      "bytes": 6141,
      "sha256": "16f03a3cc986c013190c27328c6daa11670d82e3c61e9d5cc11946a42b6d1367",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-artwork-import-normalizer.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9a2e1c9c57907c2fe33c490dba14a8e56b5175f9",
      "bytes": 17829,
      "sha256": "615885ac27b56af9d5a0d3c013414205114826b044753db401ab3f62f731da19",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-artwork-providers.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "e78c2318829a866233a5f2bb004050dcd76c57e6",
      "bytes": 22308,
      "sha256": "54a58cd59555793e999ed0e16b1eb6e897daa5dbcab0e3f9414f0dea51a0b94b",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-name-transport.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "97e944a65af6c5a84916e6ffa394fe9278a6a7e4",
      "bytes": 13700,
      "sha256": "fc87f8230ebf5a1c596f09794408e17cbc684468d091d4da0fd3c7e5b45c753d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-track-table.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "708805415dbdf54bf8af3b84ae311f3cd16e1f65",
      "bytes": 7260,
      "sha256": "0bd53c14d7cf8b361ac427d82b0cedafe2f75d7259cdabe154fba7ad64d6efe9",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-workbench-ipc.test.ts",
      "status": "A",
      "role": "test",
      "revision": "3175d272bdb64ff14869581927241032887b32e9",
      "blob": "5ad556195aa30a84bab74b8b716a89b558b53e5f",
      "bytes": 20574,
      "sha256": "6e6d4fa05c60f9cde085d22b75b478bacdbc9ee74a29303fa4ad891389cc16ac",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-workbench-service.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "e51396f1b3db7957e5bebb424ad8dcd6f212ea2d",
      "bytes": 46991,
      "sha256": "05ef0d07fac0bd457978a2c814af8da4479773fcd8c5c5b2e4e726d7a4ffc912",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/mbf-local-workbench.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "195f87da4a83b29b1ae3779826f1a962e7c31762",
      "bytes": 30822,
      "sha256": "04abcaa7a866b91a56e4ed1777bde5bc0d0f76cac57b2a99e6049823eb0bcfcf",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/test/support/mbf-vue-host.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "87caabc07f9b7163dd34b0dfcf4b72306e3c61ca",
      "bytes": 7838,
      "sha256": "7fe5ca9d3411fa987a3393a12027e1b74726e173449c26774c7332ef609ccc0d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-dispatch.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "13866409e551d41c06ea98fcc2e342acdb7922de",
      "bytes": 60122,
      "sha256": "961f386beb9b359f3594913ecdd914d37b371974206088ffada35a9b2f35bae8",
      "mode": "100644",
      "targetBefore": {
        "mode": "100644",
        "blob": "31390c6dba3604836bdc2204d5414c9e046ee011",
        "bytes": 59157,
        "sha256": "32f43b5dda5766bfa2b50d4c1c1f00e979993b50f2ed494444cd4cdcf81e44b3"
      }
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-owner-protocol.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "de338b307820c0f2842e4eaf9f2fa3df04d67726",
      "bytes": 32487,
      "sha256": "1d43c3e4f9277524b51bff59315d74f470ae91f580a55ada1e169b6631c763d8",
      "mode": "100644",
      "targetBefore": {
        "mode": "100644",
        "blob": "3990b5337b5d89b073d97513c09ec2c4cf5b2024",
        "bytes": 30338,
        "sha256": "fa070d9383c8913d27e9ff23f59e2417b7402c19f13d7ec57d09b09e64823c5b"
      }
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-services.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bfbd1cf8ca6a38dbc10259aac9942adc847b2dba",
      "bytes": 3899,
      "sha256": "967267d6d0dff6144bd7e40349ccdfb48b041aa30a41e1fabc9a7a8f3a1c1014",
      "mode": "100644",
      "targetBefore": {
        "mode": "100644",
        "blob": "7d3113f1ef2efee9a7b231b380f57226a7b20d70",
        "bytes": 3776,
        "sha256": "25aa186cc1e73e16447c972bdda28e0b99aa9eb0ec70121c58647ed3f0a6da7e"
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/artwork-read-port.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0aaf8d7c24a13e4b5ec92156df69e9d3727ec508",
      "bytes": 11134,
      "sha256": "e8d2d01a7ab972b826d43d19474847b51c993d0165d258b49f04d3eda5158bd2",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/grouping.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "9b91146090c2b4da1df48ca39d8855c725a71c87",
      "bytes": 20808,
      "sha256": "fef0cf19b5fbca7e030813aed34a60bbbab4a0d4d6a52f6141377b5c9185bc31",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/main-protocol.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "eb4720ba35951deefa7c09a933d1336496244036",
      "bytes": 3600,
      "sha256": "0afd5768c52777cc103f6a6794dcbde7b76ead127d4e9886754a3f9937c1bfd7",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-port.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "1351bf7cc3b1f0687adbde6b30f4c363d6583565",
      "bytes": 13937,
      "sha256": "85471c6f59882ea12c2f2697066389b95f9dc0c0805635504e8033237f7b2f3e",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-protocol.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0d6024d022186fffb676500ad1223bb6f9cace4d",
      "bytes": 1772,
      "sha256": "0cc1abd8f469c0ac009d7eeb751aabe361504b83170613f2a320b450f328b0d7",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-runtime.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bad231f9c7effb53f22fc24cbe34fadf4a76c49c",
      "bytes": 1747,
      "sha256": "ea047f7aeb5bf723d7c70519b70a33cb2759906e4df071ca5ca4b334066574ff",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/owner-store.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "b5dee3a90a2537f6a9c832aa955ae98302067198",
      "bytes": 1664,
      "sha256": "ed230250a1f43b1a34f3f6c6163e1acef51fa6b0ed5c02c6fb50c5eea4ca3567",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/read-service.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "6cd2aadb1c7672b3b00eae109677162e91f92878",
      "bytes": 10841,
      "sha256": "3911f59f4a2456126848150516bc0dce36204230cb26098afa580f25f1eb522e",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/sql-read.ts",
      "status": "A",
      "role": "product",
      "revision": "b535ed79ae31abacdf92668d983b8af89a584be1",
      "blob": "e454597e401d13a6cd3a95e768a420c1e3193e12",
      "bytes": 38788,
      "sha256": "cd01f6e7aeeda4d5406b1645847394e2a8873dd51850c8036be25e25cbd6211b",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/sql-types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "a4b6f34bfcccac8e9abfc6f9ee3a8200d46e7125",
      "bytes": 2922,
      "sha256": "b95088c9694d853d3591f07bea4f2890e0f300fb2a1dbfd3333be031185e2c06",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-album-browser/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "5e38f92c5438be126a588d28e4ea0e5031f69b7b",
      "bytes": 3983,
      "sha256": "17136251989b5dc7fc62858b77d79d5282aa7f71c84b4e6a0a06a0fda0c1b1c2",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-catalog-store.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "f1b9ff8cd51974174f1a8ffd8682a08f1a319cfa",
      "bytes": 121945,
      "sha256": "bc6437c90b3dde653d3eb0c6edc4dcb46cf5c8c13834c8e40b16a039f807d531",
      "mode": "100644",
      "targetBefore": {
        "mode": "100644",
        "blob": "5537d6aac291010a4543bc17d975e120de169f1f",
        "bytes": 115384,
        "sha256": "4485d96516b807433c0a3e318ebc662738ed9281431840feb29546025e7040ab"
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-library-workbench/cue-plan.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "cad2f6c7d5d70abfede1333830307001d70d5654",
      "bytes": 12641,
      "sha256": "ab257d45fe717c306d8e5221eaa57d306ef05c7c21d3000addf2eb33fba7d41d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-library-workbench/name-proposal.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0ca376c911c32ec02dfaacfe2657ce9c27585088",
      "bytes": 13171,
      "sha256": "9c840394f15af2b4edb9e137083c3363524fd8c012843dbf980dd35780751140",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-library-workbench/owner-journal.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "7a58c2322fef5b9fc30bc17cd80c3f6406b52ac4",
      "bytes": 11270,
      "sha256": "ff28bd500fd8fa5a7f44c4e87782e27aab10d0ec16e032f2d3b6b85ea17b63d5",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-library-workbench/plan-registry.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0f174e586cd287204e1daced6e55c8027f2e1558",
      "bytes": 30544,
      "sha256": "d1c2dfd7311e5f676f0dd24414cac81555448e6f11a033996527e527709840d2",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-library-workbench/read-service.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "3baf0f520cd3f7d1289aabe391007889f0792735",
      "bytes": 36128,
      "sha256": "2ecc8582ea912e5f69fe076fa13db6bbca901610dbe61387ba752d3b059a21d9",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-library-workbench/types.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "257b67728cdaa5c65b2aa29f9a5e3d4a466fda31",
      "bytes": 9345,
      "sha256": "ecaf9f741d28c0d225381e513ae7e5988cb98f6df56989e2a03bb1aa17a76340",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/src/collection/local-scan-store.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "0ee507bb1040c260488177bb73107266f71e5055",
      "bytes": 102853,
      "sha256": "79871706ebb0e1ee2dd5f4bd6221262387f3e364991a2480efe90999b86d6051",
      "mode": "100644",
      "targetBefore": {
        "mode": "100644",
        "blob": "62e1ba5630eb65e5e42ce8ed4111368534704cde",
        "bytes": 96652,
        "sha256": "0d67d169b015ea4af3cb730275126ad899aff3046190c4b17ffb61d96b8cbe7c"
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-main-protocol.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "2a901f9980d695c46cf32d4b60acb26b47a7f582",
      "bytes": 2562,
      "sha256": "76d61dc4b25000bc58a7cc22064db698678b36e909e1c03b6e9903fc005282dc",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-owner-protocol.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "d2f276cad6771d49ed14b55eae3f77fd2d30387b",
      "bytes": 1352,
      "sha256": "931cc681741a9d78c3e883ec58f14b13b82749ce820e664e77cb4a6d70159428",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-owner.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "6487f29211678188d65b4e37b2cb8884b0a9d298",
      "bytes": 10847,
      "sha256": "11ed4fdcf31c70172ef350306e6e84fbfd2eb85b0e023857ac56b0b64c5efe5b",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-read-model.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bcd9b649d2edec593fa2af476a7e92ebf3d5f130",
      "bytes": 29710,
      "sha256": "f4aa7f7071c8ae0bf4ce13d26b974d49c5f935f895396136b57a3c2a8bcd521f",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-source-revision.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "8c7b6a84f5cf1caa93dff92390099b495d34d2ae",
      "bytes": 7583,
      "sha256": "3c2aad87386554517379cc9d7583f9799f6edbc8cbd1f4718aeacb07accf9a2a",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-sql-read.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "cad12ba20bea9d0e9a065cfcd585f194312dfd9f",
      "bytes": 40493,
      "sha256": "fef5c7223469e571677ccc3e92a47bd78a97a1a201e1fe1b546eb9882f8362ff",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-workbench-contract.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "b92a1a42aa39292fe0a5a6ac0a1002eb741c4f97",
      "bytes": 11936,
      "sha256": "8814f9ad56fd9576e86a9f4f2c2bef4b88a9cc2632cb5527352449415a1aa95a",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-workbench-cue.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "937b6c71c0a12cb8a44cf6d2449756b67a7adf63",
      "bytes": 7382,
      "sha256": "330cbaf09f5cad52b9f55a07febe386ed895f443d4e82f93d763859e4f8cefb3",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-workbench-name.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "80a57c8e788e46fa7ac06ebcec9e0210919ac7fe",
      "bytes": 9016,
      "sha256": "d646c710559d9f548de2b648a505777737fdbb2f68f205a3e2bc2a987670b6db",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-workbench-owner-journal.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "911bf382b540956ebe8f8e60ef408505b9e34721",
      "bytes": 10321,
      "sha256": "7a5d63df92fc54a2979e6e1fd8c6629306f0d534c1edb9d9e80f910720b8c0cc",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-workbench-read.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "28f39f376ce911168bc94f6eebf00e94326d7bd5",
      "bytes": 21368,
      "sha256": "bec484dc923a19f948d338d29abc885b04aacf2c0254b83c5e2db096d9698618",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-workbench-registry.test.ts",
      "status": "A",
      "role": "test",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "67300a055a477550133665546eb3fde0ee6866a4",
      "bytes": 23017,
      "sha256": "fec67871f836284663e586570ad37e9d990288a53bf3b6fd1e2698663b0432fc",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/contracts/src/index.ts",
      "status": "M",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "bb6a1897980d6e7f237192a6531b2415b9811730",
      "bytes": 2855,
      "sha256": "03007c4852cf7e39539261c520c8c02f9f15a97378e03a4611e2b8680f38f68f",
      "mode": "100644",
      "targetBefore": {
        "mode": "100644",
        "blob": "b78f996e3df99ec414087c36871ebac172bad0b7",
        "bytes": 2767,
        "sha256": "334a85a4b8304102635c128a3c844917ba07606273388342dca9b8f0015245ad"
      }
    },
    {
      "path": "packages/contracts/src/local-album-library.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "91681e594939b75ece23dff6f5b531060fde3654",
      "bytes": 15401,
      "sha256": "429d403d23bd20c0c3eab141971b9187ba4416622535a021e0eeecbc3ecc9e66",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/contracts/src/local-library-workbench.ts",
      "status": "A",
      "role": "product",
      "revision": "c9398af851d7b8ddebe83db049e643818eff7659",
      "blob": "433520190cb95de24eddcb0fc762fe572a91eab6",
      "bytes": 42769,
      "sha256": "4b08388901ef35565e98374454d03e518ddb819c5b8f1b0f348b1fc913f6b910",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "apps/desktop/src/main/local-library-workbench/providers/pinned-transport-review.patch",
      "status": "A",
      "role": "historical-proposal-not-active-code",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "25ff8e0973ab0d83ea22f04457846242d057b48e",
      "bytes": 1959,
      "sha256": "43e3d606569d54494988af7d2c3f4abb1ec94e7dce4ab1039fd76a00ae48c0ad",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/ALBUM_SQL_CAPACITY_EVIDENCE.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "17dccd1c078c38bcb17b3db9b2e8170e2fa7020c",
      "bytes": 16985,
      "sha256": "72f41780ea9492d2a5938bfd989c3cccc183cf0f613a83f718efb7d43aea31a6",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/ALBUM_SQL_PERFORMANCE_REVIEW.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "93b1afb13281bfb8b3d3cb20f67c7efc6915574b",
      "bytes": 19966,
      "sha256": "3053066dc68e687839c4104d3f54e02199b52452cf477c3e82e56edef425f187",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/COVERDROP_FEATURE_MAP.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "9625d8627c23deac282366ff6b4417a7dca93e09",
      "bytes": 57669,
      "sha256": "e6b87068debcd737dc701ee477c4d185be755eda0695085961c37fd3d3ffaa6b",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/COVERDROP_FEATURE_MAP.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "cea05e3869f46bf71399e510019c629cd2a47629",
      "bytes": 34004,
      "sha256": "2c6fa824b54b1ddf4f5a30d2e20a9a517b83d8bdb5aff190c7a316f0eb49e545",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/RESULT.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "454d06e5043e25746621aea145dd7c91e853a53b",
      "bytes": 10667,
      "sha256": "b8b6baceae5714d8c3b9b2d5ba0ae9857d2005aeffd9756e763fd95815634a64",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/V39_ATOMIC_WRITER_INTEGRATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "fc92209148c6abd34cd2d0e15d7f77d1dea3e3a6",
      "bytes": 30617,
      "sha256": "2ab780ad336e070dbb7d88aac5e04d60a09ee74dada0f8462677c390129ad3e4",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/V39_NATIVE_SETTINGS_INTEGRATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "29a889c520ece47e9251aff8264a7013e2bc0d9a",
      "bytes": 36692,
      "sha256": "a888598c3f8be8924a6b1e6046cfb07512f99fccc40c7935ba1f855ee945a19c",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/V39_ROUTE_AND_PAGE_INTEGRATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "865846c1c4572266758f435844f73c7374163a95",
      "bytes": 17090,
      "sha256": "8f06b3c395fc3e31c5031d578b37b8f9f574a34ae551f03db1ef5db2d0bdc105",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/VERIFICATION_MANIFEST.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "a2d952018c867ce042c8cf5d9978c3e51d10c7a8",
      "bytes": 211686,
      "sha256": "bd3f8001308124119d7faed2a01d60321b10e2703c5962cc597781bfc70c629b",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/WORKBENCH_IMPLEMENTATION.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "30c17cc6f9c6fdf091febe7e74ad65e5c642c7e1",
      "bytes": 17599,
      "sha256": "46f3d79c92627453331d24a9b865203d6e01a0a456f46c035c8f7c93a2ac7b00",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/WORKBENCH_SHARED_PORTS.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "f61a878514de0e88271c0c6c60d2e4068c78a618",
      "bytes": 17924,
      "sha256": "1733eb2632fb916b3554e3e82edd96c187c990fcfbbffacd58010fe480cbd247",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/proposals/README.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "23f0543bb355e160192b9d3653841a0fee8e68c1",
      "bytes": 829,
      "sha256": "a4eb0f6e83dd9aa205b273a40d1471c7d5bddadde90914302f0cfceff5ef967d",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "03c2a1a666b17812f7398dcdc7283125d6de6a5a",
      "bytes": 1266,
      "sha256": "3ceb5b61cf798b1169f4b872cdd2ca88183cf4dd4c95ed20ab3ace8e9a10d0ce",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL.patch.gz",
      "status": "A",
      "role": "historical-proposal-not-active-code",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "ce24f06a75ff44a7d35bcb1c83911877c6844a64",
      "bytes": 3870,
      "sha256": "9601be79b90c8059cec99188868c134ffe38ede59ca7fa9b0df977cd0e153178",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL_V2.json",
      "status": "A",
      "role": "historical-evidence",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "d5255f253e23f182f54b731e58b439c6747873fd",
      "bytes": 1266,
      "sha256": "67279769375d21a31325681e409d92f1a7530683d363700d6901711e39f5f572",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/proposals/SHARED_WORKBENCH_JOURNAL_PROPOSAL_V2.patch.gz",
      "status": "A",
      "role": "historical-proposal-not-active-code",
      "revision": "e2d17ad1c4d11756db75b24d91d2422c7e1fecbb",
      "blob": "502459d84d9d4f5e684702c25b8476fd0ffc489d",
      "bytes": 4075,
      "sha256": "e9d4aaee0b9799307a2249c265fc3b4be7d57f7598ba0c7a7bad92e9ec3432af",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "docs/feedback/MBF-002-003/ASYNC_DATASET_FENCE_RESULT.md",
      "status": "A",
      "role": "historical-evidence",
      "revision": "776924edb128d5fa3b3f86c3265c2ba02760d248",
      "blob": "bc036b58b36b12e3424b4528baf77da83688c6d7",
      "bytes": 4810,
      "sha256": "36d369f5da5f04ea70b144a04be99aa2b16efee812202e0570ef9c3b4fdad7e1",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-scan-evidence.test.ts",
      "status": "A",
      "role": "test",
      "revision": "54887cd5a26156d19903ee4116eca507d247debf",
      "blob": "048aacb583dcf41e734d625331fcd5744c0c1795",
      "bytes": 35958,
      "sha256": "d9ae7f529721ae919c3101bed0c1b752c99a82cf66ea3180ff5504974fee908a",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-source-marker.test.ts",
      "status": "A",
      "role": "test",
      "revision": "43036e7ac9c322098782aaa9ec3d6d2d22002f5b",
      "blob": "6159068a116620785f198c17f55ec2a81777fe3f",
      "bytes": 45674,
      "sha256": "7bc747789c6f5ed0c7e1c9f64710599e0de1fb485b5ff4cf93dea3c6aa4fcab2",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    },
    {
      "path": "packages/bridge-core/test/mbf-local-album-group-markers.test.ts",
      "status": "A",
      "role": "test",
      "revision": "72e5e913e187cb558805c2c5f5faa3d2ce4b2bf3",
      "blob": "592570a06fc0bedbcad78afef90b65613329e6d1",
      "bytes": 39326,
      "sha256": "fbc88aa8e246cce55b83dbf59cc2e69e3c11ee523e8241a834272785e8d48606",
      "mode": "100644",
      "targetBefore": {
        "mode": "000000",
        "blob": "0000000000000000000000000000000000000000",
        "bytes": 0,
        "sha256": null
      }
    }
  ],
  "count": 99,
  "added": 92,
  "modified": 7,
  "selectedBytes": 1944704,
  "asyncPreservedFiles": [
    {
      "path": "apps/desktop/src/main/local-library-workbench/workbench-ipc.ts",
      "status": "A",
      "role": "product",
      "revision": "3175d272bdb64ff14869581927241032887b32e9",
      "blob": "06b327be003e9964bc2853571a61ce8ee53d7ec7",
      "bytes": 10834,
      "sha256": "83ee01e528d64c8a6908450393a37078f163583814b2a38ad2fec2db0636531d",
      "mode": "100644"
    },
    {
      "path": "apps/desktop/test/mbf-local-workbench-ipc.test.ts",
      "status": "A",
      "role": "test",
      "revision": "3175d272bdb64ff14869581927241032887b32e9",
      "blob": "5ad556195aa30a84bab74b8b716a89b558b53e5f",
      "bytes": 20574,
      "sha256": "6e6d4fa05c60f9cde085d22b75b478bacdbc9ee74a29303fa4ad891389cc16ac",
      "mode": "100644"
    }
  ],
  "finalSql": {
    "path": "packages/bridge-core/src/collection/local-album-browser/sql-read.ts",
    "status": "A",
    "role": "product",
    "revision": "b535ed79ae31abacdf92668d983b8af89a584be1",
    "blob": "e454597e401d13a6cd3a95e768a420c1e3193e12",
    "bytes": 38788,
    "sha256": "cd01f6e7aeeda4d5406b1645847394e2a8873dd51850c8036be25e25cbd6211b",
    "mode": "100644"
  },
  "finalGroupTypesLeaf": {
    "path": "packages/bridge-core/test/mbf-local-album-group-markers.test.ts",
    "status": "A",
    "role": "test",
    "revision": "72e5e913e187cb558805c2c5f5faa3d2ce4b2bf3",
    "blob": "592570a06fc0bedbcad78afef90b65613329e6d1",
    "bytes": 39326,
    "sha256": "fbc88aa8e246cce55b83dbf59cc2e69e3c11ee523e8241a834272785e8d48606",
    "mode": "100644"
  },
  "importMode": "EXACT_LOCAL_GIT_BLOBS_NO_CHERRY_PICK",
  "historicalProposalApplied": false,
  "historyDoesNotGrantCurrentProductPass": true
});
export const V39_INTEGRATION_BASELINE_RAW_PIN = freeze({
  "bytes": 10468,
  "sha256": "a4ad2179f75f20d807ca16d505e6434cf4c7488e53fdc2e156da288cff0f1588"
});

import { validateV39IntegrationSourceReceipt as validateSealed001Source } from './v39-integration-admission.mjs';
import { CI_REPORT_MIRROR_ORIGINAL_TESTS } from './verify-ci-report-mirror.mjs';
import { inspectV39StandardRaw as inspectFrozenStandardRaw } from './verify-v39-integration.mjs';
export const V39_INTEGRATION_NATIVE_STEP = 'V3.9 八格式原生能力 Gate';
export const V39_INTEGRATION_CAPACITY_STEP = 'V3.9 本地专辑当前查询容量 Gate';
export const V39_INTEGRATION_WORKFLOWS = freeze(['.github/workflows/verify.yml','.github/workflows/security.yml',
  '.github/workflows/rust-core.yml','.github/workflows/electron-e2e.yml']);
export const V39_INTEGRATION_ADMISSION_CASE_NAMES = freeze([
  '002受控真实Source唯一前序Report父与整件身份准入','002旧001标记共存仅签新域且历史原件保留',
  '002错误父多父未知分支和旧Source冒新任务拒绝','002浅库Git叠加与环境别仓库注入拒绝',
  '002实际Source漏叶多叶模式角色与固定before漂移拒绝','002完整99分叉donor与Async最终版本不可替换',
  '002真实mirror当前身份和缺历史对象拒绝且不fetch','002旧账本取消015与unsafe number token不可改写',
  '002开发Scope及当前输入漂移不能取得冻结资格','002软件自报PASS和假WeakSet对象均不签发',
  '002六job五制品失败重复run与skipped产品拒绝','002Source普通对象与旧001结果不能输出新域资格']);
export const V39_INTEGRATION_REPORT_CASE_NAMES = freeze([
  '002受控真实唯一直接Report八叶与Source证据准入','002Report错误父多父未知分支第九叶拒绝',
  '002Report冻结Scope产品donor和mode完整保护','002Report安全摘要与完整CI原件canonical绑定',
  '002Report域外数字literal数组和旧证据变化拒绝','002Source失败部分ZIP和旧容量不能复用为PASS',
  '002Source与非法Report零API且local分类不冒平台CI','002Report自身两工作流三job不冒Source四工作流',
  '002原件压缩base64CRC长度与EOF严格回环','002真实大原件保持16MiB与64MiB拒超边界',
  '002完整TAP原退出和资源关闭不能用claimedPASS代替','002报告不提升设备Owner和原18/156账本']);
const issued = new WeakSet(), issuedCi = new WeakMap();
const cap = 16 * 1024 * 1024;
const check = deadline => { if (!Number.isFinite(deadline) || performance.now() >= deadline) fail('V39_002_WHOLE_TIMEOUT'); };
const pin = bytes => ({bytes:bytes.length,sha256:hash(bytes)});
const present = filename => { try { lstatSync(filename); return true; } catch (error) { if(error.code==='ENOENT')return false;throw error; } };
export function v39Integration002GitEnvironment(env=process.env) {
  const result=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('GIT_')));
  return {...result,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',
    GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'};
}
function gitContext(directory,env,options={}) {
  const deadline=options.deadline??performance.now()+480000;
  if(!path.isAbsolute(directory)||path.resolve(directory)!==directory||realpathSync(directory)!==directory)fail('V39_002_REPOSITORY_CANONICAL');
  const gitEnv=v39Integration002GitEnvironment(env),trees=new Map(),blobs=new Map(),commits=new Map();
  function git(args,input) {
    check(deadline);const remaining=Math.floor(Math.min(10000,deadline-performance.now()));
    const result=spawnSync('git',['--no-replace-objects','-c','core.fsmonitor=false','-c','diff.external=',...args],
      {cwd:directory,env:gitEnv,input,timeout:remaining,killSignal:'SIGKILL',maxBuffer:cap,stdio:['pipe','pipe','pipe']});
    check(deadline);if(result.error||result.signal||result.status!==0)fail('V39_002_GIT_READ_FAILED');
    if(result.stdout.length>cap||result.stderr.length>cap)fail('V39_002_GIT_BUDGET');return result.stdout;
  }
  function text(args){return decode(git(args)).trim();}
  function commit(revision){
    if(!sha(revision))fail('V39_002_COMMIT_ID');if(commits.has(revision))return commits.get(revision);
    const bytes=git(['cat-file','commit',revision]);if(oidOf('commit',bytes)!==revision)fail('V39_002_COMMIT_BYTES');
    const header=decode(bytes).split('\n\n')[0],tree=/^tree ([a-f0-9]{40})$/mu.exec(header)?.[1],
      parents=[...header.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map(m=>m[1]);
    if(!tree)fail('V39_002_COMMIT_TREE');const value={sha:revision,tree,parents,bytes:bytes.length,sha256:hash(bytes)};commits.set(revision,value);return value;
  }
  function tree(revision){
    if(trees.has(revision))return trees.get(revision);commit(revision);const rows=new Map();
    for(const item of git(['ls-tree','-r','-z','--full-tree',revision]).toString('utf8').split('\0')) {
      if(!item)continue;const m=/^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/su.exec(item);
      if(!m||!relative(m[4])||rows.has(m[4]))fail('V39_002_TREE_RECORD');rows.set(m[4],{path:m[4],mode:m[1],kind:m[2],blob:m[3]});
    }trees.set(revision,rows);return rows;
  }
  /** 一次context固定OID批读；每个body的type/count/顺序/SHA1全核，16MiB分段不升限。 */
  function batch(ids) {
    ids=[...new Set(ids)].filter(id=>!blobs.has(id));if(!ids.length)return;
    if(ids.some(id=>!sha(id)))fail('V39_002_BLOB_ID');
    const sizes=decode(git(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],ids.join('\n')+'\n')).trim().split('\n');
    if(sizes.length!==ids.length)fail('V39_002_BATCH_COUNT');
    const rows=sizes.map((line,i)=>{const m=/^([a-f0-9]{40}) blob (0|[1-9]\d*)$/u.exec(line);
      if(!m||m[1]!==ids[i]||!Number.isSafeInteger(Number(m[2]))||Number(m[2])>cap)fail('V39_002_BATCH_HEADER');return{id:ids[i],size:Number(m[2])};});
    let group=[],bytes=0;
    const consume=()=>{if(!group.length)return;const raw=git(['cat-file','--batch'],group.map(r=>r.id).join('\n')+'\n');let at=0;
      for(const row of group){const end=raw.indexOf(10,at);if(end<0||decode(raw.subarray(at,end))!==row.id+' blob '+row.size)fail('V39_002_BATCH_HEADER');
        at=end+1;if(at+row.size>=raw.length)fail('V39_002_BATCH_LENGTH');const body=Buffer.from(raw.subarray(at,at+row.size));at+=row.size;
        if(raw[at++]!==10||oidOf('blob',body)!==row.id)fail('V39_002_BATCH_BODY');blobs.set(row.id,body);}
      if(at!==raw.length)fail('V39_002_BATCH_TRAILING');group=[];bytes=0;};
    for(const row of rows){const size=row.size+80;if(size>cap)fail('V39_002_BATCH_BUDGET');if(bytes+size>cap)consume();group.push(row);bytes+=size;}consume();
  }
  function body(revision,name){const item=tree(revision).get(name);if(!item||item.kind!=='blob')fail('V39_002_BLOB_MISSING');batch([item.blob]);return blobs.get(item.blob);}
  function exactDiff(parent,head){
    const raw=git(['diff','--raw','--no-abbrev','-z','--no-renames','--no-ext-diff','--no-textconv',parent,head]),parts=decode(raw).split('\0');
    if(parts.pop()!=='')fail('V39_002_DIFF_TERMINATOR');const rows=[];
    for(let i=0;i<parts.length;i+=2){const m=/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])$/u.exec(parts[i]);
      if(!m||!relative(parts[i+1]))fail('V39_002_DIFF_CLOSEDSET');rows.push({path:parts[i+1],oldMode:m[1],newMode:m[2],oldBlob:m[3],newBlob:m[4],status:m[5]});}
    return rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  }
  const top=text(['rev-parse','--show-toplevel']),gitDir=text(['rev-parse','--path-format=absolute','--git-dir']),common=text(['rev-parse','--path-format=absolute','--git-common-dir']);
  if(top!==directory||gitDir!==path.join(directory,'.git')||common!==gitDir||!lstatSync(gitDir).isDirectory()||realpathSync(gitDir)!==gitDir)fail('V39_002_INDEPENDENT_GIT');
  for(const leaf of ['shallow','info/grafts','objects/info/alternates','objects/info/http-alternates'])if(present(path.join(gitDir,leaf)))fail('V39_002_GIT_OVERLAY');
  if(text(['for-each-ref','--format=%(refname)','refs/replace'])!=='')fail('V39_002_GIT_OVERLAY');
  const head=text(['rev-parse','HEAD']),branch=text(['branch','--show-current'])||env.GITHUB_REF_NAME;
  if(branch!==V39_INTEGRATION_BRANCH||env.GITHUB_SHA!==undefined&&env.GITHUB_SHA!==head
    ||env.GITHUB_REF_NAME!==undefined&&env.GITHUB_REF_NAME!==branch)fail('V39_002_BRANCH_OR_HEAD');
  if(text(['status','--porcelain=v1','--untracked-files=all'])!=='')fail('V39_002_DIRTY');
  const base=commit(V39_INTEGRATION_BASE);if(base.tree!==V39_INTEGRATION_BASE_TREE||!equal(base.parents,['744c29af17e7f587a635810c4f45e327c7132705']))fail('V39_002_SEALED_BASE_GIT');
  const current=commit(head);if(current.parents.length!==1)fail('V39_002_UNIQUE_PARENT');
  return {directory,env,deadline,head,branch,git,text,tree,commit,batch,body,exactDiff,
    after(){check(deadline);if(text(['rev-parse','HEAD'])!==head||text(['status','--porcelain=v1','--untracked-files=all'])!==''||text(['branch','--show-current'])!==branch)fail('V39_002_SOURCE_CHANGED');}};
}
const authByPath=new Map(V39_INTEGRATION_AUTHORIZATION.map(row=>[row.path,row]));
const requiredPaths=freeze([...new Set([V39_INTEGRATION_SCOPE_PATH,V39_INTEGRATION_BASELINE_PATH,V39_INTEGRATION_DONOR_PATH,
  V39_INTEGRATION_MATRIX_PATH,V39_INTEGRATION_STATUS_PATH,V39_INTEGRATION_LOCAL_EVIDENCE_PATH,domain+'NATIVE_BUILD_INPUTS.json',
  ...V39_INTEGRATION_WAVE_PATHS,...V39_INTEGRATION_DONOR_IDENTITY.files.map(row=>row.path)])]);
export function assertV39Integration002Scope(scope,raw) {
  if(!object(scope)||scope.schema!=='musicbridge.v39.integration002.execution-scope.v1'||scope.task!==V39_INTEGRATION_TASK
    ||scope.branch!==V39_INTEGRATION_BRANCH||scope.baseSha!==V39_INTEGRATION_BASE||scope.baseTree!==V39_INTEGRATION_BASE_TREE
    ||scope.sourceParentSha!==V39_INTEGRATION_SOURCE_PARENT||scope.completePlannedAuthorization!==true||scope.frozen!==true
    ||scope.executionStatus!=='READY_FOR_SOURCE'||!equal(scope.allowedSourceFiles,V39_INTEGRATION_AUTHORIZATION)
    ||!equal(scope.orderedInputs,V39_INTEGRATION_ORDERED_INPUTS)||scope.donorCount!==99||!equal(scope.reportPaths,V39_INTEGRATION_REPORT_PATHS)
    ||!equal(scope.budgets,V39_INTEGRATION_BUDGETS)||!equal(scope.requirements,V39_INTEGRATION_REQUIREMENTS)
    ||!equal(scope.preserve001,V39_INTEGRATION_SEALED_001)||!equal(scope.preserveOriginalLedger,V39_INTEGRATION_LEDGER)
    ||!equal(scope.nextOrder,V39_INTEGRATION_NEXT_ORDER)||scope.sourceSelfReportQualification!==false
    ||!Array.isArray(scope.finalFiles)||scope.finalFiles.length<requiredPaths.length||scope.finalFiles.length>V39_INTEGRATION_AUTHORIZATION.length)fail('V39_002_SCOPE_NOT_FROZEN_OR_AUTHORIZED');
  const names=scope.finalFiles.map(row=>row.path);
  if(new Set(names).size!==names.length||!equal([...names].sort(),names)||requiredPaths.some(name=>!names.includes(name)))fail('V39_002_SOURCE_PATH_CLOSEDSET');
  for(const row of scope.finalFiles){keys(row,['path','mode','blob','bytes','sha256'],'V39_002_FINAL_FIELDS');
    const allow=authByPath.get(row.path);if(!allow||row.mode!==allow.newMode||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>cap
      ||(row.path===V39_INTEGRATION_SCOPE_PATH?row.blob!==null||row.sha256!==null:!sha(row.blob)||!sha256(row.sha256)))fail('V39_002_FINAL_PIN');}
  if(raw&&scope.finalFiles.find(row=>row.path===V39_INTEGRATION_SCOPE_PATH).bytes!==raw.length)fail('V39_002_SCOPE_SELF_BYTES');return true;
}
function actualPins(context,revision,names){
  const tree=context.tree(revision);context.batch(names.map(name=>{const row=tree.get(name);if(!row||row.kind!=='blob'||row.mode!=='100644')fail('V39_002_SOURCE_KIND');return row.blob;}));
  return names.map(name=>{const row=tree.get(name),raw=context.body(revision,name);return {path:name,mode:row.mode,blob:row.blob,...pin(raw)};});
}
function preserveHistory(context,source) {
  const parentTree=context.tree(V39_INTEGRATION_BASE),sourceTree=context.tree(source);
  const protectedNames=[...parentTree.keys()].filter(name=>name.startsWith('docs/integration/V39-INTEGRATION-001/')||name.startsWith('reports/V39-INTEGRATION-001_')
    ||['scripts/ci/v39-integration-admission.mjs','scripts/ci/report-only-v39-integration.mjs','scripts/ci/verify-v39-integration.mjs',
      'scripts/ci/test/v39-integration-admission.test.mjs','scripts/ci/test/v39-integration-report-only.test.mjs','scripts/ci/test/v39-integration-gate.test.mjs',
      'apps/desktop/src/main/core-environment.ts','packages/bridge-core/src/recording/ffmpeg-build-policy.ts',
      'packages/bridge-core/src/recording/bundled-converter.ts','scripts/native/build-ffmpeg.mjs','scripts/native/build-mobile-ffmpeg.mjs',
      'packages/bridge-core/src/mobile/mobile-ffmpeg-policy.ts'].includes(name)||CI_REPORT_MIRROR_ORIGINAL_TESTS.some(row=>row.path===name));
  for(const name of protectedNames)if(!equal(parentTree.get(name),sourceTree.get(name)))fail('V39_002_FROZEN_HISTORY_MODIFIED');
  const baseline=context.body(source,V39_INTEGRATION_BASELINE_PATH);
  if(!equal(pin(baseline),V39_INTEGRATION_BASELINE_RAW_PIN))fail('V39_002_BASELINE_BODY');
  const original=parse(context.body(V39_INTEGRATION_BASE,'docs/integration/V39-INTEGRATION-001/CI_EVIDENCE.json'));
  if(original.sourceSha!=='744c29af17e7f587a635810c4f45e327c7132705'||!validateSealed001Source(original.sourceCi,original.sourceSha))fail('V39_002_PREDECESSOR_CI_INVALID');
  if(!validateV39Integration002DonorCarrier(parse(context.body(source,V39_INTEGRATION_DONOR_PATH))))fail('V39_002_DONOR_CARRIER_INVALID');
  for(const item of CI_REPORT_MIRROR_ORIGINAL_TESTS){const raw=context.body(source,item.path);if(raw.length!==item.bytes||hash(raw)!==item.sha256)fail('V39_002_ORIGINAL173_BODY');}
  if(context.body(source,'apps/desktop/src/main/core-environment.ts').length!==5714)fail('V39_002_FIXED_FD_SOURCE');
}
function sourceObject(context,source) {
  const commit=context.commit(source);if(source===V39_INTEGRATION_BASE||!equal(commit.parents,[V39_INTEGRATION_SOURCE_PARENT]))fail('V39_002_SOURCE_PARENT');
  const raw=context.body(source,V39_INTEGRATION_SCOPE_PATH),scope=parse(raw);assertV39Integration002Scope(scope,raw);
  const changes=context.exactDiff(V39_INTEGRATION_BASE,source),names=scope.finalFiles.map(row=>row.path);
  if(!equal(changes.map(row=>row.path),names))fail('V39_002_ACTUAL_SOURCE_DIFF');
  context.batch(changes.filter(row=>row.status==='M').map(row=>row.oldBlob));
  for(const row of changes){const allow=authByPath.get(row.path),before=allow?.before;
    if(!allow||row.status!==allow.status||row.newMode!==allow.newMode)fail('V39_002_SOURCE_BEFORE_DIFF');
    if(before===null){
      if(allow.status!=='A'||row.oldMode!=='000000'||row.oldBlob!=='0'.repeat(40)||context.tree(V39_INTEGRATION_BASE).has(row.path))fail('V39_002_SOURCE_BEFORE_DIFF');
    }else{
      if(!object(before)||row.oldMode!==before.mode||row.oldBlob!==before.blob)fail('V39_002_SOURCE_BEFORE_DIFF');
      if(row.status==='M'&&!equal(pin(context.body(V39_INTEGRATION_BASE,row.path)),{bytes:before.bytes,sha256:before.sha256}))fail('V39_002_SOURCE_BEFORE_BYTES');
    }}
  const pins=actualPins(context,source,names);for(let i=0;i<pins.length;i++){
    const expected=scope.finalFiles[i];if(expected.path===V39_INTEGRATION_SCOPE_PATH){if(pins[i].bytes!==expected.bytes)fail('V39_002_SCOPE_SELF_BYTES');}
    else if(!equal(pins[i],expected))fail('V39_002_SOURCE_FINAL_BYTES');}
  preserveHistory(context,source);
  const sourceStatus=parse(context.body(source,V39_INTEGRATION_STATUS_PATH));
  if(sourceStatus.task!==V39_INTEGRATION_TASK||sourceStatus.branch!==V39_INTEGRATION_BRANCH||sourceStatus.baseReportSha!==V39_INTEGRATION_BASE
    ||sourceStatus.realApplicationServiceDeviceAudio!=='NOT_RUN'||sourceStatus.ownerAcceptance!=='NOT_RUN')fail('V39_002_SOURCE_STATUS');
  const plan=parse(context.body(source,'project/POSTRUST_PLAN.json'));
  if(plan.effective_scope?.originalTasks!==18||plan.effective_scope?.originalAcceptanceCases!==156
    ||plan.effective_scope?.activeTasks!==17||plan.effective_scope?.activeAcceptanceCases!==150||plan.effective_scope?.notApplicableAcceptanceCases!==6)fail('V39_002_LEDGER');
  protectedJson(context.body(V39_INTEGRATION_BASE,'project/POSTRUST_PLAN.json'),context.body(source,'project/POSTRUST_PLAN.json'),['integration_tasks','integration_execution_schedule'],'V39_002_SOURCE_PLAN_OUTSIDE_DOMAIN');
  protectedJson(context.body(V39_INTEGRATION_BASE,'project/STATUS.json'),context.body(source,'project/STATUS.json'),['v39Integration','v39Integration001Seal','currentIntegrationTask'],'V39_002_SOURCE_STATUS_OUTSIDE_DOMAIN');
  return {source,tree:commit.tree,scope,scopeSha256:hash(raw),sourcePins:pins,exactSourceFiles:names.length,sealedBaselinePreserved:true,offlineDonorVerified:true};
}
function sourceCurrent(context,source){const details=sourceObject(context,source),tree=context.tree(context.head);
  for(const row of details.sourcePins){const current=tree.get(row.path);if(context.head===source||!V39_INTEGRATION_REPORT_PATHS.some(item=>item.path===row.path)){
    if(!current||current.mode!==row.mode||current.blob!==row.blob)fail('V39_002_REPORT_SOURCE_BYTES');}}
  return details;}
function publish(context,details,role,ci=null){
  const current=context.commit(context.head),names=[...new Set([...details.sourcePins.map(row=>row.path),...(role==='report'?V39_INTEGRATION_REPORT_PATHS.map(row=>row.path):[])])].sort();
  const currentPins=actualPins(context,context.head,names);
  for(const row of currentPins){check(context.deadline);const raw=readWhole(path.join(context.directory,row.path));if(!equal(pin(raw),{bytes:row.bytes,sha256:row.sha256}))fail('V39_002_WORKTREE_BYTES');}
  context.after();const result=freeze({schema:'musicbridge.v39.integration002.admission.v1',task:V39_INTEGRATION_TASK,branch:V39_INTEGRATION_BRANCH,
    baseSha:V39_INTEGRATION_BASE,baseTree:V39_INTEGRATION_BASE_TREE,sourceParentSha:V39_INTEGRATION_SOURCE_PARENT,headAtAdmission:context.head,
    sourceSha:details.source,sourceTree:details.tree,repairRole:role,exactSourceFiles:details.exactSourceFiles,exactSourceDeltaFiles:details.exactSourceFiles,
    exactReportFiles:role==='report'?8:0,sourcePins:details.sourcePins,currentPins,scopeSha256:details.scopeSha256,
    sealedBaselinePreserved:true,offlineDonorVerified:true,currentProductSoftwareRequired:true,
    identity:{head:context.head,parent:current.parents[0],tree:current.tree,branch:context.branch,gitDir:path.join(context.directory,'.git'),commonDir:path.join(context.directory,'.git'),status:''}});
  issued.add(result);if(ci)issuedCi.set(result,ci);return result;
}
export function inspectV39Integration002Admission(directory=repository,env=process.env,options={}) {
  const context=gitContext(directory,env,options),details=sourceCurrent(context,context.head);return publish(context,details,'source');
}
const reportJsonFields=['state','phase','sourceCommit','reportCommit','software','nativeEightFormats','currentCapacity','sourceCi','reportCi','reportCommitResolution','sourceEvidenceCanonical'];
export function inspectV39Integration002ReportAdmission(directory=repository,env=process.env,options={}) {
  const context=gitContext(directory,env,options),current=context.commit(context.head),source=current.parents[0],details=sourceCurrent(context,source);
  const changes=context.exactDiff(source,context.head),expected=[...V39_INTEGRATION_REPORT_PATHS].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(changes.length!==8||changes.some((row,i)=>row.path!==expected[i].path||row.status!==expected[i].status||row.newMode!=='100644'
    ||row.oldMode!==(row.status==='A'?'000000':'100644')))fail('V39_002_REPORT_DIFF');
  const evidence=parse(context.body(context.head,V39_INTEGRATION_CI_EVIDENCE_PATH));
  if(evidence.task!==V39_INTEGRATION_TASK||evidence.sourceSha!==source||evidence.reportSha!==null
    ||evidence.ownerAcceptance!=='NOT_RUN'||evidence.realApplicationServiceDeviceAudio!=='NOT_RUN'
    ||!validateV39Integration002SourceReceipt(evidence.sourceCi,source))fail('V39_002_REPORT_PARENT_CI');
  const sourceSummary=v39Integration002SourceSummary(evidence.sourceCi),recorded=sourceSummary.sourceBefore;
  if(recorded.identity?.head!==source||recorded.identity?.parent!==V39_INTEGRATION_SOURCE_PARENT||recorded.identity?.tree!==details.tree
    ||recorded.admission?.scopeSha256!==details.scopeSha256||!equal(recorded.admission?.sourcePins,details.sourcePins)
    ||!equal(recorded.currentFiles,details.sourcePins)||recorded.admission?.exactSourceFiles!==details.exactSourceFiles)fail('V39_002_REPORT_ACTUAL_SOURCE_BINDING');
  if(!context.body(context.head,'reports/V39-INTEGRATION-002_RESULT.json').equals(context.body(context.head,V39_INTEGRATION_CI_EVIDENCE_PATH)))fail('V39_002_RESULT_EVIDENCE_BODY');
  const publicState=v39Integration002ReportState(source,evidence.sourceCi),after=parse(context.body(context.head,V39_INTEGRATION_STATUS_PATH));
  protectedJson(context.body(source,V39_INTEGRATION_STATUS_PATH),context.body(context.head,V39_INTEGRATION_STATUS_PATH),reportJsonFields,'V39_002_REPORT_STATUS_OUTSIDE_DOMAIN');
  for(const key of Object.keys(publicState))if(!equal(after[key],publicState[key]))fail('V39_002_REPORT_PUBLIC_IDENTITY');
  protectedJson(context.body(source,'project/STATUS.json'),context.body(context.head,'project/STATUS.json'),['v39Integration'],'V39_002_REPORT_PROJECT_STATUS');
  if(!equal(parse(context.body(context.head,'project/STATUS.json')).v39Integration,after))fail('V39_002_REPORT_STATUS_NOT_SHARED');
  const beforePlan=parse(context.body(source,'project/POSTRUST_PLAN.json')),afterPlan=parse(context.body(context.head,'project/POSTRUST_PLAN.json'));
  const select=plan=>plan.integration_tasks?.find(row=>row?.id===V39_INTEGRATION_TASK);
  const replace=plan=>({...plan,integration_tasks:plan.integration_tasks.map(row=>row.id===V39_INTEGRATION_TASK?{id:row.id}:row)});
  if(!select(beforePlan)||!select(afterPlan)||!equal(replace(beforePlan),replace(afterPlan)))fail('V39_002_REPORT_PLAN_OUTSIDE_DOMAIN');
  const numericBefore=lossless(context.body(source,'project/POSTRUST_PLAN.json')),numericAfter=lossless(context.body(context.head,'project/POSTRUST_PLAN.json'));
  if(!equal(replace(numericBefore),replace(numericAfter)))fail('V39_002_REPORT_PLAN_NUMBER_TOKEN');
  const row=select(afterPlan);if(row.source_commit!==source||!equal(row.source_ci,publicState.sourceCi)||row.owner_acceptance!=='NOT_RUN')fail('V39_002_REPORT_PLAN_IDENTITY');
  return publish(context,details,'report',evidence.sourceCi);
}
export const assertV39Integration002ReportSource=inspectV39Integration002ReportAdmission;
export function v39Integration002WorkflowOutputs(result){if(!issued.has(result))fail('V39_002_OWN_QUALIFICATION_REQUIRED');
  return {integrationTask:V39_INTEGRATION_TASK,integrationMode:'qualified',integrationRole:result.repairRole,
    productVerificationMode:result.repairRole==='source'?'fresh-source':'exact-parent-current-product-reuse'};}
export function v39Integration002AdmittedSourceCi(result){if(!issued.has(result)||!issuedCi.has(result))fail('V39_002_OWN_REPORT_QUALIFICATION_REQUIRED');return issuedCi.get(result);}
export function v39Integration002HasAuthority(directory){return [V39_INTEGRATION_SCOPE_PATH,V39_INTEGRATION_STATUS_PATH].some(name=>present(path.join(directory,name)));}
export function v39Integration002RouteRequested(branch,authorityPresent){return branch===V39_INTEGRATION_BRANCH||authorityPresent===true;}
export function inspectV39Integration002WorkflowGuard(directory=repository,env=process.env,options={}) {
  let requested=env.GITHUB_REF_NAME===V39_INTEGRATION_BRANCH||v39Integration002HasAuthority(directory);
  if(!requested){const value=spawnSync('git',['--no-replace-objects','-c','core.fsmonitor=false','branch','--show-current'],{cwd:directory,env:v39Integration002GitEnvironment(env),timeout:10000,maxBuffer:cap,encoding:'utf8'});
    if(value.error||value.signal||value.status!==0)fail('V39_002_ROUTE_GIT');requested=value.stdout.trim()===V39_INTEGRATION_BRANCH;}
  if(!requested)return {integrationTask:'not-applicable',integrationMode:'not-applicable',integrationRole:'not-applicable',productVerificationMode:'not-applicable'};
  const context=gitContext(directory,env,options),role=context.commit(context.head).parents[0]===V39_INTEGRATION_SOURCE_PARENT?'source':'report';
  return v39Integration002WorkflowOutputs(role==='source'?inspectV39Integration002Admission(directory,env,options):inspectV39Integration002ReportAdmission(directory,env,options));
}

const toolStages=freeze(['original-173','authority-safety','gate-safety','current-composition','control-plane','boundaries','cycles']);
const pinValid=row=>object(row)&&relative(row.path)&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&sha256(row.sha256);
const toolFrameMagic=Buffer.from('MusicBridgeV39Integration002RootRecords\0v1\n','utf8');
export const V39_INTEGRATION_TOOL_ROOT_LIMITS=freeze({recordBytes:16777216,frameBytes:67108864,canonicalBytes:16777216});
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let bit=0;bit<8;bit++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function toolCrc(bytes) { let c=0xffffffff;for(const byte of bytes)c=crcTable[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0; }
export function v39Integration002ToolRootNames(phase) {
  if(!['source','report'].includes(phase))fail('V39_002_002_TOOL_PHASE');
  return ['summary.json','source-before.json','source-after.json','feature-proof.json',
    ...(phase==='source'?['fresh-reader.json','verify.log','standard-verification.json']:[]),
    ...toolStages.filter(name=>phase==='source'||name!=='current-composition')
      .flatMap(name=>[name+'.json',name+'.stdout.log',name+'.stderr.log'])].sort();
}
const toolRootNames=v39Integration002ToolRootNames;
/** 压缩完整原件只减少重复表示；单件、整体展开和外层JSON均保留固定边界。 */
export function encodeV39Integration002ToolContent(records,phase) {
  const expected=toolRootNames(phase);
  if(!Array.isArray(records)||types.isProxy(records)||records.length!==expected.length||Object.getOwnPropertySymbols(records).length
    ||!equal(Object.getOwnPropertyNames(records),[...Array.from({length:records.length},(_row,i)=>String(i)),'length']))fail('V39_002_TOOL_ROOT_CLOSEDSET');
  const sorted=[];
  for(let i=0;i<records.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(records,String(i));
    if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('V39_002_TOOL_ROOT_FIELDS');
    const row=descriptor.value;
    if(!object(row)||types.isProxy(row)||Object.getOwnPropertySymbols(row).length
      ||![Object.prototype,null].includes(Object.getPrototypeOf(row)))fail('V39_002_TOOL_ROOT_FIELDS');
    keys(row,['path','bytes'],'V39_002_TOOL_ROOT_FIELDS');
    for(const key of ['path','bytes'])if(!Object.hasOwn(Object.getOwnPropertyDescriptor(row,key),'value'))fail('V39_002_TOOL_ROOT_FIELDS');
    if(!relative(row.path)||!Buffer.isBuffer(row.bytes)||types.isProxy(row.bytes)
      ||row.bytes.length>V39_INTEGRATION_TOOL_ROOT_LIMITS.recordBytes)fail('V39_002_TOOL_ROOT_FIELDS');
    sorted.push({path:row.path,bytes:Buffer.from(row.bytes)});
  }
  sorted.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(!equal(sorted.map(row=>row.path),expected))fail('V39_002_TOOL_ROOT_CLOSEDSET');
  const count=Buffer.alloc(2);count.writeUInt16BE(sorted.length);
  let rawBytes=toolFrameMagic.length+count.length;
  const parts=[toolFrameMagic,count],entries=[];
  for(const row of sorted){
    const name=Buffer.from(row.path,'utf8'),header=Buffer.alloc(6);
    header.writeUInt16BE(name.length);header.writeUInt32BE(row.bytes.length,2);
    rawBytes+=header.length+name.length+row.bytes.length;
    if(rawBytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.frameBytes)fail('V39_002_TOOL_FRAME_BUDGET');
    parts.push(header,name,row.bytes);entries.push({path:row.path,bytes:row.bytes.length,sha256:hash(row.bytes),crc32:toolCrc(row.bytes)});
  }
  const frame=Buffer.concat(parts,rawBytes),compressed=gzipSync(frame,{level:9});
  const result={entry:'summary.json',phase,encoding:'gzip-root-records-v1',rootArchive:{
    schema:'musicbridge.v39.integration002.gzip-root-records.v1',entries,rawBytes,sha256:hash(frame),
    gzip:{bytes:compressed.length,sha256:hash(compressed),base64:compressed.toString('base64')}}};
  canonical(result);
  return freeze(result);
}
/** 返回从原始summary字节解析的正文与独立原件Buffer，不接受额外或伪造继承文件。 */
export function decodeV39Integration002ToolContent(content) {
  canonical(content);
  keys(content,['entry','phase','encoding','rootArchive'],'V39_002_TOOL_CONTENT_FIELDS');
  if(content.entry!=='summary.json'||content.encoding!=='gzip-root-records-v1')fail('V39_002_TOOL_CONTENT_ENCODING');
  const expected=toolRootNames(content.phase),archive=content.rootArchive;
  keys(archive,['schema','entries','rawBytes','sha256','gzip'],'V39_002_TOOL_ARCHIVE_FIELDS');
  keys(archive.gzip,['bytes','sha256','base64'],'V39_002_TOOL_GZIP_FIELDS');
  if(archive.schema!=='musicbridge.v39.integration002.gzip-root-records.v1'||!Array.isArray(archive.entries)
    ||!equal(archive.entries.map(row=>row.path),expected)||!positive(archive.rawBytes)
    ||archive.rawBytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.frameBytes||!sha256(archive.sha256)
    ||!positive(archive.gzip.bytes)||archive.gzip.bytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.canonicalBytes
    ||!sha256(archive.gzip.sha256))fail('V39_002_TOOL_ARCHIVE_BUDGET');
  for(const entry of archive.entries){
    keys(entry,['path','bytes','sha256','crc32'],'V39_002_TOOL_ARCHIVE_ENTRY');
    if(!pinValid(entry)||entry.bytes>V39_INTEGRATION_TOOL_ROOT_LIMITS.recordBytes
      ||!Number.isSafeInteger(entry.crc32)||entry.crc32<0||entry.crc32>0xffffffff)fail('V39_002_TOOL_ARCHIVE_ENTRY');
  }
  const expectedFrameBytes=toolFrameMagic.length+2+archive.entries.reduce((sum,entry)=>sum+6+Buffer.byteLength(entry.path,'utf8')+entry.bytes,0);
  if(expectedFrameBytes!==archive.rawBytes)fail('V39_002_TOOL_FRAME_LENGTH');
  const compressed=base64(archive.gzip.base64);
  if(compressed.length!==archive.gzip.bytes||hash(compressed)!==archive.gzip.sha256)fail('V39_002_TOOL_GZIP_HASH');
  let expanded;
  try { expanded=gunzipSync(compressed,{maxOutputLength:archive.rawBytes,info:true}); }
  catch { fail('V39_002_TOOL_GZIP_BOUNDED_DECODE'); }
  const frame=expanded.buffer;
  if(expanded.engine.bytesWritten!==compressed.length||frame.length!==archive.rawBytes||hash(frame)!==archive.sha256
    ||!frame.subarray(0,toolFrameMagic.length).equals(toolFrameMagic)
    ||frame.length<toolFrameMagic.length+2||frame.readUInt16BE(toolFrameMagic.length)!==expected.length)fail('V39_002_TOOL_FRAME_HEADER');
  const rootRecords=new Map();let position=toolFrameMagic.length+2;
  for(const entry of archive.entries){
    if(position+6>frame.length)fail('V39_002_TOOL_FRAME_LENGTH');
    const nameLength=frame.readUInt16BE(position),size=frame.readUInt32BE(position+2);position+=6;
    if(nameLength===0||nameLength>4096||size>V39_INTEGRATION_TOOL_ROOT_LIMITS.recordBytes
      ||position+nameLength+size>frame.length)fail('V39_002_TOOL_FRAME_LENGTH');
    const name=decode(frame.subarray(position,position+nameLength));position+=nameLength;
    const bytes=frame.subarray(position,position+size);position+=size;
    if(name!==entry.path||size!==entry.bytes||hash(bytes)!==entry.sha256||toolCrc(bytes)!==entry.crc32)fail('V39_002_TOOL_ROOT_HASH');
    rootRecords.set(name,Buffer.from(bytes));
  }
  if(position!==frame.length)fail('V39_002_TOOL_FRAME_TRAILING_BYTES');
  const summary=parse(rootRecords.get('summary.json'));canonical(summary);
  return {summary,rootRecords};
}
export function v39Integration002SourceSummary(fullCi) {
  if(!sha(fullCi?.revision)||!Array.isArray(fullCi.artifacts))fail('V39_002_TOOL_ARTIFACT');
  const artifacts=fullCi.artifacts.filter(row=>row?.name==='verify-'+fullCi.revision);
  if(artifacts.length!==1||artifacts[0].toolContent?.phase!=='source')fail('V39_002_TOOL_ARTIFACT');
  return decodeV39Integration002ToolContent(artifacts[0].toolContent).summary;
}
function successfulStep(job,name){return job.steps?.filter(row=>row?.name===name&&row.status==='completed'&&row.conclusion==='success').length===1;}
export function validateV39Integration002ParentCi(input) {
  try {
    if(!object(input)||input.task!==V39_INTEGRATION_TASK||input.repositoryId!==V39_INTEGRATION_REPOSITORY_ID||!sha(input.parent)
      ||input.parent===V39_INTEGRATION_BASE||input.branch!==V39_INTEGRATION_BRANCH||!Number.isFinite(input.now)
      ||!Array.isArray(input.runs)||input.runs.length!==4||!Array.isArray(input.proofs)||input.proofs.length!==4)return false;
    const runIds=new Set(),jobIds=new Set(),artifactIds=new Set();let jobCount=0,artifactCount=0;
    const names=['verify-'+input.parent,'rust-core-ubuntu-latest-'+input.parent,'rust-core-macos-latest-'+input.parent,
      'rust-host-compiled-'+input.parent,'electron-e2e-'+input.parent];
    for(const file of V39_INTEGRATION_WORKFLOWS){const selected=input.runs.filter(row=>row?.path===file);if(selected.length!==1)return false;
      const run=selected[0],created=Date.parse(run.created_at),updated=Date.parse(run.updated_at);
      if(!positive(run.id)||runIds.has(run.id)||run.event!=='push'||run.run_attempt!==1||run.head_sha!==input.parent||run.head_branch!==input.branch
        ||run.status!=='completed'||run.conclusion!=='success'||run.repository?.id!==input.repositoryId
        ||!Number.isFinite(created)||!Number.isFinite(updated)||created>updated||updated>input.now)return false;runIds.add(run.id);
      const proof=input.proofs.filter(row=>row?.runId===run.id);if(proof.length!==1||!Array.isArray(proof[0].jobs)||!Array.isArray(proof[0].artifacts))return false;
      const jobs=proof[0].jobs,expectedJobs=file.includes('verify.yml')?2:file.includes('rust-core.yml')?2:1;
      if(jobs.length!==expectedJobs)return false;jobCount+=jobs.length;
      for(const job of jobs){if(!positive(job.id)||jobIds.has(job.id)||job.head_sha!==input.parent||job.status!=='completed'||job.conclusion!=='success'
        ||!Array.isArray(job.steps)||job.steps.some(step=>!['completed'].includes(step.status))
        ||!successfulStep(job,V39_INTEGRATION_GUARD_STEP))return false;jobIds.add(job.id);}
      if(file.includes('verify.yml')){
        const product=jobs.filter(job=>successfulStep(job,V39_INTEGRATION_GATE_STEP));if(product.length!==1
          ||!successfulStep(product[0],'Verify platform-independent workspace (typecheck, unit tests, build; no Electron)')
          ||!successfulStep(product[0],V39_INTEGRATION_CAPACITY_STEP)||!successfulStep(product[0],V39_INTEGRATION_UPLOAD_STEP)
          ||!['Validate control plane','Validate security and product boundaries','Scan workspace import cycles'].every(name=>successfulStep(product[0],name)))return false;
      }
      if(file.includes('verify.yml')){const audit=jobs.filter(job=>successfulStep(job,'Production dependency audit'));if(audit.length!==1)return false;}
      if(file.includes('security.yml')&&!['Validate machine control state','Run boundary, loopback, secret and URL/query scans',
        'Scan workspace import cycles','Run directed platform-independent security tests (no Electron)'].every(name=>successfulStep(jobs[0],name)))return false;
      if(file.includes('rust-core.yml')&&jobs.some(job=>!successfulStep(job,'验证实际 Rust 与 TypeScript 边界')
        ||!successfulStep(job,'保留编译器、测试及源码与二进制清单')))return false;
      if(file.includes('electron-e2e.yml')&&!['Build and verify both Rust hosts once in this job',
        'Electron startup, crash/restart, safeStorage vault and credential recovery gates','Electron end-to-end flow (Playwright, production build)',
        'Preserve declared synthetic Rust Host compiled artifacts',V39_INTEGRATION_NATIVE_STEP,V39_INTEGRATION_UPLOAD_STEP].every(name=>successfulStep(jobs[0],name)))return false;
      const artifacts=proof[0].artifacts,expectedArtifacts=file.includes('security.yml')?0:file.includes('rust-core.yml')?2:file.includes('electron-e2e.yml')?2:1;
      if(artifacts.length!==expectedArtifacts)return false;artifactCount+=artifacts.length;
      for(const artifact of artifacts){if(!positive(artifact.id)||artifactIds.has(artifact.id)||!names.includes(artifact.name)||artifact.expired!==false
        ||!positive(artifact.size_in_bytes)||!/^sha256:[a-f0-9]{64}$/u.test(artifact.digest??''))return false;artifactIds.add(artifact.id);}
    }
    const all=input.proofs.flatMap(proof=>proof.artifacts).map(row=>row.name);
    return runIds.size===4&&jobCount===6&&jobIds.size===6&&artifactCount===5&&artifactIds.size===5&&equal([...all].sort(),names.sort());
  } catch { return false; }
}
const stageFailures=['timedOut','overflow','spawnFailed','interrupted','cleanupFailed','terminationRequested','lingeringOwnedGroup',
  'descendantScanFailed','rawForcedClosed','boundedSettleObserved','unexpectedPipeHolder'];
export function v39Integration002StagePassed(stage,maximum=90000){return object(stage)&&stage.passed===true&&stage.exitCode===0&&stage.signal===null
  &&stage.exitObserved===true&&stage.closeObserved===true&&stage.rawCaptureComplete===true&&stage.physicalShutdown?.pidAbsent===true
  &&stage.physicalShutdown?.processGroupAbsent===true&&stage.observedDescendantsAbsent===true
  &&Array.isArray(stage.observedDescendants)&&stage.observedDescendants.every(row=>row.physicallyAbsent===true)
  &&stageFailures.every(key=>stage[key]===false)&&Number.isFinite(stage.durationMs)&&stage.durationMs>=0
  &&Number.isFinite(stage.budgetMs)&&stage.budgetMs>0&&stage.budgetMs<=maximum&&stage.durationMs<=stage.budgetMs;}
export function parseV39Integration002Tap(bytes,expected=null,skips=[]) {
  const text=decode(bytes),counts={},labels=['tests','suites','pass','fail','cancelled','skipped','todo'],names=[];
  if([...text.matchAll(/^TAP version 13[ \t]*\r?$/gmu)].length!==1)fail('V39_002_TAP_HEADER');
  for(const field of labels){const values=[...text.matchAll(new RegExp('^# '+field+' (\\d+)[ \t]*\r?$','gmu'))];
    if(values.length!==1)fail('V39_002_TAP_SUMMARY');counts[field]=Number(values[0][1]);}
  const stack=[{indent:0,cases:0,plan:null}];let total=0,skipped=0;
  function scope(indentation){if(indentation.includes('\t')||indentation.length%4)fail('V39_002_TAP_INDENT');const indent=indentation.length;
    while(stack.at(-1).indent>indent){const done=stack.pop();if(done.plan===null||done.plan!==done.cases)fail('V39_002_TAP_PLAN');}
    if(stack.at(-1).indent<indent){if(indent!==stack.at(-1).indent+4||stack.at(-1).plan!==null)fail('V39_002_TAP_SCOPE');stack.push({indent,cases:0,plan:null});}
    return stack.at(-1);}
  for(const line of text.split(/\r?\n/u)){const point=/^([ \t]*)(ok|not ok) (\d+) - (.*)$/u.exec(line),plan=/^([ \t]*)1\.\.(\d+)[ \t]*$/u.exec(line);
    if(point){const current=scope(point[1]),skip=/ # SKIP(?: (.*))?$/u.exec(point[4]);
      if(current.plan!==null||point[2]!=='ok'||Number(point[3])!==current.cases+1||/ # TODO(?: |$)/u.test(point[4]))fail('V39_002_TAP_ORDINAL');
      current.cases++;total++;if(!point[1].length)names.push(point[4]);
      if(skip){if(!skips.includes(skip[1]??''))fail('V39_002_TAP_SKIP');skipped++;}}
    else if(plan){const current=scope(plan[1]);if(current.plan!==null||Number(plan[2])!==current.cases)fail('V39_002_TAP_PLAN');current.plan=Number(plan[2]);}
    else if(/^[ \t]*Bail out!/u.test(line))fail('V39_002_TAP_BAILOUT');}
  if(stack.length!==1||stack[0].plan===null||stack[0].plan!==stack[0].cases||total!==counts.tests+counts.suites
    ||!counts.tests||counts.fail||counts.cancelled||counts.todo||counts.pass+counts.skipped!==counts.tests||skipped!==counts.skipped)fail('V39_002_TAP_INCOMPLETE');
  if(expected&&(!equal(names.map(name=>name.replace(/ # SKIP .*$/u,'')).sort(),[...expected].sort())||new Set(names.map(name=>name.replace(/ # SKIP .*$/u,''))).size!==expected.length))fail('V39_002_TAP_NAMES');return {counts,names};
}
const parseCompleteTap=parseV39Integration002Tap;
function wholeArtifact(artifact){return object(artifact)&&positive(artifact.id)&&object(artifact.zip)&&positive(artifact.zip.bytes)&&sha256(artifact.zip.sha256)
  &&artifact.allMembersBytesAndCrcRead===true&&Array.isArray(artifact.members)&&artifact.members.length>0&&artifact.members.length<=32768
  &&new Set(artifact.members.map(row=>row.path)).size===artifact.members.length&&Number.isSafeInteger(artifact.expandedBytes)&&artifact.expandedBytes>=0
  &&artifact.expandedBytes<=4*1024*1024*1024&&artifact.expandedBytes===artifact.members.reduce((n,row)=>n+row.bytes,0)
  &&artifact.members.every(row=>pinValid(row)&&Number.isInteger(row.crc32)&&row.crc32>=0&&row.crc32<=0xffffffff);}
function rootTool(artifact,source,phase,head){
  if(!wholeArtifact(artifact))fail('V39_002_WHOLE_TOOL');const decoded=decodeV39Integration002ToolContent(artifact.toolContent),{summary,rootRecords}=decoded;
  const names=v39Integration002ToolRootNames(phase);if(artifact.toolContent.phase!==phase||!equal(artifact.members.filter(row=>names.includes(row.path)).map(row=>row.path).sort(),names)
    ||artifact.members.some(row=>!names.includes(row.path)&&row.path!=='archive-manifest.json'&&!row.path.startsWith('capacity/')))fail('V39_002_TOOL_MEMBERS');
  for(const [name,bytes]of rootRecords){const row=artifact.members.find(row=>row.path===name);if(!row||row.bytes!==bytes.length||row.sha256!==hash(bytes)||row.crc32!==toolCrc(bytes))fail('V39_002_TOOL_MEMBER_BODY');}
  if(summary.schema!=='musicbridge.v39.integration002.software-gate.v1'||summary.task!==V39_INTEGRATION_TASK||summary.role!==phase||summary.sourceSha!==source
    ||summary.head!==head||summary.sourceParentSha!==V39_INTEGRATION_SOURCE_PARENT||summary.baseSha!==V39_INTEGRATION_BASE||summary.passed!==true||summary.failureCode!==null
    ||summary.currentSoftwareGateExitCode!==0||summary.sourceUnchanged!==true||!sha256(summary.sourceBefore?.admission?.scopeSha256)
    ||!equal(summary.sourceBefore,summary.sourceAfter)||!equal(parse(rootRecords.get('source-before.json')),summary.sourceBefore)
    ||!equal(parse(rootRecords.get('source-after.json')),summary.sourceAfter)||!equal(summary.limits,{stageMs:90000,wholeMs:480000,rawBytesPerStream:cap,gitBytes:cap,gitMs:10000})
    ||!Number.isFinite(summary.durationMs)||summary.durationMs<0||summary.durationMs>=480000||summary.temporaryCleanup?.ownedFreshTemporaryRoot!==true
    ||summary.temporaryCleanup?.allStageProcessesPhysicallyClosed!==true||summary.temporaryCleanup?.removed!==true||summary.temporaryCleanup?.sourceAndEvidenceNeverDeleted!==true)fail('V39_002_TOOL_RESULT');
  const stages=toolStages.filter(name=>phase==='source'||name!=='current-composition');
  if(!equal(summary.stages.map(stage=>stage.name),stages))fail('V39_002_TOOL_STAGES');
  for(const stage of summary.stages){if(!v39Integration002StagePassed(stage)||!equal(parse(rootRecords.get(stage.name+'.json')),stage))fail('V39_002_STAGE_PHYSICAL_OR_RAW');
    for(const stream of ['stdout','stderr']){const raw=rootRecords.get(stage.name+'.'+stream+'.log');if(!pinValid(stage.raw?.[stream])
      ||stage.raw[stream].path!==stage.name+'.'+stream+'.log'||!equal(pin(raw),{bytes:stage.raw[stream].bytes,sha256:stage.raw[stream].sha256}))fail('V39_002_STAGE_RAW');}
    if(['original-173','authority-safety','gate-safety','current-composition'].includes(stage.name)){
      const expected=stage.name==='original-173'?173:stage.name==='authority-safety'?32:stage.name==='gate-safety'?10:null;
      const frozenNames=stage.name==='authority-safety'?[...V39_INTEGRATION_ADMISSION_CASE_NAMES,...V39_INTEGRATION_REPORT_CASE_NAMES,...V39_INTEGRATION_ARTIFACT_CASE_NAMES]:
        stage.name==='gate-safety'?V39_INTEGRATION_GATE_CASE_NAMES:null;
      if(!equal(stage.expectedCaseNames,frozenNames))fail('V39_002_STAGE_EXPECTED_NAMES');
      const parsed=parseCompleteTap(rootRecords.get(stage.name+'.stdout.log'),stage.expectedCaseNames,phase==='report'&&stage.name==='gate-safety'?['EXACT_PARENT_CURRENT_SOURCE_PRODUCT_EVIDENCE_REUSED_NOT_REPEATED']:[]);
      if(expected!==null&&parsed.counts.tests!==expected||phase==='report'&&stage.name==='gate-safety'&&parsed.counts.skipped!==3||!equal(parsed.counts,stage.testCounts)||!equal(parsed.names,stage.actualCaseNames))fail('V39_002_STAGE_TAP');}
  }
  const admission=summary.sourceBefore.admission;
  if(admission.schema!=='musicbridge.v39.integration002.admission.v1'||admission.task!==V39_INTEGRATION_TASK||admission.baseSha!==V39_INTEGRATION_BASE
    ||admission.sourceParentSha!==V39_INTEGRATION_SOURCE_PARENT||admission.sourceSha!==source||admission.headAtAdmission!==head||admission.repairRole!==phase
    ||summary.sourceBefore.identity?.head!==head||summary.sourceBefore.identity?.parent!==(phase==='source'?V39_INTEGRATION_SOURCE_PARENT:source)
    ||!Array.isArray(admission.sourcePins)||admission.sourcePins.length!==admission.exactSourceFiles||admission.exactSourceFiles<requiredPaths.length||admission.exactSourceFiles>V39_INTEGRATION_AUTHORIZATION.length
    ||admission.sourcePins.some(row=>!pinValid(row)||!authByPath.has(row.path))||!Array.isArray(summary.sourceBefore.originalTests)
    ||summary.sourceBefore.originalTests.length!==11||CI_REPORT_MIRROR_ORIGINAL_TESTS.some(row=>!summary.sourceBefore.originalTests.some(input=>input.path===row.path&&input.bytes===row.bytes&&input.sha256===row.sha256)))fail('V39_002_CURRENT_SOURCE_INPUT_BINDING');
  if(!equal(parse(rootRecords.get('feature-proof.json')),summary.featureProof)||summary.featureProof?.rows?.length!==44
    ||summary.featureProof.sourceSha!==source||summary.featureProof.role!==phase||new Set(summary.featureProof.rows.map(row=>row.id)).size!==44)fail('V39_002_FEATURE_PROOF_BODY');
  if(phase==='source'){
    const standard=parse(rootRecords.get('standard-verification.json'));inspectFrozenStandardRaw(rootRecords.get('verify.log'),[standard.verifyExit,standard.teeExit]);
    if(standard.schema!=='musicbridge.v39.integration002.standard-verification.v1'||standard.status!=='PASSED_CURRENT_SOURCE_STANDARD_VERIFICATION'
      ||standard.sourceSha!==source||standard.scopeSha256!==summary.sourceBefore.admission.scopeSha256||standard.verifyExit!==0||standard.teeExit!==0
      ||standard.pipelineNaturallyEnded!==true||!equal(standard.before,standard.after)||!equal({...standard.before,freshReader:standard.freshReader},summary.sourceBefore)
      ||!equal(pin(rootRecords.get('verify.log')),{bytes:standard.raw.bytes,sha256:standard.raw.sha256})
      ||!equal(parse(rootRecords.get('fresh-reader.json')),standard.freshReader)||standard.freshReader?.currentWorkerIndependentlyVerified!==true
      ||!Array.isArray(standard.freshReader?.receipt?.sourceInputs)||!standard.freshReader.receipt.sourceInputs.length||!Array.isArray(summary.sourceBefore.productInputs)||!summary.sourceBefore.productInputs.length
      ||standard.freshReader?.sourceInputsIndependentlyMatchedToActualGit!==standard.freshReader?.receipt?.sourceInputs?.length
      ||standard.freshReader.receipt.sourceInputs.some(row=>!summary.sourceBefore.productInputs.some(input=>input.path===row.path&&input.bytes===row.bytes&&input.sha256===row.sha256)))fail('V39_002_STANDARD_AND_READER');
  }else if(summary.productVerificationRepeated!==false||summary.productEvidenceReuse!=='EXACT_PARENT_CURRENT_SOURCE_EVIDENCE')fail('V39_002_REPORT_REUSE_BOUNDARY');
  return decoded;
}
export function validateV39Integration002SourceReceipt(value,sourceSha){
  try {
    canonical(value);if(!sha(sourceSha)||sourceSha===V39_INTEGRATION_BASE||value?.schema!=='musicbridge.root.v39-integration002.first-natural-ci.v1'
      ||value.status!=='SEALED_FIRST_NATURAL_CURRENT_PRODUCT_CI'||value.code!==null||value.task!==V39_INTEGRATION_TASK||value.phase!=='source'
      ||value.revision!==sourceSha||value.repositoryId!==V39_INTEGRATION_REPOSITORY_ID||value.branch!==V39_INTEGRATION_BRANCH
      ||!equal(value.before,value.after)||value.before?.head!==sourceSha||value.before?.parent!==V39_INTEGRATION_SOURCE_PARENT
      ||value.before?.clean!==true||value.reruns!==0||value.dispatches!==0||value.credentialsOrSignedRedirectArchived!==false
      ||!validateV39Integration002ParentCi({task:V39_INTEGRATION_TASK,repositoryId:value.repositoryId,parent:sourceSha,branch:value.branch,
        runs:value.runs,proofs:value.proofs,now:Date.parse(value.recordedAt)}))return false;
    if(!Array.isArray(value.logs)||value.logs.length!==6||new Set(value.logs.map(row=>row.jobId)).size!==6||value.logs.some(row=>!positive(row.jobId)
      ||!positive(row.raw?.bytes)||!sha256(row.raw?.sha256)||row.download?.httpStatus!==200||row.download?.rawComplete!==true))return false;
    const jobIds=value.proofs.flatMap(row=>row.jobs).map(row=>row.id).sort((a,b)=>a-b);
    if(!equal(value.logs.map(row=>row.jobId).sort((a,b)=>a-b),jobIds))return false;
    const products=value.proofs.flatMap(row=>row.artifacts);if(!Array.isArray(value.artifacts)||value.artifacts.length!==5
      ||value.artifacts.some(row=>!wholeArtifact(row)||!products.some(item=>item.id===row.id&&item.name===row.name&&item.size_in_bytes===row.zip.bytes
        &&item.digest==='sha256:'+row.zip.sha256)))return false;
    const verify=value.artifacts.filter(row=>row.name==='verify-'+sourceSha);if(verify.length!==1)return false;
    const {summary,rootRecords}=rootTool(verify[0],sourceSha,'source',sourceSha);
    for(const artifact of value.artifacts){const profile=artifact.name.startsWith('verify-')?'verify-source':artifact.name.startsWith('electron-e2e-')?'electron-source':
      artifact.name.startsWith('rust-core-ubuntu-')?'rust-linux-source':artifact.name.startsWith('rust-core-macos-')?'rust-macos-source':'rust-host-source';
      if(!validateV39Integration002ArchiveManifest(artifact,sourceSha,profile))return false;}
    const electron=value.artifacts.find(row=>row.name==='electron-e2e-'+sourceSha);
    const capacity=value.artifacts.find(row=>row.name==='verify-'+sourceSha);
    // 独立域完整原件由其producer保存；拒绝将必需Native/capacity missing或部分whole当PASS。
    if(!validateV39Integration002AuxiliaryArtifact(electron,'native',sourceSha,summary.sourceBefore.admission.scopeSha256)
      ||!validateV39Integration002AuxiliaryArtifact(capacity,'capacity',sourceSha,summary.sourceBefore.admission.scopeSha256))return false;
    const nativeSnapshot=decodeV39Integration002AuxiliaryContent(electron.auxiliaryContents.find(row=>row.kind==='native')).summary.sourceBefore;
    if(!equal(nativeSnapshot.currentFiles,summary.sourceBefore.currentFiles))return false;
    for(const row of summary.featureProof.rows){if(!Array.isArray(row.evidenceRefs)||!row.evidenceRefs.length)return false;
      for(const ref of row.evidenceRefs){if(!['standard','current-composition','gate-safety','native','capacity'].includes(ref.domain)||typeof ref.caseName!=='string'||!ref.caseName)return false;
        if(ref.domain==='standard'){const text=decode(rootRecords.get('verify.log'));
          if(!text.split(/\r?\n/u).some(line=>/^\s*ok \d+ - /u.test(line)&&line.replace(/^\s*ok \d+ - /u,'')===ref.caseName))return false;}
        if(['current-composition','gate-safety'].includes(ref.domain)&&!summary.stages.find(stage=>stage.name===ref.domain)?.actualCaseNames.includes(ref.caseName))return false;
        if(['native','capacity'].includes(ref.domain)){const artifact=ref.domain==='native'?electron:capacity,
          decoded=decodeV39Integration002AuxiliaryContent(artifact.auxiliaryContents.find(value=>value.kind===ref.domain));
          if(!decoded.summary.stages.some(stage=>stage.actualCaseNames.includes(ref.caseName)))return false;}}}
    return true;
  }catch{return false;}
}
export function validateV39Integration002ReportToolContent(artifact,sourceSha,reportSha){try{rootTool(artifact,sourceSha,'report',reportSha);return validateV39Integration002ArchiveManifest(artifact,sourceSha,'verify-report',reportSha);}catch{return false;}}
export function v39Integration002PublicSourceCi(value,sourceSha=value?.revision){
  if(!validateV39Integration002SourceReceipt(value,sourceSha))fail('V39_002_CURRENT_SOURCE_CI_REQUIRED');
  return freeze({schema:'musicbridge.v39.integration002.public-source-ci.v1',task:V39_INTEGRATION_TASK,sourceSha,
    sourceParentSha:V39_INTEGRATION_SOURCE_PARENT,repositoryId:value.repositoryId,workflowCount:4,jobCount:6,wholeArtifacts:5,
    sourceCiCanonical:v39IntegrationCanonicalPin(value),nativeEightFormats:'PASSED_CURRENT_BUNDLED_ENCODE_DECODE_EOF',currentCapacity:'PASSED_CURRENT_CHANGED_DOMAIN'});
}
export function v39Integration002ReportIdentity(sourceSha,sourceCi){return freeze({task:V39_INTEGRATION_TASK,branch:V39_INTEGRATION_BRANCH,
  baseSha:V39_INTEGRATION_BASE,sourceParentSha:V39_INTEGRATION_SOURCE_PARENT,sourceSha,sourceCi,reportSha:null,reportCi:null,
  nextTask:'V39-INTEGRATION-003',realApplicationServiceDeviceAudio:'NOT_RUN',ownerAcceptance:'NOT_RUN'});}
export function v39Integration002ReportState(sourceSha,sourceCi){const identity=v39Integration002ReportIdentity(sourceSha,sourceCi);
  return freeze({schema:'musicbridge.v39.integration002.status.v1',task:V39_INTEGRATION_TASK,branch:V39_INTEGRATION_BRANCH,
    baseReportSha:V39_INTEGRATION_BASE,state:'SOURCE_SEALED_REPORT_PENDING_CURRENT_CI',phase:'REPORT',sourceCommit:sourceSha,reportCommit:null,
    reportCommitResolution:'EXACT_DIRECT_CHILD_OF_CURRENT_SOURCE',software:'PASSED_CURRENT_SOURCE_SOFTWARE',nativeEightFormats:'PASSED_CURRENT_SOURCE_NATIVE',
    currentCapacity:'PASSED_CURRENT_CHANGED_DOMAIN',sourceCi:v39Integration002PublicSourceCi(sourceCi,sourceSha),reportCi:'REQUIRED_CURRENT_REPORT_NATURAL_CI',
    sourceEvidenceCanonical:v39IntegrationCanonicalPin(identity),realApplicationServiceDeviceAudio:'NOT_RUN',ownerAcceptance:'NOT_RUN',nextTask:'V39-INTEGRATION-003'});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==3||process.argv[2]!=='--workflow-guard')fail('V39_002_UNKNOWN_ARGUMENT');
    const outputs=inspectV39Integration002WorkflowGuard();if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,Object.entries(outputs).map(([k,v])=>k+'='+v+'\n').join(''),{flag:'a'});
    process.stdout.write(JSON.stringify({schema:'musicbridge.v39.integration002.workflow-guard.v1',...outputs})+'\n');
  }catch(error){process.stderr.write('V3.9 完整集成准入拒绝：'+(/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'V39_002_ADMISSION_FAILED')+'\n');process.exitCode=1;}}

export const V39_INTEGRATION_NATIVE_TESTS=freeze([
 'packages/bridge-core/test/v39/local-cue-native.test.ts','packages/bridge-core/test/v39/local-audio-tags-native.test.ts',
 'packages/bridge-core/test/v39/local-cue-output-recovery.test.ts','packages/bridge-core/test/v39/local-cue-bundle.test.ts',
 'packages/bridge-core/test/v39/fsevents-library-monitor.test.ts','packages/bridge-core/test/v39/local-cue-input-formats.test.ts']);
export const V39_INTEGRATION_CUE_INPUT_CASE_NAMES=freeze([
 'CUE输入：七个实际demux与八族来源逐件probe和完整PCM解码EOF，源原件及FD/PID/命名租约不变',
 'CUE输入：WAV/AIFF s16/s24/s32/f32/f64真实位深回读，f64仅输入且不扩输出资格',
 'CUE输入：同stem多FILE与Unicode精确关联实际PCM，CD75/pregap/末轨完整绑定',
 'CUE输入：99轨×100专辑完整计划不截尾，轨组FILE及32MiB边界整组拒绝',
 'CUE输入：弱类型格式/假品牌/源修订/路径/非独立目标整组拒绝且原输入保留',
 'CUE输入：真实坏音频probe/decode失败保留全raw，join后FD/PID/命名租约物理关闭']);
export const V39_INTEGRATION_NATIVE_CASE_NAMES=freeze([
 ['CUE八族实际编码、Unicode标签与图片、无损等值及有损质量、完整解码EOF和物理关闭'],
 ['真实WAV和FLAC保护副本只嵌入所选歌词，保留原音频、未选标签和图片并闭合SourceFiles许可'],
 ['CUE实际独立输出原回执、品牌恢复和SQLite冷回读保持原命令，不重编码或覆盖同名外部文件'],
 ['独立CUE包实际arm64闭集与完整许可证匹配固定源码，污染清单和未准入对象均不能启动后端'],
 ['真正FSEvents事件使原根读取失效，STOP取得原生ACK后无迟到回调且FD与进程实际闭合'],V39_INTEGRATION_CUE_INPUT_CASE_NAMES]);
export const V39_INTEGRATION_CAPACITY_TESTS=freeze([
 'packages/bridge-core/test/v39/local-album-capacity.test.ts','packages/bridge-core/test/v39/local-workbench-capacity.test.ts']);
export function v39Integration002AuxiliaryRootNames(kind){const tests=kind==='native'?V39_INTEGRATION_NATIVE_TESTS:kind==='capacity'?V39_INTEGRATION_CAPACITY_TESTS:null;
 if(!tests)fail('V39_002_AUX_DOMAIN');return ['summary.json','source-before.json','source-after.json',kind+'-proof.json',
   ...(kind==='native'?['cue-input-formats.json']:[]),
   ...tests.flatMap((_row,i)=>['case-'+(i+1)+'.json','case-'+(i+1)+'.stdout.log','case-'+(i+1)+'.stderr.log'])].sort();}
/** Native附属frame仍保23个根文件，只追加504原引用的真实正文；64MiB总额和16MiB单件不变。 */
function auxiliaryBodyNames(records,kind){
 const roots=v39Integration002AuxiliaryRootNames(kind),map=new Map();
 if(!Array.isArray(records)||records.length>65535)fail('V39_002_AUX_ROOTS');
 for(const row of records){keys(row,['path','bytes'],'V39_002_AUX_ROOT');if(!relative(row.path)||map.has(row.path)||!Buffer.isBuffer(row.bytes)||row.bytes.length>cap)fail('V39_002_AUX_ROOT');map.set(row.path,row.bytes);}
 if(roots.some(name=>!map.has(name)))fail('V39_002_AUX_ROOTS');
 const required=kind==='native'?v39Integration002CueNormalScanBodyRefs(parse(map.get('native-proof.json')),ref=>map.get('evidence/'+ref.path)).map(ref=>'evidence/'+ref.path):[];
 const names=[...roots,...required].sort();if(!equal([...map.keys()].sort(),names))fail('V39_002_AUX_BODY_CLOSEDSET');return names;
}
export function encodeV39Integration002AuxiliaryContent(records,kind){
 const expected=auxiliaryBodyNames(records,kind);
 const sorted=[...records].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);if(!equal(sorted.map(row=>row.path),expected))fail('V39_002_AUX_ROOTS');
 const count=Buffer.alloc(2);count.writeUInt16BE(sorted.length);const parts=[toolFrameMagic,count],entries=[];let length=toolFrameMagic.length+2;
 for(const row of sorted){keys(row,['path','bytes'],'V39_002_AUX_ROOT');if(!Buffer.isBuffer(row.bytes)||row.bytes.length>cap)fail('V39_002_AUX_BUDGET');
  const name=Buffer.from(row.path),header=Buffer.alloc(6);header.writeUInt16BE(name.length);header.writeUInt32BE(row.bytes.length,2);
  length+=6+name.length+row.bytes.length;if(length>67108864)fail('V39_002_AUX_FRAME_BUDGET');parts.push(header,name,row.bytes);
  entries.push({path:row.path,...pin(row.bytes),crc32:toolCrc(row.bytes)});}
 const frame=Buffer.concat(parts,length),gzip=gzipSync(frame,{level:9}),result={schema:'musicbridge.v39.integration002.auxiliary-content.v1',kind,
   entries,rawBytes:frame.length,sha256:hash(frame),gzip:{...pin(gzip),base64:gzip.toString('base64')}};canonical(result);return freeze(result);
}
export function decodeV39Integration002AuxiliaryContent(content){canonical(content);keys(content,['schema','kind','entries','rawBytes','sha256','gzip'],'V39_002_AUX_FIELDS');
 const roots=v39Integration002AuxiliaryRootNames(content.kind),names=content.entries?.map(row=>row?.path);if(content.schema!=='musicbridge.v39.integration002.auxiliary-content.v1'
  ||!Array.isArray(content.entries)||content.entries.length>65535||new Set(names).size!==names.length||!equal(names,[...names].sort())
  ||roots.some(name=>!names.includes(name))||names.some(name=>!relative(name)||!roots.includes(name)&&!(content.kind==='native'&&name.startsWith('evidence/')))
  ||!positive(content.rawBytes)||content.rawBytes>67108864
  ||!sha256(content.sha256)||!positive(content.gzip?.bytes)||content.gzip.bytes>cap||!sha256(content.gzip.sha256))fail('V39_002_AUX_IDENTITY');
 keys(content.gzip,['bytes','sha256','base64'],'V39_002_AUX_GZIP');const compressed=base64(content.gzip.base64);
 if(!equal(pin(compressed),{bytes:content.gzip.bytes,sha256:content.gzip.sha256}))fail('V39_002_AUX_GZIP_HASH');
 let expanded;try{expanded=gunzipSync(compressed,{maxOutputLength:content.rawBytes,info:true});}catch{fail('V39_002_AUX_GZIP_DECODE');}
 const bytes=expanded.buffer;if(expanded.engine.bytesWritten!==compressed.length||bytes.length!==content.rawBytes||hash(bytes)!==content.sha256
  ||!bytes.subarray(0,toolFrameMagic.length).equals(toolFrameMagic)||bytes.readUInt16BE(toolFrameMagic.length)!==names.length)fail('V39_002_AUX_FRAME');
 let at=toolFrameMagic.length+2;const records=new Map();for(const entry of content.entries){keys(entry,['path','bytes','sha256','crc32'],'V39_002_AUX_ENTRY');
  if(!pinValid(entry)||entry.bytes>cap||!Number.isInteger(entry.crc32)||entry.crc32<0||entry.crc32>0xffffffff||at+6>bytes.length)fail('V39_002_AUX_ENTRY');
  const sizeName=bytes.readUInt16BE(at),size=bytes.readUInt32BE(at+2);at+=6;if(sizeName<1||sizeName>4096||size!==entry.bytes||at+sizeName+size>bytes.length)fail('V39_002_AUX_ENTRY');
  const name=decode(bytes.subarray(at,at+sizeName));at+=sizeName;const raw=Buffer.from(bytes.subarray(at,at+size));at+=size;
  if(name!==entry.path||hash(raw)!==entry.sha256||toolCrc(raw)!==entry.crc32)fail('V39_002_AUX_ENTRY_HASH');records.set(name,raw);}
 if(at!==bytes.length)fail('V39_002_AUX_FRAME_TRAILING');
 auxiliaryBodyNames([...records].map(([path,bytes])=>({path,bytes})),content.kind);return {summary:parse(records.get('summary.json')),rootRecords:records};
}
const formatIds=freeze(['flac','alac','mp3','vorbis','opus','wavpack','pcm-wav','pcm-aiff']);
const filePins=(value,result=[])=>{if(object(value)){if(pinValid(value))result.push(value);for(const child of Object.values(value))if(child&&typeof child==='object')filePins(child,result);}
 else if(Array.isArray(value))for(const item of value)filePins(item,result);return result;};
function proofFiles(proof,lookup){for(const row of filePins(proof))if(!lookup(row))fail('V39_002_PROOF_FILE_BODY');}
const cueInputDemuxers=freeze(['wav','aiff','flac','mp3','ogg','wv','mov']);
const cueInputProfiles=freeze([
 ['flac-s24','flac','s24','flac','s32',24],['alac-s24','mov','s24','alac','s32p',24],['mp3-s24','mp3','s24','mp3','fltp',32],
 ['vorbis-s24','ogg','s24','vorbis','fltp',32],['opus-s24','ogg','s24','opus','fltp',32],['wavpack-s24','wv','s24','wavpack','s32p',24],
 ['pcm-wav-s24','wav','s24','pcm_s24le','s32',24],['pcm-aiff-s24','aiff','s24','pcm_s24be','s32',24],
 ['pcm-wav-s16','wav','s16','pcm_s16le','s16',16],['pcm-wav-s32','wav','s32','pcm_s32le','s32',32],
 ['pcm-wav-f32','wav','f32','pcm_f32le','flt',32],['pcm-wav-f64','wav','f64-input-only','pcm_f64le','dbl',64],
 ['pcm-aiff-s16','aiff','s16','pcm_s16be','s16',16],['pcm-aiff-s32','aiff','s32','pcm_s32be','s32',32],
 ['pcm-aiff-f32','aiff','f32','pcm_f32be','flt',32],['pcm-aiff-f64','aiff','f64-input-only','pcm_f64be','dbl',64],
 ['same-stem-wav','wav','s24','pcm_s24le','s32',24],['same-stem-flac','flac','s24','flac','s32',24]]);
const cuePreparedProfiles=cueInputProfiles.map(row=>row[0]).filter(id=>!id.endsWith('-f64')&&!id.startsWith('same-stem-'));
const cueInputZero=freeze({readers:0,writers:0,resources:0});
function cueInputBody(raw){if(!Buffer.isBuffer(raw)||!raw.length||raw.length>cap)fail('V39_002_CUE_INPUT_RAW');const body=parse(raw);canonical(body);return body;}
/** raw正文里的原件显式进入归档闭集；同路径不同pin拒绝，不以摘要替代PCM或stdio原件。 */
export function v39Integration002CueInputSourceRefs(raw){const body=cueInputBody(raw),refs=new Map();
 for(const row of filePins(body)){if(!row.path.startsWith('cue-input/')||!v39Integration002ArtifactPathAllowed(row.path)||row.bytes>33554432)fail('V39_002_CUE_INPUT_SOURCE_REF');
  const fixed={path:row.path,bytes:row.bytes,sha256:row.sha256},old=refs.get(row.path);if(old&&!equal(old,fixed))fail('V39_002_CUE_INPUT_REF_CONFLICT');refs.set(row.path,fixed);}
 if(!refs.size||refs.size>2048)fail('V39_002_CUE_INPUT_SOURCE_REFS');return [...refs.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
export function bindV39Integration002CueInputProof(proof,raw){canonical(proof);if(!pinValid(proof?.cueInputFormats?.raw)
 ||!equal(pin(raw),{bytes:proof.cueInputFormats.raw.bytes,sha256:proof.cueInputFormats.raw.sha256}))fail('V39_002_CUE_INPUT_RAW_PIN');
 return {...proof,cueInputFormats:{...proof.cueInputFormats,sourceRefs:v39Integration002CueInputSourceRefs(raw)}};}
export function validateV39Integration002CueInputFormats(record,raw,lookup){
 try{const body=cueInputBody(raw);keys(record,['raw','inputDemuxers','completeInputProfiles','actualOutputEncoderTagQualificationGranted','physicalClosure','sourceRefs'],'V39_002_CUE_INPUT_FIELDS');
  if(!pinValid(record.raw)||record.raw.path!=='cue-input/input-formats.json'||!equal(pin(raw),{bytes:record.raw.bytes,sha256:record.raw.sha256})
   ||!equal(record.inputDemuxers,cueInputDemuxers)||record.completeInputProfiles!==18||record.actualOutputEncoderTagQualificationGranted!==false
   ||!equal(record.sourceRefs,v39Integration002CueInputSourceRefs(raw)))return false;
  keys(body,['schema','source','facts','profiles','operations','actualOutputEncoderTagQualificationGranted','actualSourceQualificationGranted','physicalClosure'],'V39_002_CUE_INPUT_BODY');
  if(body.schema!=='musicbridge.v39.cue-input-formats.evidence.v1'||!pinValid(body.source)||!positive(body.source.bytes)||body.source.bytes>33554432
   ||body.actualOutputEncoderTagQualificationGranted!==false||body.actualSourceQualificationGranted!==false||!Array.isArray(body.profiles)
   ||!equal(body.profiles.map(row=>row.id),cueInputProfiles.map(row=>row[0])))return false;
  const facts=body.facts;keys(facts,['scope','readerMs','sourceBytesLimit','cueManifest','tagsManifest',...cuePreparedProfiles.map(id=>id+'-preparation'),
   'sevenDemuxersAndEightInputFamiliesPassed','float64IsInputDecoderOnly','multiFile','pureGroupBoundaries','closedRefusals','failedAudioClosedAndNextValidInputRead'],'V39_002_CUE_INPUT_FACTS');
  if(facts.scope!=='SYNTHETIC_REAL_INPUT_PROBE_AND_DECODE_ONLY_NOT_APP_OR_OUTPUT_QUALIFICATION'||facts.readerMs!==3000||facts.sourceBytesLimit!==33554432
   ||!pinValid(facts.cueManifest)||!pinValid(facts.tagsManifest)||facts.sevenDemuxersAndEightInputFamiliesPassed!==true
   ||facts.float64IsInputDecoderOnly!==true||facts.failedAudioClosedAndNextValidInputRead!==true)return false;
  const rawRef=row=>{keys(row,['path','bytes','sha256','stdout','stderr'],'V39_002_CUE_INPUT_RUN');return pinValid(row)&&positive(row.bytes)&&row.bytes<=cap
   &&['stdout','stderr'].every(key=>pinValid(row[key])&&row[key].bytes<=cap);};
  for(let i=0;i<body.profiles.length;i++){const row=body.profiles[i],expected=cueInputProfiles[i];
   keys(row,['id','demuxer','profile','input','decoded','expectedFrames','actualFrames','sampleRate','channels','codec','sampleFormat','bitsPerSample','eof','probe','decode','exactPcm','snrDb','sourceUnchanged'],'V39_002_CUE_INPUT_PROFILE');
   const lossy=['mp3-s24','vorbis-s24','opus-s24'].includes(row.id);
   if(!equal([row.id,row.demuxer,row.profile,row.codec,row.sampleFormat,row.bitsPerSample],expected)||!pinValid(row.input)||!positive(row.input.bytes)
    ||!pinValid(row.decoded)||row.decoded.bytes!==96000*2*4||row.input.path===row.decoded.path||row.expectedFrames!==96000||row.actualFrames!==96000
    ||row.sampleRate!==48000||row.channels!==2||row.eof!==true||row.sourceUnchanged!==true||!rawRef(row.probe)||!rawRef(row.decode)
    ||row.exactPcm!==!lossy||(lossy?(!Number.isFinite(row.snrDb)||row.snrDb<18):row.snrDb!==null))return false;}
  const get=id=>body.profiles.find(row=>row.id===id);
  for(const [id,original]of [['same-stem-wav','pcm-wav-s24'],['same-stem-flac','flac-s24']]){const row=get(id),base=get(original);
   if(row.input.path===base.input.path||!equal(without(row.input,['path']),without(base.input,['path']))||!equal(without(row.decoded,['path']),without(base.decoded,['path'])))return false;}
  if(path.posix.parse(get('same-stem-wav').input.path).name!==path.posix.parse(get('same-stem-flac').input.path).name)return false;
  const multi=facts.multiFile;keys(multi,['cueSha256','sourceBindings','ranges'],'V39_002_CUE_INPUT_MULTI');
  if(!sha256(multi.cueSha256)||!Array.isArray(multi.sourceBindings)||multi.sourceBindings.length!==3||!Array.isArray(multi.ranges)||multi.ranges.length!==3)return false;
  for(let i=0;i<3;i++){const binding=multi.sourceBindings[i],media=get(i<2?'same-stem-wav':'same-stem-flac');
   const revision=hash(Buffer.from(JSON.stringify({source:media.input,probe:media.probe,decoded:media.decoded})));
   if(!equal(binding,{itemId:'cue-item-album-multi-'+(i+1),albumId:'album-multi',sourceAssetId:i<2?'asset-same-stem-wav':'asset-same-stem-flac',
     libraryRootId:'library-cue-input',sourceRootId:'source-cue-input',sourceReadRevision:revision}))return false;
   const range=multi.ranges[i];keys(range,['startFrame','frameCount','outputName'],'V39_002_CUE_INPUT_RANGE');
   if(range.startFrame!==[0,49280,1280][i]||range.frameCount!==[49280,46720,94720][i]||typeof range.outputName!=='string'
    ||!relative(range.outputName)||range.outputName.includes('/'))return false;}
  if(new Set(multi.ranges.map(row=>row.outputName)).size!==3||!multi.ranges.some(row=>/[^\x00-\x7f]/u.test(row.outputName)))return false;
  const group=facts.pureGroupBoundaries;keys(group,['albums','tracksPerAlbum','completeOutputs','filesLimit','acceptedBytes','rejectedBytes','executed9900Outputs','snapshotBudgetRaised'],'V39_002_CUE_INPUT_GROUP');
  if(group.albums!==100||group.tracksPerAlbum!==99||group.completeOutputs!==9900||group.filesLimit!==32||!positive(group.acceptedBytes)
   ||group.acceptedBytes>33554432||!positive(group.rejectedBytes)||group.rejectedBytes<=33554432||group.executed9900Outputs!==false||group.snapshotBudgetRaised!==false)return false;
  keys(facts.closedRefusals,['fakeNativeBrand','fakeOutputQualification','weakShape','alteredRevisions','paths','nonIndependentTarget','actualSameFileTargetRejectedBeforeNativeSpawn','originalPreserved'],'V39_002_CUE_INPUT_REFUSALS');
  if(!Object.values(facts.closedRefusals).every(value=>value===true))return false;
  const labels=[...cuePreparedProfiles.map(id=>id+'-prepare'),...cueInputProfiles.flatMap(row=>[row[0]+'-probe',row[0]+'-decode']),
   'same-file-target','bad-input-probe','bad-input-decode','after-failure-valid-probe'];
  if(!Array.isArray(body.operations)||!equal(body.operations.map(row=>row.label).sort(),labels.sort()))return false;
  for(const op of body.operations){keys(op,['label',...(op.label==='same-file-target'?[]:['raw']),'sourceBefore','sourceAfter','fdsClosed','namespaceState','actualCombinedResourceSnapshot'],'V39_002_CUE_INPUT_OPERATION');
   if(!pinValid(op.sourceBefore)||!equal(op.sourceBefore,op.sourceAfter)||op.fdsClosed!==true||op.namespaceState!=='released'
    ||!equal(op.actualCombinedResourceSnapshot,cueInputZero)||op.label!=='same-file-target'&&!rawRef(op.raw))return false;
   const media=body.profiles.find(row=>op.label===row.id+'-probe'||op.label===row.id+'-decode');
   if(media&&(!equal(op.sourceBefore,media.input)||!equal(op.raw,op.label.endsWith('-probe')?media.probe:media.decode)))return false;
   if(op.label.endsWith('-prepare')&&(!equal(op.sourceBefore,body.source)||!equal(op.raw,facts[op.label.replace(/-prepare$/u,'-preparation')])))return false;}
  keys(body.physicalClosure,['fdsClosed','processesClosed','claimsReleased','actualResourceSnapshot','observedPidsAbsent'],'V39_002_CUE_INPUT_CLOSURE');
  if(!equal(record.physicalClosure,body.physicalClosure)||!['fdsClosed','processesClosed','claimsReleased'].every(key=>body.physicalClosure[key]===true)
   ||!equal(body.physicalClosure.actualResourceSnapshot,cueInputZero)||body.physicalClosure.observedPidsAbsent!==labels.length-1)return false;
  if(lookup){proofFiles(body,lookup);proofFiles(record,lookup);}return true;
 }catch{return false;}}
function validateV39Integration002RareInputs(proof){
 const ordinary='bbbf3baab8a5dc22f0ccabe9c9e753a0ec5a58713d6eab66ea37813498a1625a',mpc='34f5b6601130398b4dd9a44a820c92a954f343cb6eac3deb37661cee6d79b16a';
 const expected=[
  ['ape','ape','ape','s16p',88200,92,'b4d4e23ee608da258989f3e70c4be37f7a31aa181cadd9acbf916d0947aad817',ordinary,'synthetic-silence-44100-s16-stereo.ape'],
  ['tta','tta','tta','s16',88200,22340,'ca8d9aeb8dc9263b3626f92889b9b83bb717a04de736df9bcf54df89d2e44ff1',ordinary,'synthetic-silence-44100-s16-stereo.tta'],
  ['mpc7','mpc','musepack7','s16p',88704,296,'c29d774d9b41a528e18d97f8fe93ee0f1cd3491a44be01a2c945212eb788ca53',mpc,'synthetic-zero-bands-sv7.mpc'],
  ['mpc8','mpc8','musepack8','s16p',88704,329,'21a69cd960c73dd700fbb84dfd6fbf68d6483bb733fcdadea6626b2c5319d1bf',mpc,'synthetic-zero-bands-sv8.mpc'],
  ['tak','tak','tak','s16p',88200,702,'7f75925778cc641df2e94d40c030d59a08957a932bcd3bffcaf8fc3c9b85b0d2',ordinary,'synthetic-zero-residuals-44100-s16-stereo.tak']];
 const labels=['source-probe','source-decode','flac-encode','tags-write','tags-read','flac-probe','flac-decode'];
 const tagValues={TITLE:'合成冷门编码静音：雪と花',ARTIST:'合成艺术家 Δ',ALBUM:'独立FLAC回退：测试',DATE:'2026',DISCNUMBER:'2',TRACKNUMBER:'3',
  LYRICS:'[00:00.00]中文歌词\n[00:00.25]日本語の歌詞\n',PICTURE:'5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15'};
 const statKeys=['dev','ino','size','mode','nlink','uid','gid','mtimeNs','ctimeNs'];
 const stat=row=>{keys(row,statKeys,'V39_002_RARE_STAT');return statKeys.every(key=>typeof row[key]==='string'&&/^\d+$/u.test(row[key]))
  &&row.mode==='33152'&&row.nlink==='1'&&BigInt(row.dev)>0n&&BigInt(row.ino)>0n;};
 const evidence=(row,file,bytes,sha)=>pinValid(row)&&row.path===file&&(bytes===null||row.bytes===bytes)&&(sha===null||row.sha256===sha);
 const raw=(row,prefix,label)=>{keys(row,['path','bytes','sha256','stdout','stderr'],'V39_002_RARE_RAW');
  return evidence(row,prefix+label+'.json',null,null)&&positive(row.bytes)&&row.bytes<=cap
   &&['stdout','stderr'].every(key=>evidence(row[key],prefix+label+'.'+key+'.log',null,null)&&row[key].bytes<=cap);};
 if(!Array.isArray(proof.rareInputs)||proof.rareInputs.length!==5||!equal(proof.rareInputs.map(row=>row.id),expected.map(row=>row[0])))return false;
 for(let index=0;index<expected.length;index++){
  const row=proof.rareInputs[index],[id,demuxer,codec,sampleFormat,frames,bytes,sourceSha,pcmSha,file]=expected[index],prefix='cue/rare-inputs/'+id+'/';
  keys(row,['id','demuxer','codec','sampleFormat','bitsPerSample','expectedFrames','decodedFrames','eof','sampleRate','channels','input','inputAfter',
   'sourceStatBefore','sourceStatAfter','sourceUnchanged','oracle','decoded','exactPcm','output','outputDecoded','flac','tagsExpected','tagsActual','operations','physicalClosure','raw'],'V39_002_RARE_FIELDS');
  if(!equal([row.id,row.demuxer,row.codec,row.sampleFormat,row.bitsPerSample],[id,demuxer,codec,sampleFormat,16])
   ||row.expectedFrames!==frames||row.decodedFrames!==frames||row.eof!==true||row.sampleRate!==44100||row.channels!==2||row.sourceUnchanged!==true||row.exactPcm!==true
   ||!evidence(row.input,prefix+file,bytes,sourceSha)||!equal(row.inputAfter,row.input)||!stat(row.sourceStatBefore)||!stat(row.sourceStatAfter)
   ||!equal(row.sourceStatBefore,row.sourceStatAfter)||row.sourceStatBefore.size!==String(bytes))return false;
  keys(row.oracle,['path','bytes','sha256','encoding','origin','nativeDecoded'],'V39_002_RARE_ORACLE');
  if(row.oracle.encoding!=='s32le'||row.oracle.origin!=='mathematical-synthetic-zero-pcm'||row.oracle.nativeDecoded!==false
   ||!evidence(row.oracle,prefix+'oracle-zero.s32le',frames*8,pcmSha)||!evidence(row.decoded,prefix+'source-decoded.s32le',frames*8,pcmSha)
   ||!evidence(row.outputDecoded,prefix+'flac-decoded.s32le',frames*8,pcmSha)||!evidence(row.output,prefix+'独立回退.flac',null,null)||!positive(row.output.bytes)
   ||row.output.bytes>33554432||!equal(row.flac,{format:'flac',profile:'s24',codec:'flac',sampleFormat:'s32',bitsPerSample:24,frames,decodedFrames:frames,sampleRate:44100,channels:2,eof:true,exactPcm:true})
   ||!equal(row.tagsExpected,tagValues)||!equal(row.tagsActual,tagValues)||!Array.isArray(row.operations)||!equal(row.operations.map(op=>op.label),labels))return false;
  for(const op of row.operations){
   keys(op,['label','exitCode','signal','pid','pidClosed','pidObservedAbsent','raw','freshSourceFd','sourceFdClosed','actorFdsClosed','sourceBefore','sourceAfter','sourceStatBefore','sourceStatAfter'],'V39_002_RARE_OPERATION');
   if(op.exitCode!==0||op.signal!==null||!positive(op.pid)||op.pidClosed!==true||op.pidObservedAbsent!==true||op.freshSourceFd!==true||op.sourceFdClosed!==true
    ||op.actorFdsClosed!==(op.label.startsWith('tags-')?true:null)||!raw(op.raw,prefix,op.label)||!pinValid(op.sourceBefore)||!pinValid(op.sourceAfter)
    ||!stat(op.sourceStatBefore)||!stat(op.sourceStatAfter)||!['dev','ino','mode','nlink','uid','gid'].every(key=>op.sourceStatBefore[key]===op.sourceStatAfter[key]))return false;
   if(['source-probe','source-decode','flac-encode'].includes(op.label)&&(!equal(op.sourceBefore,row.input)||!equal(op.sourceStatBefore,row.sourceStatBefore)))return false;
   if(op.label==='tags-write'){
    if(op.sourceBefore.path!==prefix+'flac-before-tags.flac'||op.sourceBefore.bytes!==Number(op.sourceStatBefore.size)||op.sourceAfter.path!==row.output.path||!equal(op.sourceAfter,row.output))return false;
   }else{
    if(!equal(op.sourceBefore,op.sourceAfter)||!equal(op.sourceStatBefore,op.sourceStatAfter))return false;
    if(['tags-read','flac-probe','flac-decode'].includes(op.label)&&!equal(op.sourceAfter,row.output))return false;
   }
  }
  const closure=row.physicalClosure;
  keys(closure,['fdsClosed','processesClosed','claimsReleased','revokedClaimsRejected','fdChecks','observedPidsAbsent','actorSnapshots','raw'],'V39_002_RARE_CLOSURE');
  const fdLabels=[...labels.map(label=>label+'-source'),'source-anchor','source-decoded-target','flac-target','flac-decoded-target'].sort();
  if(!['fdsClosed','processesClosed','claimsReleased','revokedClaimsRejected'].every(key=>closure[key]===true)||closure.observedPidsAbsent!==7
   ||!Array.isArray(closure.fdChecks)||closure.fdChecks.length!==11||!equal(closure.fdChecks.map(fd=>fd.label).sort(),fdLabels)
   ||!closure.fdChecks.every(fd=>Number.isSafeInteger(fd.fd)&&fd.fd>=0&&fd.error==='EBADF')
   ||!evidence(closure.raw,prefix+'closure.json',null,null)||!evidence(row.raw,prefix+'proof.json',null,null))return false;
  keys(closure.actorSnapshots,['cue','tags'],'V39_002_RARE_ACTORS');
  for(const actor of Object.values(closure.actorSnapshots)){
   keys(actor,['closing','running','unverified','pids'],'V39_002_RARE_ACTOR');
   if(typeof actor.closing!=='boolean'||actor.running!==0||actor.unverified!==0||!equal(actor.pids,[]))return false;
  }
 }
 return true;
}
const normal504Prefix='cue-normal-scan-owner504/';
const normal504Families=freeze(['vorbis','opus','wavpack','ape','tta','mpc7','mpc8','tak']);
const normal504Case=V39_INTEGRATION_NATIVE_CASE_NAMES[2][0];
const normal504Zero=freeze({readers:0,writers:0,resources:0});
const normal504Uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const normal504Id=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u0020\u007f]/u.test(value);
function normal504Require(ok){if(!ok)fail('V39_002_NORMAL_CUE_OWNER_EVIDENCE');}
function normal504Bytes(ref,readBody){
 normal504Require(pinValid(ref)&&ref.bytes<=cap&&typeof readBody==='function');
 const bytes=readBody(ref);normal504Require(Buffer.isBuffer(bytes)&&equal(pin(bytes),{bytes:ref.bytes,sha256:ref.sha256}));return bytes;
}
function normal504Json(ref,readBody){const value=parse(normal504Bytes(ref,readBody));canonical(value);return value;}
function normal504Stat(value,size){const names=['dev','ino','size','mode','nlink','uid','gid','mtimeNs','ctimeNs'];keys(value,names,'V39_002_NORMAL_STAT');
 normal504Require(names.every(name=>typeof value[name]==='string'&&/^\d+$/u.test(value[name]))&&value.mode==='33152'&&value.nlink==='1'
  &&BigInt(value.dev)>0n&&BigInt(value.ino)>0n&&value.size===String(size));}
function normal504Absolute(value){return typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&!/[\u0000-\u001f\u007f\\]/u.test(value);}
function normal504Physical(row){keys(row,['path','dev','ino','birthtimeNs','mode','uid','gid'],'V39_002_NORMAL_DIRECTORY_PHYSICAL');
 normal504Require(normal504Absolute(row.path)&&['dev','ino','birthtimeNs','mode','uid','gid'].every(key=>typeof row[key]==='string'&&/^\d+$/u.test(row[key]))
  &&BigInt(row.dev)>0n&&BigInt(row.ino)>0n&&(BigInt(row.mode)&0o170000n)===0o040000n);}
/** 仅列出原504正文实际引用；完整Core图留在compiled artifact，不复制或执行它。 */
export function v39Integration002CueNormalScanBodyRefs(proof,readBody){
 const record=proof?.cueNormalScanEntry;normal504Require(object(record));
 const body=normal504Json(record.raw,readBody),owner=normal504Json(record.owner?.raw,readBody),inputs=normal504Json(body.inputs,readBody);
 const rows=[record.raw,record.sourceProof,record.currentBuild,record.ownerEntry,...filePins(record.owner),body.inputs,
  ...filePins(inputs),...filePins(body.results?.map(row=>row.outputs)),...filePins(body.verification),...filePins(body.pcmVerification),
  ...filePins(owner.authorInitializationFiles).filter(ref=>/\.(?:json|log)$/u.test(ref.path))];
 const refs=new Map();for(const ref of rows){normal504Require(pinValid(ref)&&ref.bytes<=cap);
  const prior=refs.get(ref.path);normal504Require(!prior||equal(prior,{path:ref.path,bytes:ref.bytes,sha256:ref.sha256}));
  refs.set(ref.path,{path:ref.path,bytes:ref.bytes,sha256:ref.sha256});}
 normal504Require(refs.size>0&&refs.size<=65512);return [...refs.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
/** 六参只提供普通文件原字节；JSON不启动作者、不恢复WeakSet或签Main/Native grant。 */
function validateV39Integration002CueNormalScanEntry(proof,source,scopeHash,lookup,readBody){
 try{
  const record=proof.cueNormalScanEntry;
  keys(record,['raw','sourceProof','currentBuild','ownerEntry','owner','sourceSha','scopeSha256','caseName','domain','inputFamilies','sameDatasetId',
   'libraryAlbums','libraryMembers','cueSources','outputTracks','sourceUnchanged','coldReadOnly','nativeQualificationReusedAcrossRun','physicalClosure'],'V39_002_NORMAL_RECORD');
  normal504Require(record.sourceSha===source&&record.scopeSha256===scopeHash&&record.caseName===normal504Case&&record.domain==='native'
   &&equal(record.inputFamilies,normal504Families)&&normal504Uuid(record.sameDatasetId)&&record.libraryAlbums===8&&record.libraryMembers===8
   &&record.cueSources===8&&record.outputTracks===16&&record.sourceUnchanged===true&&record.coldReadOnly===true&&record.nativeQualificationReusedAcrossRun===false
   &&equal(record.physicalClosure,{ownerNaturalExit:true,actualCombinedTable:normal504Zero,mainSourcePortClosed:true}));
  for(const [key,name]of [['raw','normal-scan-entry.json'],['sourceProof','case1-source-proof.json'],['currentBuild','current-core-binding.json'],['ownerEntry','actual-owner-entry.mjs']])
   normal504Require(pinValid(record[key])&&record[key].path===normal504Prefix+name&&positive(record[key].bytes));
  keys(record.owner,['raw','stdout','stderr','exitCode'],'V39_002_NORMAL_OWNER');normal504Require(record.owner.exitCode===0);
  for(const [key,name]of [['raw','actual-owner-raw.json'],['stdout','owner.stdout.log'],['stderr','owner.stderr.log']])normal504Require(record.owner[key]?.path===normal504Prefix+name);
  const body=normal504Json(record.raw,readBody);
  keys(body,['schema','sourceSha','scopeSha256','caseName','domain','sourceProof','currentBuild','ownerEntry','inputs','owner','originalCaptureScope','flights',
   'results','verification','pcmVerification','directoryRequests','directoryFdChecks','producerErrors','cold','physical','qualifier'],'V39_002_NORMAL_BODY');
  normal504Require(body.schema==='musicbridge.v39.cue-normal-scan-owner504.evidence.v1'&&body.sourceSha===source&&body.scopeSha256===scopeHash
   &&body.caseName===normal504Case&&body.domain==='native'&&body.originalCaptureScope==='8完整专辑/8物理成员/8真实CUE/16声明轨；非Electron Main资格'
   &&['sourceProof','currentBuild','ownerEntry','owner'].every(key=>equal(body[key],record[key]))&&equal(body.producerErrors,[])
   &&equal(body.qualifier,{inputOrigin:'本次case1真实资格pins',warmOwnerFirstInitialization:'真实默认factory再次完成该新作者mandatory资格，不从JSON恢复WeakSet',crossRunQualification:false}));
  const original=normal504Json(record.sourceProof,readBody);
  normal504Require(original.schema===proof.schema&&original.task===proof.task&&original.sourceSha===source&&original.scopeSha256===scopeHash
   &&original.platform==='darwin'&&original.architecture==='arm64'&&['bundles','formats','rareInputs','physicalClosure'].every(key=>equal(original[key],proof[key])));
  normal504Build(normal504Json(record.currentBuild,readBody),source,scopeHash);
  const entry=decode(normal504Bytes(record.ownerEntry,readBody));
  // 消费原entry正文与已核compiled图的路径声明；从不执行上传的JavaScript。
  const matches=[...entry.matchAll(/const urls = (\{[^\n]+\});/gu)];normal504Require(matches.length===1);
  const urls=JSON.parse(matches[0][1]);keys(urls,['worker','domain','locks'],'V39_002_NORMAL_ENTRY_URLS');
  const coreRoots=Object.entries(urls).map(([key,url])=>{normal504Require(typeof url==='string'&&url.startsWith('file:'));
   const absolute=fileURLToPath(url),tail={worker:'/dist/collection/dataset-owner-worker.js',domain:'/dist/collection/dataset-domain.js',locks:'/dist/stream/physical-resource-locks.js'}[key];
   normal504Require(normal504Absolute(absolute)&&absolute.endsWith(tail));return absolute.slice(0,-tail.length);});
  normal504Require(new Set(coreRoots).size===1&&coreRoots[0].endsWith('/packages/bridge-core')&&entry.includes('testMode: false')
   &&entry.includes('domain = await prepareOwnedDatasetDomain(')&&entry.includes('assert.equal(++factoryCount, 1)')
   &&entry.includes('attachDatasetOwnerWorkerPort(parentPort,')&&entry.includes('await originalClose('));
  const owner=normal504Json(record.owner.raw,readBody);
  keys(owner,['schema','testMode','factoryCount','ownerThreadId','factoryStartedNativeProcesses','sourcePortClosed','parentPortClosed','repositoryClosed','physical',
   'sqlRows','fds','processes','readerWorkers','phaseEvents','authorInitializationFiles','observations'],'V39_002_NORMAL_OWNER_BODY');
  normal504Require(owner.schema==='musicbridge.v39.cue-normal-owner504.raw.v1'&&owner.testMode===false&&owner.factoryCount===1
   &&positive(owner.ownerThreadId)&&positive(owner.factoryStartedNativeProcesses)&&owner.sourcePortClosed===true&&owner.parentPortClosed===true
   &&owner.repositoryClosed===true&&equal(owner.physical,normal504Zero)&&owner.observations==='只包装真实open/close/spawn并返回原对象，不替Native/Reader/prepare ACK。');
  normal504Require(Array.isArray(owner.fds)&&owner.fds.length>0);for(const [index,fd]of owner.fds.entries()){
   keys(fd,['serial','path','fd','phase','closed','error'],'V39_002_NORMAL_FD');normal504Require(fd.serial===index+1&&typeof fd.path==='string'
    &&Number.isSafeInteger(fd.fd)&&fd.fd>=0&&typeof fd.phase==='string'&&fd.closed===true&&fd.error==='EBADF');}
  normal504Require(Array.isArray(owner.readerWorkers)&&owner.readerWorkers.length>=16);const tids=new Set([owner.ownerThreadId]);
  for(const worker of owner.readerWorkers){keys(worker,['entry','threadId','execArgv','exitObserved','exitCode'],'V39_002_NORMAL_READER_WORKER');
   normal504Require(typeof worker.entry==='string');
   const absolute=worker.entry.startsWith('file:')?fileURLToPath(worker.entry):worker.entry;
   normal504Require(normal504Absolute(absolute)&&['metadata-reader-worker.bundle.mjs','cue-sidecar-worker.js'].some(name=>absolute===coreRoots[0]+'/dist/library/'+name)
    &&(!worker.entry.startsWith('file:')||new URL(worker.entry).href===worker.entry&&!new URL(worker.entry).search&&!new URL(worker.entry).hash)
    &&positive(worker.threadId)&&!tids.has(worker.threadId)&&Array.isArray(worker.execArgv)&&worker.exitObserved===true&&worker.exitCode===0);tids.add(worker.threadId);}
  normal504Require(owner.readerWorkers.some(row=>row.entry.endsWith('metadata-reader-worker.bundle.mjs'))&&owner.readerWorkers.some(row=>row.entry.endsWith('cue-sidecar-worker.js')));
  normal504Require(Array.isArray(owner.processes)&&owner.processes.length>owner.factoryStartedNativeProcesses);const pids=new Set();
  for(const process of owner.processes){keys(process,['pid','executable','args','phase','closed','exitCode','signal','stdout','stderr','pidAbsent','groupAbsent'],'V39_002_NORMAL_PID');
   normal504Require(positive(process.pid)&&!pids.has(process.pid)&&normal504Absolute(process.executable)&&Array.isArray(process.args)&&process.args.every(arg=>typeof arg==='string')
    &&typeof process.phase==='string'&&process.closed===true&&process.exitCode===0&&process.signal===null&&process.pidAbsent===true&&process.groupAbsent===true);
   base64(process.stdout);base64(process.stderr);pids.add(process.pid);}
  normal504Require(owner.processes.filter(row=>row.phase==='owner-native-first-prepare').length===owner.factoryStartedNativeProcesses);
  normal504Require(Array.isArray(owner.phaseEvents)&&owner.phaseEvents.length>1);const initialization=owner.phaseEvents[0];
  keys(initialization,['phase','began','finished','datasetId','epoch','actualFactoryNativeProcesses'],'V39_002_NORMAL_FACTORY_EVENT');
  normal504Require(initialization.phase==='owner-native-first-prepare'&&positive(initialization.began)&&initialization.finished>=initialization.began
   &&initialization.datasetId===record.sameDatasetId&&normal504Uuid(initialization.epoch)&&initialization.actualFactoryNativeProcesses===owner.factoryStartedNativeProcesses);
  normal504Require(Array.isArray(owner.authorInitializationFiles)&&owner.authorInitializationFiles.length>14);
  const initPaths=new Set();for(const ref of owner.authorInitializationFiles){keys(ref,['path','bytes','sha256'],'V39_002_NORMAL_INIT_PIN');
   normal504Require(pinValid(ref)&&ref.path.startsWith(normal504Prefix+'唯一Owner资料/')&&ref.path.includes('/cue-qualification-'+initialization.epoch+'/')&&!initPaths.has(ref.path));initPaths.add(ref.path);}
  normal504Require(['ape','tta','mpc7','mpc8','tak'].every(id=>[...initPaths].some(name=>name.includes('/cue/rare-inputs/'+id+'/proof.json'))));
  keys(body.cold,['nativeReinitialized','previewOrApply','sameDatasetId','rows'],'V39_002_NORMAL_COLD');
  normal504Require(body.cold.nativeReinitialized===false&&body.cold.previewOrApply===false&&body.cold.sameDatasetId===record.sameDatasetId&&equal(body.cold.rows,owner.sqlRows));
  keys(body.physical,['actualCombinedTable','sourcePortCloseEvents','admission','verifierFdChecks'],'V39_002_NORMAL_PHYSICAL');
  normal504Require(equal(body.physical.actualCombinedTable,normal504Zero)&&equal(body.physical.sourcePortCloseEvents,['main-source'])
   &&equal(body.physical.admission,{permits:0,revoked:0,watches:0,timers:0,closed:true})&&body.physical.verifierFdChecks===64);
  normal504Require(body.inputs?.path===normal504Prefix+'original-copy-inputs.json');const inputs=normal504Json(body.inputs,readBody);
  normal504Require(Array.isArray(inputs)&&inputs.length===8&&equal(inputs.map(row=>row.id),normal504Families));
  const mediaRoots=new Set();for(const input of inputs){keys(input,['id','input','copy','cue','copyStat','cueStat'],'V39_002_NORMAL_INPUT');
   const known=['vorbis','opus','wavpack'].includes(input.id)?original.formats.find(row=>row.id===input.id)?.output:original.rareInputs.find(row=>row.id===input.id)?.input;
   normal504Require(equal(input.input,known)&&pinValid(input.copy)&&equal({bytes:input.copy.bytes,sha256:input.copy.sha256},{bytes:known.bytes,sha256:known.sha256})
    &&input.copy.path.startsWith(normal504Prefix+'原中文音乐库/正常源-'+input.id+'/原音频')&&path.extname(input.copy.path)===path.extname(known.path)
    &&pinValid(input.cue)&&input.cue.path===path.posix.dirname(input.copy.path)+'/原索引.cue');
   const audioName=path.posix.basename(input.copy.path),cue='TITLE "正常源-'+input.id+'"\nPERFORMER "自有艺术家 Δ"\nFILE "'+audioName+'" WAVE\n  TRACK 01 AUDIO\n    TITLE "第一曲：雪"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "第二曲：花"\n    INDEX 01 00:00:15\n';
   normal504Require(normal504Bytes(input.cue,readBody).equals(Buffer.from(cue)));normal504Stat(input.copyStat,input.copy.bytes);normal504Stat(input.cueStat,input.cue.bytes);
   mediaRoots.add(path.posix.dirname(path.posix.dirname(input.copy.path)));}
  normal504Require(mediaRoots.size===1&&Array.isArray(body.results)&&body.results.length===8&&equal(body.results.map(row=>row.id).sort(),[...normal504Families].sort()));
  normal504Flights(body.flights,body.results,owner.phaseEvents.slice(1));
  const commandIds=new Set(),planIds=new Set(),albumIds=new Set(),outputPaths=new Set(),rootPaths=new Set();
  for(const result of body.results){keys(result,['id','source','demuxer','outputDirectory','expectedOutput','request','plan','capture','receipt','outputs'],'V39_002_NORMAL_RESULT');
   const sourceInput=inputs.find(row=>row.id===result.id),spec=['vorbis','opus','wavpack'].includes(result.id)?original.formats.find(row=>row.id===result.id):original.rareInputs.find(row=>row.id===result.id);
   const rate=spec.sampleRate,frames=spec.expectedFrames,codec=['vorbis','opus','wavpack'].includes(result.id)?result.id:'flac',demuxer={vorbis:'ogg',opus:'ogg',wavpack:'wv',mpc7:'mpc',mpc8:'mpc8'}[result.id]??result.id;
   normal504Require(positive(rate)&&positive(frames)&&spec.channels===2&&result.expectedOutput===codec&&result.demuxer===demuxer
    &&normal504Absolute(result.source)&&normal504Absolute(result.outputDirectory)&&result.source.endsWith('/'+sourceInput.copy.path)
    &&result.outputDirectory.endsWith('/'+normal504Prefix+'独立分轨-'+result.id));
   const root=result.source.slice(0,-sourceInput.copy.path.length);normal504Require(result.outputDirectory.startsWith(root));rootPaths.add(root);
   const {request,plan,capture,receipt}=result;
   keys(request,['commandId','datasetId','planId','kind','expectedRevision','planHash','contextFingerprint'],'V39_002_NORMAL_REQUEST');
   normal504Require(normal504Uuid(request.commandId)&&!commandIds.has(request.commandId)&&request.datasetId===record.sameDatasetId&&request.kind==='cue'
    &&request.planId===plan.planId&&request.expectedRevision===plan.revision&&request.planHash===plan.planHash&&request.contextFingerprint===plan.contextFingerprint);commandIds.add(request.commandId);
   keys(plan,['kind','scope','datasetId','planId','revision','planHash','contextFingerprint','expiresAt','albumIds','state','blockers','items','sourceDisposition','target','tracks'],'V39_002_NORMAL_PLAN');
   normal504Require(plan.kind==='cue'&&plan.scope==='INDEPENDENT_OUTPUT'&&plan.datasetId===record.sameDatasetId&&normal504Uuid(plan.planId)&&!planIds.has(plan.planId)
    &&plan.revision==='1'&&plan.state==='ready'&&equal(plan.blockers,[])&&plan.sourceDisposition==='retain'&&sha256(plan.planHash)&&sha256(plan.contextFingerprint)
    &&plan.planHash===hash(canonical(without(plan,['planHash'])))&&plan.contextFingerprint===hash(canonical(capture))
    &&typeof plan.expiresAt==='string'&&Number.isFinite(Date.parse(plan.expiresAt))&&Array.isArray(plan.albumIds)&&plan.albumIds.length===1&&!albumIds.has(plan.albumIds[0])
    &&Array.isArray(plan.items)&&plan.items.length===2&&Array.isArray(plan.tracks)&&plan.tracks.length===2);planIds.add(plan.planId);albumIds.add(plan.albumIds[0]);
   keys(plan.target,['choiceId','label','independent'],'V39_002_NORMAL_TARGET');normal504Require(normal504Uuid(plan.target.choiceId)&&plan.target.independent===true&&plan.target.label==='自有独立输出-'+result.id);
   normal504Require(capture.datasetId===record.sameDatasetId&&capture.albums?.length===1&&capture.albums[0].albumId===plan.albumIds[0]
    &&capture.albums[0].members?.length===1&&capture.audio?.length===1&&capture.cueOutputs?.length===2&&capture.cueSheets?.length===1
    &&capture.format?.codec===codec&&capture.format.available===true&&capture.format.evidence==='encoder-tag-audio-roundtrip'
    &&capture.target?.choiceId===plan.target.choiceId&&capture.target.independent===true);
   keys(capture,['datasetId','datasetRevision','albums','cueSheets','cueOutputs','audio','target','format'],'V39_002_NORMAL_CAPTURE');
   keys(capture.target,['choiceId','label','independent','revision'],'V39_002_NORMAL_CAPTURE_TARGET');
   keys(capture.format,['formatId','revision','codec','extension','lossless','evidence','available'],'V39_002_NORMAL_FORMAT');
   normal504Require(capture.target.label===plan.target.label&&normal504Id(capture.target.revision)&&capture.format.formatId===codec&&typeof capture.format.lossless==='boolean');
   const audio=capture.audio[0],member=capture.albums[0].members[0];normal504Require(audio.evidence==='audio-pcm-read'&&audio.sampleRate===rate&&audio.totalPcmFrames===frames
    &&audio.assetReference.assetId===member.assetId&&audio.assetReference.libraryRootId===capture.albums[0].rootId);
   const names=new Set();for(const [index,track]of plan.tracks.entries()){
    keys(track,['itemId','albumId','label','changes','sequence','sourceLabel','startFrame','frameCount','sampleRate','outputName','outputFormat'],'V39_002_NORMAL_TRACK');
    normal504Require(track.albumId===plan.albumIds[0]&&normal504Id(track.itemId)&&track.sequence===index+1&&track.sampleRate===rate&&track.outputFormat===capture.format.formatId
     &&track.startFrame===(index?rate/5:0)&&track.frameCount===(index?frames-rate/5:rate/5)&&positive(track.frameCount)
     &&typeof track.outputName==='string'&&relative(track.outputName)&&!track.outputName.includes('/')&&!names.has(track.outputName.normalize('NFC').toLowerCase())
     &&equal(plan.items[index],{itemId:track.itemId,albumId:track.albumId,label:track.label,changes:track.changes}));names.add(track.outputName.normalize('NFC').toLowerCase());
    const binding=capture.cueOutputs[index];normal504Require(binding.itemId===track.itemId&&binding.albumId===track.albumId&&binding.sourceAssetId===member.assetId
     &&binding.libraryRootId===audio.assetReference.libraryRootId&&binding.sourceRootId===audio.assetReference.sourceRootId&&binding.sourceReadRevision===audio.readRevision);
   }
   keys(receipt,['commandId','datasetId','planId','planHash','state','items','message'],'V39_002_NORMAL_RECEIPT');normal504Require(receipt.commandId===request.commandId&&receipt.datasetId===request.datasetId
    &&receipt.planId===request.planId&&receipt.planHash===request.planHash&&receipt.state==='succeeded'&&Array.isArray(receipt.items)&&receipt.items.length===2
    &&receipt.items.every((item,index)=>{keys(item,['itemId','albumId','label','state','message'],'V39_002_NORMAL_RECEIPT_ITEM');return item.itemId===plan.items[index].itemId&&item.albumId===plan.items[index].albumId&&item.state==='applied';}));
   normal504Require(Array.isArray(result.outputs)&&result.outputs.length===2);for(const [index,output]of result.outputs.entries()){
    normal504Require(pinValid(output)&&positive(output.bytes)&&output.path===normal504Prefix+'独立分轨-'+result.id+'/'+plan.tracks[index].outputName&&!outputPaths.has(output.path));outputPaths.add(output.path);}
  }
  normal504Require(rootPaths.size===1&&outputPaths.size===16);
  normal504Directory(body,record.sameDatasetId,initialization.epoch,body.results,[...rootPaths][0]);
  normal504Sql(body.cold.rows,record.sameDatasetId,body.results,inputs);
  normal504Verification(body.verification,body.results,readBody);
  normal504Pcm(body.pcmVerification,body.results,original,readBody);
  for(const ref of v39Integration002CueNormalScanBodyRefs(proof,readBody)){normal504Require(typeof lookup==='function'&&lookup(ref));normal504Bytes(ref,readBody);}
  return true;
 }catch{return false;}
}
function normal504Build(build,source,scopeHash){
 keys(build,['readerBinding','cueBinding','preparation','currentOutputs'],'V39_002_NORMAL_BUILD');const {readerBinding:reader,cueBinding:cue,preparation:p}=build;
 for(const value of [reader,cue])normal504Require(['whole-source-standard-run','fresh-native-preparation-run'].includes(value.timeBasis)&&value.sourceSha===source
  &&value.scopeSha256===scopeHash&&value.compilerExit===0&&positive(value.compilerStartedAtMs)&&Number.isSafeInteger(value.compilerFinishedAtMs)
  &&value.compilerFinishedAtMs>=value.compilerStartedAtMs&&value.originalSingleCompilerIntervalsRetained===true);
 normal504Require(reader.schema==='mbrs003.reader.fresh-build.v2'&&cue.schema==='mbrs003.cue.fresh-build.v1'&&reader.timeBasis===cue.timeBasis
  &&reader.compilerStartedAtMs===cue.compilerStartedAtMs&&reader.compilerFinishedAtMs===cue.compilerFinishedAtMs&&equal(reader.originalPreparationReceipt,cue.originalPreparationReceipt));
 const receipt=reader.originalPreparationReceipt;keys(receipt,['path','bytes','sha256'],'V39_002_NORMAL_PREPARATION_PIN');normal504Require(normal504Absolute(receipt.path)&&positive(receipt.bytes)&&sha256(receipt.sha256));
 keys(p,['schema','status','sourceInputs','toolInputs','outputs','stages','readerBindingSha256','inputsUnchanged','outputsUnchanged'],'V39_002_NORMAL_PREPARATION');
 normal504Require(p.schema==='core-test.reader-preparation.v1'&&p.status==='FRESH_READER_PREPARED'&&p.inputsUnchanged===true&&p.outputsUnchanged===true&&sha256(p.readerBindingSha256)
  &&Array.isArray(p.stages)&&equal(p.stages.map(row=>row.name),['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker']));
 // 原receipt通过currentBuild保留原pretty-JSON字节，不能伪写另一份格式或pin。
 const receiptBytes=Buffer.from(JSON.stringify(p,null,2)+'\n');normal504Require(equal(pin(receiptBytes),{bytes:receipt.bytes,sha256:receipt.sha256}));
 for(const [index,stage]of p.stages.entries()){keys(stage,['name','compilerExit','startedMs','finishedMs'],'V39_002_NORMAL_STAGE');
  normal504Require(stage.compilerExit===0&&positive(stage.startedMs)&&Number.isSafeInteger(stage.finishedMs)&&stage.finishedMs>=stage.startedMs
   &&stage.startedMs>=reader.compilerStartedAtMs&&stage.finishedMs<=reader.compilerFinishedAtMs&&(!index||stage.startedMs>=p.stages[index-1].finishedMs));}
 if(reader.timeBasis==='fresh-native-preparation-run')normal504Require(reader.compilerStartedAtMs===p.stages[0].startedMs&&reader.compilerFinishedAtMs===p.stages[2].finishedMs);
 normal504Require(Array.isArray(p.sourceInputs)&&p.sourceInputs.length>0&&new Set(p.sourceInputs.map(row=>row.path)).size===p.sourceInputs.length);
 for(const row of p.sourceInputs){keys(row,['path','bytes','sha256'],'V39_002_NORMAL_SOURCE_PIN');normal504Require(pinValid(row)&&positive(row.bytes));}
 normal504Require(p.sourceInputs.some(row=>row.path==='scripts/ci/run-core-tests.mjs'));
 normal504Require(Array.isArray(p.toolInputs)&&p.toolInputs.length===4&&new Set(p.toolInputs.map(row=>row.file)).size===4);
 for(const tool of p.toolInputs){keys(tool,['file','bytes','sha256'],'V39_002_NORMAL_TOOL_PIN');normal504Require(normal504Absolute(tool.file)&&positive(tool.bytes)&&sha256(tool.sha256));}
 normal504Require(equal(p.toolInputs.map(row=>path.basename(row.file)).sort(),['_tsc.js','package.json','tsc','tsc.js'].sort()));
 const compiled=p.sourceInputs.filter(row=>/^packages\/(?:contracts|bridge-core)\/src\//u.test(row.path)&&row.path.endsWith('.ts')&&!row.path.endsWith('.d.ts')),
  fixed=['.mjs','.mjs.map','.meta.json','.build.json'].map(suffix=>'packages/bridge-core/dist/library/metadata-reader-worker.bundle'+suffix),
  expected=[...compiled.flatMap(row=>['.js','.js.map','.d.ts'].map(suffix=>row.path.replace('/src/','/dist/').slice(0,-3)+suffix)),...fixed].sort();
 normal504Require(compiled.length>0&&Array.isArray(p.outputs)&&equal(p.outputs.map(row=>row.path).sort(),expected)&&new Set(expected).size===expected.length
  &&Array.isArray(build.currentOutputs)&&equal(build.currentOutputs.map(row=>row.path).sort(),expected));
 for(const output of p.outputs){const isFixed=fixed.includes(output.path),stage=p.stages[isFixed?2:output.path.startsWith('packages/contracts/')?0:1];
  keys(output,isFixed?['path','bytes','sha256','mtimeMs']:['path','bytes','sha256','mtimeMs','sourcePath','sourceSha256'],'V39_002_NORMAL_COMPILED_PIN');
  normal504Require(pinValid(output)&&positive(output.bytes)&&Number.isFinite(output.mtimeMs)&&output.mtimeMs>=stage.startedMs&&output.mtimeMs<=stage.finishedMs);
  if(!isFixed){const sourcePin=compiled.find(row=>row.path===output.sourcePath);normal504Require(sourcePin&&sourcePin.sha256===output.sourceSha256
    &&['.js','.js.map','.d.ts'].some(suffix=>sourcePin.path.replace('/src/','/dist/').slice(0,-3)+suffix===output.path));}
  const current=build.currentOutputs.find(row=>row.path===output.path);keys(current,['path','bytes','sha256'],'V39_002_NORMAL_CURRENT_OUTPUT');normal504Require(pinValid(current)&&positive(current.bytes));
  if(reader.timeBasis==='fresh-native-preparation-run'||!output.path.endsWith('.bundle.build.json'))normal504Require(equal(current,{path:output.path,bytes:output.bytes,sha256:output.sha256}));
 }
 for(const [binding,names]of [[reader,['src/recording/source-files.ts','src/library/metadata-reader.ts','src/library/metadata-reader-worker.ts','src/library/metadata-reader-types.ts']],
  [cue,['src/library/cue-sidecar-reader.ts','src/library/cue-sidecar-worker.ts']]]){
  normal504Require(Array.isArray(binding.sourceInputs)&&equal(binding.sourceInputs.map(row=>row.file).sort(),[...names].sort())&&Array.isArray(binding.outputs)
   &&equal(binding.outputs.map(row=>row.file).sort(),names.flatMap(file=>['.js','.js.map'].map(suffix=>file.replace(/^src\//u,'dist/').slice(0,-3)+suffix)).sort()));
  for(const row of [...binding.sourceInputs,...binding.outputs]){keys(row,['file','bytes','sha256'],'V39_002_NORMAL_BINDING_PIN');
   const origin=(row.file.startsWith('src/')?p.sourceInputs:p.outputs).find(item=>item.path==='packages/bridge-core/'+row.file);
   normal504Require(origin&&row.bytes===origin.bytes&&row.sha256===origin.sha256);}
 }
 normal504Require(reader.fixedWorkerBundle?.schema==='mbrs003.metadata-worker.fixed-bundle.v2'&&Number.isFinite(reader.fixedWorkerBundle.startedAtMs)
  &&Number.isFinite(reader.fixedWorkerBundle.finishedAtMs)&&reader.fixedWorkerBundle.finishedAtMs>=reader.fixedWorkerBundle.startedAtMs
  &&reader.fixedWorkerBundle.startedAtMs>=reader.compilerStartedAtMs&&reader.fixedWorkerBundle.finishedAtMs<=reader.compilerFinishedAtMs);
 for(const name of ['collection/dataset-owner-worker','collection/dataset-owner-client','collection/dataset-domain','collection/source-writes-authority','collection/repository','recording/backup-workflow-store','stream/physical-resource-locks'])
  normal504Require(compiled.some(row=>row.path==='packages/bridge-core/src/'+name+'.ts')&&['.js','.js.map','.d.ts'].every(suffix=>expected.includes('packages/bridge-core/dist/'+name+suffix)));
}
function normal504Flights(flights,results,events){
 const commands=['library.import.prepare','library.import.confirm','library.capture','library.albums.capture','capabilities.read','read.resolveCapture','cue.preparePreview','registry.issuePlan','registry.apply','registry.readOriginalReceipt'];
 normal504Require(Array.isArray(flights)&&flights.length>=37&&flights.length<=10000);const count=name=>flights.filter(row=>row.command===name);
 for(const flight of flights){keys(flight,['command','payload','value','elapsedMs'],'V39_002_NORMAL_FLIGHT');normal504Require(commands.includes(flight.command)&&object(flight.payload)
   &&Number.isFinite(flight.elapsedMs)&&flight.elapsedMs>=0&&flight.elapsedMs<2000);}
 for(const name of commands.slice(0,5))normal504Require(count(name).length===1);
 normal504Require(equal(flights.slice(0,5).map(row=>row.command),commands.slice(0,5)));
 const imported=count('library.import.confirm')[0],libraries=count('library.capture')[0],read=count('library.albums.capture')[0],libraryId=imported.value?.libraryIds?.[0];
 normal504Require(imported.value?.state==='succeeded'&&imported.value.libraryIds.length===1&&normal504Id(libraryId)
  &&equal(libraries.payload.libraryIds,[libraryId])&&equal(libraries.value.libraryIds,[libraryId])&&read.payload.albums?.length===8&&read.value.albums?.length===8
  &&count('capabilities.read')[0].value?.capabilities?.['cue-preview']?.available===true);
 for(const name of ['read.resolveCapture','cue.preparePreview','registry.issuePlan','registry.apply'])normal504Require(count(name).length===8);
 const calls=flights.filter(row=>!row.command.startsWith('library.'));normal504Require(Array.isArray(events)&&events.length===calls.length);
 for(const [index,event]of events.entries()){keys(event,['command','began','finished'],'V39_002_NORMAL_PHASE');normal504Require(event.command===calls[index].command
   &&positive(event.began)&&Number.isSafeInteger(event.finished)&&event.finished>=event.began&&event.finished-event.began<2000&&(!index||event.began>=events[index-1].finished));}
 for(const result of results){const issued=count('registry.issuePlan').filter(row=>row.value?.planId===result.plan.planId),applied=count('registry.apply').filter(row=>row.payload?.commandId===result.request.commandId);
  normal504Require(issued.length===1&&equal(issued[0].value,result.plan)&&equal(issued[0].payload.capture,result.capture)&&applied.length===1&&equal(applied[0].payload,result.request));
  normal504Require(equal(issued[0].payload.draft,without(result.plan,['datasetId','planId','revision','planHash','contextFingerprint','expiresAt'])));
  const album=read.value.albums.find(row=>row.album?.albumId===result.plan.albumIds[0]),resolved=count('read.resolveCapture').filter(row=>row.payload?.capture?.albumId===result.plan.albumIds[0]);
  normal504Require(album?.availability==='online'&&album.capture?.readToken===result.capture.albums[0].readToken&&album.album.rootId===libraryId
   &&album.cueSheets?.filter(row=>row.eligible===true).length===1&&album.cueSheets.find(row=>row.eligible===true).cueId===result.capture.cueSheets[0].cueId
   &&resolved.length===1&&resolved[0].payload.datasetId===result.request.datasetId&&equal(resolved[0].payload.capture,album.capture)&&equal(resolved[0].value.capture,result.capture.albums[0])
   &&resolved[0].value.datasetId===result.request.datasetId&&read.payload.albums.some(row=>row.albumId===album.album.albumId&&row.rootId===libraryId));
  const previews=count('cue.preparePreview').filter(row=>row.value?.capture?.target?.choiceId===result.plan.target.choiceId);normal504Require(previews.length===1&&equal(previews[0].value,issued[0].payload)
   &&previews[0].payload.request?.outputFormat==='auto'&&previews[0].payload.request.sourceDisposition==='retain'&&previews[0].payload.request.datasetId===result.request.datasetId
   &&equal(previews[0].payload.request.target,result.plan.target)&&previews[0].payload.request.captures?.length===1&&previews[0].payload.request.cueSelections?.length===1);
  const polls=count('registry.readOriginalReceipt').filter(row=>row.payload?.commandId===result.request.commandId),receipts=[applied[0],...polls];
  normal504Require(receipts.every(row=>equal(row.payload,result.request)&&row.value?.commandId===result.request.commandId&&row.value.datasetId===result.request.datasetId&&row.value.planId===result.plan.planId)
   &&equal(receipts.at(-1).value,result.receipt)&&receipts.slice(0,-1).every(row=>['running','unknown'].includes(row.value.state)));
  const index=flights.indexOf(applied[0]);normal504Require(polls.every(row=>flights.indexOf(row)>index)&&Date.parse(result.plan.expiresAt)>events[calls.indexOf(applied[0])].began);
 }
 normal504Require(count('registry.readOriginalReceipt').every(row=>results.some(result=>equal(row.payload,result.request))));
}
function normal504Directory(body,datasetId,epoch,results,evidenceRoot){
 normal504Require(Array.isArray(body.directoryRequests)&&body.directoryRequests.length>0&&Array.isArray(body.directoryFdChecks)&&body.directoryFdChecks.length===9);
 const bindings=new Map(),requestIds=new Set(),authorities=new Set();for(const [index,row]of body.directoryRequests.entries()){
  keys(row,['version','type','purpose','requestId','sequence','authorityId','command','binding','ui','expiresAtMs'],'V39_002_NORMAL_DIRECTORY_REQUEST');
  const binding=row.binding;keys(binding,['datasetId','ownerEpoch','childGeneration','kind','choiceId','revision','issuedAtMs','expiresAtMs','originalUi'],'V39_002_NORMAL_DIRECTORY_BINDING');
  normal504Require(row.version===1&&row.type==='workbench-directory-request'&&row.purpose==='WORKBENCH_DIRECTORY'&&normal504Uuid(row.requestId)&&!requestIds.has(row.requestId)
   &&row.sequence===index+1&&normal504Uuid(row.authorityId)&&['approve','revalidate','revoke'].includes(row.command)&&positive(row.expiresAtMs)
   &&binding.datasetId===datasetId&&binding.ownerEpoch===epoch&&binding.childGeneration===1&&['library','cue'].includes(binding.kind)&&normal504Uuid(binding.choiceId)
   &&sha256(binding.revision)&&positive(binding.issuedAtMs)&&positive(binding.expiresAtMs)&&binding.expiresAtMs>binding.issuedAtMs&&binding.expiresAtMs-binding.issuedAtMs<=600000);
  for(const ui of [binding.originalUi,row.ui]){keys(ui,['family','command','commandId','requestSha256'],'V39_002_NORMAL_DIRECTORY_UI');normal504Require(['management','workbench'].includes(ui.family)
    &&typeof ui.command==='string'&&(ui.commandId===null||normal504Uuid(ui.commandId))&&sha256(ui.requestSha256));}
  normal504Require(binding.originalUi.command===(binding.kind==='library'?'library.import.prepare':'localWorkbench.cue.target')&&binding.originalUi.commandId===null);
  const old=bindings.get(binding.choiceId);normal504Require(!old||equal(old,binding));bindings.set(binding.choiceId,binding);requestIds.add(row.requestId);authorities.add(row.authorityId);
  const uiFlight=body.flights.find(flight=>flight.command===row.ui.command&&hash(canonical({command:flight.command,payload:flight.payload}))===row.ui.requestSha256)
   ??(row.ui.command==='localWorkbench.plan.apply'?body.flights.find(flight=>flight.command==='registry.apply'&&flight.payload.commandId===row.ui.commandId):null)
   ??(row.ui.command==='localWorkbench.cue.preview'?body.flights.find(flight=>flight.command==='cue.preparePreview'&&flight.payload.request.target.choiceId===binding.choiceId):null);
  if(row.ui.command==='localWorkbench.plan.apply')normal504Require(uiFlight&&row.ui.requestSha256===hash(canonical({command:row.ui.command,payload:uiFlight.payload})));
  else if(row.ui.command==='localWorkbench.cue.preview')normal504Require(uiFlight&&row.ui.requestSha256===hash(canonical({command:row.ui.command,payload:uiFlight.payload.request})));
  else normal504Require(uiFlight||equal(row.ui,binding.originalUi));
 }
 normal504Require(bindings.size===9&&authorities.size===1&&[...bindings.values()].filter(row=>row.kind==='library').length===1);
 const fdChoices=new Set();for(const fd of body.directoryFdChecks){keys(fd,Object.hasOwn(fd,'originalCommand')?['choiceId','physical','error','originalCommand']:['choiceId','physical','error'],'V39_002_NORMAL_DIRECTORY_FD');
  const binding=bindings.get(fd.choiceId);normal504Require(binding&&!fdChoices.has(fd.choiceId)&&fd.error==='EBADF');normal504Physical(fd.physical);fdChoices.add(fd.choiceId);
  const physicalPath=binding.kind==='library'?evidenceRoot+normal504Prefix+'原中文音乐库':results.find(result=>result.plan.target.choiceId===fd.choiceId)?.outputDirectory;
  normal504Require(fd.physical.path===physicalPath);if(Object.hasOwn(fd,'originalCommand'))normal504Require(fd.originalCommand==='revoke'
    &&body.directoryRequests.some(row=>row.command==='revoke'&&row.binding.choiceId===fd.choiceId));
 }
 for(const result of results)normal504Require(bindings.get(result.plan.target.choiceId)?.kind==='cue'&&bindings.get(result.plan.target.choiceId)?.revision===result.capture.target.revision);
}
function normal504Sql(rows,datasetId,results,inputs){
 normal504Require(object(rows)&&Object.keys(rows).every(name=>/^[a-zA-Z0-9_]+$/u.test(name)&&Array.isArray(rows[name])));
 const table=(name,length)=>{normal504Require(Array.isArray(rows[name])&&rows[name].length===length);return rows[name];};
 const roots=table('local_catalog_roots',1),assets=table('local_catalog_assets',8),tracks=table('local_catalog_tracks',8),jobs=table('local_scan_jobs',1),cues=table('local_cue_sources',8),cueTracks=table('local_cue_tracks',16);
 const job=JSON.parse(jobs[0].data);keys(job,['schemaVersion','jobId','datasetId','libraryRootId','sourceRootId','rootRevision','jobRevision','checkpointRef','progress','phase','failureCode'],'V39_002_NORMAL_SCAN_JOB');
 normal504Require(job.schemaVersion==='1.2'&&job.failureCode===null&&jobs[0].id===job.jobId&&jobs[0].dataset_id===datasetId&&job.datasetId===datasetId&&jobs[0].parser_version==='cue-input-scan/v39-v1'
  &&job.phase==='completed'&&equal(job.progress,{visited:'16',accepted:'16',rejected:'0'})&&jobs[0].library_root_id===roots[0].id&&jobs[0].source_root_id===roots[0].source_root_id);
 normal504Require(new Set(assets.map(row=>row.id)).size===8&&new Set(tracks.map(row=>row.id)).size===8);
 for(const input of inputs){const relativeName=input.copy.path.slice((normal504Prefix+'原中文音乐库/').length),asset=assets.find(row=>row.relative===relativeName);
  normal504Require(asset&&asset.root_id===roots[0].id&&asset.source_root_id===roots[0].source_root_id&&tracks.filter(row=>row.asset_id===asset.id).length===1);
  const assetData=JSON.parse(asset.data),trackRow=tracks.find(row=>row.asset_id===asset.id),trackData=JSON.parse(trackRow.data),rootData=JSON.parse(roots[0].data);
  normal504Require(assetData.id===asset.id&&assetData.libraryRootId===roots[0].id&&assetData.sourceRootId===roots[0].source_root_id&&trackData.id===trackRow.id&&trackData.assetId===asset.id
   &&rootData.id===roots[0].id&&rootData.sourceRootId===roots[0].source_root_id&&job.rootRevision===rootData.revision);
  const state=rows.local_scan_file_state?.find(row=>row.relative===relativeName&&row.asset_id===asset.id),fact=state&&JSON.parse(state.data);
  normal504Require(state?.job_id===jobs[0].id&&fact?.outcome==='accepted'&&fact.assetId===asset.id&&fact.libraryRootId===roots[0].id
   &&fact.parserVersion===(['tta','tak'].includes(input.id)?'musicbridge-cue-header/mbrs003-v1':'music-metadata-11.15.0/mbrs003-v4')&&fact.readFacts?.technical?.evidence==='bounded-parser-reported');
  const read=fact.readFacts?.readEvidence;normal504Require(read&&read.wholeAudioHash===false&&read.wholeAudioDecode===false&&Number.isFinite(read.elapsedMs)&&read.elapsedMs>=0&&read.elapsedMs<=3000
   &&Number.isSafeInteger(read.bytesRead)&&read.bytesRead>=0&&read.bytesRead<=33554432&&read.maxReadBytes<=8388608&&read.allocationBytes<=67108864);
  const cue=cues.find(row=>row.relative===input.cue.path.slice((normal504Prefix+'原中文音乐库/').length)),snapshot=cue&&JSON.parse(cue.data);
  normal504Require(cue?.library_root_id===roots[0].id&&snapshot?.id===cue.id&&snapshot.libraryRootId===roots[0].id&&snapshot.sourceRootId===roots[0].source_root_id
   &&snapshot.item?.outcome==='accepted'&&snapshot.item.result?.status==='ok'&&snapshot.item.result.tracks.length===2&&cueTracks.filter(row=>row.snapshot_id===cue.id).length===2);
  const result=results.find(row=>row.id===input.id),member=result.capture.albums[0].members[0];normal504Require(member.assetId===asset.id&&member.trackId===trackRow.id&&result.capture.cueSheets[0].cueId===cue.id
   &&member.rootRevision===assetData.rootRevision&&member.fileRevision===assetData.fileRevision&&member.locationRevision===assetData.locationRevision);
  for(const track of snapshot.item.result.tracks)normal504Require(track.assetReference?.assetId===asset.id&&track.assetReference.libraryRootId===roots[0].id&&track.assetReference.sourceRootId===roots[0].source_root_id);
 }
 normal504Require(Array.isArray(rows.local_catalog_ledger));const records=normal504CueLedger(rows.local_catalog_ledger,datasetId);
 normal504Require(records.size===8);for(const result of results){const record=records.get(result.request.commandId);
  normal504Require(record&&record.phase==='succeeded'&&record.physicalClosed===true&&equal(record.request,result.request)&&equal(record.receipt,result.receipt)
   &&record.outputRoot?.path===result.outputDirectory&&record.published?.length===2&&equal(record.published,result.plan.tracks.map(track=>track.itemId))&&record.staged?.length===2);
  for(const [index,staged]of record.staged.entries())normal504Require(staged.itemId===result.plan.tracks[index].itemId&&staged.outputName===result.plan.tracks[index].outputName
    &&staged.bytes===result.outputs[index].bytes&&staged.sha256===result.outputs[index].sha256&&typeof staged.dev==='string'&&typeof staged.ino==='string');}
 const snapshot=normal504RegistryLedger(rows.local_catalog_ledger,datasetId);normal504Require(snapshot?.entries?.length===8);
 for(const result of results){const entry=snapshot.entries.find(row=>row.plan?.planId===result.plan.planId);keys(entry,['plan','capture','original','receipt','cancellation'],'V39_002_NORMAL_REGISTRY_ENTRY');
  normal504Require(equal(entry.plan,result.plan)&&equal(entry.capture,result.capture)&&equal(entry.original,result.request)&&equal(entry.receipt,result.receipt)&&entry.cancellation===null);}
}
function normal504CueLedger(ledger,datasetId){
 const records=new Map(),eventIds=new Set();let pending=null;
 for(const row of ledger.filter(value=>value.operation==='local-cue-output-v1')){
  keys(row,['command_id','fingerprint','operation','request','result','created_at'],'V39_002_NORMAL_CUE_LEDGER_ROW');const event=JSON.parse(row.request),reply=JSON.parse(row.result);
  keys(event,['datasetId','eventId','transactionId','commandId','expectedRevision','revision','bytes','sha256','chunks','kind',...(event.kind==='chunk'?['index','payload']:[])],'V39_002_NORMAL_CUE_EVENT');
  normal504Require(row.request===canonical(event).toString('utf8')&&hash(Buffer.from(row.request))===row.fingerprint&&equal(reply,{eventId:event.eventId,eventHash:row.fingerprint})
   &&row.command_id===event.eventId&&!eventIds.has(event.eventId)&&normal504Uuid(event.eventId)&&normal504Uuid(event.transactionId)&&normal504Uuid(event.commandId)
   &&event.datasetId===datasetId&&positive(event.bytes)&&event.bytes<=33554432&&sha256(event.sha256)&&event.chunks===Math.ceil(event.bytes/32768)
   &&event.revision===(event.expectedRevision===null?0:event.expectedRevision+1));eventIds.add(event.eventId);
  const common=without(event,['eventId','kind','index','payload']),prior=records.get(event.commandId);normal504Require((prior?.revision??null)===event.expectedRevision);
  if(event.kind==='chunk'){
   if(event.index===0){normal504Require(pending===null);pending={common,parts:[]};}
   normal504Require(pending&&equal(pending.common,common)&&event.index===pending.parts.length);const bytes=base64(event.payload,32768);
   normal504Require(bytes.length===Math.min(32768,event.bytes-event.index*32768));pending.parts.push(bytes);
  }else{
   normal504Require(event.kind==='commit'&&pending&&equal(pending.common,common)&&pending.parts.length===event.chunks);
   const raw=Buffer.concat(pending.parts);normal504Require(raw.length===event.bytes&&hash(raw)===event.sha256);const record=parse(raw);
   keys(record,['schema','request','revision','phase','outputRoot','stageDirectory','staged','published','physicalClosed','receipt'],'V39_002_NORMAL_CUE_RECORD');
   normal504Require(record.schema===1&&record.revision===event.revision&&record.request?.datasetId===datasetId&&record.request.commandId===event.commandId
    &&canonical(record).equals(raw)&&(!prior||equal(prior.request,record.request)));records.set(event.commandId,record);pending=null;
  }
 }
 normal504Require(pending===null);return records;
}
function normal504RegistryLedger(ledger,datasetId){
 let revision=0,pending=null,snapshot=null;const ids=new Set();
 for(const row of ledger.filter(value=>value.operation==='local-workbench-v1')){
  keys(row,['command_id','fingerprint','operation','request','result','created_at'],'V39_002_NORMAL_REGISTRY_ROW');const event=JSON.parse(row.request);
  keys(event,['kind','eventId','datasetId','transactionId','expectedRevision','revision','snapshotHash','bytes','chunks',...(event.kind==='snapshot-chunk'?['index','payload']:[])],'V39_002_NORMAL_REGISTRY_EVENT');
  normal504Require(row.request===canonical(event).toString('utf8')&&hash(Buffer.from(row.request))===row.fingerprint&&row.command_id===event.eventId&&!ids.has(event.eventId)
   &&equal(JSON.parse(row.result),{eventId:event.eventId,eventHash:row.fingerprint})&&normal504Uuid(event.eventId)&&normal504Uuid(event.transactionId)&&event.datasetId===datasetId
   &&event.expectedRevision===revision&&event.revision===revision+1&&positive(event.bytes)&&event.bytes<=33554432&&sha256(event.snapshotHash)&&event.chunks===Math.ceil(event.bytes/12288));ids.add(event.eventId);
  const common=without(event,['eventId','kind','index','payload']);if(event.kind==='snapshot-chunk'){
   if(event.index===0){normal504Require(pending===null);pending={common,parts:[]};}
   normal504Require(pending&&equal(pending.common,common)&&event.index===pending.parts.length);const bytes=base64(event.payload,12288);
   normal504Require(bytes.length===Math.min(12288,event.bytes-event.index*12288));pending.parts.push(bytes);
  }else{
   normal504Require(event.kind==='snapshot-commit'&&pending&&equal(pending.common,common)&&pending.parts.length===event.chunks);const bytes=Buffer.concat(pending.parts);
   normal504Require(bytes.length===event.bytes&&hash(bytes)===event.snapshotHash);snapshot=parse(bytes);keys(snapshot,['schemaVersion','datasetId','revision','entries'],'V39_002_NORMAL_REGISTRY_SNAPSHOT');
   normal504Require(snapshot.schemaVersion===1&&snapshot.datasetId===datasetId&&snapshot.revision===event.revision);revision=event.revision;pending=null;
  }
 }
 normal504Require(pending===null);return snapshot;
}
function normal504Verification(verification,results,readBody){
 normal504Require(Array.isArray(verification)&&verification.length===40);const names=new Map();
 for(const raw of verification){keys(raw,['path','bytes','sha256','stdout','stderr'],'V39_002_NORMAL_VERIFIER_RAW');
  normal504Require(raw.path.startsWith(normal504Prefix)&&raw.path.endsWith('.json')&&!names.has(raw.path));const name=raw.path.slice(normal504Prefix.length,-5);names.set(name,raw);
  normal504Require(raw.stdout?.path===normal504Prefix+name+'.stdout.log'&&raw.stderr?.path===normal504Prefix+name+'.stderr.log');
  const receipt=normal504Json(raw,readBody);keys(receipt,['exitCode','signal','pid','pidClosed','stdout','stderr'],'V39_002_NORMAL_VERIFIER_RECEIPT');
  normal504Require(receipt.exitCode===0&&receipt.signal===null&&positive(receipt.pid)&&receipt.pidClosed===true&&equal(receipt.stdout,raw.stdout)&&equal(receipt.stderr,raw.stderr));
  normal504Bytes(raw.stderr,readBody);normal504Bytes(raw.stdout,readBody);
 }
 for(const result of results){normal504Require(names.has(result.id+'-source-decode'));for(const track of result.plan.tracks){
   normal504Require(names.has(result.id+'-track'+track.sequence+'-decode'));const ref=names.get(result.id+'-track'+track.sequence+'-probe');normal504Require(ref);
   const expectedCodec=result.expectedOutput==='wavpack'?'wavpack':result.expectedOutput,lines=decode(normal504Bytes(ref.stdout,readBody)).split('\n').filter(Boolean);let frames=0,streams=0;
   for(const line of lines){const [kind,...parts]=line.split('|'),values={};for(const part of parts){const at=part.indexOf('=');normal504Require(at>0&&!Object.hasOwn(values,part.slice(0,at)));values[part.slice(0,at)]=part.slice(at+1);}
    if(kind==='frame'){const count=Number(values.nb_samples);normal504Require(positive(count)&&Number.isSafeInteger(frames+count));frames+=count;}
    else{normal504Require(kind==='stream');streams++;normal504Require(values.codec_name===expectedCodec&&Number(values.sample_rate)===track.sampleRate&&Number(values.channels)===2);
     if(expectedCodec==='flac')normal504Require(Number(values.bits_per_raw_sample)===24||Number(values.bits_per_sample)===24);}}
   normal504Require(streams===1&&frames===track.frameCount);
  }}
}
function normal504Pcm(rows,results,original,readBody){
 normal504Require(Array.isArray(rows)&&rows.length===8&&equal(rows.map(row=>row.id).sort(),[...normal504Families].sort()));
 for(const row of rows){keys(row,['id','sampleRate','channels','source','tracks'],'V39_002_NORMAL_PCM');const result=results.find(value=>value.id===row.id),frames=result.capture.audio[0].totalPcmFrames;
  normal504Require(row.sampleRate===result.capture.audio[0].sampleRate&&row.channels===2&&row.source?.path===normal504Prefix+row.id+'-source.s32le'
   &&row.source.bytes===frames*row.channels*4&&Array.isArray(row.tracks)&&row.tracks.length===2);const source=normal504Bytes(row.source,readBody);
  const rare=original.rareInputs.find(value=>value.id===row.id);if(rare)normal504Require(row.source.bytes===rare.decoded.bytes&&row.source.sha256===rare.decoded.sha256);
  let end=0;for(const [index,track]of row.tracks.entries()){
   keys(track,['sequence','startFrame','frameCount','outputAudio','decoded'],'V39_002_NORMAL_PCM_TRACK');const plan=result.plan.tracks[index];
   normal504Require(track.sequence===plan.sequence&&track.startFrame===plan.startFrame&&track.startFrame===end&&track.frameCount===plan.frameCount
    &&equal(track.outputAudio,result.outputs[index])&&track.decoded?.path===normal504Prefix+row.id+'-track'+track.sequence+'.s32le'
    &&track.decoded.bytes===track.frameCount*row.channels*4);end+=track.frameCount;
   const decoded=normal504Bytes(track.decoded,readBody),expected=source.subarray(track.startFrame*row.channels*4,end*row.channels*4);
   if(!['vorbis','opus'].includes(row.id))normal504Require(decoded.equals(expected));
   else{let signal=0,noise=0;for(let at=0;at<expected.length;at+=4){const value=expected.readInt32LE(at),difference=value-decoded.readInt32LE(at);signal+=value*value;noise+=difference*difference;}
    const snr=noise===0?999:10*Math.log10(signal/noise);normal504Require(Number.isFinite(snr)&&snr>=18);}
  }
  normal504Require(end===frames);
 }
}

export function validateV39Integration002NativeProof(proof,source,scopeHash,lookup,inputRaw,readEvidenceBody){
 try{if(proof?.schema!=='musicbridge.v39.integration002.native-proof.v1'||proof.task!==V39_INTEGRATION_TASK||proof.sourceSha!==source||proof.scopeSha256!==scopeHash
   ||proof.platform!=='darwin'||proof.architecture!=='arm64'||!object(proof.bundles?.cue)||!object(proof.bundles?.tags)
   ||!Array.isArray(proof.formats)||!equal(proof.formats.map(row=>row.id).sort(),[...formatIds].sort())
   ||!['fdsClosed','processesClosed','claimsReleased'].every(key=>proof.physicalClosure?.[key]===true))return false;
  for(const kind of ['cue','tags']){const bundle=proof.bundles[kind];if(!pinValid(bundle.manifest)||!Array.isArray(bundle.programs)||!bundle.programs.length
    ||!Array.isArray(bundle.libraries)||!bundle.libraries.length||!Array.isArray(bundle.legal)||!bundle.legal.length)return false;}
  for(const row of proof.formats){if(!Array.isArray(row.variants))return false;const pcm=['pcm-wav','pcm-aiff'].includes(row.id);
   if(row.variants.length!==(pcm?3:0)||pcm&&row.profile!=='s24')return false;const variants=[row,...row.variants];
   const expected=row.id==='pcm-wav'?['pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le']:row.id==='pcm-aiff'?['pcm_s16be','pcm_s24be','pcm_s32be','pcm_f32be']:null;
   if(expected&&(!equal(variants.map(v=>v.encoder).sort(),expected.sort())
     ||!equal(row.variants.map(v=>v.profile).sort(),['f32','s16','s32'])))return false;
   for(const variant of variants){if(!pinValid(variant.input)||!pinValid(variant.output)||!pinValid(variant.decoded)||variant.eof!==true||variant.sourceUnchanged!==true
     ||!positive(variant.expectedFrames)||variant.decodedFrames!==variant.expectedFrames||!equal(variant.tagsExpected,variant.tagsActual)
     ||typeof variant.encoder!=='string'||typeof variant.decoder!=='string'||!variant.encoder||!variant.decoder
     ||(!pcm&&variant.encoder!==({flac:'flac',alac:'alac',mp3:'libmp3lame',vorbis:'libvorbis',opus:'libopus',wavpack:'wavpack'})[row.id])
     ||!['encode','decode'].every(op=>variant[op]?.exitCode===0&&variant[op].signal===null&&variant[op].pidClosed===true
       &&pinValid(variant[op].raw?.stdout)&&pinValid(variant[op].raw?.stderr))
     ||!['fdsClosed','processesClosed','claimsReleased'].every(key=>variant.physicalClosure?.[key]===true))return false;}}
  if(!validateV39Integration002RareInputs(proof))return false;
  if(proof.watcher?.stopAcknowledged!==true||proof.watcher?.invalidationVerified!==true||proof.watcher?.fdsClosed!==true
   ||!positive(proof.watcher.invalidationsObserved)||proof.watcher.callbacksAfterStop!==0||!pinValid(proof.watcher.raw))return false;
  if(!object(proof.lyricsProtectedCopy?.wav)||!object(proof.lyricsProtectedCopy?.flac)
    ||!['wav','flac'].every(kind=>proof.lyricsProtectedCopy[kind].audioUnchanged===true&&proof.lyricsProtectedCopy[kind].unselectedMetadataUnchanged===true
      &&proof.lyricsProtectedCopy[kind].rereadVerified===true&&proof.lyricsProtectedCopy[kind].sourceUnchanged===true
      &&['input','output','decodedBefore','decodedAfter','raw'].every(key=>pinValid(proof.lyricsProtectedCopy[kind][key]))
      &&proof.lyricsProtectedCopy[kind].input.path!==proof.lyricsProtectedCopy[kind].output.path
      &&positive(proof.lyricsProtectedCopy[kind].expectedFrames)&&proof.lyricsProtectedCopy[kind].decodedFrames===proof.lyricsProtectedCopy[kind].expectedFrames
      &&proof.lyricsProtectedCopy[kind].decodedBefore.bytes===proof.lyricsProtectedCopy[kind].decodedAfter.bytes
      &&proof.lyricsProtectedCopy[kind].decodedBefore.sha256===proof.lyricsProtectedCopy[kind].decodedAfter.sha256
      &&['fdsClosed','processesClosed','claimsReleased'].every(key=>proof.lyricsProtectedCopy[kind].physicalClosure?.[key]===true)))return false;
  if(!validateV39Integration002CueInputFormats(proof.cueInputFormats,inputRaw,lookup))return false;
  const input=cueInputBody(inputRaw);for(const kind of ['cue','tags']){const actual=input.facts[kind+'Manifest'],expected=proof.bundles[kind].manifest;
   if(!equal({bytes:actual.bytes,sha256:actual.sha256},{bytes:expected.bytes,sha256:expected.sha256}))return false;}
  if(!validateV39Integration002CueNormalScanEntry(proof,source,scopeHash,lookup,readEvidenceBody))return false;
  if(lookup)proofFiles(proof,lookup);return true;
 }catch{return false;}}
export function validateV39Integration002CapacityProof(proof,source,scopeHash,lookup){
 try{if(proof?.schema!=='musicbridge.v39.integration002.capacity-proof.v1'||proof.task!==V39_INTEGRATION_TASK||proof.sourceSha!==source||proof.scopeSha256!==scopeHash
   ||!Array.isArray(proof.changedDomains)||!proof.changedDomains.length||!Array.isArray(proof.datasets)||!proof.datasets.length
   ||!Array.isArray(proof.queries)||!proof.queries.length||!Array.isArray(proof.boundaries)||!proof.boundaries.length
   ||!proof.preservedFailures?.includes('SQL548_300K_NOT_PASSED')||!Array.isArray(proof.inheritedEvidence)
   ||!['fdsClosed','workersClosed','claimsReleased'].every(key=>proof.physicalClosure?.[key]===true))return false;
  for(const dataset of proof.datasets){if(typeof dataset.id!=='string'||!dataset.id||dataset.synthetic!==true||!positive(dataset.identity?.bytes)||!sha256(dataset.identity?.sha256)
    ||!object(dataset.rows)||!['catalogTracks','assets','scanFileState','relations'].every(key=>Number.isSafeInteger(dataset.rows[key])&&dataset.rows[key]>=0)||dataset.rows.catalogTracks>300000||dataset.rows.assets>600000||dataset.rows.scanFileState>600000||dataset.rows.relations>1200000)return false;}
  for(const query of proof.queries){if(!proof.datasets.some(row=>row.id===query.datasetId)||typeof query.cold!=='boolean'||!Number.isFinite(query.elapsedMs)
    ||query.elapsedMs<0||query.elapsedMs>30000||!positive(query.rssBytes)||query.requestDeadlineMs!==30000||query.ownerDeadlineMs!==2000
    ||!pinValid(query.raw)||query.exitCode!==0||query.signal!==null||query.completeGroup?.truncated!==false
    ||!Number.isSafeInteger(query.completeGroup.items)||query.completeGroup.items<0||query.completeGroup.items>10000||!Number.isSafeInteger(query.completeGroup.bytes)||query.completeGroup.bytes<0||query.completeGroup.bytes>33554432)return false;}
  if(!proof.boundaries.some(row=>row.id==='catalog-301000-rejected'&&row.accepted===false&&row.actualLimit===300000)
    ||!proof.boundaries.some(row=>row.id==='whole-group-10000-32mib'&&row.accepted===true)
    ||!proof.boundaries.some(row=>row.id==='small-group-2048-128kib'&&row.accepted===true))return false;
  if(lookup)proofFiles(proof,lookup);return true;
 }catch{return false;}}
export function validateV39Integration002AuxiliaryArtifact(artifact,kind,source,scopeHash){
 try{if(!wholeArtifact(artifact)||!Array.isArray(artifact.auxiliaryContents))return false;const matching=artifact.auxiliaryContents.filter(row=>row?.kind===kind);
  if(matching.length!==1)return false;const {summary,rootRecords}=decodeV39Integration002AuxiliaryContent(matching[0]);
  const prefix=kind+'/';for(const [name,raw]of rootRecords){const entry=artifact.members.find(row=>row.path===prefix+name);
   if(!entry||!equal(pin(raw),{bytes:entry.bytes,sha256:entry.sha256})||entry.crc32!==toolCrc(raw))return false;}
  if(summary.schema!=='musicbridge.v39.integration002.'+kind+'-gate.v1'||summary.sourceSha!==source||summary.scopeSha256!==scopeHash||summary.passed!==true
   ||summary.failureCode!==null||summary.sourceUnchanged!==true||!equal(summary.sourceBefore,summary.sourceAfter)
   ||!equal(parse(rootRecords.get('source-before.json')),summary.sourceBefore)||!equal(parse(rootRecords.get('source-after.json')),summary.sourceAfter)
   ||summary.stageMs!==(kind==='native'?180000:180000)||summary.wholeMs!==(kind==='native'?480000:600000)
   ||summary.effectiveCaptureStageMs!==90000||!Number.isFinite(summary.durationMs)||summary.durationMs<0||summary.durationMs>=summary.wholeMs
   ||!['ownedFreshTemporaryRoot','allStageProcessesPhysicallyClosed','removed','sourceAndEvidenceNeverDeleted'].every(key=>summary.temporaryCleanup?.[key]===true))return false;
  const tests=kind==='native'?V39_INTEGRATION_NATIVE_TESTS:V39_INTEGRATION_CAPACITY_TESTS;
  if(kind==='native'&&(!equal(summary.tests,tests)||summary.registeredTests!==11||!equal(summary.caseNames,V39_INTEGRATION_NATIVE_CASE_NAMES)))return false;
  if(kind==='native')for(const test of tests){const input=summary.sourceBefore.productInputs?.find(row=>row.path===test),current=summary.sourceBefore.currentFiles?.find(row=>row.path===test);
   if(!pinValid(input)||input.mode!=='100644'||!sha(input.blob)||!equal(input,current)||!equal(input,summary.sourceBefore.admission?.sourcePins?.find(row=>row.path===test)))return false;}
  if(summary.stages.length!==tests.length||summary.stages.some((row,i)=>row.name!=='case-'+(i+1)||!v39Integration002StagePassed(row)
    ||!equal(parse(rootRecords.get(row.name+'.json')),row)))return false;
  for(const [index,stage]of summary.stages.entries()){const expected=kind==='native'?V39_INTEGRATION_NATIVE_CASE_NAMES[index]:null;
   const parsed=parseCompleteTap(rootRecords.get(stage.name+'.stdout.log'),expected);
   if(parsed.counts.skipped||!equal(parsed.counts,stage.testCounts)||!equal(parsed.names,stage.actualCaseNames))return false;
   if(expected&&(stage.expectedTests!==expected.length||!equal(stage.expectedCaseNames,expected)||!equal(parsed.names,expected)))return false;
   for(const stream of ['stdout','stderr'])if(!equal(pin(rootRecords.get(stage.name+'.'+stream+'.log')),{bytes:stage.raw[stream].bytes,sha256:stage.raw[stream].sha256}))return false;}
  const proof=parse(rootRecords.get(kind+'-proof.json'));if(!equal(proof,summary.proof))return false;const lookup=row=>artifact.members.some(member=>member.path===prefix+'evidence/'+row.path&&member.bytes===row.bytes&&member.sha256===row.sha256);
  return kind==='native'?validateV39Integration002NativeProof(proof,source,scopeHash,lookup,rootRecords.get('cue-input-formats.json'),ref=>rootRecords.get('evidence/'+ref.path)):validateV39Integration002CapacityProof(proof,source,scopeHash,lookup);
 }catch{return false;}}

/** 公共API重新核到的producer须与完整whole收据原身份相等，不靠自己的Report green替代Source。 */
export function v39Integration002ProducerIdentity(value){
 return {runs:value.runs.map(row=>({id:row.id,path:row.path,head_sha:row.head_sha,head_branch:row.head_branch,event:row.event,
  run_attempt:row.run_attempt,status:row.status,conclusion:row.conclusion,repositoryId:row.repository?.id})).sort((a,b)=>a.id-b.id),
  proofs:value.proofs.map(row=>({runId:row.runId,jobs:row.jobs.map(job=>({id:job.id,name:job.name,head_sha:job.head_sha,status:job.status,
   conclusion:job.conclusion,steps:job.steps.map(step=>({name:step.name,status:step.status,conclusion:step.conclusion}))})).sort((a,b)=>a.id-b.id),
   artifacts:row.artifacts.map(item=>({id:item.id,name:item.name,digest:item.digest,size_in_bytes:item.size_in_bytes,expired:item.expired})).sort((a,b)=>a.id-b.id)})).sort((a,b)=>a.runId-b.runId)};
}
export const V39_INTEGRATION_ARTIFACT_PROFILES=freeze(['verify-source','verify-report','electron-source','rust-linux-source','rust-macos-source','rust-host-source']);
const excludedArchivePart = /^(?:node_modules|\.git|\.cache|cache|Caches|workspace|corepack|npm|Electron|modules|target|tmp|dist-cache)$/iu;
export function v39Integration002ArtifactPathAllowed(name){return relative(name)&&!name.split('/').some(part=>excludedArchivePart.test(part));}
/** manifest原byte与whole成员逐件相等；它描述正向复制结果，不能借摘要宣布丢失媒体/二进制已读。 */
export function validateV39Integration002ArchiveManifest(artifact,source,profile,head=source){try{
 if(!wholeArtifact(artifact)||!V39_INTEGRATION_ARTIFACT_PROFILES.includes(profile)||!object(artifact.archiveManifest)
   ||artifact.archiveManifest.entry!=='archive-manifest.json')return false;
 const raw=base64(artifact.archiveManifest.rawBase64),manifest=parse(raw),self=artifact.members.filter(row=>row.path==='archive-manifest.json');
 if(self.length!==1||!equal(pin(raw),{bytes:self[0].bytes,sha256:self[0].sha256})||toolCrc(raw)!==self[0].crc32
  ||manifest.schema!=='musicbridge.v39.integration002.archive-manifest.v1'||manifest.task!==V39_INTEGRATION_TASK
  ||manifest.profile!==profile||manifest.completeDeclaredProfile!==true||!Array.isArray(manifest.missingDeclaredFiles)||manifest.missingDeclaredFiles.length||manifest.sourceSha!==source||manifest.head!==head||manifest.cachePolicy!=='DECLARED_POSITIVE_FILES_ONLY'
  ||!Array.isArray(manifest.files)||new Set(manifest.files.map(row=>row.path)).size!==manifest.files.length)return false;
 const members=artifact.members.filter(row=>row.path!=='archive-manifest.json');
 if(manifest.files.length!==members.length||manifest.expandedBytes!==members.reduce((n,row)=>n+row.bytes,0))return false;
 for(const row of manifest.files){if(!pinValid(row)||!v39Integration002ArtifactPathAllowed(row.path)||!['100600','100700'].includes(row.mode)
   ||!members.some(member=>member.path===row.path&&member.bytes===row.bytes&&member.sha256===row.sha256))return false;}
 return true;
 }catch{return false;}}

/** 独立历史载体只验证真实commit/选定blob完整bytes；不宣称当前Git对象库有完整donor树。 */
export function validateV39Integration002DonorCarrier(document){try{
 canonical(document);if(!equal(without(document,['portableGit']),V39_INTEGRATION_DONOR_IDENTITY))return false;
 const carrier=document.portableGit;keys(carrier,['schema','commits','blobs'],'V39_002_DONOR_CARRIER_FIELDS');
 if(carrier.schema!=='musicbridge.v39.integration002.donor-git-carrier.v1'||!Array.isArray(carrier.commits)||carrier.commits.length!==8
  ||!Array.isArray(carrier.blobs)||carrier.blobs.length!==99)return false;let expanded=0;
 for(let i=0;i<8;i++){
  const row=carrier.commits[i],expected=V39_INTEGRATION_ORDERED_INPUTS[i];keys(row,['revision','rawBase64'],'V39_002_DONOR_COMMIT_FIELDS');
  if(row.revision!==expected.revision)return false;const raw=base64(row.rawBase64);expanded+=raw.length;
  if(oidOf('commit',raw)!==expected.revision||!equal(pin(raw),expected.commitRaw))return false;
  const header=decode(raw).split('\n\n')[0],tree=/^tree ([a-f0-9]{40})$/mu.exec(header)?.[1],parents=[...header.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map(match=>match[1]);
  if(tree!==expected.tree||!equal(parents,[expected.parent]))return false;
 }
 for(let i=0;i<99;i++){
  const row=carrier.blobs[i],expected=V39_INTEGRATION_DONOR_IDENTITY.files[i];keys(row,['revision','path','blob','rawBase64'],'V39_002_DONOR_BLOB_FIELDS');
  if(row.revision!==expected.revision||row.path!==expected.path||row.blob!==expected.blob)return false;
  const raw=base64(row.rawBase64);expanded+=raw.length;if(expanded>67108864||oidOf('blob',raw)!==expected.blob
   ||!equal(pin(raw),{bytes:expected.bytes,sha256:expected.sha256}))return false;
 }
 return expanded<=67108864;
 }catch{return false;}}

export const V39_INTEGRATION_ARTIFACT_CASE_NAMES=freeze([
 '002声明树不会夹带runner和依赖缓存','002普通文件整件复制SHA与mode回读',
 '002符号链越界重复目标和非文件拒绝','002软件Source28与Report22声明独立',
 '002Native19与Capacity10证明文件全pin回读','002缺原件保留失败manifest且不授PASS',
 '002whole ZIP manifest额外cache或漏成员拒绝','002实际编译产物和源码许可声明可读']);
export const V39_INTEGRATION_GATE_CASE_NAMES=freeze([
 '002当前Main唯一Owner异步scope与真实关闭组合','002当前完整组SQL与原CAS journal冷开组合','002实际独立Native资源失败与恢复边界组合',
 '002标准四TAP嵌套计划ordinal与双退出完整绑定','002输出根缓存越界符号链与Node覆盖拒绝','002当前GitSource输入不能靠声明和漂移冒充',
 '002真实自然子进程原raw与physical close','002超时溢出后代和持pipe进程不能PASS','002新artifact仅精确声明文件不携runner缓存',
 '002Source与Report继承原件边界不虚造本轮产品']);
