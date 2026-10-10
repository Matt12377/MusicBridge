import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const commitId = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !path.isAbsolute(value) && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function same(a, b) { try { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); } catch { return false; } }
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function fail(code) { const error = new Error('磁带共同基线准入拒绝。'); error.code = code; throw error; }
export const TAPE_CATALOG_COMMON_SCOPE_PATH = 'docs/tape-catalog-common/EXECUTION_SCOPE.json';
export const TAPE_CATALOG_COMMON_SCOPE = freeze({
  "schema": "musicbridge.tape-catalog-common.execution-scope.v1",
  "task": "TAPE-CATALOG-R3-COMMON",
  "branch": "codex/tape-catalog-common-baseline",
  "baseSha": "c647e02b40d55b955faabc9d6a2a6220c9286bac",
  "baseDirectParent": "fd176fdf1da069dd678b673f697cdbe8831628cc",
  "authority": "DIRECT_OWNER_BOUNDED_COMMON_BASELINE_SOURCE_AND_DIRECT_REPORT",
  "scopePath": "docs/tape-catalog-common/EXECUTION_SCOPE.json",
  "taskStatusPath": "docs/tape-catalog-common/STATUS.json",
  "integrationPath": "docs/tape-catalog-common/INTEGRATION.md",
  "sourceChangedPaths": [
    {
      "path": ".github/workflows/verify.yml",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "8d658886d35abdfeaab84ab6ee77d19e3b5ddb5e"
    },
    {
      "path": "apps/desktop/e2e/collection-preview.spec.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "c1274330f42fd4848a119aa8798f235379baf775"
    },
    {
      "path": "apps/desktop/scripts/tape-catalog-r3-observe.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/src/main/cassette-catalog-service.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/src/main/index.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "6273b519da21104118243187d54fc17074e14ead"
    },
    {
      "path": "apps/desktop/src/preload/api.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "d5c29f0408cb108d001a0d07c370eb7e9059c5f1"
    },
    {
      "path": "apps/desktop/src/preload/index.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "57be53b468796f0127dd41325f38ae138d1000d3"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/CommandOutboxPanel.vue",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "472964c523cb9556734fb5456d6d3ed7de21d86c"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteArchiveImportPanel.vue",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogDetail.vue",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogView.vue",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionModelDetail.vue",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "872051ab6dfdf7fa82f49d33ec151ae35f6e7b52"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReceiveDialog.vue",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "69d50b16d372731117910a20c407f36c0f4936c2"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReferenceImage.vue",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "f3ed618c5c74029084b70febc7f964b6869712fa"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionView.vue",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "21dc85c9c086177586724b3719f7130eefbe950c"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/ReferenceCatalogPanel.vue",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "122bd384dac1ea4fb9fd6bbe4c575881eb3194e0"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/cassette-catalog-controller.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/reference-images.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "873e1eeec0a5c3228ff14679543088ba4349459c"
    },
    {
      "path": "apps/desktop/src/shared/cassette-catalog.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/test/cassette-catalog-service.test.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/test/cassette-catalog-ui.test.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "apps/desktop/test/collection-display.test.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "8cdf7567f184daf18966eef5bf9c50b338d55b96"
    },
    {
      "path": "apps/desktop/test/collection-progress-ui.test.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "732cab800e0934b5237ca87603c668977938e2d6"
    },
    {
      "path": "apps/desktop/test/collection-readonly-ui.test.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "b4020127aef9678a7dd8dd5655739c75335f61fc"
    },
    {
      "path": "apps/desktop/test/collection-return-navigation.test.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "2fa060a845e71250ab0df0eadea64ebf6f27750e"
    },
    {
      "path": "apps/desktop/test/preload.test.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "2eb8bfb9ee7798c58930ecdd260d61eecd04e562"
    },
    {
      "path": "docs/tape-catalog-common/EXECUTION_SCOPE.json",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-common/INTEGRATION.md",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-common/STATUS.json",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-r3/ARTIFACTS.json",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-r3/CI_APPLICABILITY.md",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-r3/CI_SCOPE.json",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-r3/EXECUTION_SCOPE.json",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-r3/RESULT.md",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "docs/tape-catalog-r3/STATUS.json",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "packages/bridge-core/src/collection/cassette-archive.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-dispatch.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "3fcbb89b5353c93630aba2f1703768a0225f0d2b"
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-owner-protocol.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "7265b1724b47de4746837fffa6fcd7d935717823"
    },
    {
      "path": "packages/bridge-core/src/collection/reference-catalog-store.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "044c4c7b9e4390d3c195a2e6ae9c22623fdbf9fd"
    },
    {
      "path": "packages/bridge-core/src/collection/repository.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "e1e7fa14d56b72b5c04620e67bbece4bbac52149"
    },
    {
      "path": "packages/bridge-core/src/recording/restore-dataset-runtime.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "07801f00f4dfe698bb3d97896f1d174c3b956cad"
    },
    {
      "path": "packages/bridge-core/test/cassette-archive.test.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "packages/bridge-core/test/cassette-import-dispatch.test.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "packages/bridge-core/test/reference-archive-catalog-store.test.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "packages/contracts/src/command-outbox.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "575abfa2e68b630ee4b074d636a4b060416816aa"
    },
    {
      "path": "packages/contracts/src/ipc-names.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "47cbe1b9053b4b29778456ade08e1d9f0fd32552"
    },
    {
      "path": "packages/contracts/src/ipc.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "ba31ba63da85b05406d5134eb21a462bd665a337"
    },
    {
      "path": "packages/contracts/src/reference-catalog.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "13ac5933f5fb23a79f0bdc0e32091e6295e37b52"
    },
    {
      "path": "packages/contracts/src/validator.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "2c09f996083eb68ffa337ee29369acf343c0a90c"
    },
    {
      "path": "packages/contracts/test/cassette-import-ipc.test.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "packages/contracts/test/reference-catalog.test.ts",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "e84dddc0ee3a66dd3d1b73baeb23760f2e2f6a48"
    },
    {
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "4bb4873c279abc664d064a6e5949118d3b6a7cfd"
    },
    {
      "path": "scripts/ci/tape-catalog-common-admission.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/ci/tape-catalog-r3-ci-applicability.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/ci/task-applicability.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/ci/test/tape-catalog-common-admission.test.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/ci/test/tape-catalog-common-gate.test.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/ci/test/tape-catalog-r3-ci-applicability.test.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/ci/test/task-applicability.test.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/ci/verify-local-library-signed-stat-fix.mjs",
      "status": "M",
      "oldMode": "100644",
      "oldBlob": "18d07c4f07efb7b6ea1695983b4527de9257e862"
    },
    {
      "path": "scripts/ci/verify-tape-catalog-common.mjs",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/tape-catalog-r3-gate.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    },
    {
      "path": "scripts/tape-catalog-r3-restore-gate.ts",
      "status": "A",
      "oldMode": "000000",
      "oldBlob": "0000000000000000000000000000000000000000"
    }
  ],
  "reportOnlyAddedPaths": [
    "reports/TAPE_CATALOG_COMMON_EVIDENCE.json",
    "reports/TAPE_CATALOG_COMMON_RESULT.md"
  ],
  "reportOnlyModifiedPaths": [
    "docs/tape-catalog-common/STATUS.json",
    "docs/tape-catalog-common/INTEGRATION.md"
  ],
  "sourceCommitCount": 1,
  "reportCommitCountMaximum": 1,
  "tapeCatalogFrozen": {
    "baseSha": "c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95",
    "productSourceSha": "ff02c6b2fd248748fe7d461259f5749dda86fa0c",
    "productReportSha": "799fece27f0cfe056a56fd6258f0db380db3461e",
    "sourceSha": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f",
    "productOwnershipTask": "TAPE-CATALOG-R3",
    "integratedExactPaths": 52,
    "workflowAdaptedFromMacBase": true
  },
  "frozenGraph": {
    "baseParents": [
      "fd176fdf1da069dd678b673f697cdbe8831628cc"
    ],
    "tapeSourceParents": [
      "c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95"
    ],
    "tapeReportParents": [
      "ff02c6b2fd248748fe7d461259f5749dda86fa0c"
    ],
    "tapeFinalParents": [
      "3f552e1af28869407588ac70d9856819817c057f"
    ],
    "tapeCiCommits": [
      {
        "sha": "3f552e1af28869407588ac70d9856819817c057f",
        "parents": [
          "799fece27f0cfe056a56fd6258f0db380db3461e"
        ]
      },
      {
        "sha": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f",
        "parents": [
          "3f552e1af28869407588ac70d9856819817c057f"
        ]
      }
    ],
    "originalMbm003ReportParents": [
      "5e96372f0dd99e08b1e2964d68ce234eb438bbdf"
    ]
  },
  "tapeCatalogPins": [
    {
      "path": "apps/desktop/e2e/collection-preview.spec.ts",
      "bytes": 23987,
      "sha256": "9daddcd4e6a8ee2a8486e45ada77015a4acfe664e974cf795c9306b5fd741c35",
      "gitBlob": "545b5269149282ac09b0aa2568367b944d37679d"
    },
    {
      "path": "apps/desktop/scripts/tape-catalog-r3-observe.mjs",
      "bytes": 12492,
      "sha256": "78a8eea247c9605dcd71f72895d5a9cd4264a50b3674a4f093bc4d7ca2c8ca85",
      "gitBlob": "3763f9580509c16d2751578b2e3f2b41ac6edc68"
    },
    {
      "path": "apps/desktop/src/main/cassette-catalog-service.ts",
      "bytes": 11462,
      "sha256": "2bb1271a767c002c25bf706ac4575e31a6bf55f9c6d3db8687d9dcf33fd2ed4e",
      "gitBlob": "88773641a2bb1f812e4c90937baea7e3e3422ea4"
    },
    {
      "path": "apps/desktop/src/main/index.ts",
      "bytes": 111382,
      "sha256": "4bb278cbb22f92f5b0affb02f8b291dd6eb9d23229377b85523ddb73e1ba2e27",
      "gitBlob": "c7f982dba7d79db47fade65230fdf8423380c620"
    },
    {
      "path": "apps/desktop/src/preload/api.ts",
      "bytes": 44738,
      "sha256": "6748d8a7886abe9adff4ec2ea73d179ef0e874982c4e32c6e2217d38eebdda40",
      "gitBlob": "1ec8541d1e32dc0de473b0b37a3f77f68d81f73e"
    },
    {
      "path": "apps/desktop/src/preload/index.ts",
      "bytes": 28597,
      "sha256": "eccce4486969ee84d080d7623b54d28b865c431244ab74bb672894fa5e87dee7",
      "gitBlob": "ee21096670d13155ff74f1b977a07cbbf7f7e538"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/CommandOutboxPanel.vue",
      "bytes": 20695,
      "sha256": "4b3b8b6cb854d61aa175875bd858c9957b02a159f3028ff90395342f2bf15e56",
      "gitBlob": "599df32aabca261aa615833e4ca136d95c5cc0d7"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteArchiveImportPanel.vue",
      "bytes": 6951,
      "sha256": "6a94a8e7467909160b36f714b1cd3d47bc73cce78444585bdd870223759d0bf0",
      "gitBlob": "f58ea07116b5bbfef4f47c042c38256d8cfd0354"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogDetail.vue",
      "bytes": 12605,
      "sha256": "0cd22aa8ff76b28aaa85913a748310761057bbfcbee11ed5bb47b1bc21ac5064",
      "gitBlob": "74680f02751654aad644fab5df54549d8fd9a8ac"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogView.vue",
      "bytes": 15887,
      "sha256": "d410d8a3e236259de4d97d8a6c5b870b7bee48ad986fee3a7543fbe460896e74",
      "gitBlob": "20f905a432db9caa6aa930654b70001600fb1bcc"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionModelDetail.vue",
      "bytes": 24769,
      "sha256": "f63391b37946dc9e58b0a2dfce85b2b0799920be5b1a60def13bafbe33e536dc",
      "gitBlob": "70d2523f13ba68e78a94a24d8593e6051d4a5c12"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReceiveDialog.vue",
      "bytes": 7713,
      "sha256": "991ea840fd38e595a4280d83d73a53c6a4fc17805692f99ec86cc2af63cec56b",
      "gitBlob": "a4fc377edd709c6146fe37be0789d69aa76ed054"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReferenceImage.vue",
      "bytes": 1165,
      "sha256": "53ac223025c193936382f5afe8aebd2260dbd6a162f6addbffdead06dfe1733e",
      "gitBlob": "62d5ace7714c9f816a9dfef84b4f090180a2aebd"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionView.vue",
      "bytes": 39258,
      "sha256": "7045d279a2e3902d02e16f469b8d04af1fe94994e20c1684b631a2f5f7f15252",
      "gitBlob": "e8069457feaead993ff8f3fe40b6ee7bb2e021d0"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/ReferenceCatalogPanel.vue",
      "bytes": 37559,
      "sha256": "49574915aab3a01b71b72c56f7a3c06a794d2b1b1b0653d24cbf34c7ca0d9261",
      "gitBlob": "51ba9b3f57b7a40c561cbe72046242b09aec71cf"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/cassette-catalog-controller.ts",
      "bytes": 3462,
      "sha256": "91a08accff057fe002c29a51677bec2f60d5908135ee9f68d8a277facdf943cf",
      "gitBlob": "0a0f53a3deeab8feae9ed0f6a7f785dbf0373478"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/reference-images.ts",
      "bytes": 9377,
      "sha256": "a1d3579551d2bbd06547f4a5ebf35861a5344a3bbee78b55351a04b9ee9ef14a",
      "gitBlob": "e0febb7c48468dde6289c069f3a8f38c47df7b78"
    },
    {
      "path": "apps/desktop/src/shared/cassette-catalog.ts",
      "bytes": 1905,
      "sha256": "d0f9824c15498c03afc76007883bd44bf8e9055f172e0cee70b3402a0266619c",
      "gitBlob": "4b3aa3c68f8517cd70d8eff85f11d435a459b0ea"
    },
    {
      "path": "apps/desktop/test/cassette-catalog-service.test.ts",
      "bytes": 3334,
      "sha256": "db02a43a2d4df3cb9d4d5f0097796d412a03df84bccefd3020f84bfc84b6a475",
      "gitBlob": "06e63e033060b36d85cac5093777ac7c2ed54c2a"
    },
    {
      "path": "apps/desktop/test/cassette-catalog-ui.test.ts",
      "bytes": 27565,
      "sha256": "68022d18fbadae9f92a93accbf04c723609ed5e0cfb3c91405d41679392fc6a7",
      "gitBlob": "8f59d911d7543a0aa36ff9bad069e0f7dc34e89e"
    },
    {
      "path": "apps/desktop/test/collection-display.test.ts",
      "bytes": 4684,
      "sha256": "1e4722d0e65401114a1ef5df1ef6cae7b8184624f5dc0a7e44367b80b55ea898",
      "gitBlob": "da658ed602826160b42d76db8041f87116520b73"
    },
    {
      "path": "apps/desktop/test/collection-progress-ui.test.ts",
      "bytes": 33012,
      "sha256": "49dd1200d1d9be911ebc8b229096ce251d35beb5a2c820376eec5373023c9b77",
      "gitBlob": "c0e428911614c60317a40cc643c630837561840c"
    },
    {
      "path": "apps/desktop/test/collection-readonly-ui.test.ts",
      "bytes": 10271,
      "sha256": "098742e8e66d12c0286683211311ca1bbdb9962e5a5a9d0e14fe8b8c4aeef4d6",
      "gitBlob": "ab70cfe5227d1bbb312810956cd9f04ae857fd34"
    },
    {
      "path": "apps/desktop/test/collection-return-navigation.test.ts",
      "bytes": 6479,
      "sha256": "b1d19d59d919d09dfba79000372e33c6b47deb6296151ea28affa2b2f433daae",
      "gitBlob": "2e4462b7b801ade3e430f67614b7243d721ab162"
    },
    {
      "path": "apps/desktop/test/preload.test.ts",
      "bytes": 37258,
      "sha256": "91ba4beb8478bc651383cddb71ab6cdd84b930c03a1b6ba58db73fc8167391d1",
      "gitBlob": "3aa3364c7a1a991d670ed2f9d7a7f9a9718a3990"
    },
    {
      "path": "docs/tape-catalog-r3/ARTIFACTS.json",
      "bytes": 6971,
      "sha256": "3feb8489444f8d11179e76dade3c4cc405a1e8a3bf98e6f13981a31ba40917e7",
      "gitBlob": "0b5e38e34c9ee1f951f1eb0c25b9462a162b94da"
    },
    {
      "path": "docs/tape-catalog-r3/CI_APPLICABILITY.md",
      "bytes": 7573,
      "sha256": "62153b9aa5c2e0c5b357867a20888245edb2c9ab101c8cf1526ff178c78f8d7d",
      "gitBlob": "3e36b725a3cc77e47107d96266d54a59a3bff919"
    },
    {
      "path": "docs/tape-catalog-r3/CI_SCOPE.json",
      "bytes": 1974,
      "sha256": "d726b98bf8dd02d0dadc02434596121c31a5e35b3af02eb93c8b224dcf771cc1",
      "gitBlob": "1a474c709c3be536f4363f6c108ddb1ef6efd4d9"
    },
    {
      "path": "docs/tape-catalog-r3/EXECUTION_SCOPE.json",
      "bytes": 5630,
      "sha256": "7fc8edf02cb64cdb91c286b9180ed13f1ab7878eb5c17c8d35ba37b56da368d4",
      "gitBlob": "03d8192132051cb9d7eab3dad7db69b5b8c77528"
    },
    {
      "path": "docs/tape-catalog-r3/RESULT.md",
      "bytes": 10373,
      "sha256": "1880f7d6b37ab6f5c2c5be454903b40b8e93477ed3fda865a6e68550db7123be",
      "gitBlob": "2e198325443d3bb7f85107272963e46de42d8074"
    },
    {
      "path": "docs/tape-catalog-r3/STATUS.json",
      "bytes": 4166,
      "sha256": "f1582c26e893b9636b6b01f15e8a86fb1e7c78460de52477b863473f0268a544",
      "gitBlob": "b236a5178ad5c3f622b6c3629d87c345ba9751cd"
    },
    {
      "path": "packages/bridge-core/src/collection/cassette-archive.ts",
      "bytes": 35565,
      "sha256": "0716a8de02fcce06a4a06aec87f2773152bda239fa53f6e6e460dda33da574b6",
      "gitBlob": "d2ef786b8435b8b7157bee1ac754e4b3988d9c8d"
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-dispatch.ts",
      "bytes": 59157,
      "sha256": "32f43b5dda5766bfa2b50d4c1c1f00e979993b50f2ed494444cd4cdcf81e44b3",
      "gitBlob": "31390c6dba3604836bdc2204d5414c9e046ee011"
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-owner-protocol.ts",
      "bytes": 30338,
      "sha256": "fa070d9383c8913d27e9ff23f59e2417b7402c19f13d7ec57d09b09e64823c5b",
      "gitBlob": "3990b5337b5d89b073d97513c09ec2c4cf5b2024"
    },
    {
      "path": "packages/bridge-core/src/collection/reference-catalog-store.ts",
      "bytes": 46960,
      "sha256": "0d197187345ef39897fb3dbf0be469e737a5de49b1733663b44b778ca8eccda1",
      "gitBlob": "4fe9e51a6aab6c84427330d7a1c00e3462aa35eb"
    },
    {
      "path": "packages/bridge-core/src/collection/repository.ts",
      "bytes": 66458,
      "sha256": "a062a84b5832830a81d4156af2fb004c0aec00ae020d7937471b5eb1a40aab83",
      "gitBlob": "a87bd6e8d5b592163ee97221daf35fc3c2fedfcb"
    },
    {
      "path": "packages/bridge-core/src/recording/restore-dataset-runtime.ts",
      "bytes": 12768,
      "sha256": "81f6148faea02e2ba33ef2d3a3213a1827957b17e7bdaf1e1383f7c9d1376f67",
      "gitBlob": "a14f6a9143f002361a3d21544619b3fa806ea53d"
    },
    {
      "path": "packages/bridge-core/test/cassette-archive.test.ts",
      "bytes": 14856,
      "sha256": "4a6dcc7879bc0fa724126d8fb31f373bd550c38d80f8c1a6f1faf282a169ddb2",
      "gitBlob": "50234bcbdbc301fb16e7c6f1c5e447b111dc0a8b"
    },
    {
      "path": "packages/bridge-core/test/cassette-import-dispatch.test.ts",
      "bytes": 1456,
      "sha256": "7b28d6e13baf7ba89ffcde3b39ee3f2f57c432280e9c99b5da33aa98bb599940",
      "gitBlob": "8af61f5d009fdec1edc26e0f1f7c87fb898b8c65"
    },
    {
      "path": "packages/bridge-core/test/reference-archive-catalog-store.test.ts",
      "bytes": 19643,
      "sha256": "cd29116df00bf415fac5276454472cef8f83a1702ee2baad11c602530f703b60",
      "gitBlob": "0db2e3167c707f023ad8fc2aee396240b3f27c39"
    },
    {
      "path": "packages/contracts/src/command-outbox.ts",
      "bytes": 33600,
      "sha256": "276f6f1eef08931a1051c172217f663c47402ea4c5f15177214a705de680f892",
      "gitBlob": "45feab54cd57aeec5d1f4b7e372323365fd34ab8"
    },
    {
      "path": "packages/contracts/src/ipc-names.ts",
      "bytes": 9505,
      "sha256": "541948e20d047293883b3d93d7a08a107fc32b29a35c008edce269e4ac30bff6",
      "gitBlob": "b08f20ae13f91b0974f9d4e1a2b0a8705a70a484"
    },
    {
      "path": "packages/contracts/src/ipc.ts",
      "bytes": 46925,
      "sha256": "2593372ce88e2920273068d4ebed86172f38eeb595a443908797b195fb42b918",
      "gitBlob": "c63f2cf2edb1d3d60d0cf7d8130e8a58ce84a519"
    },
    {
      "path": "packages/contracts/src/reference-catalog.ts",
      "bytes": 30579,
      "sha256": "0d8ea64fe9a3ae5ba234be2c4f7289e232f3dda975ec0cabec6f4d75c9ca61da",
      "gitBlob": "51143d386ae8722850d9f5d3b2859a0b3ab17db6"
    },
    {
      "path": "packages/contracts/src/validator.ts",
      "bytes": 128571,
      "sha256": "cd95ddab71d7c60590b9aee6538657ee8ff4e1c8237dddf173bd83e5367334d9",
      "gitBlob": "cf3e057bbd3cf97fbcab4c4ccd5617ca864cf67d"
    },
    {
      "path": "packages/contracts/test/cassette-import-ipc.test.ts",
      "bytes": 1211,
      "sha256": "e6448d235a2aadf8f3d7e788e4e0874a8e75684cd85cc63f66cc2d57680b1d4f",
      "gitBlob": "f6aca2176a83471a4cae0ef2c552a75f819746a4"
    },
    {
      "path": "packages/contracts/test/reference-catalog.test.ts",
      "bytes": 22893,
      "sha256": "0782732451e5e73f040bd2013402db4ce0f194a6dd5c3ad9bb5a783170af8482",
      "gitBlob": "7e8051cb1c6e25be530e9d14750cdd692f87dc3a"
    },
    {
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "bytes": 7352,
      "sha256": "cc80f33f89be952c17cbfd9f382a9075eefb23d537507788a4f1d9a4ccbfeb19",
      "gitBlob": "ade34d55f973eb67172b9ea2eed20cfc2f39de45"
    },
    {
      "path": "scripts/ci/tape-catalog-r3-ci-applicability.mjs",
      "bytes": 11915,
      "sha256": "a4d7a091db2d85cc33dc9ba80351485d781c0ba86e1f26599d831c7aab9e01ab",
      "gitBlob": "d52904a072c41878225c6f246d954b60bac4c8e3"
    },
    {
      "path": "scripts/ci/test/tape-catalog-r3-ci-applicability.test.mjs",
      "bytes": 40566,
      "sha256": "82b365f8dce1ae075d1897992f7d0bf852999db4a9b7dbc8eeb7d1f31ded1132",
      "gitBlob": "094c42f4e441d1fbd2a583b18347f615d7036502"
    },
    {
      "path": "scripts/tape-catalog-r3-gate.ts",
      "bytes": 13456,
      "sha256": "2f86d5c6ecc41e0f442b5b534cd005f59bb8f5bb88b5232026c33c0e7aaf86d5",
      "gitBlob": "df05b786bfe64b1ad80264728829560cb2e98bba"
    },
    {
      "path": "scripts/tape-catalog-r3-restore-gate.ts",
      "bytes": 7077,
      "sha256": "882342a724c18736beb2bed09effdcdb6d247408ca3094ae13bf4bb98c2f89e3",
      "gitBlob": "3dffaeac13930c19bb12700087c282c790822fe0"
    }
  ],
  "productPins": [
    {
      "path": "packages/bridge-core/src/collection/local-relocation-coordinator.ts",
      "bytes": 9644,
      "sha256": "05acb43a9486bf3c33ce06fd4e2d13908668b67125ef362c751fd03beaffd98c",
      "gitBlob": "6e884b7d4ce58f44a7ccd92305f9b22603b92b95"
    },
    {
      "path": "packages/bridge-core/src/collection/local-scan-coordinator.ts",
      "bytes": 36729,
      "sha256": "c690142cee8bfb3de0762fbe69df6a325b1d44baafe461e8c8afb3dc603ea92d",
      "gitBlob": "7e5cb3f111ba3dd5a045e7d609b2ad1d4470fc52"
    },
    {
      "path": "packages/bridge-core/src/stream/source-namespace-claims.ts",
      "bytes": 24762,
      "sha256": "c7810434565cdb4b5c8fe394ca70d50442327e158a1439b54dcf3ae15e35d715",
      "gitBlob": "1a4623a32f5f98999cd7233cfc47d9e651e8edeb"
    },
    {
      "path": "packages/bridge-core/src/stream/physical-resource-locks.ts",
      "bytes": 15391,
      "sha256": "79052d83b6c602de784da7002f975aaf71e91c84f11bb9acc7d913fbf2fff2b8",
      "gitBlob": "a7f9fd18088bce4986269072b942ae119b5ca5a6"
    },
    {
      "path": "packages/bridge-core/src/stream/physical-resource-claims.ts",
      "bytes": 14918,
      "sha256": "8b1f47063435521135b5bfaf61951b6486d355fdcea6bb9bdfe3fdff5cd4cdba",
      "gitBlob": "38b3e563995f75af7b334ea1b2000ce745390d0b"
    },
    {
      "path": "packages/bridge-core/src/application/local-source-resolver.ts",
      "bytes": 8424,
      "sha256": "3fc6087d0e4cb14edb2d0eab65917ce479a688cb71a9a88fc07d50ff0f4fb4c5",
      "gitBlob": "3e70c32eb8023f712d898e48f6dbc4ba58844867"
    },
    {
      "path": "packages/bridge-core/src/collection/local-source-ticket-types.ts",
      "bytes": 4423,
      "sha256": "ac836361c8bcd7d428d73e3ccc570310d54c8337ee007555d23eee5a7b26f67f",
      "gitBlob": "9cf26b78f494cfa2de499a5ff013f986c6e4c6d9"
    },
    {
      "path": "packages/bridge-core/src/stream/local-file-source.ts",
      "bytes": 11489,
      "sha256": "39c5bfd368273d75fdb81a69566c67180fbd36c383217056720843c8847be7f5",
      "gitBlob": "603b4b69163614e7e1ea2fd36240d437c7ec2d08"
    },
    {
      "path": "packages/bridge-core/src/recording/source-files.ts",
      "bytes": 46157,
      "sha256": "3ccafec70017b883c3709a72b6715b3ca6b367b663a71d858b0279424e7de898",
      "gitBlob": "5804e480219c884de4354fe84748a3dbb760faee"
    },
    {
      "path": "packages/bridge-core/src/library/metadata-reader-worker.ts",
      "bytes": 21652,
      "sha256": "259691cb8e8062b3db4d8522da864e6c14c2b0dde7ecaf19950e91add0662577",
      "gitBlob": "2e94f86034ec35dc2bf83d5897334543e8c11d88"
    },
    {
      "path": "packages/bridge-core/src/library/metadata-reader-types.ts",
      "bytes": 4680,
      "sha256": "53d23129795ddbb0440687a8519636fee23624caef2f4a1a71e17774ccde03ff",
      "gitBlob": "41b2aff101f02f69c196633a372542024b5dd25a"
    },
    {
      "path": "packages/bridge-core/src/library/metadata-reader.ts",
      "bytes": 14112,
      "sha256": "375f2527dc23c4b2be5431dbc98a95882d3654a77c9d368ecc74eaf11c582097",
      "gitBlob": "5ba774ec24489b60c87a34f17b9a2fa833f08638"
    }
  ],
  "compatibilityPins": [
    {
      "path": "packages/bridge-core/test/mbrs004/name-rules-scan-integration.test.ts",
      "bytes": 9010,
      "sha256": "9aa92bb73fd445ac4e8ec829d1fae2c9eb470811aecd45f3c7513fc48bdb2229",
      "gitBlob": "f22b22f8cba2ebdba6461f29a5331b1859f3053b"
    },
    {
      "path": "packages/bridge-core/test/mbrs005/config-integration.test.ts",
      "bytes": 8337,
      "sha256": "e284cd3cbd7e44ee08b24c5a94c0faf8725113b2e37fcbed755940c8c4eb4510",
      "gitBlob": "75e486c1ce8ff5eea626a206c5b9ec5f4c4a7346"
    },
    {
      "path": "packages/bridge-core/test/mbrs006/owner-worker.ts",
      "bytes": 722,
      "sha256": "6cbc6a24cf1a5e2945972c7993c46314de4860825a8bff7219e096b8b2249e55",
      "gitBlob": "6a453ccf23fea8c1c2952259d5b03df19a1fb214"
    },
    {
      "path": "packages/bridge-core/test/mbrs007/queue-worker.ts",
      "bytes": 731,
      "sha256": "dd626e9703546af316226f66e345d328bb2105b128466103a5739caf87ca0b08",
      "gitBlob": "134273d813a127d17ecfe737138f71eaae4b73f7"
    },
    {
      "path": "packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts",
      "bytes": 26566,
      "sha256": "571a14e89f3395bfd7e4b66900bba3344bfa8e74640b9aef7b7c25ab8bc84fd4",
      "gitBlob": "b11aa58c766ded86bfbc5e14b82f263151da959a"
    },
    {
      "path": "packages/bridge-core/test/local-library-wave-empty-list.test.ts",
      "bytes": 31034,
      "sha256": "1090e2a1547b376cdb7c3d738d5a5e4f3223cf6e6d5d38a13b0810b4009505dd",
      "gitBlob": "fa1b24afbfad462714ae780c9a5f2f26573a3dd7"
    }
  ],
  "protectedFiles": [
    {
      "path": "docs/postrust/MBM-000/EXECUTION_SCOPE.json",
      "bytes": 2791,
      "sha256": "bed0961a57bab85daf3d85daf382b487dc7b3f2b58bd02bcf8f807c6c1c0dc4a",
      "gitBlob": "e98a305b0571ba5283d4630ea5fd633408536574"
    },
    {
      "path": "docs/postrust/MBM-001/EXECUTION_SCOPE.json",
      "bytes": 4846,
      "sha256": "9d72a7a092f60a6c0c8e50a7f75d66ca40ec12cfe9cd40bbd333ccb02fea6484",
      "gitBlob": "b30a180cf27cdfc081ccc5f4d9583812e47cffff"
    },
    {
      "path": "docs/postrust/MBM-002/EXECUTION_SCOPE.json",
      "bytes": 2232,
      "sha256": "45c6665ba2cf1563621ffbd4181aae48abc471204849675d896c77a0fe0dbeef",
      "gitBlob": "fd245258ded96a2da8f5ca39d8c5c6551b41e4bb"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_FREEZE.json",
      "bytes": 2184,
      "sha256": "dd8fef00d2ab38066c458b5c92c16d5e060633d40dff7bcce488b609f57d3e5a",
      "gitBlob": "767193fcf97cf2dbdcd42ad5f29d6b303d6489d3"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS.md",
      "bytes": 6076,
      "sha256": "698ca28f695b950c7409489b67929da523193856461f858df7047c1b48d2fa2a",
      "gitBlob": "66d1de97033684d7789acdaaaf7ef9a151b2c98e"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS_DRAFT.md",
      "bytes": 3105,
      "sha256": "c7b40febb7039f700a68c737d8624810f60f0a6560dbdec5cfd7dec4c045efef",
      "gitBlob": "f65e1e3a6b4374fdeed3933c7d7e62e25c4e4e36"
    },
    {
      "path": "docs/postrust/MBM-003/DSD_PROCESSING_CONTRACT_PROPOSAL.json",
      "bytes": 3863,
      "sha256": "189250e7ad93dddc4c24dccc6c7ec86565d3cd06e84a0fb977fc125ef4924ffc",
      "gitBlob": "b7b764cd82605a61672a13fd8b4377f7fbf2e9b8"
    },
    {
      "path": "docs/postrust/MBM-003/EXECUTION_SCOPE.json",
      "bytes": 7103,
      "sha256": "e0e35e4723a90c07a422c30f355ac7ab76b78ce17212e0aa414369622e5071ec",
      "gitBlob": "d81bd62f51ec55ae0a33f0aa3d322b1bb1ae21b7"
    },
    {
      "path": "docs/postrust/MBM-003/IMPLEMENTATION_CHECKPOINT.md",
      "bytes": 4860,
      "sha256": "1f70c1b015d85cc1bae7798190e722d38529e3a1efcca7bf96b3087bb97b3678",
      "gitBlob": "dfb14e09c0a6470a243def350bddbe9e657acb97"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_DSD_TRANSPORT_DECISION_2026-10-10.json",
      "bytes": 4578,
      "sha256": "a36b722255201e98167b4a616fa8228cf2109b8204613d0cb3a85aab7f2bc256",
      "gitBlob": "4b9c01cbc44a723ac51802008e9d80d3206f088a"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_AMENDMENT_2026-10-09.json",
      "bytes": 4007,
      "sha256": "1b63215f580aa6975ad9cccf265c666cc6b37cbec9f9e75ab1eb4837758a9718",
      "gitBlob": "645678a59e8e0872e8ff230c01d7656d7cfc27d2"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_DECISION_2026-10-10.json",
      "bytes": 6241,
      "sha256": "4851db40bf2f987c0d787413a2d7b0bcc6461d151f33d7ae20c796c63920baad",
      "gitBlob": "69661b576756d8a53eea6184aa5243ed4896457e"
    },
    {
      "path": "docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json",
      "bytes": 1932,
      "sha256": "9ea3af0f43c773819a969260dade313c6f54c3e37ac57214d666e18c52383147",
      "gitBlob": "e47dd406582123d584cb313515d83cb7e0c38e1e"
    },
    {
      "path": "docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json",
      "bytes": 3058,
      "sha256": "87cb1fcc67dc74013b7780cdf01e3ff0d44d756ee964938c23b0e37c266e1d4c",
      "gitBlob": "a1fdf051c9ecf9a3d73158a2f8e8d83733ba9936"
    },
    {
      "path": "docs/postrust/MBM-003/READY_RENEW_BOUNDARY.json",
      "bytes": 1374,
      "sha256": "18ced7a85d813730f90108ad18ac7f0e903f261d23dfda1b214188513b659665",
      "gitBlob": "448d09afd1f697f995f3ede74e05a5a69289334c"
    },
    {
      "path": "docs/postrust/MBM-003/contract-preview/openapi.json",
      "bytes": 147487,
      "sha256": "9dcde7b24150e9b21dc9366bd913e3ca216a34584b6f85942fee17e8bd7a06a8",
      "gitBlob": "76a28da1cf3fb373f8677d0310aae44e985559ab"
    },
    {
      "path": "packages/contracts/mobile/openapi.json",
      "bytes": 147445,
      "sha256": "3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21",
      "gitBlob": "51d155f0a09a6988676826b6c82d858d84e9c46c"
    },
    {
      "path": "reports/MBM-002_EVIDENCE.json",
      "bytes": 4030,
      "sha256": "6fb3dbcdf7bc2026bae0b30664581c0d3bc476aad132c274354e19eb7d1a5bea",
      "gitBlob": "e6efe5839fdefc53b20099f115e5122dd3dd832f"
    },
    {
      "path": "reports/MBM-002_RESULT.md",
      "bytes": 873,
      "sha256": "0dda06192257333401b2836281458f8c9479c6d2a03109c2200f636efbca3c3d",
      "gitBlob": "33754a5246b065fd2c78c9554f3457c351d58b34"
    },
    {
      "path": "scripts/ci/mbm003-contract-gate.mjs",
      "bytes": 8831,
      "sha256": "29a96cadb48571fba8aca902f8fa99e391dbb1a43021a5e642a03acc2d37d56e",
      "gitBlob": "fcd524d25aa3dbfd8f09912d08f9f4c2f4038898"
    },
    {
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "bytes": 7352,
      "sha256": "cc80f33f89be952c17cbfd9f382a9075eefb23d537507788a4f1d9a4ccbfeb19",
      "gitBlob": "ade34d55f973eb67172b9ea2eed20cfc2f39de45"
    },
    {
      "path": "scripts/ci/mbm003-software-gate.mjs",
      "bytes": 35887,
      "sha256": "85a88fedba29caa43f68fe6d49551f86578948ad9e2ff4decd450cbf48086dc3",
      "gitBlob": "a49f8f356fb7d3f806539235ff8de0baa2ebdd1c"
    },
    {
      "path": "scripts/ci/report-only-admission.mjs",
      "bytes": 27460,
      "sha256": "ed5c7c32f3aa27591e99139807827fd5bc1089693df09409578508231be762ab",
      "gitBlob": "925c4ec45a43bac248c0d8b55b4b22f97300e8df"
    },
    {
      "path": "scripts/ci/report-only-mbm002.mjs",
      "bytes": 9791,
      "sha256": "223e3efbd10ce3d59635f73717465cafadcedd11b16c5260617b0f76be134aea",
      "gitBlob": "36ca7e813fcca28ed2018bb4304769d000697d5b"
    },
    {
      "path": "scripts/ci/report-only-mbm003.mjs",
      "bytes": 11480,
      "sha256": "68da84bebcdc79fb650fb809b75bbcd0ab049da3b5470f267f1943f82e4d6e85",
      "gitBlob": "fc80ca25ae1055b4a83bbe60698f7e7cec023ed2"
    },
    {
      "path": "scripts/ci/run-core-tests.mjs",
      "bytes": 13476,
      "sha256": "5b6b405a4fe514197765cb7c9fc59d1f1141545d143effd7f1f1ff4c65a5d44b",
      "gitBlob": "7b8e330d90273943f5bd87d1552fb3766c9abc2c"
    },
    {
      "path": "scripts/ci/verify-mbm000-contract-adoption.mjs",
      "bytes": 44759,
      "sha256": "a3e87936042d8085615b07a6ad2eeec1ada98645cdcbabbf5f0b2c50f23d86b5",
      "gitBlob": "9dba48422779a6228b22db8ef94a963a8d34ec27"
    },
    {
      "path": "scripts/ci/verify-mbm001-pairing-library.mjs",
      "bytes": 18073,
      "sha256": "b439348a66c25b1a70493ca75854a9e346737763dbc42f9d3a9c8f84dceeb855",
      "gitBlob": "af694a75605c2b1f41ca60d327764b1d1be6b435"
    },
    {
      "path": "scripts/ci/verify-mbm002-resource-playback.mjs",
      "bytes": 12321,
      "sha256": "9e48660e3e074f1172de49740713d9e072f1ba0d8dc3684cedd1e04897d3e28e",
      "gitBlob": "f9d73dd0580032ee94ab5c995cc05cd8cd346eef"
    },
    {
      "path": "scripts/ci/verify-mbrs001-offline.mjs",
      "bytes": 14851,
      "sha256": "35ad160e0f58c0eea0cbb22ae0f4d948955c13c05857eaa3134c18aa9552ab3d",
      "gitBlob": "44aaa3138052bb02d32bb203a55e768118317cb3"
    },
    {
      "path": "scripts/ci/verify-mbrs002-contracts.mjs",
      "bytes": 22849,
      "sha256": "b207255e2d7a555cd3ea9d4ba305472bf8f09a5c72a0877fd081eae249be1b8e",
      "gitBlob": "4d371724a9da77219d794fcc674015728dfd6053"
    },
    {
      "path": "scripts/ci/verify-mbrs003-scan.mjs",
      "bytes": 37197,
      "sha256": "c33d12f7401bcbdfa3b532bfc00376377e224ad8c5a6efa1b77eff6a1dc1dc53",
      "gitBlob": "4fc2a686e11c217832105021c108be4f006def1a"
    },
    {
      "path": "scripts/ci/verify-mbrs004-rules.mjs",
      "bytes": 11521,
      "sha256": "a2e293a7c1860526cba36334285eda3b9e759b77c91b5fbb03bba27ffc7bc328",
      "gitBlob": "5bf3376af4f965a295c11cc1e51f7251b6a7e1e2"
    },
    {
      "path": "scripts/ci/verify-mbrs005-gateway.mjs",
      "bytes": 14217,
      "sha256": "c77cde79ec4dfc4486afda25a74c0455fb5c96200cf5273724ccf3435cf2863e",
      "gitBlob": "f0a1b21163298ee7837993beb79558c8741dcf43"
    },
    {
      "path": "scripts/ci/verify-mbrs006-local-playback.mjs",
      "bytes": 16705,
      "sha256": "4df7b1624306556a5df90e31cc6565fd51b5baaedf2961d6e4574ec3eae6dbb6",
      "gitBlob": "f8639be464f4c32878acacc82417c55d74643e26"
    },
    {
      "path": "scripts/ci/verify-mbrs007-queue.mjs",
      "bytes": 23136,
      "sha256": "c9d8c1d1605ea08b2754e6058440940dbcede505b3b0c90f44c81a8adee94471",
      "gitBlob": "6b5f24c4fe98aa5f8e50f5af6780bb874e1055f2"
    },
    {
      "path": "scripts/ci/verify-mbrs008-audio.mjs",
      "bytes": 21327,
      "sha256": "c00e66b3c5ce423352bdfdc79be458b973d9b8a695ec5569b579cfb039cc4527",
      "gitBlob": "87312721e40f124afd15f394b18f4517d5002a83"
    },
    {
      "path": "scripts/ci/verify-mbrs008-ui-render.mjs",
      "bytes": 6034,
      "sha256": "6bddcb1221be202ce4af5ee75cafacedb63bca5c480f7a5a027144e445db513b",
      "gitBlob": "96ad195d314bcb30eedbb4d05fd9bfdb608cdbe3"
    },
    {
      "path": "scripts/ci/verify-mbrs009-local-library-ui.mjs",
      "bytes": 21699,
      "sha256": "f834f4e6dfefe6e0985a31896e4e9d0d03d90a6d7b5fa968359ac613a83434ff",
      "gitBlob": "5238d744a0669f300319a819a2eefcc16042a4ba"
    },
    {
      "path": "scripts/ci/verify-mbrs009-ui-render.mjs",
      "bytes": 7479,
      "sha256": "9d4e2fc018fee8673a721b4667975994f3cc307296627cb675ab95773fe369d3",
      "gitBlob": "a3d7da32baf3e7d12a5aa6feb9dc91c400fc1ee7"
    },
    {
      "path": "scripts/ci/verify-mbrs010-artwork.mjs",
      "bytes": 29111,
      "sha256": "3427476dd5fb20f243a48b359ec6b5a06faa0157c7333dd7582cf3814da3a7f4",
      "gitBlob": "64876ac23a502b3a6c179ee68d68a8c65d816ae6"
    },
    {
      "path": "scripts/ci/verify-mbrs011-organizer.mjs",
      "bytes": 17055,
      "sha256": "56988faccb590c14f5241b431ef5d555271bd2e6496aa3a346107fa7cf52b692",
      "gitBlob": "d65c6f5bf55fde9c3da4a951dc7f4ae203283ce9"
    },
    {
      "path": "scripts/ci/verify-mbrs012-source-writes.mjs",
      "bytes": 27972,
      "sha256": "84185ff650463228d6584c862674823c9bdafc45ec704cb7a6a1bf2b06c43e42",
      "gitBlob": "74727eb22b11e7db86d27c0d96420219b6acb703"
    },
    {
      "path": "scripts/ci/verify-mbrs013-relocation.mjs",
      "bytes": 23501,
      "sha256": "ee35adb79f5805ebfe7754bf0987ade6baf1412d568ac750f1eecf94ab363b92",
      "gitBlob": "52fbc2531d17e16b4acb1369a38da225e42a1d8b"
    },
    {
      "path": "scripts/ci/verify-mbrs014-compatibility.mjs",
      "bytes": 23064,
      "sha256": "11d46740fe6e9e0169af1503ec135b74e52b1338b740148bc994e5d59ecfc262",
      "gitBlob": "65532fde5d3b0d264cd5a2ba265f330ee1665e15"
    }
  ],
  "protectedRouterException": {
    "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
    "before": {
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "bytes": 4805,
      "sha256": "2bcf3610973546403c2856897e3568c188be6bffc1b185b79f9cdf8f67cba9d5",
      "gitBlob": "4bb4873c279abc664d064a6e5949118d3b6a7cfd"
    },
    "after": {
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "bytes": 7352,
      "sha256": "cc80f33f89be952c17cbfd9f382a9075eefb23d537507788a4f1d9a4ccbfeb19",
      "gitBlob": "ade34d55f973eb67172b9ea2eed20cfc2f39de45"
    },
    "sourceSha": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f",
    "entireFrozenFileRequired": true
  },
  "projectFiles": [
    {
      "path": "project/STATUS.json",
      "bytes": 2642238,
      "sha256": "11094be82c51f1b18f7adafb4e74ae2231f061cfeb7711826bf5bd8fa58165ae",
      "gitBlob": "cdb7d8d13fd9b148886e7e48d3400911001e5462"
    },
    {
      "path": "project/POSTRUST_PLAN.json",
      "bytes": 2119501,
      "sha256": "5e8896ed995de6093cdd7c59695fc9cef09c83bf6ea725e63b03c208db41fe41",
      "gitBlob": "b2c374686388bbdbb7884d8f8f44c7d0728839e0"
    },
    {
      "path": "project/POSTRUST_TODO.md",
      "bytes": 30415,
      "sha256": "8a654a6ecd2813a7ea3756d21a10ec16e9ba938f666b298d32595e733b25a241",
      "gitBlob": "26ed698ca6f65d9a1b2e44c601f7b77121a2025e"
    },
    {
      "path": "project/POSTRUST_PROGRESS.md",
      "bytes": 117849,
      "sha256": "fe2bca5b8196cbcc203bfce68337c87aa44c7e4cc9a05e42600dd1e1452ae5bd",
      "gitBlob": "ef1b7496cdeef40015d8aeaa7190c587268cb6fe"
    }
  ],
  "localFixFrozenFiles": [
    {
      "path": "docs/postrust/LOCAL_LIBRARY_SIGNED_STAT_FIX/EXECUTION_SCOPE.json",
      "bytes": 22127,
      "sha256": "6a69aeff7acc2f737c3b859c1d94bfc9591dc91b3445d256c38d3cc3cf8bbb8f",
      "gitBlob": "c2f885a57e20f3629ad0bb8445f1a112bf3822a2"
    },
    {
      "path": "scripts/ci/local-library-signed-stat-fix-admission.mjs",
      "bytes": 37449,
      "sha256": "0dc21cfe7ac1c784bf680c2a7b330be86e8bb999d073dd3650e06e62cb70fb6a",
      "gitBlob": "706d673d5d7f36779235baec82d738f800817611"
    },
    {
      "path": "scripts/ci/local-library-signed-stat-legacy-normalization.mjs",
      "bytes": 5061,
      "sha256": "158a6a414e4ce93c632c2a7b89500ca8839702f95b75fcca86ee6bf7c7a6720b",
      "gitBlob": "29592fac0e2b3b59eb919c13f4e1963c7e5cbf1a"
    },
    {
      "path": "scripts/ci/test/local-library-signed-stat-fix-admission.test.mjs",
      "bytes": 14577,
      "sha256": "4f004a214ed9ebb05054f86d3a784a14258684109dce39b4c090c29d232b004e",
      "gitBlob": "652a337f31031425f1ab9a7441bbbdf5ff1ac06e"
    },
    {
      "path": "scripts/ci/test/local-library-signed-stat-legacy-normalization.test.mjs",
      "bytes": 46141,
      "sha256": "5572fce729fd38398e483b194061d8f225a968e2682a5448a539c03ece8dee2c",
      "gitBlob": "b61daaf8d7bab90203f45a6b9edc388c8cbab984"
    },
    {
      "path": "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EVIDENCE.json",
      "bytes": 28133,
      "sha256": "697110088f6366420ba9fe363ac324f9d147521140fff7c36def83a5e73fc1d4",
      "gitBlob": "3e60d069a65faa48c12509e50cf92eafe6131df7"
    },
    {
      "path": "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_RESULT.md",
      "bytes": 12121,
      "sha256": "9686a13533426d4e8a9b47fd6ad7157a2600bf7bf3c9a48deb3a210beebc79a2",
      "gitBlob": "2a6874a8c608d8ec4f58ac66ba894909db1027da"
    },
    {
      "path": "scripts/ci/mbm002-legacy-input-normalization.mjs",
      "bytes": 14267,
      "sha256": "e2a01acbc3ffaac7b6d5bd51964c05d139c61c00aba03488fb02ff0521f5b70c",
      "gitBlob": "8d290bac61d252f3a7d739a4fba1f7f40f0bf71b"
    },
    {
      "path": "scripts/ci/test/mbm002-legacy-input-normalization.test.mjs",
      "bytes": 8345,
      "sha256": "ad93af459901342d31b0eae13ab0f9b4dba3ac737846aaa4fdd4c926168c1302",
      "gitBlob": "04a889e2cf3130aa0938238c7f3cacb51f64166b"
    }
  ],
  "coreEnvironment": {
    "path": "apps/desktop/src/main/core-environment.ts",
    "bytes": 5714,
    "sha256": "38ba0e6fa5f845da791720ca8997a5ca331ed8d0f9757c464f20ebbbcbf8f712",
    "gitBlob": "1c326466207f035359374707dcba9c3b8cd5d3f6"
  },
  "mobileContract": {
    "path": "packages/contracts/mobile/openapi.json",
    "bytes": 147445,
    "sha256": "3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21",
    "gitBlob": "51d155f0a09a6988676826b6c82d858d84e9c46c",
    "version": "1.7.0",
    "operations": 40
  },
  "originalMbm003ReportInheritance": {
    "originalSource": "5e96372f0dd99e08b1e2964d68ce234eb438bbdf",
    "originalDirectReport": "99c89519f3357f4018b32930e8179b66719f99e7",
    "directReportSingleParent": "5e96372f0dd99e08b1e2964d68ce234eb438bbdf",
    "currentFixSource": "fd176fdf1da069dd678b673f697cdbe8831628cc",
    "originalReportNotAncestorAndFiveFilesAbsentFromFixTree": true,
    "immutableOriginalFiles": [
      {
        "path": "docs/postrust/MBM-003/evidence/actual-runtime.json",
        "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:docs/postrust/MBM-003/evidence/actual-runtime.json",
        "gitBlob": "f4fb084f9b1121de968f314e84ad8fa59413789f",
        "bytes": 29810,
        "sha256": "05e76d197a000783d8775d3789937a1376c5f40e8b38b24af14d89ca12dab649"
      },
      {
        "path": "docs/postrust/MBM-003/evidence/installed-trial.json",
        "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:docs/postrust/MBM-003/evidence/installed-trial.json",
        "gitBlob": "d53dac5d79eea3c148e14fe6b6f082f30ce56018",
        "bytes": 1417,
        "sha256": "97e588829290665fa2d94bfcd5b4ded0bc654339dd1d3c2b0f1326dd5bf908c6"
      },
      {
        "path": "docs/postrust/MBM-003/evidence/source-ci.json",
        "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:docs/postrust/MBM-003/evidence/source-ci.json",
        "gitBlob": "c84cb4de04d3ec8b4b3c4c8f040998598087d423",
        "bytes": 2098500,
        "sha256": "5b059b8c4ee1fea5e11ff8bd0999eae43e6cc1c894aac0f4abc1e72ea98bf7d2"
      },
      {
        "path": "reports/MBM-003_EVIDENCE.json",
        "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:reports/MBM-003_EVIDENCE.json",
        "gitBlob": "ad1b634706e4596662ddbd1f8765db5d4ceb740c",
        "bytes": 2733,
        "sha256": "266117d0180c0fbee373ef8bb4391adf1a282f3ac6821c6082cc20cafa069a4b"
      },
      {
        "path": "reports/MBM-003_RESULT.md",
        "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:reports/MBM-003_RESULT.md",
        "gitBlob": "eca589082fff7860c01bcb11b3cb1b177c035e3f",
        "bytes": 4427,
        "sha256": "fd7de646933b74e5a183e254598155e1d0e78090fff1f4cab9f9ec9d315fa6cb"
      }
    ],
    "currentFixFourProjectFilesNotOverwritten": true,
    "currentFixFrozenScopeNotExpandedToAddTheseFiveFiles": true,
    "original5eRuntimeAnd99ReportingFactsNotRelabeledAsFixFd": true,
    "currentFrozenPredecessorDispatcherDoesNotAutomaticallyImportFive99Files": true,
    "nextCombinedScopeMustConsumeImmutableGitRefsOrExplicitlyInheritOnlyPinnedFiveFiles": true,
    "newPhoneOrOldSoftwareRevalidationRequiredByReportInheritance": false,
    "privateReceipt": "checks/original-mbm003-direct-report-inheritance76.json"
  },
  "currentPins": [
    {
      "path": ".github/workflows/verify.yml",
      "bytes": 18094,
      "sha256": "373bcd88ef8dc13ae2641611fc2617363621fe72684df02925e223b2aaf247bc",
      "gitBlob": "f141cf6ffc2148629cdc0a9ed487eb3f79a0a830"
    },
    {
      "path": "apps/desktop/e2e/collection-preview.spec.ts",
      "bytes": 23987,
      "sha256": "9daddcd4e6a8ee2a8486e45ada77015a4acfe664e974cf795c9306b5fd741c35",
      "gitBlob": "545b5269149282ac09b0aa2568367b944d37679d"
    },
    {
      "path": "apps/desktop/scripts/tape-catalog-r3-observe.mjs",
      "bytes": 12492,
      "sha256": "78a8eea247c9605dcd71f72895d5a9cd4264a50b3674a4f093bc4d7ca2c8ca85",
      "gitBlob": "3763f9580509c16d2751578b2e3f2b41ac6edc68"
    },
    {
      "path": "apps/desktop/src/main/cassette-catalog-service.ts",
      "bytes": 11462,
      "sha256": "2bb1271a767c002c25bf706ac4575e31a6bf55f9c6d3db8687d9dcf33fd2ed4e",
      "gitBlob": "88773641a2bb1f812e4c90937baea7e3e3422ea4"
    },
    {
      "path": "apps/desktop/src/main/core-environment.ts",
      "bytes": 5714,
      "sha256": "38ba0e6fa5f845da791720ca8997a5ca331ed8d0f9757c464f20ebbbcbf8f712",
      "gitBlob": "1c326466207f035359374707dcba9c3b8cd5d3f6"
    },
    {
      "path": "apps/desktop/src/main/index.ts",
      "bytes": 111382,
      "sha256": "4bb278cbb22f92f5b0affb02f8b291dd6eb9d23229377b85523ddb73e1ba2e27",
      "gitBlob": "c7f982dba7d79db47fade65230fdf8423380c620"
    },
    {
      "path": "apps/desktop/src/preload/api.ts",
      "bytes": 44738,
      "sha256": "6748d8a7886abe9adff4ec2ea73d179ef0e874982c4e32c6e2217d38eebdda40",
      "gitBlob": "1ec8541d1e32dc0de473b0b37a3f77f68d81f73e"
    },
    {
      "path": "apps/desktop/src/preload/index.ts",
      "bytes": 28597,
      "sha256": "eccce4486969ee84d080d7623b54d28b865c431244ab74bb672894fa5e87dee7",
      "gitBlob": "ee21096670d13155ff74f1b977a07cbbf7f7e538"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/cassette-catalog-controller.ts",
      "bytes": 3462,
      "sha256": "91a08accff057fe002c29a51677bec2f60d5908135ee9f68d8a277facdf943cf",
      "gitBlob": "0a0f53a3deeab8feae9ed0f6a7f785dbf0373478"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteArchiveImportPanel.vue",
      "bytes": 6951,
      "sha256": "6a94a8e7467909160b36f714b1cd3d47bc73cce78444585bdd870223759d0bf0",
      "gitBlob": "f58ea07116b5bbfef4f47c042c38256d8cfd0354"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogDetail.vue",
      "bytes": 12605,
      "sha256": "0cd22aa8ff76b28aaa85913a748310761057bbfcbee11ed5bb47b1bc21ac5064",
      "gitBlob": "74680f02751654aad644fab5df54549d8fd9a8ac"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogView.vue",
      "bytes": 15887,
      "sha256": "d410d8a3e236259de4d97d8a6c5b870b7bee48ad986fee3a7543fbe460896e74",
      "gitBlob": "20f905a432db9caa6aa930654b70001600fb1bcc"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionModelDetail.vue",
      "bytes": 24769,
      "sha256": "f63391b37946dc9e58b0a2dfce85b2b0799920be5b1a60def13bafbe33e536dc",
      "gitBlob": "70d2523f13ba68e78a94a24d8593e6051d4a5c12"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReceiveDialog.vue",
      "bytes": 7713,
      "sha256": "991ea840fd38e595a4280d83d73a53c6a4fc17805692f99ec86cc2af63cec56b",
      "gitBlob": "a4fc377edd709c6146fe37be0789d69aa76ed054"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReferenceImage.vue",
      "bytes": 1165,
      "sha256": "53ac223025c193936382f5afe8aebd2260dbd6a162f6addbffdead06dfe1733e",
      "gitBlob": "62d5ace7714c9f816a9dfef84b4f090180a2aebd"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionView.vue",
      "bytes": 39258,
      "sha256": "7045d279a2e3902d02e16f469b8d04af1fe94994e20c1684b631a2f5f7f15252",
      "gitBlob": "e8069457feaead993ff8f3fe40b6ee7bb2e021d0"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/reference-images.ts",
      "bytes": 9377,
      "sha256": "a1d3579551d2bbd06547f4a5ebf35861a5344a3bbee78b55351a04b9ee9ef14a",
      "gitBlob": "e0febb7c48468dde6289c069f3a8f38c47df7b78"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/collection/ReferenceCatalogPanel.vue",
      "bytes": 37559,
      "sha256": "49574915aab3a01b71b72c56f7a3c06a794d2b1b1b0653d24cbf34c7ca0d9261",
      "gitBlob": "51ba9b3f57b7a40c561cbe72046242b09aec71cf"
    },
    {
      "path": "apps/desktop/src/renderer/src/components/CommandOutboxPanel.vue",
      "bytes": 20695,
      "sha256": "4b3b8b6cb854d61aa175875bd858c9957b02a159f3028ff90395342f2bf15e56",
      "gitBlob": "599df32aabca261aa615833e4ca136d95c5cc0d7"
    },
    {
      "path": "apps/desktop/src/shared/cassette-catalog.ts",
      "bytes": 1905,
      "sha256": "d0f9824c15498c03afc76007883bd44bf8e9055f172e0cee70b3402a0266619c",
      "gitBlob": "4b3aa3c68f8517cd70d8eff85f11d435a459b0ea"
    },
    {
      "path": "apps/desktop/test/cassette-catalog-service.test.ts",
      "bytes": 3334,
      "sha256": "db02a43a2d4df3cb9d4d5f0097796d412a03df84bccefd3020f84bfc84b6a475",
      "gitBlob": "06e63e033060b36d85cac5093777ac7c2ed54c2a"
    },
    {
      "path": "apps/desktop/test/cassette-catalog-ui.test.ts",
      "bytes": 27565,
      "sha256": "68022d18fbadae9f92a93accbf04c723609ed5e0cfb3c91405d41679392fc6a7",
      "gitBlob": "8f59d911d7543a0aa36ff9bad069e0f7dc34e89e"
    },
    {
      "path": "apps/desktop/test/collection-display.test.ts",
      "bytes": 4684,
      "sha256": "1e4722d0e65401114a1ef5df1ef6cae7b8184624f5dc0a7e44367b80b55ea898",
      "gitBlob": "da658ed602826160b42d76db8041f87116520b73"
    },
    {
      "path": "apps/desktop/test/collection-progress-ui.test.ts",
      "bytes": 33012,
      "sha256": "49dd1200d1d9be911ebc8b229096ce251d35beb5a2c820376eec5373023c9b77",
      "gitBlob": "c0e428911614c60317a40cc643c630837561840c"
    },
    {
      "path": "apps/desktop/test/collection-readonly-ui.test.ts",
      "bytes": 10271,
      "sha256": "098742e8e66d12c0286683211311ca1bbdb9962e5a5a9d0e14fe8b8c4aeef4d6",
      "gitBlob": "ab70cfe5227d1bbb312810956cd9f04ae857fd34"
    },
    {
      "path": "apps/desktop/test/collection-return-navigation.test.ts",
      "bytes": 6479,
      "sha256": "b1d19d59d919d09dfba79000372e33c6b47deb6296151ea28affa2b2f433daae",
      "gitBlob": "2e4462b7b801ade3e430f67614b7243d721ab162"
    },
    {
      "path": "apps/desktop/test/preload.test.ts",
      "bytes": 37258,
      "sha256": "91ba4beb8478bc651383cddb71ab6cdd84b930c03a1b6ba58db73fc8167391d1",
      "gitBlob": "3aa3364c7a1a991d670ed2f9d7a7f9a9718a3990"
    },
    {
      "path": "docs/postrust/LOCAL_LIBRARY_SIGNED_STAT_FIX/EXECUTION_SCOPE.json",
      "bytes": 22127,
      "sha256": "6a69aeff7acc2f737c3b859c1d94bfc9591dc91b3445d256c38d3cc3cf8bbb8f",
      "gitBlob": "c2f885a57e20f3629ad0bb8445f1a112bf3822a2"
    },
    {
      "path": "docs/postrust/MBM-000/EXECUTION_SCOPE.json",
      "bytes": 2791,
      "sha256": "bed0961a57bab85daf3d85daf382b487dc7b3f2b58bd02bcf8f807c6c1c0dc4a",
      "gitBlob": "e98a305b0571ba5283d4630ea5fd633408536574"
    },
    {
      "path": "docs/postrust/MBM-001/EXECUTION_SCOPE.json",
      "bytes": 4846,
      "sha256": "9d72a7a092f60a6c0c8e50a7f75d66ca40ec12cfe9cd40bbd333ccb02fea6484",
      "gitBlob": "b30a180cf27cdfc081ccc5f4d9583812e47cffff"
    },
    {
      "path": "docs/postrust/MBM-002/EXECUTION_SCOPE.json",
      "bytes": 2232,
      "sha256": "45c6665ba2cf1563621ffbd4181aae48abc471204849675d896c77a0fe0dbeef",
      "gitBlob": "fd245258ded96a2da8f5ca39d8c5c6551b41e4bb"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_FREEZE.json",
      "bytes": 2184,
      "sha256": "dd8fef00d2ab38066c458b5c92c16d5e060633d40dff7bcce488b609f57d3e5a",
      "gitBlob": "767193fcf97cf2dbdcd42ad5f29d6b303d6489d3"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS_DRAFT.md",
      "bytes": 3105,
      "sha256": "c7b40febb7039f700a68c737d8624810f60f0a6560dbdec5cfd7dec4c045efef",
      "gitBlob": "f65e1e3a6b4374fdeed3933c7d7e62e25c4e4e36"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS.md",
      "bytes": 6076,
      "sha256": "698ca28f695b950c7409489b67929da523193856461f858df7047c1b48d2fa2a",
      "gitBlob": "66d1de97033684d7789acdaaaf7ef9a151b2c98e"
    },
    {
      "path": "docs/postrust/MBM-003/contract-preview/openapi.json",
      "bytes": 147487,
      "sha256": "9dcde7b24150e9b21dc9366bd913e3ca216a34584b6f85942fee17e8bd7a06a8",
      "gitBlob": "76a28da1cf3fb373f8677d0310aae44e985559ab"
    },
    {
      "path": "docs/postrust/MBM-003/DSD_PROCESSING_CONTRACT_PROPOSAL.json",
      "bytes": 3863,
      "sha256": "189250e7ad93dddc4c24dccc6c7ec86565d3cd06e84a0fb977fc125ef4924ffc",
      "gitBlob": "b7b764cd82605a61672a13fd8b4377f7fbf2e9b8"
    },
    {
      "path": "docs/postrust/MBM-003/EXECUTION_SCOPE.json",
      "bytes": 7103,
      "sha256": "e0e35e4723a90c07a422c30f355ac7ab76b78ce17212e0aa414369622e5071ec",
      "gitBlob": "d81bd62f51ec55ae0a33f0aa3d322b1bb1ae21b7"
    },
    {
      "path": "docs/postrust/MBM-003/IMPLEMENTATION_CHECKPOINT.md",
      "bytes": 4860,
      "sha256": "1f70c1b015d85cc1bae7798190e722d38529e3a1efcca7bf96b3087bb97b3678",
      "gitBlob": "dfb14e09c0a6470a243def350bddbe9e657acb97"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_DSD_TRANSPORT_DECISION_2026-10-10.json",
      "bytes": 4578,
      "sha256": "a36b722255201e98167b4a616fa8228cf2109b8204613d0cb3a85aab7f2bc256",
      "gitBlob": "4b9c01cbc44a723ac51802008e9d80d3206f088a"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_AMENDMENT_2026-10-09.json",
      "bytes": 4007,
      "sha256": "1b63215f580aa6975ad9cccf265c666cc6b37cbec9f9e75ab1eb4837758a9718",
      "gitBlob": "645678a59e8e0872e8ff230c01d7656d7cfc27d2"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_DECISION_2026-10-10.json",
      "bytes": 6241,
      "sha256": "4851db40bf2f987c0d787413a2d7b0bcc6461d151f33d7ae20c796c63920baad",
      "gitBlob": "69661b576756d8a53eea6184aa5243ed4896457e"
    },
    {
      "path": "docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json",
      "bytes": 1932,
      "sha256": "9ea3af0f43c773819a969260dade313c6f54c3e37ac57214d666e18c52383147",
      "gitBlob": "e47dd406582123d584cb313515d83cb7e0c38e1e"
    },
    {
      "path": "docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json",
      "bytes": 3058,
      "sha256": "87cb1fcc67dc74013b7780cdf01e3ff0d44d756ee964938c23b0e37c266e1d4c",
      "gitBlob": "a1fdf051c9ecf9a3d73158a2f8e8d83733ba9936"
    },
    {
      "path": "docs/postrust/MBM-003/READY_RENEW_BOUNDARY.json",
      "bytes": 1374,
      "sha256": "18ced7a85d813730f90108ad18ac7f0e903f261d23dfda1b214188513b659665",
      "gitBlob": "448d09afd1f697f995f3ede74e05a5a69289334c"
    },
    {
      "path": "docs/tape-catalog-r3/ARTIFACTS.json",
      "bytes": 6971,
      "sha256": "3feb8489444f8d11179e76dade3c4cc405a1e8a3bf98e6f13981a31ba40917e7",
      "gitBlob": "0b5e38e34c9ee1f951f1eb0c25b9462a162b94da"
    },
    {
      "path": "docs/tape-catalog-r3/CI_APPLICABILITY.md",
      "bytes": 7573,
      "sha256": "62153b9aa5c2e0c5b357867a20888245edb2c9ab101c8cf1526ff178c78f8d7d",
      "gitBlob": "3e36b725a3cc77e47107d96266d54a59a3bff919"
    },
    {
      "path": "docs/tape-catalog-r3/CI_SCOPE.json",
      "bytes": 1974,
      "sha256": "d726b98bf8dd02d0dadc02434596121c31a5e35b3af02eb93c8b224dcf771cc1",
      "gitBlob": "1a474c709c3be536f4363f6c108ddb1ef6efd4d9"
    },
    {
      "path": "docs/tape-catalog-r3/EXECUTION_SCOPE.json",
      "bytes": 5630,
      "sha256": "7fc8edf02cb64cdb91c286b9180ed13f1ab7878eb5c17c8d35ba37b56da368d4",
      "gitBlob": "03d8192132051cb9d7eab3dad7db69b5b8c77528"
    },
    {
      "path": "docs/tape-catalog-r3/RESULT.md",
      "bytes": 10373,
      "sha256": "1880f7d6b37ab6f5c2c5be454903b40b8e93477ed3fda865a6e68550db7123be",
      "gitBlob": "2e198325443d3bb7f85107272963e46de42d8074"
    },
    {
      "path": "docs/tape-catalog-r3/STATUS.json",
      "bytes": 4166,
      "sha256": "f1582c26e893b9636b6b01f15e8a86fb1e7c78460de52477b863473f0268a544",
      "gitBlob": "b236a5178ad5c3f622b6c3629d87c345ba9751cd"
    },
    {
      "path": "packages/bridge-core/src/application/local-source-resolver.ts",
      "bytes": 8424,
      "sha256": "3fc6087d0e4cb14edb2d0eab65917ce479a688cb71a9a88fc07d50ff0f4fb4c5",
      "gitBlob": "3e70c32eb8023f712d898e48f6dbc4ba58844867"
    },
    {
      "path": "packages/bridge-core/src/collection/cassette-archive.ts",
      "bytes": 35565,
      "sha256": "0716a8de02fcce06a4a06aec87f2773152bda239fa53f6e6e460dda33da574b6",
      "gitBlob": "d2ef786b8435b8b7157bee1ac754e4b3988d9c8d"
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-dispatch.ts",
      "bytes": 59157,
      "sha256": "32f43b5dda5766bfa2b50d4c1c1f00e979993b50f2ed494444cd4cdcf81e44b3",
      "gitBlob": "31390c6dba3604836bdc2204d5414c9e046ee011"
    },
    {
      "path": "packages/bridge-core/src/collection/dataset-owner-protocol.ts",
      "bytes": 30338,
      "sha256": "fa070d9383c8913d27e9ff23f59e2417b7402c19f13d7ec57d09b09e64823c5b",
      "gitBlob": "3990b5337b5d89b073d97513c09ec2c4cf5b2024"
    },
    {
      "path": "packages/bridge-core/src/collection/local-relocation-coordinator.ts",
      "bytes": 9644,
      "sha256": "05acb43a9486bf3c33ce06fd4e2d13908668b67125ef362c751fd03beaffd98c",
      "gitBlob": "6e884b7d4ce58f44a7ccd92305f9b22603b92b95"
    },
    {
      "path": "packages/bridge-core/src/collection/local-scan-coordinator.ts",
      "bytes": 36729,
      "sha256": "c690142cee8bfb3de0762fbe69df6a325b1d44baafe461e8c8afb3dc603ea92d",
      "gitBlob": "7e5cb3f111ba3dd5a045e7d609b2ad1d4470fc52"
    },
    {
      "path": "packages/bridge-core/src/collection/local-source-ticket-types.ts",
      "bytes": 4423,
      "sha256": "ac836361c8bcd7d428d73e3ccc570310d54c8337ee007555d23eee5a7b26f67f",
      "gitBlob": "9cf26b78f494cfa2de499a5ff013f986c6e4c6d9"
    },
    {
      "path": "packages/bridge-core/src/collection/reference-catalog-store.ts",
      "bytes": 46960,
      "sha256": "0d197187345ef39897fb3dbf0be469e737a5de49b1733663b44b778ca8eccda1",
      "gitBlob": "4fe9e51a6aab6c84427330d7a1c00e3462aa35eb"
    },
    {
      "path": "packages/bridge-core/src/collection/repository.ts",
      "bytes": 66458,
      "sha256": "a062a84b5832830a81d4156af2fb004c0aec00ae020d7937471b5eb1a40aab83",
      "gitBlob": "a87bd6e8d5b592163ee97221daf35fc3c2fedfcb"
    },
    {
      "path": "packages/bridge-core/src/library/metadata-reader-types.ts",
      "bytes": 4680,
      "sha256": "53d23129795ddbb0440687a8519636fee23624caef2f4a1a71e17774ccde03ff",
      "gitBlob": "41b2aff101f02f69c196633a372542024b5dd25a"
    },
    {
      "path": "packages/bridge-core/src/library/metadata-reader-worker.ts",
      "bytes": 21652,
      "sha256": "259691cb8e8062b3db4d8522da864e6c14c2b0dde7ecaf19950e91add0662577",
      "gitBlob": "2e94f86034ec35dc2bf83d5897334543e8c11d88"
    },
    {
      "path": "packages/bridge-core/src/library/metadata-reader.ts",
      "bytes": 14112,
      "sha256": "375f2527dc23c4b2be5431dbc98a95882d3654a77c9d368ecc74eaf11c582097",
      "gitBlob": "5ba774ec24489b60c87a34f17b9a2fa833f08638"
    },
    {
      "path": "packages/bridge-core/src/recording/restore-dataset-runtime.ts",
      "bytes": 12768,
      "sha256": "81f6148faea02e2ba33ef2d3a3213a1827957b17e7bdaf1e1383f7c9d1376f67",
      "gitBlob": "a14f6a9143f002361a3d21544619b3fa806ea53d"
    },
    {
      "path": "packages/bridge-core/src/recording/source-files.ts",
      "bytes": 46157,
      "sha256": "3ccafec70017b883c3709a72b6715b3ca6b367b663a71d858b0279424e7de898",
      "gitBlob": "5804e480219c884de4354fe84748a3dbb760faee"
    },
    {
      "path": "packages/bridge-core/src/stream/local-file-source.ts",
      "bytes": 11489,
      "sha256": "39c5bfd368273d75fdb81a69566c67180fbd36c383217056720843c8847be7f5",
      "gitBlob": "603b4b69163614e7e1ea2fd36240d437c7ec2d08"
    },
    {
      "path": "packages/bridge-core/src/stream/physical-resource-claims.ts",
      "bytes": 14918,
      "sha256": "8b1f47063435521135b5bfaf61951b6486d355fdcea6bb9bdfe3fdff5cd4cdba",
      "gitBlob": "38b3e563995f75af7b334ea1b2000ce745390d0b"
    },
    {
      "path": "packages/bridge-core/src/stream/physical-resource-locks.ts",
      "bytes": 15391,
      "sha256": "79052d83b6c602de784da7002f975aaf71e91c84f11bb9acc7d913fbf2fff2b8",
      "gitBlob": "a7f9fd18088bce4986269072b942ae119b5ca5a6"
    },
    {
      "path": "packages/bridge-core/src/stream/source-namespace-claims.ts",
      "bytes": 24762,
      "sha256": "c7810434565cdb4b5c8fe394ca70d50442327e158a1439b54dcf3ae15e35d715",
      "gitBlob": "1a4623a32f5f98999cd7233cfc47d9e651e8edeb"
    },
    {
      "path": "packages/bridge-core/test/cassette-archive.test.ts",
      "bytes": 14856,
      "sha256": "4a6dcc7879bc0fa724126d8fb31f373bd550c38d80f8c1a6f1faf282a169ddb2",
      "gitBlob": "50234bcbdbc301fb16e7c6f1c5e447b111dc0a8b"
    },
    {
      "path": "packages/bridge-core/test/cassette-import-dispatch.test.ts",
      "bytes": 1456,
      "sha256": "7b28d6e13baf7ba89ffcde3b39ee3f2f57c432280e9c99b5da33aa98bb599940",
      "gitBlob": "8af61f5d009fdec1edc26e0f1f7c87fb898b8c65"
    },
    {
      "path": "packages/bridge-core/test/local-library-wave-empty-list.test.ts",
      "bytes": 31034,
      "sha256": "1090e2a1547b376cdb7c3d738d5a5e4f3223cf6e6d5d38a13b0810b4009505dd",
      "gitBlob": "fa1b24afbfad462714ae780c9a5f2f26573a3dd7"
    },
    {
      "path": "packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts",
      "bytes": 26566,
      "sha256": "571a14e89f3395bfd7e4b66900bba3344bfa8e74640b9aef7b7c25ab8bc84fd4",
      "gitBlob": "b11aa58c766ded86bfbc5e14b82f263151da959a"
    },
    {
      "path": "packages/bridge-core/test/mbrs004/name-rules-scan-integration.test.ts",
      "bytes": 9010,
      "sha256": "9aa92bb73fd445ac4e8ec829d1fae2c9eb470811aecd45f3c7513fc48bdb2229",
      "gitBlob": "f22b22f8cba2ebdba6461f29a5331b1859f3053b"
    },
    {
      "path": "packages/bridge-core/test/mbrs005/config-integration.test.ts",
      "bytes": 8337,
      "sha256": "e284cd3cbd7e44ee08b24c5a94c0faf8725113b2e37fcbed755940c8c4eb4510",
      "gitBlob": "75e486c1ce8ff5eea626a206c5b9ec5f4c4a7346"
    },
    {
      "path": "packages/bridge-core/test/mbrs006/owner-worker.ts",
      "bytes": 722,
      "sha256": "6cbc6a24cf1a5e2945972c7993c46314de4860825a8bff7219e096b8b2249e55",
      "gitBlob": "6a453ccf23fea8c1c2952259d5b03df19a1fb214"
    },
    {
      "path": "packages/bridge-core/test/mbrs007/queue-worker.ts",
      "bytes": 731,
      "sha256": "dd626e9703546af316226f66e345d328bb2105b128466103a5739caf87ca0b08",
      "gitBlob": "134273d813a127d17ecfe737138f71eaae4b73f7"
    },
    {
      "path": "packages/bridge-core/test/reference-archive-catalog-store.test.ts",
      "bytes": 19643,
      "sha256": "cd29116df00bf415fac5276454472cef8f83a1702ee2baad11c602530f703b60",
      "gitBlob": "0db2e3167c707f023ad8fc2aee396240b3f27c39"
    },
    {
      "path": "packages/contracts/mobile/openapi.json",
      "bytes": 147445,
      "sha256": "3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21",
      "gitBlob": "51d155f0a09a6988676826b6c82d858d84e9c46c"
    },
    {
      "path": "packages/contracts/src/command-outbox.ts",
      "bytes": 33600,
      "sha256": "276f6f1eef08931a1051c172217f663c47402ea4c5f15177214a705de680f892",
      "gitBlob": "45feab54cd57aeec5d1f4b7e372323365fd34ab8"
    },
    {
      "path": "packages/contracts/src/ipc-names.ts",
      "bytes": 9505,
      "sha256": "541948e20d047293883b3d93d7a08a107fc32b29a35c008edce269e4ac30bff6",
      "gitBlob": "b08f20ae13f91b0974f9d4e1a2b0a8705a70a484"
    },
    {
      "path": "packages/contracts/src/ipc.ts",
      "bytes": 46925,
      "sha256": "2593372ce88e2920273068d4ebed86172f38eeb595a443908797b195fb42b918",
      "gitBlob": "c63f2cf2edb1d3d60d0cf7d8130e8a58ce84a519"
    },
    {
      "path": "packages/contracts/src/reference-catalog.ts",
      "bytes": 30579,
      "sha256": "0d8ea64fe9a3ae5ba234be2c4f7289e232f3dda975ec0cabec6f4d75c9ca61da",
      "gitBlob": "51143d386ae8722850d9f5d3b2859a0b3ab17db6"
    },
    {
      "path": "packages/contracts/src/validator.ts",
      "bytes": 128571,
      "sha256": "cd95ddab71d7c60590b9aee6538657ee8ff4e1c8237dddf173bd83e5367334d9",
      "gitBlob": "cf3e057bbd3cf97fbcab4c4ccd5617ca864cf67d"
    },
    {
      "path": "packages/contracts/test/cassette-import-ipc.test.ts",
      "bytes": 1211,
      "sha256": "e6448d235a2aadf8f3d7e788e4e0874a8e75684cd85cc63f66cc2d57680b1d4f",
      "gitBlob": "f6aca2176a83471a4cae0ef2c552a75f819746a4"
    },
    {
      "path": "packages/contracts/test/reference-catalog.test.ts",
      "bytes": 22893,
      "sha256": "0782732451e5e73f040bd2013402db4ce0f194a6dd5c3ad9bb5a783170af8482",
      "gitBlob": "7e8051cb1c6e25be530e9d14750cdd692f87dc3a"
    },
    {
      "path": "project/POSTRUST_PLAN.json",
      "bytes": 2119501,
      "sha256": "5e8896ed995de6093cdd7c59695fc9cef09c83bf6ea725e63b03c208db41fe41",
      "gitBlob": "b2c374686388bbdbb7884d8f8f44c7d0728839e0"
    },
    {
      "path": "project/POSTRUST_PROGRESS.md",
      "bytes": 117849,
      "sha256": "fe2bca5b8196cbcc203bfce68337c87aa44c7e4cc9a05e42600dd1e1452ae5bd",
      "gitBlob": "ef1b7496cdeef40015d8aeaa7190c587268cb6fe"
    },
    {
      "path": "project/POSTRUST_TODO.md",
      "bytes": 30415,
      "sha256": "8a654a6ecd2813a7ea3756d21a10ec16e9ba938f666b298d32595e733b25a241",
      "gitBlob": "26ed698ca6f65d9a1b2e44c601f7b77121a2025e"
    },
    {
      "path": "project/STATUS.json",
      "bytes": 2642238,
      "sha256": "11094be82c51f1b18f7adafb4e74ae2231f061cfeb7711826bf5bd8fa58165ae",
      "gitBlob": "cdb7d8d13fd9b148886e7e48d3400911001e5462"
    },
    {
      "path": "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EVIDENCE.json",
      "bytes": 28133,
      "sha256": "697110088f6366420ba9fe363ac324f9d147521140fff7c36def83a5e73fc1d4",
      "gitBlob": "3e60d069a65faa48c12509e50cf92eafe6131df7"
    },
    {
      "path": "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_RESULT.md",
      "bytes": 12121,
      "sha256": "9686a13533426d4e8a9b47fd6ad7157a2600bf7bf3c9a48deb3a210beebc79a2",
      "gitBlob": "2a6874a8c608d8ec4f58ac66ba894909db1027da"
    },
    {
      "path": "reports/MBM-002_EVIDENCE.json",
      "bytes": 4030,
      "sha256": "6fb3dbcdf7bc2026bae0b30664581c0d3bc476aad132c274354e19eb7d1a5bea",
      "gitBlob": "e6efe5839fdefc53b20099f115e5122dd3dd832f"
    },
    {
      "path": "reports/MBM-002_RESULT.md",
      "bytes": 873,
      "sha256": "0dda06192257333401b2836281458f8c9479c6d2a03109c2200f636efbca3c3d",
      "gitBlob": "33754a5246b065fd2c78c9554f3457c351d58b34"
    },
    {
      "path": "scripts/ci/local-library-signed-stat-fix-admission.mjs",
      "bytes": 37449,
      "sha256": "0dc21cfe7ac1c784bf680c2a7b330be86e8bb999d073dd3650e06e62cb70fb6a",
      "gitBlob": "706d673d5d7f36779235baec82d738f800817611"
    },
    {
      "path": "scripts/ci/local-library-signed-stat-legacy-normalization.mjs",
      "bytes": 5061,
      "sha256": "158a6a414e4ce93c632c2a7b89500ca8839702f95b75fcca86ee6bf7c7a6720b",
      "gitBlob": "29592fac0e2b3b59eb919c13f4e1963c7e5cbf1a"
    },
    {
      "path": "scripts/ci/mbm002-legacy-input-normalization.mjs",
      "bytes": 14267,
      "sha256": "e2a01acbc3ffaac7b6d5bd51964c05d139c61c00aba03488fb02ff0521f5b70c",
      "gitBlob": "8d290bac61d252f3a7d739a4fba1f7f40f0bf71b"
    },
    {
      "path": "scripts/ci/mbm003-contract-gate.mjs",
      "bytes": 8831,
      "sha256": "29a96cadb48571fba8aca902f8fa99e391dbb1a43021a5e642a03acc2d37d56e",
      "gitBlob": "fcd524d25aa3dbfd8f09912d08f9f4c2f4038898"
    },
    {
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "bytes": 7352,
      "sha256": "cc80f33f89be952c17cbfd9f382a9075eefb23d537507788a4f1d9a4ccbfeb19",
      "gitBlob": "ade34d55f973eb67172b9ea2eed20cfc2f39de45"
    },
    {
      "path": "scripts/ci/mbm003-software-gate.mjs",
      "bytes": 35887,
      "sha256": "85a88fedba29caa43f68fe6d49551f86578948ad9e2ff4decd450cbf48086dc3",
      "gitBlob": "a49f8f356fb7d3f806539235ff8de0baa2ebdd1c"
    },
    {
      "path": "scripts/ci/report-only-admission.mjs",
      "bytes": 27460,
      "sha256": "ed5c7c32f3aa27591e99139807827fd5bc1089693df09409578508231be762ab",
      "gitBlob": "925c4ec45a43bac248c0d8b55b4b22f97300e8df"
    },
    {
      "path": "scripts/ci/report-only-mbm002.mjs",
      "bytes": 9791,
      "sha256": "223e3efbd10ce3d59635f73717465cafadcedd11b16c5260617b0f76be134aea",
      "gitBlob": "36ca7e813fcca28ed2018bb4304769d000697d5b"
    },
    {
      "path": "scripts/ci/report-only-mbm003.mjs",
      "bytes": 11480,
      "sha256": "68da84bebcdc79fb650fb809b75bbcd0ab049da3b5470f267f1943f82e4d6e85",
      "gitBlob": "fc80ca25ae1055b4a83bbe60698f7e7cec023ed2"
    },
    {
      "path": "scripts/ci/run-core-tests.mjs",
      "bytes": 13476,
      "sha256": "5b6b405a4fe514197765cb7c9fc59d1f1141545d143effd7f1f1ff4c65a5d44b",
      "gitBlob": "7b8e330d90273943f5bd87d1552fb3766c9abc2c"
    },
    {
      "path": "scripts/ci/tape-catalog-r3-ci-applicability.mjs",
      "bytes": 11915,
      "sha256": "a4d7a091db2d85cc33dc9ba80351485d781c0ba86e1f26599d831c7aab9e01ab",
      "gitBlob": "d52904a072c41878225c6f246d954b60bac4c8e3"
    },
    {
      "path": "scripts/ci/test/local-library-signed-stat-fix-admission.test.mjs",
      "bytes": 14577,
      "sha256": "4f004a214ed9ebb05054f86d3a784a14258684109dce39b4c090c29d232b004e",
      "gitBlob": "652a337f31031425f1ab9a7441bbbdf5ff1ac06e"
    },
    {
      "path": "scripts/ci/test/local-library-signed-stat-legacy-normalization.test.mjs",
      "bytes": 46141,
      "sha256": "5572fce729fd38398e483b194061d8f225a968e2682a5448a539c03ece8dee2c",
      "gitBlob": "b61daaf8d7bab90203f45a6b9edc388c8cbab984"
    },
    {
      "path": "scripts/ci/test/mbm002-legacy-input-normalization.test.mjs",
      "bytes": 8345,
      "sha256": "ad93af459901342d31b0eae13ab0f9b4dba3ac737846aaa4fdd4c926168c1302",
      "gitBlob": "04a889e2cf3130aa0938238c7f3cacb51f64166b"
    },
    {
      "path": "scripts/ci/test/tape-catalog-r3-ci-applicability.test.mjs",
      "bytes": 40566,
      "sha256": "82b365f8dce1ae075d1897992f7d0bf852999db4a9b7dbc8eeb7d1f31ded1132",
      "gitBlob": "094c42f4e441d1fbd2a583b18347f615d7036502"
    },
    {
      "path": "scripts/ci/verify-mbm000-contract-adoption.mjs",
      "bytes": 44759,
      "sha256": "a3e87936042d8085615b07a6ad2eeec1ada98645cdcbabbf5f0b2c50f23d86b5",
      "gitBlob": "9dba48422779a6228b22db8ef94a963a8d34ec27"
    },
    {
      "path": "scripts/ci/verify-mbm001-pairing-library.mjs",
      "bytes": 18073,
      "sha256": "b439348a66c25b1a70493ca75854a9e346737763dbc42f9d3a9c8f84dceeb855",
      "gitBlob": "af694a75605c2b1f41ca60d327764b1d1be6b435"
    },
    {
      "path": "scripts/ci/verify-mbm002-resource-playback.mjs",
      "bytes": 12321,
      "sha256": "9e48660e3e074f1172de49740713d9e072f1ba0d8dc3684cedd1e04897d3e28e",
      "gitBlob": "f9d73dd0580032ee94ab5c995cc05cd8cd346eef"
    },
    {
      "path": "scripts/ci/verify-mbrs001-offline.mjs",
      "bytes": 14851,
      "sha256": "35ad160e0f58c0eea0cbb22ae0f4d948955c13c05857eaa3134c18aa9552ab3d",
      "gitBlob": "44aaa3138052bb02d32bb203a55e768118317cb3"
    },
    {
      "path": "scripts/ci/verify-mbrs002-contracts.mjs",
      "bytes": 22849,
      "sha256": "b207255e2d7a555cd3ea9d4ba305472bf8f09a5c72a0877fd081eae249be1b8e",
      "gitBlob": "4d371724a9da77219d794fcc674015728dfd6053"
    },
    {
      "path": "scripts/ci/verify-mbrs003-scan.mjs",
      "bytes": 37197,
      "sha256": "c33d12f7401bcbdfa3b532bfc00376377e224ad8c5a6efa1b77eff6a1dc1dc53",
      "gitBlob": "4fc2a686e11c217832105021c108be4f006def1a"
    },
    {
      "path": "scripts/ci/verify-mbrs004-rules.mjs",
      "bytes": 11521,
      "sha256": "a2e293a7c1860526cba36334285eda3b9e759b77c91b5fbb03bba27ffc7bc328",
      "gitBlob": "5bf3376af4f965a295c11cc1e51f7251b6a7e1e2"
    },
    {
      "path": "scripts/ci/verify-mbrs005-gateway.mjs",
      "bytes": 14217,
      "sha256": "c77cde79ec4dfc4486afda25a74c0455fb5c96200cf5273724ccf3435cf2863e",
      "gitBlob": "f0a1b21163298ee7837993beb79558c8741dcf43"
    },
    {
      "path": "scripts/ci/verify-mbrs006-local-playback.mjs",
      "bytes": 16705,
      "sha256": "4df7b1624306556a5df90e31cc6565fd51b5baaedf2961d6e4574ec3eae6dbb6",
      "gitBlob": "f8639be464f4c32878acacc82417c55d74643e26"
    },
    {
      "path": "scripts/ci/verify-mbrs007-queue.mjs",
      "bytes": 23136,
      "sha256": "c9d8c1d1605ea08b2754e6058440940dbcede505b3b0c90f44c81a8adee94471",
      "gitBlob": "6b5f24c4fe98aa5f8e50f5af6780bb874e1055f2"
    },
    {
      "path": "scripts/ci/verify-mbrs008-audio.mjs",
      "bytes": 21327,
      "sha256": "c00e66b3c5ce423352bdfdc79be458b973d9b8a695ec5569b579cfb039cc4527",
      "gitBlob": "87312721e40f124afd15f394b18f4517d5002a83"
    },
    {
      "path": "scripts/ci/verify-mbrs008-ui-render.mjs",
      "bytes": 6034,
      "sha256": "6bddcb1221be202ce4af5ee75cafacedb63bca5c480f7a5a027144e445db513b",
      "gitBlob": "96ad195d314bcb30eedbb4d05fd9bfdb608cdbe3"
    },
    {
      "path": "scripts/ci/verify-mbrs009-local-library-ui.mjs",
      "bytes": 21699,
      "sha256": "f834f4e6dfefe6e0985a31896e4e9d0d03d90a6d7b5fa968359ac613a83434ff",
      "gitBlob": "5238d744a0669f300319a819a2eefcc16042a4ba"
    },
    {
      "path": "scripts/ci/verify-mbrs009-ui-render.mjs",
      "bytes": 7479,
      "sha256": "9d4e2fc018fee8673a721b4667975994f3cc307296627cb675ab95773fe369d3",
      "gitBlob": "a3d7da32baf3e7d12a5aa6feb9dc91c400fc1ee7"
    },
    {
      "path": "scripts/ci/verify-mbrs010-artwork.mjs",
      "bytes": 29111,
      "sha256": "3427476dd5fb20f243a48b359ec6b5a06faa0157c7333dd7582cf3814da3a7f4",
      "gitBlob": "64876ac23a502b3a6c179ee68d68a8c65d816ae6"
    },
    {
      "path": "scripts/ci/verify-mbrs011-organizer.mjs",
      "bytes": 17055,
      "sha256": "56988faccb590c14f5241b431ef5d555271bd2e6496aa3a346107fa7cf52b692",
      "gitBlob": "d65c6f5bf55fde9c3da4a951dc7f4ae203283ce9"
    },
    {
      "path": "scripts/ci/verify-mbrs012-source-writes.mjs",
      "bytes": 27972,
      "sha256": "84185ff650463228d6584c862674823c9bdafc45ec704cb7a6a1bf2b06c43e42",
      "gitBlob": "74727eb22b11e7db86d27c0d96420219b6acb703"
    },
    {
      "path": "scripts/ci/verify-mbrs013-relocation.mjs",
      "bytes": 23501,
      "sha256": "ee35adb79f5805ebfe7754bf0987ade6baf1412d568ac750f1eecf94ab363b92",
      "gitBlob": "52fbc2531d17e16b4acb1369a38da225e42a1d8b"
    },
    {
      "path": "scripts/ci/verify-mbrs014-compatibility.mjs",
      "bytes": 23064,
      "sha256": "11d46740fe6e9e0169af1503ec135b74e52b1338b740148bc994e5d59ecfc262",
      "gitBlob": "65532fde5d3b0d264cd5a2ba265f330ee1665e15"
    },
    {
      "path": "scripts/tape-catalog-r3-gate.ts",
      "bytes": 13456,
      "sha256": "2f86d5c6ecc41e0f442b5b534cd005f59bb8f5bb88b5232026c33c0e7aaf86d5",
      "gitBlob": "df05b786bfe64b1ad80264728829560cb2e98bba"
    },
    {
      "path": "scripts/tape-catalog-r3-restore-gate.ts",
      "bytes": 7077,
      "sha256": "882342a724c18736beb2bed09effdcdb6d247408ca3094ae13bf4bb98c2f89e3",
      "gitBlob": "3dffaeac13930c19bb12700087c282c790822fe0"
    }
  ],
  "gitPins": [
    {
      "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:docs/postrust/MBM-003/evidence/actual-runtime.json",
      "path": "docs/postrust/MBM-003/evidence/actual-runtime.json",
      "bytes": 29810,
      "sha256": "05e76d197a000783d8775d3789937a1376c5f40e8b38b24af14d89ca12dab649",
      "gitBlob": "f4fb084f9b1121de968f314e84ad8fa59413789f"
    },
    {
      "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:docs/postrust/MBM-003/evidence/installed-trial.json",
      "path": "docs/postrust/MBM-003/evidence/installed-trial.json",
      "bytes": 1417,
      "sha256": "97e588829290665fa2d94bfcd5b4ded0bc654339dd1d3c2b0f1326dd5bf908c6",
      "gitBlob": "d53dac5d79eea3c148e14fe6b6f082f30ce56018"
    },
    {
      "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:docs/postrust/MBM-003/evidence/source-ci.json",
      "path": "docs/postrust/MBM-003/evidence/source-ci.json",
      "bytes": 2098500,
      "sha256": "5b059b8c4ee1fea5e11ff8bd0999eae43e6cc1c894aac0f4abc1e72ea98bf7d2",
      "gitBlob": "c84cb4de04d3ec8b4b3c4c8f040998598087d423"
    },
    {
      "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:reports/MBM-003_EVIDENCE.json",
      "path": "reports/MBM-003_EVIDENCE.json",
      "bytes": 2733,
      "sha256": "266117d0180c0fbee373ef8bb4391adf1a282f3ac6821c6082cc20cafa069a4b",
      "gitBlob": "ad1b634706e4596662ddbd1f8765db5d4ceb740c"
    },
    {
      "gitRef": "99c89519f3357f4018b32930e8179b66719f99e7:reports/MBM-003_RESULT.md",
      "path": "reports/MBM-003_RESULT.md",
      "bytes": 4427,
      "sha256": "fd7de646933b74e5a183e254598155e1d0e78090fff1f4cab9f9ec9d315fa6cb",
      "gitBlob": "eca589082fff7860c01bcb11b3cb1b177c035e3f"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:apps/desktop/src/main/core-environment.ts",
      "path": "apps/desktop/src/main/core-environment.ts",
      "bytes": 5714,
      "sha256": "38ba0e6fa5f845da791720ca8997a5ca331ed8d0f9757c464f20ebbbcbf8f712",
      "gitBlob": "1c326466207f035359374707dcba9c3b8cd5d3f6"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/LOCAL_LIBRARY_SIGNED_STAT_FIX/EXECUTION_SCOPE.json",
      "path": "docs/postrust/LOCAL_LIBRARY_SIGNED_STAT_FIX/EXECUTION_SCOPE.json",
      "bytes": 22127,
      "sha256": "6a69aeff7acc2f737c3b859c1d94bfc9591dc91b3445d256c38d3cc3cf8bbb8f",
      "gitBlob": "c2f885a57e20f3629ad0bb8445f1a112bf3822a2"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-000/EXECUTION_SCOPE.json",
      "path": "docs/postrust/MBM-000/EXECUTION_SCOPE.json",
      "bytes": 2791,
      "sha256": "bed0961a57bab85daf3d85daf382b487dc7b3f2b58bd02bcf8f807c6c1c0dc4a",
      "gitBlob": "e98a305b0571ba5283d4630ea5fd633408536574"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-001/EXECUTION_SCOPE.json",
      "path": "docs/postrust/MBM-001/EXECUTION_SCOPE.json",
      "bytes": 4846,
      "sha256": "9d72a7a092f60a6c0c8e50a7f75d66ca40ec12cfe9cd40bbd333ccb02fea6484",
      "gitBlob": "b30a180cf27cdfc081ccc5f4d9583812e47cffff"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-002/EXECUTION_SCOPE.json",
      "path": "docs/postrust/MBM-002/EXECUTION_SCOPE.json",
      "bytes": 2232,
      "sha256": "45c6665ba2cf1563621ffbd4181aae48abc471204849675d896c77a0fe0dbeef",
      "gitBlob": "fd245258ded96a2da8f5ca39d8c5c6551b41e4bb"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/CONTRACT_FREEZE.json",
      "path": "docs/postrust/MBM-003/CONTRACT_FREEZE.json",
      "bytes": 2184,
      "sha256": "dd8fef00d2ab38066c458b5c92c16d5e060633d40dff7bcce488b609f57d3e5a",
      "gitBlob": "767193fcf97cf2dbdcd42ad5f29d6b303d6489d3"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/CONTRACT_SEMANTICS_DRAFT.md",
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS_DRAFT.md",
      "bytes": 3105,
      "sha256": "c7b40febb7039f700a68c737d8624810f60f0a6560dbdec5cfd7dec4c045efef",
      "gitBlob": "f65e1e3a6b4374fdeed3933c7d7e62e25c4e4e36"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/CONTRACT_SEMANTICS.md",
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS.md",
      "bytes": 6076,
      "sha256": "698ca28f695b950c7409489b67929da523193856461f858df7047c1b48d2fa2a",
      "gitBlob": "66d1de97033684d7789acdaaaf7ef9a151b2c98e"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/contract-preview/openapi.json",
      "path": "docs/postrust/MBM-003/contract-preview/openapi.json",
      "bytes": 147487,
      "sha256": "9dcde7b24150e9b21dc9366bd913e3ca216a34584b6f85942fee17e8bd7a06a8",
      "gitBlob": "76a28da1cf3fb373f8677d0310aae44e985559ab"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/DSD_PROCESSING_CONTRACT_PROPOSAL.json",
      "path": "docs/postrust/MBM-003/DSD_PROCESSING_CONTRACT_PROPOSAL.json",
      "bytes": 3863,
      "sha256": "189250e7ad93dddc4c24dccc6c7ec86565d3cd06e84a0fb977fc125ef4924ffc",
      "gitBlob": "b7b764cd82605a61672a13fd8b4377f7fbf2e9b8"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/EXECUTION_SCOPE.json",
      "path": "docs/postrust/MBM-003/EXECUTION_SCOPE.json",
      "bytes": 7103,
      "sha256": "e0e35e4723a90c07a422c30f355ac7ab76b78ce17212e0aa414369622e5071ec",
      "gitBlob": "d81bd62f51ec55ae0a33f0aa3d322b1bb1ae21b7"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/IMPLEMENTATION_CHECKPOINT.md",
      "path": "docs/postrust/MBM-003/IMPLEMENTATION_CHECKPOINT.md",
      "bytes": 4860,
      "sha256": "1f70c1b015d85cc1bae7798190e722d38529e3a1efcca7bf96b3087bb97b3678",
      "gitBlob": "dfb14e09c0a6470a243def350bddbe9e657acb97"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/OWNER_DSD_TRANSPORT_DECISION_2026-10-10.json",
      "path": "docs/postrust/MBM-003/OWNER_DSD_TRANSPORT_DECISION_2026-10-10.json",
      "bytes": 4578,
      "sha256": "a36b722255201e98167b4a616fa8228cf2109b8204613d0cb3a85aab7f2bc256",
      "gitBlob": "4b9c01cbc44a723ac51802008e9d80d3206f088a"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/OWNER_SCOPE_AMENDMENT_2026-10-09.json",
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_AMENDMENT_2026-10-09.json",
      "bytes": 4007,
      "sha256": "1b63215f580aa6975ad9cccf265c666cc6b37cbec9f9e75ab1eb4837758a9718",
      "gitBlob": "645678a59e8e0872e8ff230c01d7656d7cfc27d2"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/OWNER_SCOPE_DECISION_2026-10-10.json",
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_DECISION_2026-10-10.json",
      "bytes": 6241,
      "sha256": "4851db40bf2f987c0d787413a2d7b0bcc6461d151f33d7ae20c796c63920baad",
      "gitBlob": "69661b576756d8a53eea6184aa5243ed4896457e"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json",
      "path": "docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json",
      "bytes": 1932,
      "sha256": "9ea3af0f43c773819a969260dade313c6f54c3e37ac57214d666e18c52383147",
      "gitBlob": "e47dd406582123d584cb313515d83cb7e0c38e1e"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json",
      "path": "docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json",
      "bytes": 3058,
      "sha256": "87cb1fcc67dc74013b7780cdf01e3ff0d44d756ee964938c23b0e37c266e1d4c",
      "gitBlob": "a1fdf051c9ecf9a3d73158a2f8e8d83733ba9936"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:docs/postrust/MBM-003/READY_RENEW_BOUNDARY.json",
      "path": "docs/postrust/MBM-003/READY_RENEW_BOUNDARY.json",
      "bytes": 1374,
      "sha256": "18ced7a85d813730f90108ad18ac7f0e903f261d23dfda1b214188513b659665",
      "gitBlob": "448d09afd1f697f995f3ede74e05a5a69289334c"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:packages/contracts/mobile/openapi.json",
      "path": "packages/contracts/mobile/openapi.json",
      "bytes": 147445,
      "sha256": "3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21",
      "gitBlob": "51d155f0a09a6988676826b6c82d858d84e9c46c"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:project/POSTRUST_PLAN.json",
      "path": "project/POSTRUST_PLAN.json",
      "bytes": 2119501,
      "sha256": "5e8896ed995de6093cdd7c59695fc9cef09c83bf6ea725e63b03c208db41fe41",
      "gitBlob": "b2c374686388bbdbb7884d8f8f44c7d0728839e0"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:project/POSTRUST_PROGRESS.md",
      "path": "project/POSTRUST_PROGRESS.md",
      "bytes": 117849,
      "sha256": "fe2bca5b8196cbcc203bfce68337c87aa44c7e4cc9a05e42600dd1e1452ae5bd",
      "gitBlob": "ef1b7496cdeef40015d8aeaa7190c587268cb6fe"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:project/POSTRUST_TODO.md",
      "path": "project/POSTRUST_TODO.md",
      "bytes": 30415,
      "sha256": "8a654a6ecd2813a7ea3756d21a10ec16e9ba938f666b298d32595e733b25a241",
      "gitBlob": "26ed698ca6f65d9a1b2e44c601f7b77121a2025e"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:project/STATUS.json",
      "path": "project/STATUS.json",
      "bytes": 2642238,
      "sha256": "11094be82c51f1b18f7adafb4e74ae2231f061cfeb7711826bf5bd8fa58165ae",
      "gitBlob": "cdb7d8d13fd9b148886e7e48d3400911001e5462"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EVIDENCE.json",
      "path": "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EVIDENCE.json",
      "bytes": 28133,
      "sha256": "697110088f6366420ba9fe363ac324f9d147521140fff7c36def83a5e73fc1d4",
      "gitBlob": "3e60d069a65faa48c12509e50cf92eafe6131df7"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_RESULT.md",
      "path": "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_RESULT.md",
      "bytes": 12121,
      "sha256": "9686a13533426d4e8a9b47fd6ad7157a2600bf7bf3c9a48deb3a210beebc79a2",
      "gitBlob": "2a6874a8c608d8ec4f58ac66ba894909db1027da"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:reports/MBM-002_EVIDENCE.json",
      "path": "reports/MBM-002_EVIDENCE.json",
      "bytes": 4030,
      "sha256": "6fb3dbcdf7bc2026bae0b30664581c0d3bc476aad132c274354e19eb7d1a5bea",
      "gitBlob": "e6efe5839fdefc53b20099f115e5122dd3dd832f"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:reports/MBM-002_RESULT.md",
      "path": "reports/MBM-002_RESULT.md",
      "bytes": 873,
      "sha256": "0dda06192257333401b2836281458f8c9479c6d2a03109c2200f636efbca3c3d",
      "gitBlob": "33754a5246b065fd2c78c9554f3457c351d58b34"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/local-library-signed-stat-fix-admission.mjs",
      "path": "scripts/ci/local-library-signed-stat-fix-admission.mjs",
      "bytes": 37449,
      "sha256": "0dc21cfe7ac1c784bf680c2a7b330be86e8bb999d073dd3650e06e62cb70fb6a",
      "gitBlob": "706d673d5d7f36779235baec82d738f800817611"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/local-library-signed-stat-legacy-normalization.mjs",
      "path": "scripts/ci/local-library-signed-stat-legacy-normalization.mjs",
      "bytes": 5061,
      "sha256": "158a6a414e4ce93c632c2a7b89500ca8839702f95b75fcca86ee6bf7c7a6720b",
      "gitBlob": "29592fac0e2b3b59eb919c13f4e1963c7e5cbf1a"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/mbm002-legacy-input-normalization.mjs",
      "path": "scripts/ci/mbm002-legacy-input-normalization.mjs",
      "bytes": 14267,
      "sha256": "e2a01acbc3ffaac7b6d5bd51964c05d139c61c00aba03488fb02ff0521f5b70c",
      "gitBlob": "8d290bac61d252f3a7d739a4fba1f7f40f0bf71b"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/mbm003-contract-gate.mjs",
      "path": "scripts/ci/mbm003-contract-gate.mjs",
      "bytes": 8831,
      "sha256": "29a96cadb48571fba8aca902f8fa99e391dbb1a43021a5e642a03acc2d37d56e",
      "gitBlob": "fcd524d25aa3dbfd8f09912d08f9f4c2f4038898"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/mbm003-predecessor-reuse.mjs",
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "bytes": 4805,
      "sha256": "2bcf3610973546403c2856897e3568c188be6bffc1b185b79f9cdf8f67cba9d5",
      "gitBlob": "4bb4873c279abc664d064a6e5949118d3b6a7cfd"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/mbm003-software-gate.mjs",
      "path": "scripts/ci/mbm003-software-gate.mjs",
      "bytes": 35887,
      "sha256": "85a88fedba29caa43f68fe6d49551f86578948ad9e2ff4decd450cbf48086dc3",
      "gitBlob": "a49f8f356fb7d3f806539235ff8de0baa2ebdd1c"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/report-only-admission.mjs",
      "path": "scripts/ci/report-only-admission.mjs",
      "bytes": 27460,
      "sha256": "ed5c7c32f3aa27591e99139807827fd5bc1089693df09409578508231be762ab",
      "gitBlob": "925c4ec45a43bac248c0d8b55b4b22f97300e8df"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/report-only-mbm002.mjs",
      "path": "scripts/ci/report-only-mbm002.mjs",
      "bytes": 9791,
      "sha256": "223e3efbd10ce3d59635f73717465cafadcedd11b16c5260617b0f76be134aea",
      "gitBlob": "36ca7e813fcca28ed2018bb4304769d000697d5b"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/report-only-mbm003.mjs",
      "path": "scripts/ci/report-only-mbm003.mjs",
      "bytes": 11480,
      "sha256": "68da84bebcdc79fb650fb809b75bbcd0ab049da3b5470f267f1943f82e4d6e85",
      "gitBlob": "fc80ca25ae1055b4a83bbe60698f7e7cec023ed2"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/run-core-tests.mjs",
      "path": "scripts/ci/run-core-tests.mjs",
      "bytes": 13476,
      "sha256": "5b6b405a4fe514197765cb7c9fc59d1f1141545d143effd7f1f1ff4c65a5d44b",
      "gitBlob": "7b8e330d90273943f5bd87d1552fb3766c9abc2c"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/test/local-library-signed-stat-fix-admission.test.mjs",
      "path": "scripts/ci/test/local-library-signed-stat-fix-admission.test.mjs",
      "bytes": 14577,
      "sha256": "4f004a214ed9ebb05054f86d3a784a14258684109dce39b4c090c29d232b004e",
      "gitBlob": "652a337f31031425f1ab9a7441bbbdf5ff1ac06e"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/test/local-library-signed-stat-legacy-normalization.test.mjs",
      "path": "scripts/ci/test/local-library-signed-stat-legacy-normalization.test.mjs",
      "bytes": 46141,
      "sha256": "5572fce729fd38398e483b194061d8f225a968e2682a5448a539c03ece8dee2c",
      "gitBlob": "b61daaf8d7bab90203f45a6b9edc388c8cbab984"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/test/mbm002-legacy-input-normalization.test.mjs",
      "path": "scripts/ci/test/mbm002-legacy-input-normalization.test.mjs",
      "bytes": 8345,
      "sha256": "ad93af459901342d31b0eae13ab0f9b4dba3ac737846aaa4fdd4c926168c1302",
      "gitBlob": "04a889e2cf3130aa0938238c7f3cacb51f64166b"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbm000-contract-adoption.mjs",
      "path": "scripts/ci/verify-mbm000-contract-adoption.mjs",
      "bytes": 44759,
      "sha256": "a3e87936042d8085615b07a6ad2eeec1ada98645cdcbabbf5f0b2c50f23d86b5",
      "gitBlob": "9dba48422779a6228b22db8ef94a963a8d34ec27"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbm001-pairing-library.mjs",
      "path": "scripts/ci/verify-mbm001-pairing-library.mjs",
      "bytes": 18073,
      "sha256": "b439348a66c25b1a70493ca75854a9e346737763dbc42f9d3a9c8f84dceeb855",
      "gitBlob": "af694a75605c2b1f41ca60d327764b1d1be6b435"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbm002-resource-playback.mjs",
      "path": "scripts/ci/verify-mbm002-resource-playback.mjs",
      "bytes": 12321,
      "sha256": "9e48660e3e074f1172de49740713d9e072f1ba0d8dc3684cedd1e04897d3e28e",
      "gitBlob": "f9d73dd0580032ee94ab5c995cc05cd8cd346eef"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs001-offline.mjs",
      "path": "scripts/ci/verify-mbrs001-offline.mjs",
      "bytes": 14851,
      "sha256": "35ad160e0f58c0eea0cbb22ae0f4d948955c13c05857eaa3134c18aa9552ab3d",
      "gitBlob": "44aaa3138052bb02d32bb203a55e768118317cb3"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs002-contracts.mjs",
      "path": "scripts/ci/verify-mbrs002-contracts.mjs",
      "bytes": 22849,
      "sha256": "b207255e2d7a555cd3ea9d4ba305472bf8f09a5c72a0877fd081eae249be1b8e",
      "gitBlob": "4d371724a9da77219d794fcc674015728dfd6053"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs003-scan.mjs",
      "path": "scripts/ci/verify-mbrs003-scan.mjs",
      "bytes": 37197,
      "sha256": "c33d12f7401bcbdfa3b532bfc00376377e224ad8c5a6efa1b77eff6a1dc1dc53",
      "gitBlob": "4fc2a686e11c217832105021c108be4f006def1a"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs004-rules.mjs",
      "path": "scripts/ci/verify-mbrs004-rules.mjs",
      "bytes": 11521,
      "sha256": "a2e293a7c1860526cba36334285eda3b9e759b77c91b5fbb03bba27ffc7bc328",
      "gitBlob": "5bf3376af4f965a295c11cc1e51f7251b6a7e1e2"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs005-gateway.mjs",
      "path": "scripts/ci/verify-mbrs005-gateway.mjs",
      "bytes": 14217,
      "sha256": "c77cde79ec4dfc4486afda25a74c0455fb5c96200cf5273724ccf3435cf2863e",
      "gitBlob": "f0a1b21163298ee7837993beb79558c8741dcf43"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs006-local-playback.mjs",
      "path": "scripts/ci/verify-mbrs006-local-playback.mjs",
      "bytes": 16705,
      "sha256": "4df7b1624306556a5df90e31cc6565fd51b5baaedf2961d6e4574ec3eae6dbb6",
      "gitBlob": "f8639be464f4c32878acacc82417c55d74643e26"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs007-queue.mjs",
      "path": "scripts/ci/verify-mbrs007-queue.mjs",
      "bytes": 23136,
      "sha256": "c9d8c1d1605ea08b2754e6058440940dbcede505b3b0c90f44c81a8adee94471",
      "gitBlob": "6b5f24c4fe98aa5f8e50f5af6780bb874e1055f2"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs008-audio.mjs",
      "path": "scripts/ci/verify-mbrs008-audio.mjs",
      "bytes": 21327,
      "sha256": "c00e66b3c5ce423352bdfdc79be458b973d9b8a695ec5569b579cfb039cc4527",
      "gitBlob": "87312721e40f124afd15f394b18f4517d5002a83"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs008-ui-render.mjs",
      "path": "scripts/ci/verify-mbrs008-ui-render.mjs",
      "bytes": 6034,
      "sha256": "6bddcb1221be202ce4af5ee75cafacedb63bca5c480f7a5a027144e445db513b",
      "gitBlob": "96ad195d314bcb30eedbb4d05fd9bfdb608cdbe3"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs009-local-library-ui.mjs",
      "path": "scripts/ci/verify-mbrs009-local-library-ui.mjs",
      "bytes": 21699,
      "sha256": "f834f4e6dfefe6e0985a31896e4e9d0d03d90a6d7b5fa968359ac613a83434ff",
      "gitBlob": "5238d744a0669f300319a819a2eefcc16042a4ba"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs009-ui-render.mjs",
      "path": "scripts/ci/verify-mbrs009-ui-render.mjs",
      "bytes": 7479,
      "sha256": "9d4e2fc018fee8673a721b4667975994f3cc307296627cb675ab95773fe369d3",
      "gitBlob": "a3d7da32baf3e7d12a5aa6feb9dc91c400fc1ee7"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs010-artwork.mjs",
      "path": "scripts/ci/verify-mbrs010-artwork.mjs",
      "bytes": 29111,
      "sha256": "3427476dd5fb20f243a48b359ec6b5a06faa0157c7333dd7582cf3814da3a7f4",
      "gitBlob": "64876ac23a502b3a6c179ee68d68a8c65d816ae6"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs011-organizer.mjs",
      "path": "scripts/ci/verify-mbrs011-organizer.mjs",
      "bytes": 17055,
      "sha256": "56988faccb590c14f5241b431ef5d555271bd2e6496aa3a346107fa7cf52b692",
      "gitBlob": "d65c6f5bf55fde9c3da4a951dc7f4ae203283ce9"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs012-source-writes.mjs",
      "path": "scripts/ci/verify-mbrs012-source-writes.mjs",
      "bytes": 27972,
      "sha256": "84185ff650463228d6584c862674823c9bdafc45ec704cb7a6a1bf2b06c43e42",
      "gitBlob": "74727eb22b11e7db86d27c0d96420219b6acb703"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs013-relocation.mjs",
      "path": "scripts/ci/verify-mbrs013-relocation.mjs",
      "bytes": 23501,
      "sha256": "ee35adb79f5805ebfe7754bf0987ade6baf1412d568ac750f1eecf94ab363b92",
      "gitBlob": "52fbc2531d17e16b4acb1369a38da225e42a1d8b"
    },
    {
      "gitRef": "c647e02b40d55b955faabc9d6a2a6220c9286bac:scripts/ci/verify-mbrs014-compatibility.mjs",
      "path": "scripts/ci/verify-mbrs014-compatibility.mjs",
      "bytes": 23064,
      "sha256": "11d46740fe6e9e0169af1503ec135b74e52b1338b740148bc994e5d59ecfc262",
      "gitBlob": "65532fde5d3b0d264cd5a2ba265f330ee1665e15"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/e2e/collection-preview.spec.ts",
      "path": "apps/desktop/e2e/collection-preview.spec.ts",
      "bytes": 23987,
      "sha256": "9daddcd4e6a8ee2a8486e45ada77015a4acfe664e974cf795c9306b5fd741c35",
      "gitBlob": "545b5269149282ac09b0aa2568367b944d37679d"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/scripts/tape-catalog-r3-observe.mjs",
      "path": "apps/desktop/scripts/tape-catalog-r3-observe.mjs",
      "bytes": 12492,
      "sha256": "78a8eea247c9605dcd71f72895d5a9cd4264a50b3674a4f093bc4d7ca2c8ca85",
      "gitBlob": "3763f9580509c16d2751578b2e3f2b41ac6edc68"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/main/cassette-catalog-service.ts",
      "path": "apps/desktop/src/main/cassette-catalog-service.ts",
      "bytes": 11462,
      "sha256": "2bb1271a767c002c25bf706ac4575e31a6bf55f9c6d3db8687d9dcf33fd2ed4e",
      "gitBlob": "88773641a2bb1f812e4c90937baea7e3e3422ea4"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/main/index.ts",
      "path": "apps/desktop/src/main/index.ts",
      "bytes": 111382,
      "sha256": "4bb278cbb22f92f5b0affb02f8b291dd6eb9d23229377b85523ddb73e1ba2e27",
      "gitBlob": "c7f982dba7d79db47fade65230fdf8423380c620"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/preload/api.ts",
      "path": "apps/desktop/src/preload/api.ts",
      "bytes": 44738,
      "sha256": "6748d8a7886abe9adff4ec2ea73d179ef0e874982c4e32c6e2217d38eebdda40",
      "gitBlob": "1ec8541d1e32dc0de473b0b37a3f77f68d81f73e"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/preload/index.ts",
      "path": "apps/desktop/src/preload/index.ts",
      "bytes": 28597,
      "sha256": "eccce4486969ee84d080d7623b54d28b865c431244ab74bb672894fa5e87dee7",
      "gitBlob": "ee21096670d13155ff74f1b977a07cbbf7f7e538"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/cassette-catalog-controller.ts",
      "path": "apps/desktop/src/renderer/src/components/collection/cassette-catalog-controller.ts",
      "bytes": 3462,
      "sha256": "91a08accff057fe002c29a51677bec2f60d5908135ee9f68d8a277facdf943cf",
      "gitBlob": "0a0f53a3deeab8feae9ed0f6a7f785dbf0373478"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/CassetteArchiveImportPanel.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteArchiveImportPanel.vue",
      "bytes": 6951,
      "sha256": "6a94a8e7467909160b36f714b1cd3d47bc73cce78444585bdd870223759d0bf0",
      "gitBlob": "f58ea07116b5bbfef4f47c042c38256d8cfd0354"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/CassetteCatalogDetail.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogDetail.vue",
      "bytes": 12605,
      "sha256": "0cd22aa8ff76b28aaa85913a748310761057bbfcbee11ed5bb47b1bc21ac5064",
      "gitBlob": "74680f02751654aad644fab5df54549d8fd9a8ac"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/CassetteCatalogView.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/CassetteCatalogView.vue",
      "bytes": 15887,
      "sha256": "d410d8a3e236259de4d97d8a6c5b870b7bee48ad986fee3a7543fbe460896e74",
      "gitBlob": "20f905a432db9caa6aa930654b70001600fb1bcc"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/CollectionModelDetail.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionModelDetail.vue",
      "bytes": 24769,
      "sha256": "f63391b37946dc9e58b0a2dfce85b2b0799920be5b1a60def13bafbe33e536dc",
      "gitBlob": "70d2523f13ba68e78a94a24d8593e6051d4a5c12"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/CollectionReceiveDialog.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReceiveDialog.vue",
      "bytes": 7713,
      "sha256": "991ea840fd38e595a4280d83d73a53c6a4fc17805692f99ec86cc2af63cec56b",
      "gitBlob": "a4fc377edd709c6146fe37be0789d69aa76ed054"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/CollectionReferenceImage.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionReferenceImage.vue",
      "bytes": 1165,
      "sha256": "53ac223025c193936382f5afe8aebd2260dbd6a162f6addbffdead06dfe1733e",
      "gitBlob": "62d5ace7714c9f816a9dfef84b4f090180a2aebd"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/CollectionView.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/CollectionView.vue",
      "bytes": 39258,
      "sha256": "7045d279a2e3902d02e16f469b8d04af1fe94994e20c1684b631a2f5f7f15252",
      "gitBlob": "e8069457feaead993ff8f3fe40b6ee7bb2e021d0"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/reference-images.ts",
      "path": "apps/desktop/src/renderer/src/components/collection/reference-images.ts",
      "bytes": 9377,
      "sha256": "a1d3579551d2bbd06547f4a5ebf35861a5344a3bbee78b55351a04b9ee9ef14a",
      "gitBlob": "e0febb7c48468dde6289c069f3a8f38c47df7b78"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/collection/ReferenceCatalogPanel.vue",
      "path": "apps/desktop/src/renderer/src/components/collection/ReferenceCatalogPanel.vue",
      "bytes": 37559,
      "sha256": "49574915aab3a01b71b72c56f7a3c06a794d2b1b1b0653d24cbf34c7ca0d9261",
      "gitBlob": "51ba9b3f57b7a40c561cbe72046242b09aec71cf"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/renderer/src/components/CommandOutboxPanel.vue",
      "path": "apps/desktop/src/renderer/src/components/CommandOutboxPanel.vue",
      "bytes": 20695,
      "sha256": "4b3b8b6cb854d61aa175875bd858c9957b02a159f3028ff90395342f2bf15e56",
      "gitBlob": "599df32aabca261aa615833e4ca136d95c5cc0d7"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/src/shared/cassette-catalog.ts",
      "path": "apps/desktop/src/shared/cassette-catalog.ts",
      "bytes": 1905,
      "sha256": "d0f9824c15498c03afc76007883bd44bf8e9055f172e0cee70b3402a0266619c",
      "gitBlob": "4b3aa3c68f8517cd70d8eff85f11d435a459b0ea"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/test/cassette-catalog-service.test.ts",
      "path": "apps/desktop/test/cassette-catalog-service.test.ts",
      "bytes": 3334,
      "sha256": "db02a43a2d4df3cb9d4d5f0097796d412a03df84bccefd3020f84bfc84b6a475",
      "gitBlob": "06e63e033060b36d85cac5093777ac7c2ed54c2a"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/test/cassette-catalog-ui.test.ts",
      "path": "apps/desktop/test/cassette-catalog-ui.test.ts",
      "bytes": 27565,
      "sha256": "68022d18fbadae9f92a93accbf04c723609ed5e0cfb3c91405d41679392fc6a7",
      "gitBlob": "8f59d911d7543a0aa36ff9bad069e0f7dc34e89e"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/test/collection-display.test.ts",
      "path": "apps/desktop/test/collection-display.test.ts",
      "bytes": 4684,
      "sha256": "1e4722d0e65401114a1ef5df1ef6cae7b8184624f5dc0a7e44367b80b55ea898",
      "gitBlob": "da658ed602826160b42d76db8041f87116520b73"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/test/collection-progress-ui.test.ts",
      "path": "apps/desktop/test/collection-progress-ui.test.ts",
      "bytes": 33012,
      "sha256": "49dd1200d1d9be911ebc8b229096ce251d35beb5a2c820376eec5373023c9b77",
      "gitBlob": "c0e428911614c60317a40cc643c630837561840c"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/test/collection-readonly-ui.test.ts",
      "path": "apps/desktop/test/collection-readonly-ui.test.ts",
      "bytes": 10271,
      "sha256": "098742e8e66d12c0286683211311ca1bbdb9962e5a5a9d0e14fe8b8c4aeef4d6",
      "gitBlob": "ab70cfe5227d1bbb312810956cd9f04ae857fd34"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/test/collection-return-navigation.test.ts",
      "path": "apps/desktop/test/collection-return-navigation.test.ts",
      "bytes": 6479,
      "sha256": "b1d19d59d919d09dfba79000372e33c6b47deb6296151ea28affa2b2f433daae",
      "gitBlob": "2e4462b7b801ade3e430f67614b7243d721ab162"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:apps/desktop/test/preload.test.ts",
      "path": "apps/desktop/test/preload.test.ts",
      "bytes": 37258,
      "sha256": "91ba4beb8478bc651383cddb71ab6cdd84b930c03a1b6ba58db73fc8167391d1",
      "gitBlob": "3aa3364c7a1a991d670ed2f9d7a7f9a9718a3990"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:docs/tape-catalog-r3/ARTIFACTS.json",
      "path": "docs/tape-catalog-r3/ARTIFACTS.json",
      "bytes": 6971,
      "sha256": "3feb8489444f8d11179e76dade3c4cc405a1e8a3bf98e6f13981a31ba40917e7",
      "gitBlob": "0b5e38e34c9ee1f951f1eb0c25b9462a162b94da"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:docs/tape-catalog-r3/CI_APPLICABILITY.md",
      "path": "docs/tape-catalog-r3/CI_APPLICABILITY.md",
      "bytes": 7573,
      "sha256": "62153b9aa5c2e0c5b357867a20888245edb2c9ab101c8cf1526ff178c78f8d7d",
      "gitBlob": "3e36b725a3cc77e47107d96266d54a59a3bff919"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:docs/tape-catalog-r3/CI_SCOPE.json",
      "path": "docs/tape-catalog-r3/CI_SCOPE.json",
      "bytes": 1974,
      "sha256": "d726b98bf8dd02d0dadc02434596121c31a5e35b3af02eb93c8b224dcf771cc1",
      "gitBlob": "1a474c709c3be536f4363f6c108ddb1ef6efd4d9"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:docs/tape-catalog-r3/EXECUTION_SCOPE.json",
      "path": "docs/tape-catalog-r3/EXECUTION_SCOPE.json",
      "bytes": 5630,
      "sha256": "7fc8edf02cb64cdb91c286b9180ed13f1ab7878eb5c17c8d35ba37b56da368d4",
      "gitBlob": "03d8192132051cb9d7eab3dad7db69b5b8c77528"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:docs/tape-catalog-r3/RESULT.md",
      "path": "docs/tape-catalog-r3/RESULT.md",
      "bytes": 10373,
      "sha256": "1880f7d6b37ab6f5c2c5be454903b40b8e93477ed3fda865a6e68550db7123be",
      "gitBlob": "2e198325443d3bb7f85107272963e46de42d8074"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:docs/tape-catalog-r3/STATUS.json",
      "path": "docs/tape-catalog-r3/STATUS.json",
      "bytes": 4166,
      "sha256": "f1582c26e893b9636b6b01f15e8a86fb1e7c78460de52477b863473f0268a544",
      "gitBlob": "b236a5178ad5c3f622b6c3629d87c345ba9751cd"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/src/collection/cassette-archive.ts",
      "path": "packages/bridge-core/src/collection/cassette-archive.ts",
      "bytes": 35565,
      "sha256": "0716a8de02fcce06a4a06aec87f2773152bda239fa53f6e6e460dda33da574b6",
      "gitBlob": "d2ef786b8435b8b7157bee1ac754e4b3988d9c8d"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/src/collection/dataset-dispatch.ts",
      "path": "packages/bridge-core/src/collection/dataset-dispatch.ts",
      "bytes": 59157,
      "sha256": "32f43b5dda5766bfa2b50d4c1c1f00e979993b50f2ed494444cd4cdcf81e44b3",
      "gitBlob": "31390c6dba3604836bdc2204d5414c9e046ee011"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/src/collection/dataset-owner-protocol.ts",
      "path": "packages/bridge-core/src/collection/dataset-owner-protocol.ts",
      "bytes": 30338,
      "sha256": "fa070d9383c8913d27e9ff23f59e2417b7402c19f13d7ec57d09b09e64823c5b",
      "gitBlob": "3990b5337b5d89b073d97513c09ec2c4cf5b2024"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/src/collection/reference-catalog-store.ts",
      "path": "packages/bridge-core/src/collection/reference-catalog-store.ts",
      "bytes": 46960,
      "sha256": "0d197187345ef39897fb3dbf0be469e737a5de49b1733663b44b778ca8eccda1",
      "gitBlob": "4fe9e51a6aab6c84427330d7a1c00e3462aa35eb"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/src/collection/repository.ts",
      "path": "packages/bridge-core/src/collection/repository.ts",
      "bytes": 66458,
      "sha256": "a062a84b5832830a81d4156af2fb004c0aec00ae020d7937471b5eb1a40aab83",
      "gitBlob": "a87bd6e8d5b592163ee97221daf35fc3c2fedfcb"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/src/recording/restore-dataset-runtime.ts",
      "path": "packages/bridge-core/src/recording/restore-dataset-runtime.ts",
      "bytes": 12768,
      "sha256": "81f6148faea02e2ba33ef2d3a3213a1827957b17e7bdaf1e1383f7c9d1376f67",
      "gitBlob": "a14f6a9143f002361a3d21544619b3fa806ea53d"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/test/cassette-archive.test.ts",
      "path": "packages/bridge-core/test/cassette-archive.test.ts",
      "bytes": 14856,
      "sha256": "4a6dcc7879bc0fa724126d8fb31f373bd550c38d80f8c1a6f1faf282a169ddb2",
      "gitBlob": "50234bcbdbc301fb16e7c6f1c5e447b111dc0a8b"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/test/cassette-import-dispatch.test.ts",
      "path": "packages/bridge-core/test/cassette-import-dispatch.test.ts",
      "bytes": 1456,
      "sha256": "7b28d6e13baf7ba89ffcde3b39ee3f2f57c432280e9c99b5da33aa98bb599940",
      "gitBlob": "8af61f5d009fdec1edc26e0f1f7c87fb898b8c65"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/bridge-core/test/reference-archive-catalog-store.test.ts",
      "path": "packages/bridge-core/test/reference-archive-catalog-store.test.ts",
      "bytes": 19643,
      "sha256": "cd29116df00bf415fac5276454472cef8f83a1702ee2baad11c602530f703b60",
      "gitBlob": "0db2e3167c707f023ad8fc2aee396240b3f27c39"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/contracts/src/command-outbox.ts",
      "path": "packages/contracts/src/command-outbox.ts",
      "bytes": 33600,
      "sha256": "276f6f1eef08931a1051c172217f663c47402ea4c5f15177214a705de680f892",
      "gitBlob": "45feab54cd57aeec5d1f4b7e372323365fd34ab8"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/contracts/src/ipc-names.ts",
      "path": "packages/contracts/src/ipc-names.ts",
      "bytes": 9505,
      "sha256": "541948e20d047293883b3d93d7a08a107fc32b29a35c008edce269e4ac30bff6",
      "gitBlob": "b08f20ae13f91b0974f9d4e1a2b0a8705a70a484"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/contracts/src/ipc.ts",
      "path": "packages/contracts/src/ipc.ts",
      "bytes": 46925,
      "sha256": "2593372ce88e2920273068d4ebed86172f38eeb595a443908797b195fb42b918",
      "gitBlob": "c63f2cf2edb1d3d60d0cf7d8130e8a58ce84a519"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/contracts/src/reference-catalog.ts",
      "path": "packages/contracts/src/reference-catalog.ts",
      "bytes": 30579,
      "sha256": "0d8ea64fe9a3ae5ba234be2c4f7289e232f3dda975ec0cabec6f4d75c9ca61da",
      "gitBlob": "51143d386ae8722850d9f5d3b2859a0b3ab17db6"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/contracts/src/validator.ts",
      "path": "packages/contracts/src/validator.ts",
      "bytes": 128571,
      "sha256": "cd95ddab71d7c60590b9aee6538657ee8ff4e1c8237dddf173bd83e5367334d9",
      "gitBlob": "cf3e057bbd3cf97fbcab4c4ccd5617ca864cf67d"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/contracts/test/cassette-import-ipc.test.ts",
      "path": "packages/contracts/test/cassette-import-ipc.test.ts",
      "bytes": 1211,
      "sha256": "e6448d235a2aadf8f3d7e788e4e0874a8e75684cd85cc63f66cc2d57680b1d4f",
      "gitBlob": "f6aca2176a83471a4cae0ef2c552a75f819746a4"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:packages/contracts/test/reference-catalog.test.ts",
      "path": "packages/contracts/test/reference-catalog.test.ts",
      "bytes": 22893,
      "sha256": "0782732451e5e73f040bd2013402db4ce0f194a6dd5c3ad9bb5a783170af8482",
      "gitBlob": "7e8051cb1c6e25be530e9d14750cdd692f87dc3a"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:scripts/ci/mbm003-predecessor-reuse.mjs",
      "path": "scripts/ci/mbm003-predecessor-reuse.mjs",
      "bytes": 7352,
      "sha256": "cc80f33f89be952c17cbfd9f382a9075eefb23d537507788a4f1d9a4ccbfeb19",
      "gitBlob": "ade34d55f973eb67172b9ea2eed20cfc2f39de45"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:scripts/ci/tape-catalog-r3-ci-applicability.mjs",
      "path": "scripts/ci/tape-catalog-r3-ci-applicability.mjs",
      "bytes": 11915,
      "sha256": "a4d7a091db2d85cc33dc9ba80351485d781c0ba86e1f26599d831c7aab9e01ab",
      "gitBlob": "d52904a072c41878225c6f246d954b60bac4c8e3"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:scripts/ci/test/tape-catalog-r3-ci-applicability.test.mjs",
      "path": "scripts/ci/test/tape-catalog-r3-ci-applicability.test.mjs",
      "bytes": 40566,
      "sha256": "82b365f8dce1ae075d1897992f7d0bf852999db4a9b7dbc8eeb7d1f31ded1132",
      "gitBlob": "094c42f4e441d1fbd2a583b18347f615d7036502"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:scripts/tape-catalog-r3-gate.ts",
      "path": "scripts/tape-catalog-r3-gate.ts",
      "bytes": 13456,
      "sha256": "2f86d5c6ecc41e0f442b5b534cd005f59bb8f5bb88b5232026c33c0e7aaf86d5",
      "gitBlob": "df05b786bfe64b1ad80264728829560cb2e98bba"
    },
    {
      "gitRef": "cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f:scripts/tape-catalog-r3-restore-gate.ts",
      "path": "scripts/tape-catalog-r3-restore-gate.ts",
      "bytes": 7077,
      "sha256": "882342a724c18736beb2bed09effdcdb6d247408ca3094ae13bf4bb98c2f89e3",
      "gitBlob": "3dffaeac13930c19bb12700087c282c790822fe0"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/application/local-source-resolver.ts",
      "path": "packages/bridge-core/src/application/local-source-resolver.ts",
      "bytes": 8424,
      "sha256": "3fc6087d0e4cb14edb2d0eab65917ce479a688cb71a9a88fc07d50ff0f4fb4c5",
      "gitBlob": "3e70c32eb8023f712d898e48f6dbc4ba58844867"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/collection/local-relocation-coordinator.ts",
      "path": "packages/bridge-core/src/collection/local-relocation-coordinator.ts",
      "bytes": 9644,
      "sha256": "05acb43a9486bf3c33ce06fd4e2d13908668b67125ef362c751fd03beaffd98c",
      "gitBlob": "6e884b7d4ce58f44a7ccd92305f9b22603b92b95"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/collection/local-scan-coordinator.ts",
      "path": "packages/bridge-core/src/collection/local-scan-coordinator.ts",
      "bytes": 36729,
      "sha256": "c690142cee8bfb3de0762fbe69df6a325b1d44baafe461e8c8afb3dc603ea92d",
      "gitBlob": "7e5cb3f111ba3dd5a045e7d609b2ad1d4470fc52"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/collection/local-source-ticket-types.ts",
      "path": "packages/bridge-core/src/collection/local-source-ticket-types.ts",
      "bytes": 4423,
      "sha256": "ac836361c8bcd7d428d73e3ccc570310d54c8337ee007555d23eee5a7b26f67f",
      "gitBlob": "9cf26b78f494cfa2de499a5ff013f986c6e4c6d9"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/library/metadata-reader-types.ts",
      "path": "packages/bridge-core/src/library/metadata-reader-types.ts",
      "bytes": 4680,
      "sha256": "53d23129795ddbb0440687a8519636fee23624caef2f4a1a71e17774ccde03ff",
      "gitBlob": "41b2aff101f02f69c196633a372542024b5dd25a"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/library/metadata-reader-worker.ts",
      "path": "packages/bridge-core/src/library/metadata-reader-worker.ts",
      "bytes": 21652,
      "sha256": "259691cb8e8062b3db4d8522da864e6c14c2b0dde7ecaf19950e91add0662577",
      "gitBlob": "2e94f86034ec35dc2bf83d5897334543e8c11d88"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/library/metadata-reader.ts",
      "path": "packages/bridge-core/src/library/metadata-reader.ts",
      "bytes": 14112,
      "sha256": "375f2527dc23c4b2be5431dbc98a95882d3654a77c9d368ecc74eaf11c582097",
      "gitBlob": "5ba774ec24489b60c87a34f17b9a2fa833f08638"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/recording/source-files.ts",
      "path": "packages/bridge-core/src/recording/source-files.ts",
      "bytes": 46157,
      "sha256": "3ccafec70017b883c3709a72b6715b3ca6b367b663a71d858b0279424e7de898",
      "gitBlob": "5804e480219c884de4354fe84748a3dbb760faee"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/stream/local-file-source.ts",
      "path": "packages/bridge-core/src/stream/local-file-source.ts",
      "bytes": 11489,
      "sha256": "39c5bfd368273d75fdb81a69566c67180fbd36c383217056720843c8847be7f5",
      "gitBlob": "603b4b69163614e7e1ea2fd36240d437c7ec2d08"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/stream/physical-resource-claims.ts",
      "path": "packages/bridge-core/src/stream/physical-resource-claims.ts",
      "bytes": 14918,
      "sha256": "8b1f47063435521135b5bfaf61951b6486d355fdcea6bb9bdfe3fdff5cd4cdba",
      "gitBlob": "38b3e563995f75af7b334ea1b2000ce745390d0b"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/stream/physical-resource-locks.ts",
      "path": "packages/bridge-core/src/stream/physical-resource-locks.ts",
      "bytes": 15391,
      "sha256": "79052d83b6c602de784da7002f975aaf71e91c84f11bb9acc7d913fbf2fff2b8",
      "gitBlob": "a7f9fd18088bce4986269072b942ae119b5ca5a6"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/src/stream/source-namespace-claims.ts",
      "path": "packages/bridge-core/src/stream/source-namespace-claims.ts",
      "bytes": 24762,
      "sha256": "c7810434565cdb4b5c8fe394ca70d50442327e158a1439b54dcf3ae15e35d715",
      "gitBlob": "1a4623a32f5f98999cd7233cfc47d9e651e8edeb"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/test/local-library-wave-empty-list.test.ts",
      "path": "packages/bridge-core/test/local-library-wave-empty-list.test.ts",
      "bytes": 31034,
      "sha256": "1090e2a1547b376cdb7c3d738d5a5e4f3223cf6e6d5d38a13b0810b4009505dd",
      "gitBlob": "fa1b24afbfad462714ae780c9a5f2f26573a3dd7"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts",
      "path": "packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts",
      "bytes": 26566,
      "sha256": "571a14e89f3395bfd7e4b66900bba3344bfa8e74640b9aef7b7c25ab8bc84fd4",
      "gitBlob": "b11aa58c766ded86bfbc5e14b82f263151da959a"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/test/mbrs004/name-rules-scan-integration.test.ts",
      "path": "packages/bridge-core/test/mbrs004/name-rules-scan-integration.test.ts",
      "bytes": 9010,
      "sha256": "9aa92bb73fd445ac4e8ec829d1fae2c9eb470811aecd45f3c7513fc48bdb2229",
      "gitBlob": "f22b22f8cba2ebdba6461f29a5331b1859f3053b"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/test/mbrs005/config-integration.test.ts",
      "path": "packages/bridge-core/test/mbrs005/config-integration.test.ts",
      "bytes": 8337,
      "sha256": "e284cd3cbd7e44ee08b24c5a94c0faf8725113b2e37fcbed755940c8c4eb4510",
      "gitBlob": "75e486c1ce8ff5eea626a206c5b9ec5f4c4a7346"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/test/mbrs006/owner-worker.ts",
      "path": "packages/bridge-core/test/mbrs006/owner-worker.ts",
      "bytes": 722,
      "sha256": "6cbc6a24cf1a5e2945972c7993c46314de4860825a8bff7219e096b8b2249e55",
      "gitBlob": "6a453ccf23fea8c1c2952259d5b03df19a1fb214"
    },
    {
      "gitRef": "fd176fdf1da069dd678b673f697cdbe8831628cc:packages/bridge-core/test/mbrs007/queue-worker.ts",
      "path": "packages/bridge-core/test/mbrs007/queue-worker.ts",
      "bytes": 731,
      "sha256": "dd626e9703546af316226f66e345d328bb2105b128466103a5739caf87ca0b08",
      "gitBlob": "134273d813a127d17ecfe737138f71eaae4b73f7"
    }
  ],
  "evidenceBoundary": {
    "localLibraryFixTask": "LOCAL_LIBRARY_SIGNED_STAT_FIX",
    "originalMobileTask": "MBM-003",
    "legacyGateEvidenceReused": true,
    "newCombinedSoftwareGateRequired": true,
    "signedStatFreshSoftwareGateRequired": true,
    "oldGateOr003ReexecutionRequired": false,
    "productionCatalogImport": "NOT_RUN",
    "ordinary61Acceptance": "OPEN",
    "coldStart61Acceptance": "OPEN",
    "realOsInterruptionAcceptance": "OPEN",
    "newPhoneOrOldSoftwareRevalidationRequiredByReportInheritance": false,
    "newOwnerAcceptanceGateRequired": false,
    "currentCombinedAppDeviceOwnerProven": false
  },
  "workflowPin": {
    "path": ".github/workflows/verify.yml",
    "bytes": 18094,
    "sha256": "373bcd88ef8dc13ae2641611fc2617363621fe72684df02925e223b2aaf247bc",
    "gitBlob": "f141cf6ffc2148629cdc0a9ed487eb3f79a0a830"
  },
  "taskStatusEvidenceBoundary": {
    "realCatalogImport": "NOT_RUN",
    "sourceMediaWrites": false,
    "ordinary61": "OPEN",
    "cold61": "OPEN",
    "realOsInterruption": "OPEN",
    "ownerAcceptanceProven": false,
    "oldEvidenceReattributed": false
  },
  "sourceGitReadbackPaths": [
    "docs/tape-catalog-common/STATUS.json",
    "docs/tape-catalog-common/INTEGRATION.md"
  ]
});
export const TAPE_CATALOG_COMMON_TASK = TAPE_CATALOG_COMMON_SCOPE.task;
export const TAPE_CATALOG_COMMON_BRANCH = TAPE_CATALOG_COMMON_SCOPE.branch;
export const TAPE_CATALOG_COMMON_BASE = TAPE_CATALOG_COMMON_SCOPE.baseSha;
const scope = TAPE_CATALOG_COMMON_SCOPE;
const scopeBytes = Buffer.from(JSON.stringify(scope, null, 2) + '\n');
const admittedResults = new WeakSet();

