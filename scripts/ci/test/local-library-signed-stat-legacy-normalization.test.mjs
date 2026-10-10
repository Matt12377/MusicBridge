import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, openSync, fstatSync, lstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { LOCAL_LIBRARY_SIGNED_STAT_LEGACY_SOURCE, LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS,
  normalizeLocalLibrarySignedStatLegacyInput } from '../local-library-signed-stat-legacy-normalization.mjs';
import { MBM002_LEGACY_INPUTS, normalizeMbm002LegacyInputs } from '../mbm002-legacy-input-normalization.mjs';
import { normalizeMbm001LegacyReuse } from '../mbm001-legacy-reuse-normalization.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const maxBytes = 4 * 1024 * 1024;
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const signedChanged = error => error?.code === 'LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUT_CHANGED';
const oldChanged = error => error?.code === 'MBM002_LEGACY_INPUT_CHANGED';

// 这三份完整源码从只读Source5e实际整件独立封入测试；不执行Git，不用被测窗口生成期望。
const source5eWholeFiles = [
  {
    "path": "packages/bridge-core/src/application/local-source-resolver.ts",
    "bytes": 8378,
    "sha256": "ba979c56513746bca0d8c353da880d0dde4fb77bc1d464367fb553bf54d38901",
    "gitBlobOid": "5736f27b7fee95926e61150c490aacd99f6e89b5",
    "deflateRawBase64": "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"
  },
  {
    "path": "packages/bridge-core/src/stream/local-file-source.ts",
    "bytes": 11419,
    "sha256": "9a02dd349d7ca0952ac57920f26b57f607b556b08c554e4614f82be2683cfd82",
    "gitBlobOid": "5446df92f1bee7127c1be97f1a9f9c2e42e48075",
    "deflateRawBase64": "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"
  },
  {
    "path": "packages/bridge-core/src/recording/source-files.ts",
    "bytes": 46087,
    "sha256": "8316723b6d3a8b90770d4ca2df3ddb4c998e73f89997afe674cc6ac3a1b47be1",
    "gitBlobOid": "07f6ae15e71d2af26eaa2988d8f27b112182b58f",
    "deflateRawBase64": "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"
  }
];
const frozenControls = [
  {
    "path": "scripts/ci/mbm002-legacy-input-normalization.mjs",
    "bytes": 14048,
    "sha256": "0c10c23e00247c9af71f1993b068cd14e4e6697dcc09a8e67749cc4a208fe755"
  },
  {
    "path": "scripts/ci/test/mbm002-legacy-input-normalization.test.mjs",
    "bytes": 8179,
    "sha256": "c401150d87c5045e956110c7772866bcfec8833163b3a73b56db4a561b593663"
  },
  {
    "path": "scripts/ci/verify-mbm000-contract-adoption.mjs",
    "bytes": 44759,
    "sha256": "a3e87936042d8085615b07a6ad2eeec1ada98645cdcbabbf5f0b2c50f23d86b5"
  },
  {
    "path": "scripts/ci/mbm003-software-gate.mjs",
    "bytes": 35887,
    "sha256": "85a88fedba29caa43f68fe6d49551f86578948ad9e2ff4decd450cbf48086dc3"
  },
  {
    "path": "scripts/ci/mbm003-contract-gate.mjs",
    "bytes": 8831,
    "sha256": "29a96cadb48571fba8aca902f8fa99e391dbb1a43021a5e642a03acc2d37d56e"
  },
  {
    "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
    "bytes": 4805,
    "sha256": "2bcf3610973546403c2856897e3568c188be6bffc1b185b79f9cdf8f67cba9d5"
  },
  {
    "path": "scripts/ci/mbm001-legacy-reuse-normalization.mjs",
    "bytes": 11702,
    "sha256": "f3977562e4dce2938e8de3f29baf90586f7c1efef1623d87919f8bee1f12b602"
  },
  {
    "path": "docs/postrust/MBM-000/INPUT_LOCK.json",
    "bytes": 45510,
    "sha256": "2f190bdd30838991ffa43a9c0acc8d114d7474a591f62b31ba03cfbbbfaae2ac"
  },
  {
    "path": "docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json",
    "bytes": 3058,
    "sha256": "87cb1fcc67dc74013b7780cdf01e3ff0d44d756ee964938c23b0e37c266e1d4c"
  }
];
const productWholeIdentities = [
  {
    "path": "packages/bridge-core/src/collection/local-relocation-coordinator.ts",
    "before": {
      "bytes": 9621,
      "sha256": "d447c4c1ace3c947ebfc5345f9c351f1dc33270dbda31ab58ba82c1e56c62497"
    },
    "after": {
      "bytes": 9644,
      "sha256": "05acb43a9486bf3c33ce06fd4e2d13908668b67125ef362c751fd03beaffd98c"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-scan-coordinator.ts",
    "before": {
      "bytes": 36683,
      "sha256": "edc7e64751d3d1a534e858bcba2204105292c907e1e38e6822881f5ef3f6b37e"
    },
    "after": {
      "bytes": 36729,
      "sha256": "bc4dd52c0196bcb3c489ff44d728a09ae974bc5c72157783b1f8fab7c58b56e5"
    }
  },
  {
    "path": "packages/bridge-core/src/application/local-source-resolver.ts",
    "before": {
      "bytes": 8378,
      "sha256": "ba979c56513746bca0d8c353da880d0dde4fb77bc1d464367fb553bf54d38901"
    },
    "after": {
      "bytes": 8424,
      "sha256": "3fc6087d0e4cb14edb2d0eab65917ce479a688cb71a9a88fc07d50ff0f4fb4c5"
    }
  },
  {
    "path": "packages/bridge-core/src/collection/local-source-ticket-types.ts",
    "before": {
      "bytes": 4363,
      "sha256": "77952df9b715b38824d64831dea32789dc84ec12eccc2c93c109dbb25e54c3a4"
    },
    "after": {
      "bytes": 4423,
      "sha256": "ac836361c8bcd7d428d73e3ccc570310d54c8337ee007555d23eee5a7b26f67f"
    }
  },
  {
    "path": "packages/bridge-core/src/stream/local-file-source.ts",
    "before": {
      "bytes": 11419,
      "sha256": "9a02dd349d7ca0952ac57920f26b57f607b556b08c554e4614f82be2683cfd82"
    },
    "after": {
      "bytes": 11489,
      "sha256": "39c5bfd368273d75fdb81a69566c67180fbd36c383217056720843c8847be7f5"
    }
  },
  {
    "path": "packages/bridge-core/src/recording/source-files.ts",
    "before": {
      "bytes": 46087,
      "sha256": "8316723b6d3a8b90770d4ca2df3ddb4c998e73f89997afe674cc6ac3a1b47be1"
    },
    "after": {
      "bytes": 46157,
      "sha256": "3ccafec70017b883c3709a72b6715b3ca6b367b663a71d858b0279424e7de898"
    }
  },
  {
    "path": "packages/bridge-core/src/stream/physical-resource-locks.ts",
    "before": {
      "bytes": 15108,
      "sha256": "3ce61bd5f704df7922a51d8f537afa5f0e9af363e37e64daee488e826ee16160"
    },
    "after": {
      "bytes": 15391,
      "sha256": "79052d83b6c602de784da7002f975aaf71e91c84f11bb9acc7d913fbf2fff2b8"
    }
  },
  {
    "path": "packages/bridge-core/src/stream/physical-resource-claims.ts",
    "before": {
      "bytes": 14798,
      "sha256": "ef92308c9bf0076d2ece5ab59cd62974d407bd81c9e4194b191ababdcff06854"
    },
    "after": {
      "bytes": 14918,
      "sha256": "8b1f47063435521135b5bfaf61951b6486d355fdcea6bb9bdfe3fdff5cd4cdba"
    }
  },
  {
    "path": "packages/bridge-core/src/stream/source-namespace-claims.ts",
    "before": {
      "bytes": 24726,
      "sha256": "53d3db53fdb4fbdfede5ffe8e527ed34a464f0e8b130974a638d5e68ea280ed5"
    },
    "after": {
      "bytes": 24762,
      "sha256": "c7810434565cdb4b5c8fe394ca70d50442327e158a1439b54dcf3ae15e35d715"
    }
  },
  {
    "path": "packages/bridge-core/src/library/metadata-reader-worker.ts",
    "before": {
      "bytes": 20986,
      "sha256": "0aeadd7b2bfdad3508f8861ea8975e3bc112dc0535a78a4d40195ddf5d8e4948"
    },
    "after": {
      "bytes": 21663,
      "sha256": "ae050ec90ec99e52f173d0bf9e6603c902077936f9cc65e5f78c3462d4055165"
    }
  },
  {
    "path": "packages/bridge-core/src/library/metadata-reader-types.ts",
    "before": {
      "bytes": 4680,
      "sha256": "789284d079636be2468598e4b8f9dc33c12f0a9bdd10645d224bac0a12a3d95e"
    },
    "after": {
      "bytes": 4680,
      "sha256": "a57cc35fb1958b8a1c3368b67c06e3f45fbd3a1487fe1b514a1356d57369faa5"
    }
  },
  {
    "path": "packages/bridge-core/src/library/metadata-reader.ts",
    "before": {
      "bytes": 14112,
      "sha256": "5f23c12dacb922832c4261391c0961aab565b77f1c4f79c52ca9882f8fce4bfe"
    },
    "after": {
      "bytes": 14112,
      "sha256": "34345874986b1d4416ca69c645e9d0dfe9b5bb66ba4b774b5b2f35f89a22b6ed"
    }
  }
];
// 其余19份只认证Source5e原件未变；003既有修改不能冒充当前重新通过旧000 Gate。
const source5eMacReuseIdentities = [{"path":"packages/bridge-core/src/control/server.ts","bytes":19625,"sha256":"a7bf41239869a3bf134dfcc526d98d0e0ad00e747233a40db7c56dd0e2c2a2e6"},{"path":"packages/bridge-core/src/config/config.ts","bytes":8715,"sha256":"191f7228e93bfe4b36c53adfaa203c2aab754f89d2297f7373f0ac375773c915"},{"path":"apps/desktop/src/main/core-host.ts","bytes":5033,"sha256":"67087bd2418d6e2ecec3a4ea8d8bbf275def6c85cd164353d19fb217cdfb781c"},{"path":"packages/bridge-core/src/collection/dataset-owner-client.ts","bytes":22836,"sha256":"cef49cbb448c1283b82e61ed1962dff79106c56d505d372a4f0be726421ec86c"},{"path":"packages/bridge-core/src/collection/dataset-domain.ts","bytes":29912,"sha256":"abb9d59856d57ec58c98cc6a96ee0400f712b0d06137e0c4ecda8e938da0b929"},{"path":"packages/contracts/src/local-catalog.ts","bytes":30109,"sha256":"8796cce24bec3b10cabdcde05fe24fa536eef23755cc61389977959a0b2e54e6"},{"path":"packages/bridge-core/src/collection/local-catalog-store.ts","bytes":115384,"sha256":"4485d96516b807433c0a3e318ebc662738ed9281431840feb29546025e7040ab"},{"path":"packages/bridge-core/src/collection/dataset-dispatch.ts","bytes":57912,"sha256":"1ffe34aa2977d75db1619289ef73ee6c2112fe25450e05eedcacc72b24cc7b50"},{"path":"packages/contracts/src/audio-quality.ts","bytes":2014,"sha256":"62356e9a4bbd387a4605f45d05bbf713d106ca262923cca2172d2735d8a890dd"},{"path":"packages/bridge-core/src/runtime.ts","bytes":99677,"sha256":"9c11125386f197a9e50f3c4a37df8765afc0980f5f9cdc87a412d5bf7bc012c0"},{"path":"packages/bridge-core/src/netease/client.ts","bytes":38269,"sha256":"2cff7ab1e211567024c2fb9a1f410d2e365cc8a86197f010e938b03671fb54ec"},{"path":"packages/contracts/src/library.ts","bytes":1944,"sha256":"3c1f4ae84f33ae19da5449b6ee6c23d99759d18902e4931441cad8a52a717106"},{"path":"packages/contracts/src/lyrics.ts","bytes":1687,"sha256":"4650c22a2465ae83a7e2cc1813fb5254289550241fccd6f3c6b22af94694e7dc"},{"path":"packages/bridge-core/src/favorites/repository.ts","bytes":8960,"sha256":"e123f8aea0aed9c27ae4d2e85f3f5e8ec36abf8713e1af2efec05314425cfd6f"},{"path":"packages/contracts/src/favorites.ts","bytes":566,"sha256":"65ff3e2f4b0c7488e5933cfb43ae2c69f5ef35f8bd6d8a985be131ba60a3a386"},{"path":"packages/bridge-core/src/application/local-source-resolver.ts","bytes":8378,"sha256":"ba979c56513746bca0d8c353da880d0dde4fb77bc1d464367fb553bf54d38901"},{"path":"packages/bridge-core/src/recording/source-files.ts","bytes":46087,"sha256":"8316723b6d3a8b90770d4ca2df3ddb4c998e73f89997afe674cc6ac3a1b47be1"},{"path":"packages/bridge-core/src/stream/local-file-source.ts","bytes":11419,"sha256":"9a02dd349d7ca0952ac57920f26b57f607b556b08c554e4614f82be2683cfd82"},{"path":"packages/bridge-core/src/stream/registry.ts","bytes":4471,"sha256":"252dccc13127c99fe2e9f6646edcb48a171bdcc37719e9d5d12664664158ee4b"},{"path":"packages/bridge-core/src/stream/local-file-http.ts","bytes":3636,"sha256":"ac50d11d1b41d64ebfbeaadcdf95bda2db3b155f69d9243829520502317e2482"},{"path":"packages/bridge-core/src/stream/gateway.ts","bytes":25140,"sha256":"e3b7a75a1e62f4448baeca05ef348b2cf2aa227f948d7594e7b0d2822c584bb0"},{"path":"packages/contracts/src/playback.ts","bytes":5030,"sha256":"3b8778e9060a4ed4a6c3866ef5445a63e1414764aa52a693ade4d267756fd018"}];
const signature = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs, info.mode];
function readWhole(relative) {
  const file = path.join(repository, relative), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert.equal(before.isFile(), true); assert.ok(before.size >= 0n && before.size <= BigInt(maxBytes));
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(fd, bytes, position, bytes.length - position, position);
      assert.ok(count > 0); position += count;
    }
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, position), 0);
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true });
    assert.equal(named.isSymbolicLink(), false); assert.equal(named.isFile(), true);
    assert.deepEqual(signature(after), signature(before)); assert.deepEqual(signature(named), signature(before));
    return bytes;
  } finally { closeSync(fd); }
}
function oldWhole(row) {
  const bytes = inflateRawSync(Buffer.from(row.deflateRawBase64, 'base64'), { maxOutputLength: maxBytes });
  assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 });
  const blob = createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
  assert.equal(blob, row.gitBlobOid);
  return bytes;
}
function control(relative) {
  const expected = frozenControls.find(row => row.path === relative); assert.ok(expected);
  assert.deepEqual(identity(readWhole(relative)), { bytes: expected.bytes, sha256: expected.sha256 });
}
const compose = (file, bytes) => normalizeMbm001LegacyReuse(file, normalizeMbm002LegacyInputs(file, bytes));

