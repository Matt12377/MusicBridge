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
  },
  {
    "path": "packages/bridge-core/src/recording/source-files.ts",
    "task": "MBM-002",
    "before": {
      "bytes": 42398,
      "sha256": "1012b602ea9b3641e41da391b3c1d268ec39bf9029bf548441358daa73f06fc9"
    },
    "after": {
      "bytes": 46087,
      "sha256": "8316723b6d3a8b90770d4ca2df3ddb4c998e73f89997afe674cc6ac3a1b47be1"
    },
    "hunks": [
      {
        "offset": 42,
        "after": "aW1wb3J0IHsgY2xvc2VTeW5jLCBjb25zdGFudHMsIGZzdGF0U3luYywgbHN0YXRTeW5jLCBvcGVuU3luYywgcmVhZFN5bmMsIHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnOwo=",
        "before": "aW1wb3J0IHsgY29uc3RhbnRzIH0gZnJvbSAnbm9kZTpmcyc7Cg=="
      },
      {
        "offset": 26512,
        "after": "ZXhwb3J0IGNsYXNzIFNvdXJjZUNhdGFsb2dSZWxlYXNlRXJyb3IgZXh0ZW5kcyBFcnJvciB7IGNvbnN0cnVjdG9yKCkgeyBzdXBlcign55uu5b2V6LWE5qC855qE5Y+q6K+75Y+l5p+E5YWz6Zet5bCa5pyq56Gu6K6k44CCJyk7IH0gfQovKiogT3duZXIg55uu5b2V55qE5Y2z5pe25Y+q6K+76LWE5qC877yb5pyA5aSa6K+7IDEyIOWtl+iKgu+8jOS4jeetvuelqOaNruOAgeS4jeS/neeVmSBGRO+8jOS5n+S4jeS7o+abv+ecn+atoyBwcmVwYXJlIOeahOS/neaKpOenn+e6puOAgiAqLwpleHBvcnQgZnVuY3Rpb24gcmVhZG9ubHlTb3VyY2VDYXRhbG9nRmlsZUF2YWlsYWJsZShyb290OiBSb290Q2FwYWJpbGl0eSwgcmVsYXRpdmU6IHN0cmluZywgZXhwZWN0ZWRTaWduYXR1cmU6IHN0cmluZywKICBwY21IZWFkZXI/OiAnV0FWRScgfCAnQUlGRicpOiBib29sZWFuIHsKICBsZXQgZGVzY3JpcHRvcjogbnVtYmVyIHwgdW5kZWZpbmVkOwogIHRyeSB7CiAgICBpZiAoIXJvb3QuYXV0aG9yaXplZCB8fCAhcGF0aC5pc0Fic29sdXRlKHJvb3QucGF0aCkgfHwgcm9vdC5wYXRoID09PSBwYXRoLnBhcnNlKHJvb3QucGF0aCkucm9vdAogICAgICB8fCB0eXBlb2YgcmVsYXRpdmUgIT09ICdzdHJpbmcnIHx8IHJlbGF0aXZlLmxlbmd0aCA+IDQwOTYgfHwgcmVsYXRpdmUuaW5jbHVkZXMoJ1wwJykgfHwgcGF0aC5pc0Fic29sdXRlKHJlbGF0aXZlKQogICAgICB8fCB0eXBlb2YgZXhwZWN0ZWRTaWduYXR1cmUgIT09ICdzdHJpbmcnIHx8IGV4cGVjdGVkU2lnbmF0dXJlLmxlbmd0aCA+IDI1NiB8fCAhL15cZCs6XGQrOlxkKzotP1xkKzotP1xkKyQvdS50ZXN0KGV4cGVjdGVkU2lnbmF0dXJlKSkgcmV0dXJuIGZhbHNlOwogICAgY29uc3QgcGFydHMgPSByZWxhdGl2ZS5zcGxpdChwYXRoLnNlcCk7CiAgICBpZiAocGFydHMubGVuZ3RoID4gMjU2IHx8IHBhcnRzLnNvbWUocGFydCA9PiAhcGFydCB8fCBwYXJ0ID09PSAnLicgfHwgcGFydCA9PT0gJy4uJykpIHJldHVybiBmYWxzZTsKICAgIGNvbnN0IG5hbWVkID0gKCkgPT4gewogICAgICBjb25zdCByb290SW5mbyA9IGxzdGF0U3luYyhyb290LnBhdGgsIHsgYmlnaW50OiB0cnVlIH0pOwogICAgICBpZiAoIXJvb3QuYXV0aG9yaXplZCB8fCAhcm9vdEluZm8uaXNEaXJlY3RvcnkoKSB8fCByb290SW5mby5pc1N5bWJvbGljTGluaygpIHx8IFN0cmluZyhyb290SW5mby5kZXYpICE9PSByb290LmRldgogICAgICAgIHx8IFN0cmluZyhyb290SW5mby5pbm8pICE9PSByb290LmlubyB8fCByZWFscGF0aFN5bmMocm9vdC5wYXRoKSAhPT0gcm9vdC5wYXRoKSByZXR1cm4gZmFpbCgnU09VUkNFX1JPT1RfT0ZGTElORScpOwogICAgICBjb25zdCBpZGVudGl0eSA9IChpbmZvOiBCaWdJbnRTdGF0cykgPT4gYCR7ZGlyZWN0b3J5SWRlbnRpdHkoaW5mbyl9OiR7aW5mby5iaXJ0aHRpbWVOc306JHtpbmZvLm1vZGV9YDsKICAgICAgY29uc3QgZGlyZWN0b3J5SWRzID0gW2lkZW50aXR5KHJvb3RJbmZvKV07CiAgICAgIGxldCBhYnNvbHV0ZSA9IHJvb3QucGF0aDsKICAgICAgZm9yIChjb25zdCBbaW5kZXgsIHBhcnRdIG9mIHBhcnRzLmVudHJpZXMoKSkgewogICAgICAgIGFic29sdXRlID0gcGF0aC5qb2luKGFic29sdXRlLCBwYXJ0KTsKICAgICAgICBjb25zdCBpbmZvID0gbHN0YXRTeW5jKGFic29sdXRlLCB7IGJpZ2ludDogdHJ1ZSB9KTsKICAgICAgICBpZiAoaW5mby5pc1N5bWJvbGljTGluaygpIHx8IChpbmRleCA8IHBhcnRzLmxlbmd0aCAtIDEgPyAhaW5mby5pc0RpcmVjdG9yeSgpIDogIWluZm8uaXNGaWxlKCkpKSByZXR1cm4gZmFpbCgnT1VUU0lERV9ST09UJyk7CiAgICAgICAgaWYgKGluZGV4IDwgcGFydHMubGVuZ3RoIC0gMSkgZGlyZWN0b3J5SWRzLnB1c2goaWRlbnRpdHkoaW5mbykpOwogICAgICAgIGVsc2UgewogICAgICAgICAgaWYgKHJlYWxwYXRoU3luYyhhYnNvbHV0ZSkgIT09IGFic29sdXRlKSByZXR1cm4gZmFpbCgnT1VUU0lERV9ST09UJyk7CiAgICAgICAgICByZXR1cm4geyBhYnNvbHV0ZSwgaW5mbywgZGlyZWN0b3J5SWRzIH07CiAgICAgICAgfQogICAgICB9CiAgICAgIHJldHVybiBmYWlsKCdPVVRTSURFX1JPT1QnKTsKICAgIH07CiAgICBjb25zdCBiZWZvcmUgPSBuYW1lZCgpOwogICAgaWYgKHNpZ25hdHVyZShiZWZvcmUuaW5mbykgIT09IGV4cGVjdGVkU2lnbmF0dXJlIHx8IGJlZm9yZS5pbmZvLnNpemUgPCAxbiB8fCBiZWZvcmUuaW5mby5zaXplID4gNjhfNzE5XzQ3Nl83MzZuKSByZXR1cm4gZmFsc2U7CiAgICAvLyDpnZ7pmLvloZ7moIflv5fkv53or4Hlkb3lkI3nq57kuonmm7/mjaLmiJAgRklGTyDnrYnnibnmrormlofku7bml7bvvIznm67lvZXor7fmsYLkuI3kvJrnrYnlvoXlj6bkuIDnq6/jgIIKICAgIGRlc2NyaXB0b3IgPSBvcGVuU3luYyhiZWZvcmUuYWJzb2x1dGUsIGNvbnN0YW50cy5PX1JET05MWSB8IGNvbnN0YW50cy5PX05PRk9MTE9XIHwgY29uc3RhbnRzLk9fTk9OQkxPQ0spOwogICAgY29uc3Qgb3BlbmVkID0gZnN0YXRTeW5jKGRlc2NyaXB0b3IsIHsgYmlnaW50OiB0cnVlIH0pOwogICAgaWYgKCFvcGVuZWQuaXNGaWxlKCkgfHwgc2lnbmF0dXJlKG9wZW5lZCkgIT09IGV4cGVjdGVkU2lnbmF0dXJlIHx8IG9wZW5lZC5iaXJ0aHRpbWVOcyAhPT0gYmVmb3JlLmluZm8uYmlydGh0aW1lTnMpIHJldHVybiBmYWxzZTsKICAgIGlmIChwY21IZWFkZXIgIT09IHVuZGVmaW5lZCkgewogICAgICBjb25zdCBoZWFkID0gQnVmZmVyLmFsbG9jKDEyKTsKICAgICAgaWYgKHJlYWRTeW5jKGRlc2NyaXB0b3IsIGhlYWQsIDAsIGhlYWQubGVuZ3RoLCAwKSAhPT0gaGVhZC5sZW5ndGgpIHJldHVybiBmYWxzZTsKICAgICAgY29uc3QgbWFnaWMgPSBoZWFkLnN1YmFycmF5KDAsIDQpLnRvU3RyaW5nKCdhc2NpaScpLCBraW5kID0gaGVhZC5zdWJhcnJheSg4LCAxMikudG9TdHJpbmcoJ2FzY2lpJyk7CiAgICAgIGlmIChwY21IZWFkZXIgPT09ICdXQVZFJyA/IG1hZ2ljICE9PSAnUklGRicgfHwga2luZCAhPT0gJ1dBVkUnIDogbWFnaWMgIT09ICdGT1JNJyB8fCBraW5kICE9PSAnQUlGRicpIHJldHVybiBmYWxzZTsKICAgIH0KICAgIGNvbnN0IGFjdHVhbCA9IGZzdGF0U3luYyhkZXNjcmlwdG9yLCB7IGJpZ2ludDogdHJ1ZSB9KSwgYWZ0ZXIgPSBuYW1lZCgpOwogICAgcmV0dXJuIGFjdHVhbC5pc0ZpbGUoKSAmJiBzaWduYXR1cmUoYWN0dWFsKSA9PT0gZXhwZWN0ZWRTaWduYXR1cmUgJiYgc2lnbmF0dXJlKGFmdGVyLmluZm8pID09PSBleHBlY3RlZFNpZ25hdHVyZQogICAgICAmJiBhY3R1YWwuYmlydGh0aW1lTnMgPT09IG9wZW5lZC5iaXJ0aHRpbWVOcyAmJiBhZnRlci5pbmZvLmJpcnRodGltZU5zID09PSBvcGVuZWQuYmlydGh0aW1lTnMKICAgICAgJiYgSlNPTi5zdHJpbmdpZnkoYWZ0ZXIuZGlyZWN0b3J5SWRzKSA9PT0gSlNPTi5zdHJpbmdpZnkoYmVmb3JlLmRpcmVjdG9yeUlkcyk7CiAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfQogIGZpbmFsbHkgewogICAgaWYgKGRlc2NyaXB0b3IgIT09IHVuZGVmaW5lZCkgewogICAgICB0cnkgeyBjbG9zZVN5bmMoZGVzY3JpcHRvcik7IH0KICAgICAgY2F0Y2ggeyB0aHJvdyBuZXcgU291cmNlQ2F0YWxvZ1JlbGVhc2VFcnJvcigpOyB9CiAgICB9CiAgfQp9Cg==",
        "before": ""
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