function rawBytes(value, code = 'TAPE_COMMON_FILE_BYTES_INVALID') {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > MAX_FILE_BYTES) fail(code);
  return value;
}
function parse(bytes, code) {
  rawBytes(bytes, code);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(code); }
}
function descriptor(file, content) { return { path: file, bytes: content.length, sha256: hash(content), gitBlob: blob(content) }; }
function pinMatches(content, expected, code) {
  rawBytes(content, code);
  if (content.length !== expected.bytes || hash(content) !== expected.sha256 || blob(content) !== expected.gitBlob) fail(code);
}
function fileMap(rows, key, required) {
  if (!Array.isArray(rows) || rows.length !== required.length || new Set(required).size !== required.length) fail('TAPE_COMMON_FILE_SET_INVALID');
  const result = new Map();
  for (const row of rows) {
    if (!exactKeys(row, [key, 'content']) || typeof row[key] !== 'string' || !required.includes(row[key]) || result.has(row[key])) fail('TAPE_COMMON_FILE_SET_INVALID');
    rawBytes(row.content);
    result.set(row[key], row.content);
  }
  return result;
}
function validateIdentity(identity) {
  if (!exactKeys(identity, ['branch','branchAfter','head','stableHead','githubSha','githubRefName','githubHeadRef','runnerRequired','clean','cleanAfter','git'])) fail('TAPE_COMMON_IDENTITY_INVALID');
  if (identity.branch !== TAPE_CATALOG_COMMON_BRANCH || identity.branchAfter !== TAPE_CATALOG_COMMON_BRANCH) fail('TAPE_COMMON_BRANCH_MISMATCH');
  if (!commitId(identity.head) || identity.head !== identity.stableHead) fail('TAPE_COMMON_HEAD_MISMATCH');
  if (typeof identity.runnerRequired !== 'boolean' || ![null, undefined].includes(identity.githubSha) && identity.githubSha !== identity.head
    || ![null, undefined].includes(identity.githubRefName) && identity.githubRefName !== TAPE_CATALOG_COMMON_BRANCH
    || ![null, undefined].includes(identity.githubHeadRef) && identity.githubHeadRef !== TAPE_CATALOG_COMMON_BRANCH
    || identity.runnerRequired && (!commitId(identity.githubSha) || identity.githubRefName !== TAPE_CATALOG_COMMON_BRANCH)) fail('TAPE_COMMON_RUNNER_MISMATCH');
  if (identity.clean !== true || identity.cleanAfter !== true) fail('TAPE_COMMON_WORKTREE_DIRTY');
  if (!same(identity.git, { topLevelIsDirectory:true,gitDirInsideRepository:true,commonDirMatchesGitDir:true,
    objectFormat:'sha1',shallow:false,replaceRefs:[],grafts:false,alternates:false,externalGitEnvironment:[] })) fail('TAPE_COMMON_GIT_CONTEXT_REJECTED');
}
function rows(changes, expected, code) {
  if (!Array.isArray(changes) || changes.length !== expected.length || new Set(changes.map(row => row?.path)).size !== changes.length) fail(code);
  const allowed = new Map(expected.map(row => [row.path, row]));
  for (const row of changes) {
    const expectedRow = allowed.get(row?.path);
    if (!exactKeys(row, ['path','status','oldMode','newMode','oldBlob','newBlob']) || !relative(row.path) || !expectedRow
      || row.status !== expectedRow.status || !['A','M'].includes(row.status)
      || row.oldMode !== expectedRow.oldMode || row.oldBlob !== expectedRow.oldBlob
      || row.newMode !== '100644' || !commitId(row.newBlob) || row.newBlob === '0'.repeat(40)
      || row.newBlob === row.oldBlob) fail(code);
  }
}
function validateClosure(commits, head, changes) {
  if (!Array.isArray(commits) || commits.length < 1 || commits.length > 2) fail('TAPE_COMMON_COMMIT_CHAIN_INVALID');
  let previous = scope.baseSha;
  const seen = new Set([scope.baseSha, scope.baseDirectParent]);
  for (const entry of commits) {
    if (!exactKeys(entry, ['sha','parents','changes']) || !commitId(entry.sha) || seen.has(entry.sha) || !same(entry.parents, [previous])) fail('TAPE_COMMON_COMMIT_CHAIN_INVALID');
    seen.add(entry.sha); previous = entry.sha;
  }
  if (previous !== head) fail('TAPE_COMMON_COMMIT_CHAIN_INVALID');
  const source = commits[0], report = commits[1];
  rows(source.changes, scope.sourceChangedPaths, 'TAPE_COMMON_SOURCE_CHANGES_REJECTED');
  const sourceRows = new Map(source.changes.map(row => [row.path, row]));
  const reportExpected = [
    ...scope.reportOnlyAddedPaths.map(file => ({path:file,status:'A',oldMode:'000000',oldBlob:'0'.repeat(40)})),
    ...scope.reportOnlyModifiedPaths.map(file => ({path:file,status:'M',oldMode:'100644',oldBlob:sourceRows.get(file).newBlob})),
  ];
  if (report) rows(report.changes, reportExpected, 'TAPE_COMMON_REPORT_CHANGES_REJECTED');
  const cumulativeExpected = [...scope.sourceChangedPaths, ...(report ? reportExpected.filter(row => row.status === 'A') : [])];
  rows(changes, cumulativeExpected, 'TAPE_COMMON_CUMULATIVE_CHANGES_REJECTED');
  const changed = new Map(changes.map(row => [row.path, row]));
  const reportRows = new Map(report?.changes.map(row => [row.path, row]) ?? []);
  for (const [file, row] of sourceRows) {
    if (changed.get(file).newBlob !== (reportRows.get(file)?.newBlob ?? row.newBlob)) fail('TAPE_COMMON_CUMULATIVE_BLOB_MISMATCH');
  }
  return {source,report,cumulativeExpected,sourceRows};
}
function statusBinding(content, phase, sourceSha) {
  const status = parse(content, 'TAPE_COMMON_TASK_STATUS_INVALID');
  if (!plain(status) || status.schema !== 'musicbridge.tape-catalog-common.status.v1'
    || status.task !== scope.task || status.branch !== scope.branch || status.baseSha !== scope.baseSha
    || status.executionScope !== scope.scopePath || status.phase !== phase
    || !same(status.evidenceBoundary, scope.taskStatusEvidenceBoundary)) fail('TAPE_COMMON_TASK_STATUS_INVALID');
  if (phase === 'SOURCE_IMPLEMENTATION' && (Object.hasOwn(status, 'sourceSha') || Object.hasOwn(status, 'reportSha'))
    || phase === 'SOURCE_VERIFIED_REPORT' && (status.sourceSha !== sourceSha || Object.hasOwn(status, 'reportSha'))) fail('TAPE_COMMON_REPORT_IDENTITY_INVALID');
}
function reportBinding(files, sourceSha) {
  const evidence = parse(files.get(scope.reportOnlyAddedPaths[0]), 'TAPE_COMMON_REPORT_EVIDENCE_INVALID');
  if (!plain(evidence) || evidence.schema !== 'musicbridge.tape-catalog-common.evidence.v1'
    || evidence.task !== scope.task || evidence.branch !== scope.branch || evidence.baseSha !== scope.baseSha
    || evidence.sourceSha !== sourceSha || !same(evidence.evidenceBoundary, scope.taskStatusEvidenceBoundary)) fail('TAPE_COMMON_REPORT_EVIDENCE_INVALID');
  try { new TextDecoder('utf-8', { fatal: true }).decode(files.get(scope.reportOnlyAddedPaths[1])); }
  catch { fail('TAPE_COMMON_REPORT_EVIDENCE_INVALID'); }
}