test('有符号身份旧锁：三份当前整件精确逆回独立Source5e全字节且原文件不变', () => {
  assert.equal(LOCAL_LIBRARY_SIGNED_STAT_LEGACY_SOURCE, '5e96372f0dd99e08b1e2964d68ce234eb438bbdf');
  assert.equal(LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.length, 3);
  assert.deepEqual(LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.map(row => row.path).sort(),
    source5eWholeFiles.map(row => row.path).sort());
  for (const pinned of source5eWholeFiles) {
    const row = LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.find(value => value.path === pinned.path); assert.ok(row);
    const before = oldWhole(pinned), current = readWhole(row.path), preserved = Buffer.from(current);
    assert.deepEqual(identity(current), row.after); assert.deepEqual(identity(before), row.before);
    assert.equal(normalizeLocalLibrarySignedStatLegacyInput(row.path, before), before);
    const restored = normalizeLocalLibrarySignedStatLegacyInput(row.path, current);
    assert.notEqual(restored, current); assert.deepEqual(restored, before);
    assert.deepEqual(current, preserved); assert.deepEqual(readWhole(row.path), preserved);
    restored[0] ^= 1; assert.deepEqual(current, preserved); assert.deepEqual(readWhole(row.path), preserved);
  }
});

test('有符号身份旧锁：原002早返回与六项正文不变且三份逆回原000整件', () => {
  const importLine = "import { normalizeLocalLibrarySignedStatLegacyInput } from './local-library-signed-stat-legacy-normalization.mjs';\n";
  const inserted = "  try { bytes = normalizeLocalLibrarySignedStatLegacyInput(file, bytes); }\n  catch { return reject(); }\n";
  const currentAdapter = readWhole('scripts/ci/mbm002-legacy-input-normalization.mjs').toString('utf8');
  assert.equal(currentAdapter.split(importLine).length, 2); assert.equal(currentAdapter.split(inserted).length, 2);
  const adapterOriginal = Buffer.from(currentAdapter.replace(importLine, '').replace(inserted, ''));
  const adapterPin = frozenControls.find(row => row.path === 'scripts/ci/mbm002-legacy-input-normalization.mjs');
  assert.deepEqual(identity(adapterOriginal), { bytes: adapterPin.bytes, sha256: adapterPin.sha256 });
  const testImport = "import { normalizeLocalLibrarySignedStatLegacyInput } from '../local-library-signed-stat-legacy-normalization.mjs';\n";
  const currentOld = 'const current = async file => (await readMobileFile(path.join(repository, file), { maxBytes })).bytes;';
  const currentNew = 'const current = async file => normalizeLocalLibrarySignedStatLegacyInput(file, (await readMobileFile(path.join(repository, file), { maxBytes })).bytes);';
  const currentTest = readWhole('scripts/ci/test/mbm002-legacy-input-normalization.test.mjs').toString('utf8');
  assert.equal(currentTest.split(testImport).length, 2); assert.equal(currentTest.split(currentNew).length, 2);
  const testOriginal = Buffer.from(currentTest.replace(testImport, '').replace(currentNew, currentOld));
  const testPin = frozenControls.find(row => row.path === 'scripts/ci/test/mbm002-legacy-input-normalization.test.mjs');
  assert.deepEqual(identity(testOriginal), { bytes: testPin.bytes, sha256: testPin.sha256 });
  for (const row of frozenControls.filter(row => ![adapterPin.path, testPin.path].includes(row.path))) control(row.path);
  const lock = JSON.parse(readWhole('docs/postrust/MBM-000/INPUT_LOCK.json'));
  assert.equal(lock.macReusePoints.length, 22); assert.equal(lock.macReusePointCount, 22);
  assert.deepEqual(lock.originalTaskLedger, { tasks: 18, acceptanceCases: 156, effectiveTasks: 17,
    effectiveAcceptanceCases: 150, cancelled015SixCases: 'N_A' });
  for (const pinned of lock.macReusePoints) {
    const current = readWhole(pinned.path), preserved = Buffer.from(current);
    const source5e = source5eMacReuseIdentities.find(row => row.path === pinned.path); assert.ok(source5e);
    const row = LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.find(value => value.path === pinned.path);
    if (row) {
      const restored = normalizeLocalLibrarySignedStatLegacyInput(pinned.path, current);
      assert.deepEqual(identity(restored), { bytes: source5e.bytes, sha256: source5e.sha256 });
      assert.deepEqual(identity(compose(pinned.path, current)), { bytes: pinned.bytes, sha256: pinned.sha256 });
    } else {
      assert.deepEqual(identity(current), { bytes: source5e.bytes, sha256: source5e.sha256 });
      assert.equal(normalizeLocalLibrarySignedStatLegacyInput(pinned.path, current), current);
    }
    assert.deepEqual(current, preserved); assert.deepEqual(readWhole(pinned.path), preserved);
  }
  for (const pinned of source5eWholeFiles) {
    const source5e = oldWhole(pinned), oldRow = MBM002_LEGACY_INPUTS.find(row => row.path === pinned.path); assert.ok(oldRow);
    assert.deepEqual(identity(source5e), oldRow.after);
    const base002 = normalizeMbm002LegacyInputs(pinned.path, source5e);
    assert.deepEqual(identity(base002), oldRow.before);
    assert.equal(normalizeMbm002LegacyInputs(pinned.path, base002), base002);
    assert.throws(() => normalizeLocalLibrarySignedStatLegacyInput(pinned.path, base002), signedChanged);
    assert.deepEqual(normalizeMbm002LegacyInputs(pinned.path, readWhole(pinned.path)), base002);
  }
});

