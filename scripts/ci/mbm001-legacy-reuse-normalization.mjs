import { createHash } from 'node:crypto';

// 001必要接线的完整新字节先锁定，再按确定的字节窗口逆回000原片段；不替换工作树。
export const MBM001_LEGACY_REUSE = Object.freeze([
  {
    "path": "packages/bridge-core/src/collection/dataset-owner-client.ts",
    "task": "MBM-001",
    "before": {
      "bytes": 21890,
      "sha256": "a14c8140aa4712782760d9565a240d5bfbf6855834f4edcf63addfe76a50fac3"
    },
    "after": {
      "bytes": 22836,
      "sha256": "cef49cbb448c1283b82e61ed1962dff79106c56d505d372a4f0be726421ec86c"
    },
    "hunks": [
      {
        "offset": 570,
        "after": "aW1wb3J0IHsgaXNNb2JpbGVPd25lclByaXZhdGVSZXF1ZXN0LCBpc01vYmlsZU93bmVyUHJpdmF0ZVJlc3VsdCB9IGZyb20gJy4uL21vYmlsZS9vd25lci1wcm90b2NvbC5qcyc7CmltcG9ydCB0eXBlIHsgTW9iaWxlT3duZXJQcml2YXRlUmVxdWVzdCwgTW9iaWxlT3duZXJQcml2YXRlUmVzdWx0IH0gZnJvbSAnLi4vbW9iaWxlL3R5cGVzLmpzJzsK",
        "before": ""
      },
      {
        "offset": 2614,
        "after": "ICBtb2JpbGU/OiBNb2JpbGVPd25lclByaXZhdGVSZXF1ZXN0Owo=",
        "before": ""
      },
      {
        "offset": 5267,
        "after": "ICBmdW5jdGlvbiBycGMob3BlcmF0aW9uOiBEYXRhc2V0T3duZXJPcGVyYXRpb24sIHJlcXVlc3Q/OiBJcGNSZXF1ZXN0LCBleHBlY3RlZERhdGFzZXRJZD86IHN0cmluZywgbG9jYWw/OiBMb2NhbFNvdXJjZVByaXZhdGVQYXlsb2FkLCBxdWV1ZT86IE1CUXVldWVTYXZlUmVxdWVzdCwgZWRpdGlvbj86TUJFZGl0aW9uUXVldWVSZXF1ZXN0LCBtb2JpbGU/OiBNb2JpbGVPd25lclByaXZhdGVSZXF1ZXN0KTogUHJvbWlzZTx1bmtub3duPiB7Cg==",
        "before": "ICBmdW5jdGlvbiBycGMob3BlcmF0aW9uOiBEYXRhc2V0T3duZXJPcGVyYXRpb24sIHJlcXVlc3Q/OiBJcGNSZXF1ZXN0LCBleHBlY3RlZERhdGFzZXRJZD86IHN0cmluZywgbG9jYWw/OiBMb2NhbFNvdXJjZVByaXZhdGVQYXlsb2FkLCBxdWV1ZT86IE1CUXVldWVTYXZlUmVxdWVzdCwgZWRpdGlvbj86TUJFZGl0aW9uUXVldWVSZXF1ZXN0KTogUHJvbWlzZTx1bmtub3duPiB7Cg=="
      },
      {
        "offset": 5802,
        "after": "ICAgICAgc2VxdWVuY2U6ICsrc2VxdWVuY2UsIG9wZXJhdGlvbiwgLi4uKG1vYmlsZSA9PT0gdW5kZWZpbmVkID8ge30gOiB7IG1vYmlsZSB9KSwgLi4uKGxvY2FsID09PSB1bmRlZmluZWQgPyB7fSA6IHsgbG9jYWwgfSksIC4uLihxdWV1ZSA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHF1ZXVlIH0pLCAuLi4oZWRpdGlvbiA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGVkaXRpb24gfSksIC4uLihyZXF1ZXN0ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgcmVxdWVzdCB9KSwK",
        "before": "ICAgICAgc2VxdWVuY2U6ICsrc2VxdWVuY2UsIG9wZXJhdGlvbiwgLi4uKGxvY2FsID09PSB1bmRlZmluZWQgPyB7fSA6IHsgbG9jYWwgfSksIC4uLihxdWV1ZSA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHF1ZXVlIH0pLCAuLi4oZWRpdGlvbiA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGVkaXRpb24gfSksIC4uLihyZXF1ZXN0ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgcmVxdWVzdCB9KSwK"
      },
      {
        "offset": 6192,
        "after": "ICAgICAgY29uc3QgaXRlbTogUGVuZGluZ1JlcXVlc3QgPSB7IG9wZXJhdGlvbiwgc2VudDogZmFsc2UsIHJlc29sdmUsIHJlamVjdCwgLi4uKG1vYmlsZSA9PT0gdW5kZWZpbmVkID8ge30gOiB7IG1vYmlsZSB9KSwK",
        "before": "ICAgICAgY29uc3QgaXRlbTogUGVuZGluZ1JlcXVlc3QgPSB7IG9wZXJhdGlvbiwgc2VudDogZmFsc2UsIHJlc29sdmUsIHJlamVjdCwK"
      },
      {
        "offset": 9569,
        "after": "ICAgIGlmIChtZXNzYWdlLm9rICYmIG1lc3NhZ2Uub3BlcmF0aW9uID09PSAnbW9iaWxlTWFpbicgJiYgKCFpdGVtLm1vYmlsZSB8fCAhaXNNb2JpbGVPd25lclByaXZhdGVSZXN1bHQobWVzc2FnZS5yZXN1bHQsIGl0ZW0ubW9iaWxlKSkpIHsgZmF0YWwoJ3Byb3RvY29sLWZhaWx1cmUnKTsgcmV0dXJuOyB9Cg==",
        "before": ""
      },
      {
        "offset": 16961,
        "after": "ICAgIG1vYmlsZU1haW4ocmVxdWVzdCkgewogICAgICBpZiAoIWlkZW50aXR5IHx8ICFib290Q29tbWl0dGVkIHx8IGNsb3NpbmcgfHwgZmFpbGVkIHx8IGV4aXRlZCB8fCAhaXNNb2JpbGVPd25lclByaXZhdGVSZXF1ZXN0KHJlcXVlc3QpIHx8IHJlcXVlc3QuZGF0YXNldElkICE9PSBpZGVudGl0eS5kYXRhc2V0SWQpIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRGF0YXNldE93bmVyVHJhbnNwb3J0RXJyb3IoJ25vdC1zZW50JykpOwogICAgICByZXR1cm4gcnBjKCdtb2JpbGVNYWluJywgdW5kZWZpbmVkLCBpZGVudGl0eS5kYXRhc2V0SWQsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHJlcXVlc3QpLnRoZW4odmFsdWUgPT4gdmFsdWUgYXMgTW9iaWxlT3duZXJQcml2YXRlUmVzdWx0KTsKICAgIH0sCg==",
        "before": ""
      }
    ]
  },
  {
    "path": "packages/bridge-core/src/collection/dataset-domain.ts",
    "task": "MBM-001",
    "before": {
      "bytes": 26961,
      "sha256": "bd839ee6f8d279d3171e48b7d0036ecc30714186dfa70d2194ceb07fe1445bcf"
    },
    "after": {
      "bytes": 27553,
      "sha256": "9028c07739174a5600fb3cd72f36dcc527c48e28a794d3aa2b84b88e90df90f9"
    },
    "hunks": [
      {
        "offset": 72,
        "after": "aW1wb3J0IHsgY3JlYXRlTW9iaWxlT3duZXJTZXJ2aWNlIH0gZnJvbSAnLi4vbW9iaWxlL293bmVyLXNlcnZpY2UuanMnOwo=",
        "before": ""
      },
      {
        "offset": 8641,
        "after": "ICBjb25zdCBtb2JpbGVPd25lciA9IGNyZWF0ZU1vYmlsZU93bmVyU2VydmljZSh7IGNvbGxlY3Rpb24sIGRhdGFzZXRJZDogaWRlbnRpdHkuZGF0YXNldElkLCBvd25lckVwb2NoOiBvcHRpb25zLmxvY2FsU291cmNlRXBvY2ggPz8gcmFuZG9tVVVJRCgpLAogICAgYXNzZXJ0Q3VycmVudDogKCkgPT4geyBhc3NlcnRPcGVuKCk7IGlmICghc2NhbkJvb3RSZWFkeSkgdGhyb3cgbmV3IENvbGxlY3Rpb25FcnJvcignSU5WRU5UT1JZX1VOQVZBSUxBQkxFJywgJ+enu+WKqCBPd25lciDlsJrmnKogY29tbWl0Qm9vdOOAgicpOyB9IH0pOwo=",
        "before": ""
      },
      {
        "offset": 19175,
        "after": "ICAgIH0sCiAgICBtb2JpbGVNYWluKHJlcXVlc3QpIHsKICAgICAgY29uc3QgcGVuZGluZyA9IFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gbW9iaWxlT3duZXIuZGlzcGF0Y2gocmVxdWVzdCkpOwogICAgICBwZW5kaW5nRGlzcGF0Y2hlcy5hZGQocGVuZGluZyk7IHJldHVybiBwZW5kaW5nLmZpbmFsbHkoKCkgPT4gcGVuZGluZ0Rpc3BhdGNoZXMuZGVsZXRlKHBlbmRpbmcpKTsK",
        "before": ""
      }
    ]
  },
  {
    "path": "packages/bridge-core/src/collection/local-catalog-store.ts",
    "task": "MBM-001",
    "before": {
      "bytes": 111852,
      "sha256": "33f711a804800e3fd49d1bd052c1a68f33d46dcad34f9586c7133051267248f9"
    },
    "after": {
      "bytes": 115384,
      "sha256": "4485d96516b807433c0a3e318ebc662738ed9281431840feb29546025e7040ab"
    },
    "hunks": [
      {
        "offset": 165,
        "after": "aW1wb3J0IHsgTW9iaWxlU2VydmljZUVycm9yIH0gZnJvbSAnLi4vbW9iaWxlL3R5cGVzLmpzJzsK",
        "before": ""
      },
      {
        "offset": 105633,
        "after": "ICAgIC8qKiDnp7vliqjlj6ror7vlgJnpgInlpI3nlKjljp8gZWZmZWN0aXZlL3JhdyDmipXlvbHvvJvkuI3lop7lhazlvIDlkb3ku6TvvIzkuI3mlrDlvIDov57mjqXjgIIgKi8KICAgIHByaXZhdGVNb2JpbGVDYW5kaWRhdGVzKHBhZ2U6IHsga2luZDogJ2FsYnVtcycgfCAndHJhY2tzJzsgb2Zmc2V0OiBudW1iZXI7IGxpbWl0OiBudW1iZXI7IHF1ZXJ5OiBzdHJpbmc7IGVkaXRpb25JZDogc3RyaW5nIHwgbnVsbDsgdHJhY2tJZDogc3RyaW5nIHwgbnVsbCB9KTogeyB0b3RhbDogbnVtYmVyOyBpdGVtczogeyBlZGl0aW9uSWQ6IHN0cmluZzsgdHJhY2tJZDogc3RyaW5nIH1bXSB9IHsKICAgICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihwYWdlLm9mZnNldCkgfHwgcGFnZS5vZmZzZXQgPCAwIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihwYWdlLmxpbWl0KSB8fCBwYWdlLmxpbWl0IDwgMSB8fCBwYWdlLmxpbWl0ID4gMTAwCiAgICAgICAgfHwgdHlwZW9mIHBhZ2UucXVlcnkgIT09ICdzdHJpbmcnIHx8IFsuLi5wYWdlLnF1ZXJ5XS5sZW5ndGggPiAyMDAgfHwgcGFnZS5lZGl0aW9uSWQgIT09IG51bGwgJiYgIWR0by5pc0NvbGxlY3Rpb25JZChwYWdlLmVkaXRpb25JZCkKICAgICAgICB8fCBwYWdlLnRyYWNrSWQgIT09IG51bGwgJiYgIWR0by5pc0NvbGxlY3Rpb25JZChwYWdlLnRyYWNrSWQpKSByZXR1cm4gYWNjZXNzLmNvbmZsaWN0KCfnp7vliqjnm67lvZXliIbpobXojIPlm7Tml6DmlYjjgIInKTsKICAgICAgcmV0dXJuIGFjY2Vzcy5yZWFkKGRiID0+IHsKICAgICAgICBjb25zdCBwcm9qZWN0aW9uID0gc291cmNlUHJvamVjdGlvbkZvcihkYiksIHNvdXJjZVJhdyA9IEpTT04uc3RyaW5naWZ5KFsuLi5wcm9qZWN0aW9uLmZ1bGxSYXddLm1hcCgoW3RyYWNrSWQsIHZhbHVlXSkgPT4gKHsgdHJhY2tJZCwgb3JkaW5hbDogdmFsdWUubGVkZ2VyT3JkaW5hbCwgZmllbGRzOiB2YWx1ZS5maWVsZHMgfSkpKTsKICAgICAgICBjb25zdCBmaWx0ZXJzID0geyByb290OiBudWxsLCBxdWVyeTogcGFnZS5xdWVyeS50cmltKCksIHNvdXJjZVJhdywgZWRpdGlvbjogcGFnZS5lZGl0aW9uSWQsIHRyYWNrOiBwYWdlLnRyYWNrSWQgfTsKICAgICAgICBpZiAocGFnZS5raW5kID09PSAndHJhY2tzJyAmJiBwYWdlLmVkaXRpb25JZCA9PT0gbnVsbCkgewogICAgICAgICAgY29uc3Qgb3JwaGFuID0gZGIucHJlcGFyZShgJHtsaWJyYXJ5UHJvamVjdGlvbn0gU0VMRUNUIDEgbWlzc2luZyBGUk9NIGNhbmRpZGF0ZXMKICAgICAgICAgICAgSk9JTiBsb2NhbF9jYXRhbG9nX3Jvb3RzIHIgT04gci5pZD1jYW5kaWRhdGVzLnJvb3RfaWQgSk9JTiBzb3VyY2Vfcm9vdHMgcyBPTiBzLmlkPXIuc291cmNlX3Jvb3RfaWQKICAgICAgICAgICAgV0hFUkUganNvbl9leHRyYWN0KHIuZGF0YSwnJC5yb2xlJyk9J2xpYnJhcnknIEFORCBqc29uX2V4dHJhY3Qocy5kYXRhLCckLmF1dGhvcml6ZWQnKT0xIEFORCAke2xpYnJhcnlXaGVyZX0KICAgICAgICAgICAgQU5EIE5PVCBFWElTVFMoU0VMRUNUIDEgRlJPTSBsb2NhbF9jYXRhbG9nX2VkaXRpb25fdHJhY2tzIGwgV0hFUkUgbC50cmFja19pZD1jYW5kaWRhdGVzLmlkIEFORCBqc29uX2V4dHJhY3QobC5kYXRhLCckLmFjdGl2ZScpPTEpIExJTUlUIDFgKS5nZXQoeyByb290OiBudWxsLCBxdWVyeTogZmlsdGVycy5xdWVyeSwgc291cmNlUmF3IH0pOwogICAgICAgICAgaWYgKG9ycGhhbikgdGhyb3cgbmV3IE1vYmlsZVNlcnZpY2VFcnJvcig1MDMsICdCVVNZJyk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IHJlbGF0aW9ucyA9IGAke2xpYnJhcnlQcm9qZWN0aW9ufSwgbW9iaWxlIEFTIChTRUxFQ1QgY2FuZGlkYXRlcy5vcmRpbmFsLGNhbmRpZGF0ZXMuaWQgdHJhY2tfaWQsZS5pZCBlZGl0aW9uX2lkLGUucm93aWQgZWRpdGlvbl9vcmRpbmFsLAogICAgICAgICAganNvbl9leHRyYWN0KGwuZGF0YSwnJC5zZXF1ZW5jZScpIHNlcXVlbmNlIEZST00gY2FuZGlkYXRlcwogICAgICAgICAgSk9JTiBsb2NhbF9jYXRhbG9nX2VkaXRpb25fdHJhY2tzIGwgT04gbC50cmFja19pZD1jYW5kaWRhdGVzLmlkIEFORCBqc29uX2V4dHJhY3QobC5kYXRhLCckLmFjdGl2ZScpPTEKICAgICAgICAgIEpPSU4gbG9jYWxfY2F0YWxvZ19lZGl0aW9ucyBlIE9OIGUuaWQ9bC5lZGl0aW9uX2lkIEpPSU4gbG9jYWxfY2F0YWxvZ19yb290cyByIE9OIHIuaWQ9Y2FuZGlkYXRlcy5yb290X2lkCiAgICAgICAgICBKT0lOIHNvdXJjZV9yb290cyBzIE9OIHMuaWQ9ci5zb3VyY2Vfcm9vdF9pZAogICAgICAgICAgV0hFUkUganNvbl9leHRyYWN0KHIuZGF0YSwnJC5yb2xlJyk9J2xpYnJhcnknIEFORCBqc29uX2V4dHJhY3Qocy5kYXRhLCckLmF1dGhvcml6ZWQnKT0xCiAgICAgICAgICBBTkQgKEBlZGl0aW9uIElTIE5VTEwgT1IgZS5pZD1AZWRpdGlvbikgQU5EIChAdHJhY2sgSVMgTlVMTCBPUiBjYW5kaWRhdGVzLmlkPUB0cmFjaykgQU5EICR7bGlicmFyeVdoZXJlfSlgOwogICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBwYWdlLmtpbmQgPT09ICdhbGJ1bXMnCiAgICAgICAgICA/IGAke3JlbGF0aW9uc30sIHNlbGVjdGVkIEFTIChTRUxFQ1QgZWRpdGlvbl9pZCxtaW4odHJhY2tfaWQpIHRyYWNrX2lkLG1pbihlZGl0aW9uX29yZGluYWwpIG9yZGluYWwgRlJPTSBtb2JpbGUgR1JPVVAgQlkgZWRpdGlvbl9pZClgCiAgICAgICAgICA6IGAke3JlbGF0aW9uc30sIHNlbGVjdGVkIEFTIChTRUxFQ1QgZWRpdGlvbl9pZCx0cmFja19pZCxtaW4ob3JkaW5hbCkgb3JkaW5hbCxtaW4oc2VxdWVuY2UpIHNlcXVlbmNlIEZST00gbW9iaWxlIEdST1VQIEJZIGVkaXRpb25faWQsdHJhY2tfaWQpYDsKICAgICAgICBjb25zdCB0b3RhbCA9IE51bWJlcihkYi5wcmVwYXJlKGAke2NhbmRpZGF0ZXN9IFNFTEVDVCBjb3VudCgqKSBuIEZST00gc2VsZWN0ZWRgKS5nZXQoZmlsdGVycykhLm4pOwogICAgICAgIGlmICh0b3RhbCA+IDMwMF8wMDApIHRocm93IG5ldyBNb2JpbGVTZXJ2aWNlRXJyb3IoNTAzLCAnQ09OVEVOVF9MSU1JVF9FWENFRURFRCcpOwogICAgICAgIGNvbnN0IG9yZGVyID0gcGFnZS5raW5kID09PSAnYWxidW1zJyA/ICdvcmRpbmFsLGVkaXRpb25faWQnIDogJ29yZGluYWwsZWRpdGlvbl9pZCxzZXF1ZW5jZSx0cmFja19pZCc7CiAgICAgICAgY29uc3Qgcm93cyA9IGRiLnByZXBhcmUoYCR7Y2FuZGlkYXRlc30gU0VMRUNUIGVkaXRpb25faWQsdHJhY2tfaWQgRlJPTSBzZWxlY3RlZCBPUkRFUiBCWSAke29yZGVyfSBMSU1JVCBAbGltaXQgT0ZGU0VUIEBvZmZzZXRgKS5hbGwoeyAuLi5maWx0ZXJzLCBsaW1pdDogcGFnZS5saW1pdCwgb2Zmc2V0OiBwYWdlLm9mZnNldCB9KTsKICAgICAgICByZXR1cm4geyB0b3RhbCwgaXRlbXM6IHJvd3MubWFwKHJvdyA9PiAoeyBlZGl0aW9uSWQ6IFN0cmluZyhyb3cuZWRpdGlvbl9pZCksIHRyYWNrSWQ6IFN0cmluZyhyb3cudHJhY2tfaWQpIH0pKSB9OwogICAgICB9KTsKICAgIH0sCg==",
        "before": ""
      }
    ]
  }
]);

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const match = (bytes, identity) => bytes.length === identity.bytes && sha(bytes) === identity.sha256;
const reject = () => { const error = new Error('001旧Owner复用片段只接受完整已核字节。'); error.code = 'MBM001_LEGACY_REUSE_INPUT_CHANGED'; throw error; };
/** 只读内存适配；旧锁/原断言保持。此处不证明001当前Owner行为。 */
export function normalizeMbm001LegacyReuse(file, bytes) {
  if (typeof file !== 'string' || !Buffer.isBuffer(bytes)) return reject();
  const row = MBM001_LEGACY_REUSE.find(value => value.path === file);
  if (!row || match(bytes,row.before)) return bytes;
  if (!match(bytes,row.after)) return reject();
  let restored = Buffer.from(bytes);
  for (const hunk of [...row.hunks].reverse()) {
    const expected = Buffer.from(hunk.after,'base64');
    if (!restored.subarray(hunk.offset,hunk.offset+expected.length).equals(expected)) return reject();
    restored = Buffer.concat([restored.subarray(0,hunk.offset),Buffer.from(hunk.before,'base64'),restored.subarray(hunk.offset+expected.length)]);
  }
  if (!match(restored,row.before)) return reject();
  return restored;
}