/**
 * @typedef {{path:string,status:'A'|'M',oldMode:string,newMode:string,oldBlob:string,newBlob:string}} TapeCatalogCommonChange
 * @typedef {{sha:string,parents:string[],changes:TapeCatalogCommonChange[]}} TapeCatalogCommonCommit
 * @typedef {{path:string,content:Buffer}} TapeCatalogCommonCurrentFile
 * @typedef {{gitRef:string,content:Buffer}} TapeCatalogCommonGitFile
 * @typedef {Object} TapeCatalogCommonAdmissionInput
 * @property {Object} identity 固定分支、HEAD、runner、清洁状态和真实Git对象环境事实。
 * @property {Buffer} executionBytes 独立Scope完整原始字节。
 * @property {Buffer} taskStatusBytes 独立STATUS完整原始字节。
 * @property {Object} frozenGraph Scope规定的固定历史唯一父图。
 * @property {TapeCatalogCommonCommit[]} commits base之后一份Source及可选唯一直接Report。
 * @property {TapeCatalogCommonChange[]} changes base到HEAD完整累计raw差异。
 * @property {TapeCatalogCommonCurrentFile[]} currentFiles currentPins与累计变更的完整当前字节闭集。
 * @property {TapeCatalogCommonGitFile[]} gitFiles 固定134个Gitref及Source独立STATUS/INTEGRATION两个动态Gitref的完整字节。
 */