test('有符号身份旧锁：第三种整件与片段内外漂移拒绝且保留原002错误码', () => {
  for (const pinned of source5eWholeFiles) {
    const row = LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.find(value => value.path === pinned.path); assert.ok(row);
    for (const source of [oldWhole(pinned), readWhole(pinned.path)]) {
      const preserved = Buffer.from(source), positions = new Set([0, Math.floor(source.length / 2), source.length - 1,
        ...row.hunks.map(hunk => Math.min(hunk.offset, source.length - 1))]);
      for (const position of positions) {
        const mutation = Buffer.from(source); mutation[position] ^= 1;
        assert.throws(() => normalizeLocalLibrarySignedStatLegacyInput(row.path, mutation), signedChanged);
        assert.throws(() => normalizeMbm002LegacyInputs(row.path, mutation), oldChanged);
      }
      for (const mutation of [Buffer.alloc(0), source.subarray(0, source.length - 1),
        Buffer.concat([source, Buffer.from('\n')]), Buffer.concat([Buffer.from(' '), source])]) {
        assert.throws(() => normalizeLocalLibrarySignedStatLegacyInput(row.path, mutation), signedChanged);
        assert.throws(() => normalizeMbm002LegacyInputs(row.path, mutation), oldChanged);
      }
      assert.deepEqual(source, preserved);
    }
    const current = readWhole(row.path);
    for (const file of [null, './' + row.path, '../' + row.path, '/' + row.path,
      row.path.replaceAll('/', '\\'), row.path + '\0', row.path + '\n']) {
      assert.throws(() => normalizeLocalLibrarySignedStatLegacyInput(file, current), signedChanged);
    }
    for (const bytes of [current.toString('utf8'), new Uint8Array(current), null]) {
      assert.throws(() => normalizeLocalLibrarySignedStatLegacyInput(row.path, bytes), signedChanged);
    }
    // 原002的未列路径处理不扩权：它仍交给完整旧锁，不获得新路径豁免。
    assert.equal(normalizeMbm002LegacyInputs('./' + row.path, current), current);
  }
  const unlisted = 'packages/bridge-core/src/stream/local-file-http.ts', raw = readWhole(unlisted);
  const unknown = Buffer.from(raw); unknown[0] ^= 1;
  assert.equal(normalizeLocalLibrarySignedStatLegacyInput(unlisted, unknown), unknown);
  const lock = JSON.parse(readWhole('docs/postrust/MBM-000/INPUT_LOCK.json'));
  const pinned = lock.macReusePoints.find(row => row.path === unlisted); assert.ok(pinned);
  assert.notDeepEqual(identity(compose(unlisted, unknown)), { bytes: pinned.bytes, sha256: pinned.sha256 });
});

