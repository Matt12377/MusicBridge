import { createHash } from 'node:crypto';

// 只在旧锁比较时把本次已冻结的三份只读修复整件逆回Source5e；不修改磁盘。
// 真实Scanner、Reader、编译和运行证据必须使用当前字节；本模块不证明任何产品行为或写资格。
export const LOCAL_LIBRARY_SIGNED_STAT_LEGACY_SOURCE = '5e96372f0dd99e08b1e2964d68ce234eb438bbdf';
export const LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS = Object.freeze([
  {
    "path": "packages/bridge-core/src/application/local-source-resolver.ts",
    "before": {
      "bytes": 8378,
      "sha256": "ba979c56513746bca0d8c353da880d0dde4fb77bc1d464367fb553bf54d38901"
    },
    "after": {
      "bytes": 8424,
      "sha256": "3fc6087d0e4cb14edb2d0eab65917ce479a688cb71a9a88fc07d50ff0f4fb4c5"
    },
    "hunks": [
      {
        "offset": 2416,
        "after": "ICAgICYmIHR5cGVvZiByLmRldiA9PT0gJ3N0cmluZycgJiYgL14oMHxbMS05XVswLTldezAsMzF9fC1bMS05XVswLTldezAsMzB9KSQvdS50ZXN0KHIuZGV2KSAmJiByLmRldi5sZW5ndGggPD0gMzIKICAgICYmIHR5cGVvZiByLmlubyA9PT0gJ3N0cmluZycgJiYgL14oMHxbMS05XVswLTldezAsMzF9fC1bMS05XVswLTldezAsMzB9KSQvdS50ZXN0KHIuaW5vKSAmJiByLmluby5sZW5ndGggPD0gMzIK",
        "before": "ICAgICYmIHR5cGVvZiByLmRldiA9PT0gJ3N0cmluZycgJiYgL14oMHxbMS05XVswLTldKikkL3UudGVzdChyLmRldikgJiYgci5kZXYubGVuZ3RoIDw9IDMyCiAgICAmJiB0eXBlb2Ygci5pbm8gPT09ICdzdHJpbmcnICYmIC9eKDB8WzEtOV1bMC05XSopJC91LnRlc3Qoci5pbm8pICYmIHIuaW5vLmxlbmd0aCA8PSAzMgo="
      }
    ]
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
    },
    "hunks": [
      {
        "offset": 9136,
        "after": "ICAgICAgfHwgIS9eKDB8WzEtOV1bMC05XXswLDMxfXwtWzEtOV1bMC05XXswLDMwfSk6KDB8WzEtOV1bMC05XXswLDMxfXwtWzEtOV1bMC05XXswLDMwfSk6XGQrOi0/XGQrOi0/XGQrJC91LnRlc3Qob2JzZXJ2YXRpb24uc2lnbmF0dXJlKSB8fCBvYnNlcnZhdGlvbi5hc3NldElkICE9PSBhc3NldC5pZCB8fCBvYnNlcnZhdGlvbi50cmFja0lkICE9PSB0cmFjay5pZAo=",
        "before": "ICAgICAgfHwgIS9eXGQrOlxkKzpcZCs6LT9cZCs6LT9cZCskL3UudGVzdChvYnNlcnZhdGlvbi5zaWduYXR1cmUpIHx8IG9ic2VydmF0aW9uLmFzc2V0SWQgIT09IGFzc2V0LmlkIHx8IG9ic2VydmF0aW9uLnRyYWNrSWQgIT09IHRyYWNrLmlkCg=="
      }
    ]
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
    },
    "hunks": [
      {
        "offset": 27213,
        "after": "ICAgICAgfHwgdHlwZW9mIGV4cGVjdGVkU2lnbmF0dXJlICE9PSAnc3RyaW5nJyB8fCBleHBlY3RlZFNpZ25hdHVyZS5sZW5ndGggPiAyNTYgfHwgIS9eKDB8WzEtOV1bMC05XXswLDMxfXwtWzEtOV1bMC05XXswLDMwfSk6KDB8WzEtOV1bMC05XXswLDMxfXwtWzEtOV1bMC05XXswLDMwfSk6XGQrOi0/XGQrOi0/XGQrJC91LnRlc3QoZXhwZWN0ZWRTaWduYXR1cmUpKSByZXR1cm4gZmFsc2U7Cg==",
        "before": "ICAgICAgfHwgdHlwZW9mIGV4cGVjdGVkU2lnbmF0dXJlICE9PSAnc3RyaW5nJyB8fCBleHBlY3RlZFNpZ25hdHVyZS5sZW5ndGggPiAyNTYgfHwgIS9eXGQrOlxkKzpcZCs6LT9cZCs6LT9cZCskL3UudGVzdChleHBlY3RlZFNpZ25hdHVyZSkpIHJldHVybiBmYWxzZTsK"
      }
    ]
  }
].map(row => Object.freeze({
  ...row, before: Object.freeze(row.before), after: Object.freeze(row.after),
  hunks: Object.freeze(row.hunks.map(hunk => Object.freeze(hunk))),
})));

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, identity) => bytes.length === identity.bytes && sha(bytes) === identity.sha256;
const reject = () => {
  const error = new Error('有符号文件身份旧输入适配只接受完整已锁的Source5e整件或本次修复整件。');
  error.code = 'LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUT_CHANGED'; throw error;
};
const relativePath = file => typeof file === 'string'
  && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(file)
  && file.split('/').every(part => part !== '.' && part !== '..');

/** 未列出的规范相对路径仍由后续原锁认证；已列路径不接受第三种输入。 */
export function normalizeLocalLibrarySignedStatLegacyInput(file, bytes) {
  if (!relativePath(file) || !Buffer.isBuffer(bytes)) return reject();
  const row = LOCAL_LIBRARY_SIGNED_STAT_LEGACY_INPUTS.find(value => value.path === file);
  if (!row || matches(bytes, row.before)) return bytes;
  // 必须先认证整个输入，不能只凭一个可匹配的修改窗口授予豁免。
  if (!matches(bytes, row.after)) return reject();
  let restored = Buffer.from(bytes);
  for (const hunk of [...row.hunks].reverse()) {
    const after = Buffer.from(hunk.after, 'base64');
    if (!restored.subarray(hunk.offset, hunk.offset + after.length).equals(after)) return reject();
    restored = Buffer.concat([restored.subarray(0, hunk.offset), Buffer.from(hunk.before, 'base64'),
      restored.subarray(hunk.offset + after.length)]);
  }
  if (!matches(restored, row.before)) return reject();
  return restored;
}