/** 纯规则只接受完整事实；Source与Report每个提交和累计闭包同时核验，防止越界后回退。 */
export function assertTapeCatalogCommonAdmission(input) {
  if (!exactKeys(input, ['identity','executionBytes','taskStatusBytes','frozenGraph','commits','changes','currentFiles','gitFiles'])) fail('TAPE_COMMON_INPUT_INVALID');
  validateIdentity(input.identity);
  if (!Buffer.isBuffer(input.executionBytes) || !input.executionBytes.equals(scopeBytes)) fail('TAPE_COMMON_SCOPE_CHANGED');
  if (!same(input.frozenGraph, scope.frozenGraph)) fail('TAPE_COMMON_FROZEN_GRAPH_MISMATCH');
  const {source,report,cumulativeExpected,sourceRows}=validateClosure(input.commits,input.identity.head,input.changes);
  const paths = [...new Set([...scope.currentPins.map(row => row.path), ...cumulativeExpected.map(row => row.path)])].sort();
  const current = fileMap(input.currentFiles, 'path', paths);
  if (!current.get(scope.scopePath)?.equals(input.executionBytes) || !current.get(scope.taskStatusPath)?.equals(input.taskStatusBytes)) fail('TAPE_COMMON_CURRENT_BYTES_MISMATCH');
  for (const row of scope.currentPins) pinMatches(current.get(row.path), row, 'TAPE_COMMON_CURRENT_PIN_DRIFT');
  for (const row of input.changes) if (blob(current.get(row.path)) !== row.newBlob) fail('TAPE_COMMON_CURRENT_BLOB_MISMATCH');
  const sourceReadbackRefs = scope.sourceGitReadbackPaths.map(file => source.sha + ':' + file);
  const historical = fileMap(input.gitFiles, 'gitRef', [...scope.gitPins.map(row => row.gitRef), ...sourceReadbackRefs]);
  for (const row of scope.gitPins) pinMatches(historical.get(row.gitRef), row, 'TAPE_COMMON_FROZEN_GIT_BYTES_DRIFT');
  for (const file of scope.sourceGitReadbackPaths) {
    const content = historical.get(source.sha + ':' + file);
    if (blob(content) !== sourceRows.get(file).newBlob) fail('TAPE_COMMON_SOURCE_READBACK_DRIFT');
    if (!report && !content.equals(current.get(file))) fail('TAPE_COMMON_SOURCE_READBACK_DRIFT');
  }
  statusBinding(historical.get(source.sha + ':' + scope.taskStatusPath), 'SOURCE_IMPLEMENTATION', source.sha);
  statusBinding(input.taskStatusBytes, report ? 'SOURCE_VERIFIED_REPORT' : 'SOURCE_IMPLEMENTATION', source.sha);
  if (report) reportBinding(current, source.sha);
  const contract = parse(current.get(scope.mobileContract.path), 'TAPE_COMMON_MOBILE_CONTRACT_INVALID');
  const methods = new Set(['get','post','put','patch','delete','options','head','trace']);
  const operations = plain(contract?.paths) ? Object.values(contract.paths).reduce((count, value) => count + (plain(value) ? Object.keys(value).filter(key => methods.has(key)).length : 0), 0) : 0;
  if (contract?.info?.version !== scope.mobileContract.version || operations !== scope.mobileContract.operations) fail('TAPE_COMMON_MOBILE_CONTRACT_INVALID');
  const inheritance = parse(current.get('reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EVIDENCE.json'), 'TAPE_COMMON_ORIGINAL_REPORT_INHERITANCE_INVALID').originalMbm003ReportInheritance;
  if (!same(inheritance, scope.originalMbm003ReportInheritance)) fail('TAPE_COMMON_ORIGINAL_REPORT_INHERITANCE_INVALID');
  const result = freeze({
    schema:'musicbridge.tape-catalog-common.admission.v1',task:scope.task,branch:scope.branch,baseSha:scope.baseSha,
    headAtAdmission:input.identity.head,scopeSha256:hash(scopeBytes),workflowPin:scope.workflowPin,
    localLibraryFixTask:scope.evidenceBoundary.localLibraryFixTask,originalMobileTask:scope.evidenceBoundary.originalMobileTask,
    legacyGateEvidenceReused:true,newCombinedSoftwareGateRequired:true,signedStatFreshSoftwareGateRequired:true,
    currentCombinedAppDeviceOwnerProven:false,oldGateOr003ReexecutionRequired:false,
    exactTapeCatalogFiles:scope.tapeCatalogPins.length,exactSignedStatProductFiles:scope.productPins.length,
    exactProtectedPredecessorFiles:scope.protectedFiles.length,exactInheritedOriginalReportFiles:scope.originalMbm003ReportInheritance.immutableOriginalFiles.length,
    inheritedOriginalReportRefs:scope.originalMbm003ReportInheritance.immutableOriginalFiles,
    sourceFiles:scope.sourceChangedPaths.map(row => row.path),
    sourcePins:paths.map(file => descriptor(file, current.get(file))),
    changedPaths:input.changes.map(row => ({path:row.path,status:row.status})).sort((a,b) => a.path.localeCompare(b.path)),
    closure:{phase:report ? 'DIRECT_REPORT' : 'SOURCE',sourceSha:source.sha,reportSha:report?.sha ?? null,commits:input.commits.map(row => row.sha),baseSha:scope.baseSha},
    evidenceBoundary:scope.evidenceBoundary,
  });
  admittedResults.add(result);
  return result;
}