test('有符号身份旧锁：三路径身份表深冻结且九份当前源保持真实新字节', () => {
  assert.equal(Object.isFrozen(LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS), true);
  assert.equal(new Set(LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.map(row => row.path)).size, 3);
  assert.throws(() => LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.push({}), TypeError);
  for (const row of LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS) {
    for (const value of [row, row.before, row.after, row.hunks, ...row.hunks]) assert.equal(Object.isFrozen(value), true);
    assert.throws(() => { row.path = 'packages/bridge-core/src/collection/local-source-ticket-types.ts'; }, TypeError);
    assert.throws(() => { row.before.sha256 = '0'.repeat(64); }, TypeError);
    assert.throws(() => { row.after.bytes += 1; }, TypeError);
    assert.throws(() => row.hunks.push({}), TypeError);
    for (const hunk of row.hunks) {
      assert.throws(() => { hunk.offset += 1; }, TypeError);
      assert.throws(() => { hunk.before = ''; }, TypeError);
    }
  }
  assert.equal(productWholeIdentities.length, 12);
  for (const row of productWholeIdentities) {
    const current = readWhole(row.path); assert.deepEqual(identity(current), row.after);
    assert.notDeepEqual(identity(current), row.before);
    if (!LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.some(value => value.path === row.path)) {
      assert.equal(normalizeLocalLibrarySignedStatLegacyInput(row.path, current), current);
    }
    assert.deepEqual(identity(readWhole(row.path)), row.after);
  }
});
