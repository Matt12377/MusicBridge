import { createHash } from 'node:crypto';

// 仅把002已锁的完整复用字节在内存逆回BASE002；不修改文件、旧锁或真实新行为。
// 后续仍须normalizeMbm001LegacyReuse和原000完整锁校验；本模块不证明002运行成功。
export const MBM002_LEGACY_INPUT_BASE = '8044d935e242d8647adc21445116fb49c9100e4a';
export const MBM002_LEGACY_INPUTS = Object.freeze([
  {
    "path": "packages/bridge-core/src/application/local-source-resolver.ts",
    "task": "MBM-002",
    "before": {
      "bytes": 7966,
      "sha256": "400263aca9f161fba087984c905f45639c82903456dad1f33b77ad5a4a5f7d06"
    },
    "after": {
      "bytes": 8378,
      "sha256": "ba979c56513746bca0d8c353da880d0dde4fb77bc1d464367fb553bf54d38901"
    },
    "hunks": [
      {
        "offset": 2698,
        "after": "ZXhwb3J0IHR5cGUgTG9jYWxGYWN0U2VsZWN0aW9uID0gUGljazxMb2NhbFBsYXlSZXF1ZXN0LCAnbG9jYWxfdHJhY2tfaWQnIHwgJ2Fzc2V0X2lkJyB8ICdleHBlY3RlZF9hc3NldF9yZXZpc2lvbic+OwpmdW5jdGlvbiBmYWN0cyhyZXBvc2l0b3J5OiBDb2xsZWN0aW9uUmVwb3NpdG9yeSwgcmVxdWVzdDogTG9jYWxGYWN0U2VsZWN0aW9uKTogTG9jYWxTb3VyY2VGYWN0cyB7Cg==",
        "before": "ZnVuY3Rpb24gZmFjdHMocmVwb3NpdG9yeTogQ29sbGVjdGlvblJlcG9zaXRvcnksIHJlcXVlc3Q6IExvY2FsUGxheVJlcXVlc3QpOiBMb2NhbFNvdXJjZUZhY3RzIHsK"
      },
      {
        "offset": 5415,
        "after": "ICByZXR1cm4gY2FwdHVyZUxvY2FsRmFjdHNCeUlkZW50aXR5UmVhZG9ubHkocmVxdWVzdCwgcmVwb3NpdG9yeSk7Cn0KLyoqIOaJi+acuuivu+WPlueUseecn+WunuebruW9lei6q+S7veaOiOadg++8jOS4jeaehOmAoOWutuW6rSBSb29uIHRhcmdldCDmiJbliqjkvZzjgIIgKi8KZXhwb3J0IGZ1bmN0aW9uIGNhcHR1cmVMb2NhbEZhY3RzQnlJZGVudGl0eVJlYWRvbmx5KHJlcXVlc3Q6IExvY2FsRmFjdFNlbGVjdGlvbiwgcmVwb3NpdG9yeTogQ29sbGVjdGlvblJlcG9zaXRvcnkpOiBMb2NhbFNvdXJjZUZhY3RzIHsK",
        "before": ""
      }
    ]
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-domain.ts",
    "task": "MBM-002",
    "before": {
      "bytes": 27553,
      "sha256": "9028c07739174a5600fb3cd72f36dcc527c48e28a794d3aa2b84b88e90df90f9"
    },
    "after": {
      "bytes": 28465,
      "sha256": "bfa711441901daee3c84bc7a96fce1bc151b44724fb2ee4a43d6d9690a37b29a"
    },
    "hunks": [
      {
        "offset": 143,
        "after": "aW1wb3J0IHsgY3JlYXRlTW9iaWxlT3duZXJTb3VyY2VTZXJ2aWNlIH0gZnJvbSAnLi4vbW9iaWxlL3NvdXJjZS1zZXJ2aWNlLmpzJzsKaW1wb3J0IHsgaXNNb2JpbGVPd25lclByaXZhdGVSZXF1ZXN0IH0gZnJvbSAnLi4vbW9iaWxlL293bmVyLXByb3RvY29sLmpzJzsK",
        "before": ""
      },
      {
        "offset": 9315,
        "after": "ICBjb25zdCBtb2JpbGVTb3VyY2VzID0gY3JlYXRlTW9iaWxlT3duZXJTb3VyY2VTZXJ2aWNlKHsgY29sbGVjdGlvbiwgdGlja2V0czogbG9jYWxUaWNrZXRzLCBkYXRhc2V0SWQ6IGlkZW50aXR5LmRhdGFzZXRJZCwKICAgIG93bmVyRXBvY2g6IG9wdGlvbnMubG9jYWxTb3VyY2VFcG9jaCA/PyByYW5kb21VVUlEKCksIGFzc2VydEN1cnJlbnQ6ICgpID0+IHsKICAgICAgYXNzZXJ0T3BlbigpOyBpZiAoIXNjYW5Cb290UmVhZHkpIHRocm93IG5ldyBDb2xsZWN0aW9uRXJyb3IoJ0lOVkVOVE9SWV9VTkFWQUlMQUJMRScsICfnp7vliqjmupAgT3duZXIg5bCa5pyqIGNvbW1pdEJvb3TjgIInKTsKICAgIH0gfSk7Cg==",
        "before": ""
      },
      {
        "offset": 19707,
        "after": "ICAgICAgY29uc3QgcGVuZGluZyA9IFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gewogICAgICAgIGlmIChyZXF1ZXN0LmtpbmQgIT09ICdtZWRpYS1zb3VyY2UnKSByZXR1cm4gbW9iaWxlT3duZXIuZGlzcGF0Y2gocmVxdWVzdCk7CiAgICAgICAgaWYgKCFpc01vYmlsZU93bmVyUHJpdmF0ZVJlcXVlc3QocmVxdWVzdCkgfHwgcmVxdWVzdC5kYXRhc2V0SWQgIT09IGlkZW50aXR5LmRhdGFzZXRJZCkgcmV0dXJuIHsKICAgICAgICAgIGtpbmQ6ICdtb2JpbGUtZXJyb3InIGFzIGNvbnN0LCBzdGF0dXM6IDQwMCBhcyBjb25zdCwgY29kZTogJ0lOVkFMSURfUkVRVUVTVCcgYXMgY29uc3QsIHJldHJ5YWJsZTogZmFsc2UsIG91dGNvbWU6IG51bGwsCiAgICAgICAgfTsKICAgICAgICByZXR1cm4gbW9iaWxlU291cmNlcy5kaXNwYXRjaChyZXF1ZXN0LnJlcXVlc3QpOwogICAgICB9KTsK",
        "before": "ICAgICAgY29uc3QgcGVuZGluZyA9IFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gbW9iaWxlT3duZXIuZGlzcGF0Y2gocmVxdWVzdCkpOwo="
      },
      {
        "offset": 22994,
        "after": "ICAgICAgICBhd2FpdCBzdG9wKCgpID0+IG1vYmlsZVNvdXJjZXMuY2xvc2UoKSk7Cg==",
        "before": ""
      }
    ]
  },
  {
    "path": "packages/bridge-core/src/stream/local-file-source.ts",
    "task": "MBM-002",
    "before": {
      "bytes": 10847,
      "sha256": "eab1749c6d78ee5ebee704520d6d8570291ffdf7a160ce866312f52164d9684c"
    },
    "after": {
      "bytes": 11419,
      "sha256": "9a02dd349d7ca0952ac57920f26b57f607b556b08c554e4614f82be2683cfd82"
    },
    "hunks": [
      {
        "offset": 783,
        "after": "LyoqIOWbuuWumuS6i+WunueahOacgOWwj+WPquivu+aPj+i/sOespu+8m+WOnyBSb29uIOaPj+i/sOespuS7jea7oei2s+atpOWQiOWQjOOAgiAqLwpleHBvcnQgdHlwZSBSZWFkb25seUxvY2FsRmlsZURlc2NyaXB0b3IgPSBQaWNrPFByZXBhcmVkTG9jYWxTb3VyY2UsICdzb3VyY2Vfa2luZCcgfCAnc3RhdHVzJyB8ICdmYWN0cyc+Owo=",
        "before": ""
      },
      {
        "offset": 1434,
        "after": "ICBwcml2YXRlIGZhaWx1cmVDb2RlVmFsdWU6IExvY2FsRmlsZUxlYXNlRXJyb3JbJ2NvZGUnXSB8IG51bGwgPSBudWxsOwo=",
        "before": ""
      },
      {
        "offset": 1878,
        "after": "ICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGZpbGU6IE9wZW5lZFNvdXJjZSwgZGVzY3JpcHRvcjogUmVhZG9ubHlMb2NhbEZpbGVEZXNjcmlwdG9yLCBwcml2YXRlIHJlYWRvbmx5IGF1dGhvcml0eTogTG9jYWxMZWFzZUF1dGhvcml0eSwK",
        "before": "ICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGZpbGU6IE9wZW5lZFNvdXJjZSwgZGVzY3JpcHRvcjogUHJlcGFyZWRMb2NhbFNvdXJjZSwgcHJpdmF0ZSByZWFkb25seSBhdXRob3JpdHk6IExvY2FsTGVhc2VBdXRob3JpdHksCg=="
      },
      {
        "offset": 2979,
        "after": "ICBnZXQgZmFpbHVyZUNvZGUoKTogTG9jYWxGaWxlTGVhc2VFcnJvclsnY29kZSddIHwgbnVsbCB7IHJldHVybiB0aGlzLmZhaWx1cmVDb2RlVmFsdWU7IH0K",
        "before": ""
      },
      {
        "offset": 4736,
        "after": "ICAgIGNhdGNoIChlcnJvcikgewogICAgICBjb25zdCBmYWlsdXJlID0gZXJyb3IgaW5zdGFuY2VvZiBMb2NhbEZpbGVMZWFzZUVycm9yID8gZXJyb3IgOiBuZXcgTG9jYWxGaWxlTGVhc2VFcnJvcignU09VUkNFX0NIQU5HRUQnKTsKICAgICAgLy8g5YWI5bCB5a2Y5Y6f5aSx6LSl56CB77yM5YaN6Kem5Y+RYWJvcnTvvJvlkI7lj7DpgIDkvJHnmoTnm5HlkKzmlrnkuI3lvpfmiormupDlj5jljJbor6/orrDkuLrmmL7lvI/ph4rmlL7jgIIKICAgICAgdGhpcy5mYWlsdXJlQ29kZVZhbHVlID8/PSBmYWlsdXJlLmNvZGU7CiAgICAgIHZvaWQgdGhpcy5jbG9zZSgpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7IHRocm93IGZhaWx1cmU7CiAgICB9Cg==",
        "before": "ICAgIGNhdGNoIChlcnJvcikgeyB2b2lkIHRoaXMuY2xvc2UoKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpOyBpZiAoZXJyb3IgaW5zdGFuY2VvZiBMb2NhbEZpbGVMZWFzZUVycm9yKSB0aHJvdyBlcnJvcjsgdGhyb3cgbmV3IExvY2FsRmlsZUxlYXNlRXJyb3IoJ1NPVVJDRV9DSEFOR0VEJyk7IH0K"
      },
      {
        "offset": 7845,
        "after": "ICBhc3luYyBwcmVwYXJlKGRlc2NyaXB0b3I6IFJlYWRvbmx5TG9jYWxGaWxlRGVzY3JpcHRvciwgYXV0aG9yaXR5OiBMb2NhbExlYXNlQXV0aG9yaXR5KTogUHJvbWlzZTxBc3NldExlYXNlPiB7Cg==",
        "before": "ICBhc3luYyBwcmVwYXJlKGRlc2NyaXB0b3I6IFByZXBhcmVkTG9jYWxTb3VyY2UsIGF1dGhvcml0eTogTG9jYWxMZWFzZUF1dGhvcml0eSk6IFByb21pc2U8QXNzZXRMZWFzZT4gewo="
      },
      {
        "offset": 8163,
        "after": "ICBwcml2YXRlIGFzeW5jIHByZXBhcmVJbnRlcm5hbChkZXNjcmlwdG9yOiBSZWFkb25seUxvY2FsRmlsZURlc2NyaXB0b3IsIGF1dGhvcml0eTogTG9jYWxMZWFzZUF1dGhvcml0eSk6IFByb21pc2U8QXNzZXRMZWFzZT4gewo=",
        "before": "ICBwcml2YXRlIGFzeW5jIHByZXBhcmVJbnRlcm5hbChkZXNjcmlwdG9yOiBQcmVwYXJlZExvY2FsU291cmNlLCBhdXRob3JpdHk6IExvY2FsTGVhc2VBdXRob3JpdHkpOiBQcm9taXNlPEFzc2V0TGVhc2U+IHsK"
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
  const error = new Error('002旧输入适配只接受完整已锁的原字节或新字节。');
  error.code = 'MBM002_LEGACY_INPUT_CHANGED'; throw error;
};

/** 未列出的文件原样交给旧锁；已列路径的第三种内容一律拒绝，不能只凭片段匹配放行。 */
export function normalizeMbm002LegacyInputs(file, bytes) {
  if (typeof file !== 'string' || !Buffer.isBuffer(bytes)) return reject();
  const row = MBM002_LEGACY_INPUTS.find(value => value.path === file);
  if (!row || matches(bytes, row.before)) return bytes;
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