/** 同一个FD读完整普通文件；拒绝符号链、硬链接和执行位并核对读取前后命名身份。 */
export function readTapeCatalogCommonWhole(file, maxBytes = MAX_FILE_BYTES) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) fail('TAPE_COMMON_FILE_NOT_CANONICAL');
  const named = lstatSync(file, {bigint:true});
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd, {bigint:true});
    const stable = row => ['dev','ino','size','mtimeNs','ctimeNs','mode','uid','gid','nlink'].every(key => first[key] === row[key]);
    if (!first.isFile() || first.size < 1n || first.size > BigInt(maxBytes) || first.nlink !== 1n
      || (first.mode & 0o111n) !== 0n || !stable(named)) fail('TAPE_COMMON_FILE_KIND_OR_BUDGET');
    const bytes = Buffer.alloc(Number(first.size)); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length-offset, null); if (!count) fail('TAPE_COMMON_FILE_TRUNCATED'); offset += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || !stable(fstatSync(fd,{bigint:true})) || !stable(lstatSync(file,{bigint:true}))) fail('TAPE_COMMON_FILE_DRIFT');
    return bytes;
  } finally { closeSync(fd); }
}
function rawChanges(output) {
  const fields = output.split('\0');
  if (fields.pop() !== '') fail('TAPE_COMMON_GIT_DIFF_INVALID');
  const result = [];
  for (let index=0; index<fields.length; index+=2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/u.exec(fields[index]);
    if (!match || !relative(fields[index+1])) fail('TAPE_COMMON_GIT_DIFF_INVALID');
    result.push({path:fields[index+1],status:match[5],oldMode:match[1],newMode:match[2],oldBlob:match[3],newBlob:match[4]});
  }
  return result;
}
function commitParents(text, sha) {
  const fields = text.trim().split(/\s+/u);
  if (fields.shift() !== sha || fields.some(parent => !commitId(parent))) fail('TAPE_COMMON_GIT_GRAPH_INVALID');
  return fields;
}
function existingUnsafeGitPath(file) { return existsSync(file); }

/** 只读取固定目录真实对象；I/O测试可替换字节和Git事实，不能直接注入准入结果。 */
export function inspectTapeCatalogCommonAdmission(directory = repository, env = process.env, io = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()
    || !plain(io) || Object.keys(io).some(key => !['read','git'].includes(key))
    || io.read !== undefined && typeof io.read !== 'function' || io.git !== undefined && typeof io.git !== 'function') fail('TAPE_COMMON_REPOSITORY_INVALID');
  const externalGitEnvironment = Object.keys(env).filter(key => key.startsWith('GIT_') && env[key] !== undefined).sort();
  if (externalGitEnvironment.length) fail('TAPE_COMMON_EXTERNAL_GIT_ENVIRONMENT');
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnv,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'});
  const run = io.git ?? (args => execFileSync('git',['--no-replace-objects','-c','core.fsmonitor=false','-c','core.commitGraph=false','-c','core.hooksPath=/dev/null','-c','core.attributesfile=/dev/null',...args],
    {cwd:directory,env:gitEnv,timeout:10000,maxBuffer:MAX_FILE_BYTES,stdio:['ignore','pipe','pipe']}));
  const text = args => { const output = run(args); if (typeof output === 'string') return output; if (!Buffer.isBuffer(output) || output.length > MAX_FILE_BYTES) fail('TAPE_COMMON_GIT_OUTPUT_INVALID'); try { return new TextDecoder('utf-8',{fatal:true}).decode(output); } catch { fail('TAPE_COMMON_GIT_OUTPUT_INVALID'); } };
  const gitBytes = args => { const output = run(args); return rawBytes(output, 'TAPE_COMMON_GIT_BINARY_READ_REQUIRED'); };
  const read = filename => rawBytes((io.read ?? readTapeCatalogCommonWhole)(filename));
  const observedBranch = () => text(['branch','--show-current']).trim();
  const actualBranch = observedBranch();
  const branch = actualBranch || env.GITHUB_REF_NAME;
  const head = text(['rev-parse','--verify','HEAD^{commit}']).trim();
  const clean = text(['status','--porcelain=v1','--untracked-files=all']) === '';
  const topLevel = text(['rev-parse','--show-toplevel']).trim();
  const gitDir = text(['rev-parse','--path-format=absolute','--git-dir']).trim();
  const commonDir = text(['rev-parse','--path-format=absolute','--git-common-dir']).trim();
  const directoryGitDir = path.join(directory,'.git');
  const gitDirCanonical = path.isAbsolute(gitDir) && gitDir === directoryGitDir && realpathSync(gitDir) === gitDir && lstatSync(gitDir).isDirectory();
  const gitContext = {topLevelIsDirectory:topLevel===directory,gitDirInsideRepository:gitDirCanonical,
    commonDirMatchesGitDir:commonDir===gitDir,objectFormat:text(['rev-parse','--show-object-format']).trim(),
    shallow:text(['rev-parse','--is-shallow-repository']).trim() !== 'false',
    replaceRefs:text(['for-each-ref','--format=%(refname)','refs/replace']).trim().split('\n').filter(Boolean),
    grafts:existingUnsafeGitPath(path.join(gitDir,'info/grafts')),alternates:existingUnsafeGitPath(path.join(gitDir,'objects/info/alternates')),externalGitEnvironment};
  validateIdentity({branch,branchAfter:branch,head,stableHead:head,githubSha:env.GITHUB_SHA??null,githubRefName:env.GITHUB_REF_NAME??null,
    githubHeadRef:env.GITHUB_HEAD_REF||null,runnerRequired:env.GITHUB_ACTIONS==='true',clean,cleanAfter:clean,git:gitContext});
  const parents = sha => commitParents(text(['rev-list','--parents','-n','1',sha]),sha);
  const tape = scope.tapeCatalogFrozen, inheritance = scope.originalMbm003ReportInheritance;
  const ciRows = text(['rev-list','--parents','--reverse','--topo-order',tape.productReportSha+'..'+tape.sourceSha]).trim();
  const tapeCiCommits = ciRows ? ciRows.split('\n').map(line => {const [sha,...parents]=line.trim().split(/\s+/u);return{sha,parents};}) : [];
  const frozenGraph = {baseParents:parents(scope.baseSha),tapeSourceParents:parents(tape.productSourceSha),
    tapeReportParents:parents(tape.productReportSha),tapeFinalParents:parents(tape.sourceSha),tapeCiCommits,
    originalMbm003ReportParents:parents(inheritance.originalDirectReport)};
  // 必须精确闭合到HEAD；不能只检查累计差异来掩盖中途越界或多父合并。
  const lines = text(['rev-list','--parents','--reverse','--topo-order',scope.baseSha+'..'+head]).trim();
  const commits = lines ? lines.split('\n').map(line => {
    const [sha,...parents] = line.trim().split(/\s+/u);
    if (!commitId(sha) || parents.length!==1 || !commitId(parents[0])) fail('TAPE_COMMON_COMMIT_CHAIN_INVALID');
    return{sha,parents,changes:rawChanges(text(['diff','--raw','-z','--no-renames','--no-ext-diff','--no-textconv','--no-abbrev',parents[0],sha,'--']))};
  }) : [];
  if (commits.length<1 || commits.length>2) fail('TAPE_COMMON_COMMIT_CHAIN_INVALID');
  const changes = rawChanges(text(['diff','--raw','-z','--no-renames','--no-ext-diff','--no-textconv','--no-abbrev',scope.baseSha,head,'--']));
  // 先拒绝越界闭包，再读取当前文件；越界路径不能成为资料读取入口。
  if (!same(frozenGraph,scope.frozenGraph)) fail('TAPE_COMMON_FROZEN_GRAPH_MISMATCH');
  validateClosure(commits,head,changes);
  const currentPaths = [...new Set([...scope.currentPins.map(row=>row.path),...changes.map(row=>row.path)])].sort();
  const currentFiles = currentPaths.map(file=>({path:file,content:read(path.join(directory,file))}));
  const sourceReadbackRefs = scope.sourceGitReadbackPaths.map(file=>commits[0].sha+':'+file);
  const gitFiles = [...scope.gitPins.map(row=>row.gitRef),...sourceReadbackRefs].map(gitRef=>({gitRef,content:gitBytes(['show',gitRef])}));
  const currentMap = new Map(currentFiles.map(row=>[row.path,row.content]));
  const stableHead = text(['rev-parse','--verify','HEAD^{commit}']).trim();
  const branchAfter = observedBranch() || env.GITHUB_REF_NAME;
  const cleanAfter = text(['status','--porcelain=v1','--untracked-files=all']) === '';
  const result = assertTapeCatalogCommonAdmission({identity:{branch,branchAfter,head,stableHead,githubSha:env.GITHUB_SHA??null,
    githubRefName:env.GITHUB_REF_NAME??null,githubHeadRef:env.GITHUB_HEAD_REF||null,runnerRequired:env.GITHUB_ACTIONS==='true',clean,cleanAfter,git:gitContext},
    executionBytes:currentMap.get(scope.scopePath),taskStatusBytes:currentMap.get(scope.taskStatusPath),frozenGraph,commits,changes,currentFiles,gitFiles});
  for (const row of currentFiles) if (!read(path.join(directory,row.path)).equals(row.content)) fail('TAPE_COMMON_ADMISSION_DRIFT');
  if (text(['rev-parse','--verify','HEAD^{commit}']).trim()!==head || (observedBranch()||env.GITHUB_REF_NAME)!==branch
    || text(['status','--porcelain=v1','--untracked-files=all'])!==''
    || text(['for-each-ref','--format=%(refname)','refs/replace']).trim()!==''
    || existingUnsafeGitPath(path.join(gitDir,'info/grafts')) || existingUnsafeGitPath(path.join(gitDir,'objects/info/alternates'))) fail('TAPE_COMMON_ADMISSION_DRIFT');
  return result;
}

/** 只有本模块完整准入结果才生成历史复用输出，不能凭手写flags绕过验证。 */
export function tapeCatalogCommonWorkflowOutputs(result) {
  if (!admittedResults.has(result) || result.task!==scope.task || result.legacyGateEvidenceReused!==true
    || result.newCombinedSoftwareGateRequired!==true || result.signedStatFreshSoftwareGateRequired!==true
    || result.localLibraryFixTask!=='LOCAL_LIBRARY_SIGNED_STAT_FIX' || result.originalMobileTask!=='MBM-003') fail('TAPE_COMMON_WORKFLOW_RESULT_REJECTED');
  return {task:scope.task,mobileTask:'reuse-frozen',legacyGateMode:'reuse-frozen',localLibraryFixTask:'LOCAL_LIBRARY_SIGNED_STAT_FIX',combinedGateMode:'run'};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length!==2) fail('TAPE_COMMON_UNKNOWN_ARGUMENT');
    const result=inspectTapeCatalogCommonAdmission();
    const outputs=tapeCatalogCommonWorkflowOutputs(result);
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,Object.entries(outputs).map(([key,value])=>key+'='+value+'\n').join(''),{flag:'a'});
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {
    process.stderr.write('磁带共同基线准入拒绝：'+(/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'TAPE_COMMON_ADMISSION_FAILED')+'\n');
    process.exitCode=1;
  }
}
