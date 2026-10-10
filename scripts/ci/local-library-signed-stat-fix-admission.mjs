import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMbm003PredecessorReuse } from './mbm003-predecessor-reuse.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !path.isAbsolute(value) && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sameJson = (a, b) => same(canonical(a), canonical(b));
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).length === keys.length;
function fail(code) { const error = new Error('本地库有符号身份修复准入拒绝。'); error.code = code; throw error; }
export const LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE_PATH = 'docs/postrust/LOCAL_LIBRARY_SIGNED_STAT_FIX/EXECUTION_SCOPE.json';
export const LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE = freeze({
  "schema": "musicbridge.local-library-signed-stat-fix.execution-scope.v1",
  "task": "LOCAL_LIBRARY_SIGNED_STAT_FIX",
  "branch": "codex/fix-local-library-loading",
  "baseSha": "5e96372f0dd99e08b1e2964d68ce234eb438bbdf",
  "authority": "DIRECT_OWNER_ORDINARY_INSTALLED_APP_BUGFIX_CONTINUING_AUTHORIZATION",
  "sourceChangedPaths": [
    {
      "path": ".github/workflows/verify.yml",
      "status": "M",
      "role": "FIX_CI_ADMISSION"
    },
    {
      "path": "docs/postrust/LOCAL_LIBRARY_SIGNED_STAT_FIX/EXECUTION_SCOPE.json",
      "status": "A",
      "role": "FIX_CI_ADMISSION"
    },
    {
      "path": "packages/bridge-core/src/application/local-source-resolver.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/collection/local-relocation-coordinator.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/collection/local-scan-coordinator.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/collection/local-source-ticket-types.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/recording/source-files.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/stream/local-file-source.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/stream/physical-resource-claims.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/stream/physical-resource-locks.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/src/stream/source-namespace-claims.ts",
      "status": "M",
      "role": "SIGNED_STAT_PRODUCT"
    },
    {
      "path": "packages/bridge-core/test/local-library-signed-read-chain.test.ts",
      "status": "A",
      "role": "SIGNED_STAT_BEHAVIOR"
    },
    {
      "path": "packages/bridge-core/test/local-library-signed-stat-identity.test.ts",
      "status": "A",
      "role": "SIGNED_STAT_BEHAVIOR"
    },
    {
      "path": "project/POSTRUST_PLAN.json",
      "status": "M",
      "role": "FIX_PROGRESS_ONLY"
    },
    {
      "path": "project/POSTRUST_PROGRESS.md",
      "status": "M",
      "role": "FIX_PROGRESS_ONLY"
    },
    {
      "path": "project/POSTRUST_TODO.md",
      "status": "M",
      "role": "FIX_PROGRESS_ONLY"
    },
    {
      "path": "project/STATUS.json",
      "status": "M",
      "role": "FIX_PROGRESS_ONLY"
    },
    {
      "path": "scripts/ci/local-library-signed-stat-fix-admission.mjs",
      "status": "A",
      "role": "FIX_CI_ADMISSION"
    },
    {
      "path": "scripts/ci/local-library-signed-stat-legacy-normalization.mjs",
      "status": "A",
      "role": "EXACT_LEGACY_INVERSE_GUARD"
    },
    {
      "path": "scripts/ci/mbm002-legacy-input-normalization.mjs",
      "status": "M",
      "role": "EXACT_LEGACY_INVERSE_GUARD"
    },
    {
      "path": "scripts/ci/test/local-library-signed-stat-fix-admission.test.mjs",
      "status": "A",
      "role": "FIX_CI_ADMISSION"
    },
    {
      "path": "scripts/ci/test/local-library-signed-stat-legacy-normalization.test.mjs",
      "status": "A",
      "role": "EXACT_LEGACY_INVERSE_GUARD"
    },
    {
      "path": "scripts/ci/test/mbm002-legacy-input-normalization.test.mjs",
      "status": "M",
      "role": "EXACT_LEGACY_INVERSE_GUARD"
    },
    {
      "path": "scripts/ci/verify-local-library-signed-stat-fix.mjs",
      "status": "A",
      "role": "FIX_CI_ADMISSION"
    }
  ],
  "reportOnlyAddedPaths": [
    "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_EVIDENCE.json",
    "reports/LOCAL_LIBRARY_SIGNED_STAT_FIX_RESULT.md"
  ],
  "productPins": [
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
        "sha256": "14e0054b011279db0440652e3f5382e3ab3332b19c775fa84578f395d6b7aa2c"
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
    }
  ],
  "protectedFiles": [
    {
      "path": "docs/postrust/MBM-000/EXECUTION_SCOPE.json",
      "bytes": 2791,
      "sha256": "bed0961a57bab85daf3d85daf382b487dc7b3f2b58bd02bcf8f807c6c1c0dc4a"
    },
    {
      "path": "docs/postrust/MBM-001/EXECUTION_SCOPE.json",
      "bytes": 4846,
      "sha256": "9d72a7a092f60a6c0c8e50a7f75d66ca40ec12cfe9cd40bbd333ccb02fea6484"
    },
    {
      "path": "docs/postrust/MBM-002/EXECUTION_SCOPE.json",
      "bytes": 2232,
      "sha256": "45c6665ba2cf1563621ffbd4181aae48abc471204849675d896c77a0fe0dbeef"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_FREEZE.json",
      "bytes": 2184,
      "sha256": "dd8fef00d2ab38066c458b5c92c16d5e060633d40dff7bcce488b609f57d3e5a"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS.md",
      "bytes": 6076,
      "sha256": "698ca28f695b950c7409489b67929da523193856461f858df7047c1b48d2fa2a"
    },
    {
      "path": "docs/postrust/MBM-003/CONTRACT_SEMANTICS_DRAFT.md",
      "bytes": 3105,
      "sha256": "c7b40febb7039f700a68c737d8624810f60f0a6560dbdec5cfd7dec4c045efef"
    },
    {
      "path": "docs/postrust/MBM-003/DSD_PROCESSING_CONTRACT_PROPOSAL.json",
      "bytes": 3863,
      "sha256": "189250e7ad93dddc4c24dccc6c7ec86565d3cd06e84a0fb977fc125ef4924ffc"
    },
    {
      "path": "docs/postrust/MBM-003/EXECUTION_SCOPE.json",
      "bytes": 7103,
      "sha256": "e0e35e4723a90c07a422c30f355ac7ab76b78ce17212e0aa414369622e5071ec"
    },
    {
      "path": "docs/postrust/MBM-003/IMPLEMENTATION_CHECKPOINT.md",
      "bytes": 4860,
      "sha256": "1f70c1b015d85cc1bae7798190e722d38529e3a1efcca7bf96b3087bb97b3678"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_DSD_TRANSPORT_DECISION_2026-10-10.json",
      "bytes": 4578,
      "sha256": "a36b722255201e98167b4a616fa8228cf2109b8204613d0cb3a85aab7f2bc256"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_AMENDMENT_2026-10-09.json",
      "bytes": 4007,
      "sha256": "1b63215f580aa6975ad9cccf265c666cc6b37cbec9f9e75ab1eb4837758a9718"
    },
    {
      "path": "docs/postrust/MBM-003/OWNER_SCOPE_DECISION_2026-10-10.json",
      "bytes": 6241,
      "sha256": "4851db40bf2f987c0d787413a2d7b0bcc6461d151f33d7ae20c796c63920baad"
    },
    {
      "path": "docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json",
      "bytes": 1932,
      "sha256": "9ea3af0f43c773819a969260dade313c6f54c3e37ac57214d666e18c52383147"
    },
    {
      "path": "docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json",
      "bytes": 3058,
      "sha256": "87cb1fcc67dc74013b7780cdf01e3ff0d44d756ee964938c23b0e37c266e1d4c"
    },
    {
      "path": "docs/postrust/MBM-003/READY_RENEW_BOUNDARY.json",
      "bytes": 1374,
      "sha256": "18ced7a85d813730f90108ad18ac7f0e903f261d23dfda1b214188513b659665"
    },
    {
      "path": "docs/postrust/MBM-003/contract-preview/openapi.json",
      "bytes": 147487,
      "sha256": "9dcde7b24150e9b21dc9366bd913e3ca216a34584b6f85942fee17e8bd7a06a8"
    },
    {
      "path": "packages/contracts/mobile/openapi.json",
      "bytes": 147445,
      "sha256": "3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21"
    },
    {
      "path": "reports/MBM-002_EVIDENCE.json",
      "bytes": 4030,
      "sha256": "6fb3dbcdf7bc2026bae0b30664581c0d3bc476aad132c274354e19eb7d1a5bea"
    },
    {
      "path": "reports/MBM-002_RESULT.md",
      "bytes": 873,
      "sha256": "0dda06192257333401b2836281458f8c9479c6d2a03109c2200f636efbca3c3d"
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
      "path": "scripts/ci/mbm003-software-gate.mjs",
      "bytes": 35887,
      "sha256": "85a88fedba29caa43f68fe6d49551f86578948ad9e2ff4decd450cbf48086dc3"
    },
    {
      "path": "scripts/ci/report-only-admission.mjs",
      "bytes": 27460,
      "sha256": "ed5c7c32f3aa27591e99139807827fd5bc1089693df09409578508231be762ab"
    },
    {
      "path": "scripts/ci/report-only-mbm002.mjs",
      "bytes": 9791,
      "sha256": "223e3efbd10ce3d59635f73717465cafadcedd11b16c5260617b0f76be134aea"
    },
    {
      "path": "scripts/ci/report-only-mbm003.mjs",
      "bytes": 11480,
      "sha256": "68da84bebcdc79fb650fb809b75bbcd0ab049da3b5470f267f1943f82e4d6e85"
    },
    {
      "path": "scripts/ci/run-core-tests.mjs",
      "bytes": 13476,
      "sha256": "5b6b405a4fe514197765cb7c9fc59d1f1141545d143effd7f1f1ff4c65a5d44b"
    },
    {
      "path": "scripts/ci/verify-mbm000-contract-adoption.mjs",
      "bytes": 44759,
      "sha256": "a3e87936042d8085615b07a6ad2eeec1ada98645cdcbabbf5f0b2c50f23d86b5"
    },
    {
      "path": "scripts/ci/verify-mbm001-pairing-library.mjs",
      "bytes": 18073,
      "sha256": "b439348a66c25b1a70493ca75854a9e346737763dbc42f9d3a9c8f84dceeb855"
    },
    {
      "path": "scripts/ci/verify-mbm002-resource-playback.mjs",
      "bytes": 12321,
      "sha256": "9e48660e3e074f1172de49740713d9e072f1ba0d8dc3684cedd1e04897d3e28e"
    },
    {
      "path": "scripts/ci/verify-mbrs001-offline.mjs",
      "bytes": 14851,
      "sha256": "35ad160e0f58c0eea0cbb22ae0f4d948955c13c05857eaa3134c18aa9552ab3d"
    },
    {
      "path": "scripts/ci/verify-mbrs002-contracts.mjs",
      "bytes": 22849,
      "sha256": "b207255e2d7a555cd3ea9d4ba305472bf8f09a5c72a0877fd081eae249be1b8e"
    },
    {
      "path": "scripts/ci/verify-mbrs003-scan.mjs",
      "bytes": 37197,
      "sha256": "c33d12f7401bcbdfa3b532bfc00376377e224ad8c5a6efa1b77eff6a1dc1dc53"
    },
    {
      "path": "scripts/ci/verify-mbrs004-rules.mjs",
      "bytes": 11521,
      "sha256": "a2e293a7c1860526cba36334285eda3b9e759b77c91b5fbb03bba27ffc7bc328"
    },
    {
      "path": "scripts/ci/verify-mbrs005-gateway.mjs",
      "bytes": 14217,
      "sha256": "c77cde79ec4dfc4486afda25a74c0455fb5c96200cf5273724ccf3435cf2863e"
    },
    {
      "path": "scripts/ci/verify-mbrs006-local-playback.mjs",
      "bytes": 16705,
      "sha256": "4df7b1624306556a5df90e31cc6565fd51b5baaedf2961d6e4574ec3eae6dbb6"
    },
    {
      "path": "scripts/ci/verify-mbrs007-queue.mjs",
      "bytes": 23136,
      "sha256": "c9d8c1d1605ea08b2754e6058440940dbcede505b3b0c90f44c81a8adee94471"
    },
    {
      "path": "scripts/ci/verify-mbrs008-audio.mjs",
      "bytes": 21327,
      "sha256": "c00e66b3c5ce423352bdfdc79be458b973d9b8a695ec5569b579cfb039cc4527"
    },
    {
      "path": "scripts/ci/verify-mbrs008-ui-render.mjs",
      "bytes": 6034,
      "sha256": "6bddcb1221be202ce4af5ee75cafacedb63bca5c480f7a5a027144e445db513b"
    },
    {
      "path": "scripts/ci/verify-mbrs009-local-library-ui.mjs",
      "bytes": 21699,
      "sha256": "f834f4e6dfefe6e0985a31896e4e9d0d03d90a6d7b5fa968359ac613a83434ff"
    },
    {
      "path": "scripts/ci/verify-mbrs009-ui-render.mjs",
      "bytes": 7479,
      "sha256": "9d4e2fc018fee8673a721b4667975994f3cc307296627cb675ab95773fe369d3"
    },
    {
      "path": "scripts/ci/verify-mbrs010-artwork.mjs",
      "bytes": 29111,
      "sha256": "3427476dd5fb20f243a48b359ec6b5a06faa0157c7333dd7582cf3814da3a7f4"
    },
    {
      "path": "scripts/ci/verify-mbrs011-organizer.mjs",
      "bytes": 17055,
      "sha256": "56988faccb590c14f5241b431ef5d555271bd2e6496aa3a346107fa7cf52b692"
    },
    {
      "path": "scripts/ci/verify-mbrs012-source-writes.mjs",
      "bytes": 27972,
      "sha256": "84185ff650463228d6584c862674823c9bdafc45ec704cb7a6a1bf2b06c43e42"
    },
    {
      "path": "scripts/ci/verify-mbrs013-relocation.mjs",
      "bytes": 23501,
      "sha256": "ee35adb79f5805ebfe7754bf0987ade6baf1412d568ac750f1eecf94ab363b92"
    },
    {
      "path": "scripts/ci/verify-mbrs014-compatibility.mjs",
      "bytes": 23064,
      "sha256": "11d46740fe6e9e0169af1503ec135b74e52b1338b740148bc994e5d59ecfc262"
    }
  ],
  "budgets": {
    "totalTimeoutMs": 480000,
    "stageTimeoutMs": 180000,
    "preparationTimeoutMs": 360000,
    "killGraceMs": 10000,
    "rawOutputBytes": 16777216,
    "sourceFileBytes": 16777216,
    "maxSourceFiles": 8192
  },
  "tests": [
    {
      "file": "packages/bridge-core/test/local-library-signed-stat-identity.test.ts",
      "expectedTests": 5
    },
    {
      "file": "packages/bridge-core/test/local-library-signed-read-chain.test.ts",
      "expectedTests": 2
    },
    {
      "file": "packages/bridge-core/test/mbrs003/persistent-scan-owner.test.ts",
      "expectedTests": 8
    },
    {
      "file": "packages/bridge-core/test/mbrs005/locks.test.ts",
      "expectedTests": 7
    },
    {
      "file": "packages/bridge-core/test/mbrs012/namespace.test.ts",
      "expectedTests": 36
    },
    {
      "file": "apps/desktop/test/mbrs003/local-root-outbox-cold-recovery.test.ts",
      "expectedTests": 2
    },
    {
      "file": "apps/desktop/test/command-outbox-service.test.ts",
      "expectedTests": 15
    }
  ],
  "policy": {
    "defaultNode": true,
    "optionalRust": "OFF",
    "sourceMediaWrites": false,
    "newWriterOrOwner": false,
    "sourceIdentitySignPreserved": true,
    "numberOrAbsOrUnsignedReinterpretation": false,
    "oldIdentityMismatchStillRejected": true,
    "bulkAuthorizationRecovery": false,
    "libraryWriteEnabledDefault": "OFF",
    "metadataAndFdAndLeaseBudgetsChanged": false
  },
  "projectBinding": {
    "statusCurrent": "currentLocalLibraryFixTask",
    "statusAuthority": "localLibrarySignedStatFix",
    "planAuthority": "local_library_signed_stat_fix",
    "oldMobileTaskBlocksUnchanged": true,
    "statusAddedFields": [
      "currentLocalLibraryFixTask",
      "localLibrarySignedStatFix",
      "currentMobileDeliveryReadback20261010",
      "parallelTapeCatalogDelivery20261010"
    ],
    "planAddedFields": [
      "local_library_signed_stat_fix"
    ]
  },
  "evidenceBoundary": {
    "newExactSoftwareGateRequired": true,
    "standardVerificationRequired": true,
    "firstNaturalSourceCiRequired": true,
    "ordinaryProfileRecoveryAndUiScanSeparate": true,
    "freshReaderAndWorkerRequired": true,
    "legacyGateReexecutionRequired": false,
    "fixtureOrMockDoesNotProveOrdinaryLibrary": true,
    "providerRoonNasAndPhysicalDeviceAndOwnerAcceptanceNotProven": true
  }
});
export const LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK = LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.task;
export const LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH = LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.branch;
export const LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE = LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.baseSha;

/** 只移除Root前置的精确新字段，余下整份JSON保持原始字节，绝不重序列化历史unsafe整数。 */
export function stripAddedJsonPrefix(bytes, names) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16777216 || !Array.isArray(names)) fail('SIGNED_STAT_PROJECT_PREFIX_INVALID');
  let text;
  try { text = new TextDecoder('utf-8', { fatal:true }).decode(bytes); } catch { fail('SIGNED_STAT_PROJECT_PREFIX_INVALID'); }
  if (!text.startsWith('{\n')) fail('SIGNED_STAT_PROJECT_PREFIX_INVALID');
  let at = 2;
  for (const name of names) {
    const label = '  ' + JSON.stringify(name) + ':';
    if (!text.startsWith(label, at)) fail('SIGNED_STAT_PROJECT_PREFIX_INVALID');
    at += label.length;
    let quoted = false, escaped = false, depth = 0, start = at, end = -1;
    for (; at < text.length; at++) {
      const char = text[at];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') { if (--depth < 0) fail('SIGNED_STAT_PROJECT_PREFIX_INVALID'); }
      else if (char === ',' && depth === 0) { end = at; break; }
    }
    if (end < 0 || quoted || depth !== 0 || text[end + 1] !== '\n') fail('SIGNED_STAT_PROJECT_PREFIX_INVALID');
    try { JSON.parse(text.slice(start, end)); } catch { fail('SIGNED_STAT_PROJECT_PREFIX_INVALID'); }
    at = end + 2;
  }
  if (!text.startsWith('  "', at)) fail('SIGNED_STAT_PROJECT_PREFIX_INVALID');
  return Buffer.from('{\n' + text.slice(at), 'utf8');
}

export function localLibraryFixRoute(branch, status, plan) {
  return branch === LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH
    || [status?.currentLocalLibraryFixTask,status?.localLibrarySignedStatFix?.task,plan?.local_library_signed_stat_fix?.current_task].includes(LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK)
    ? 'VALIDATE_EXACT_FIX' : 'ORIGINAL_PREDECESSOR_INSPECTOR';
}

/** 纯准入：不写库、不构建、不修改旧任务，产品9叶只能是冻结的完整新字节。 */
export function assertLocalLibrarySignedStatFixAdmission(input) {
  if (!exactKeys(input, ['branch','head','baseIsAncestor','statusBytes','planBytes','baselineStatusBytes','baselinePlanBytes','execution','changedPaths','productFiles','frozenFiles'])) fail('SIGNED_STAT_UNKNOWN_INPUT');
  if (input.branch !== LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH) fail('SIGNED_STAT_BRANCH_MISMATCH');
  if (!/^[a-f0-9]{40}$/u.test(input.head ?? '') || input.baseIsAncestor !== true) fail('SIGNED_STAT_BASE_MISMATCH');
  const status = parse(input.statusBytes), projectPlan = parse(input.planBytes);
  const authority = status?.localLibrarySignedStatFix, plan = projectPlan?.local_library_signed_stat_fix;
  if (status?.currentLocalLibraryFixTask !== LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK
    || authority?.task !== LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK || plan?.current_task !== LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK) fail('SIGNED_STAT_TASK_MISMATCH');
  if (authority.branch !== LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH || plan.branch !== LOCAL_LIBRARY_SIGNED_STAT_FIX_BRANCH
    || authority.baseSha !== LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE || plan.base_sha !== LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE
    || authority.executionScope !== LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE_PATH || plan.scope_ref !== LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE_PATH) fail('SIGNED_STAT_AUTHORITY_MISMATCH');
  if (!Buffer.isBuffer(input.baselineStatusBytes) || !Buffer.isBuffer(input.baselinePlanBytes)
    || !stripAddedJsonPrefix(input.statusBytes, LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.projectBinding.statusAddedFields).equals(input.baselineStatusBytes)
    || !stripAddedJsonPrefix(input.planBytes, LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.projectBinding.planAddedFields).equals(input.baselinePlanBytes)) fail('SIGNED_STAT_PREDECESSOR_PROJECT_CHANGED');
  if (!sameJson(status.currentMobileDeliveryReadback20261010, {
    task:'MBM-003',source:LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE,directReport:'99c89519f3357f4018b32930e8179b66719f99e7',
    software:'SOURCE_AND_DIRECT_REPORT_FIRST_NATURAL_CI_CONTENT_SEALED',deviceAcceptance:'PARTIAL_REPLAY_AND_INTERRUPTION_RECOVERY_OPEN',
    nextOrder:['MBM-004','MBRS-016','MBRS-017'],newFixIsSeparatelyVerified:true })
    || !sameJson(status.parallelTapeCatalogDelivery20261010, {
      source:'cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f',software:'ISOLATED_SOURCE_FIRST_NATURAL_FOUR_CI_SUCCESS_READ_BACK',
      ordinaryAppIntegration:'PENDING_FINAL003_BASELINE_INTEGRATION',realCatalogImport:'NOT_RUN',effectiveMainTaskAndAcceptanceCountsUnchanged:true })
    || authority.sourceFilesWrite !== 'UNCHANGED_DEFAULT_OFF' || authority.originalMobileTaskAndAcceptanceUnchanged !== true
    || authority.ownerRepeatedApprovalRequired !== false) fail('SIGNED_STAT_EVIDENCE_BOUNDARY_CHANGED');
  if (!sameJson(input.execution, LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE)) fail('SIGNED_STAT_SCOPE_CHANGED');
  const allowed = new Map(LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.sourceChangedPaths.map(row => [row.path, row.status]));
  for (const report of LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.reportOnlyAddedPaths) allowed.set(report, 'A');
  if (!Array.isArray(input.changedPaths) || input.changedPaths.length < 24 || input.changedPaths.length > allowed.size
    || new Set(input.changedPaths.map(row => row?.path)).size !== input.changedPaths.length) fail('SIGNED_STAT_CHANGED_SET_INVALID');
  for (const row of input.changedPaths) if (!exactKeys(row, ['path','status']) || !relative(row.path)
    || allowed.get(row.path) !== row.status) fail('SIGNED_STAT_CHANGED_PATH_REJECTED');
  if (LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.sourceChangedPaths.some(row => !input.changedPaths.some(actual => actual.path === row.path && actual.status === row.status))) fail('SIGNED_STAT_REQUIRED_CHANGE_MISSING');
  const expectedProducts = LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.productPins.map(row => ({ path: row.path, ...row.after }));
  if (!same(input.productFiles, expectedProducts)) fail('SIGNED_STAT_PRODUCT_DRIFT');
  if (!same(input.frozenFiles, LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.protectedFiles)) fail('SIGNED_STAT_FROZEN_PREDECESSOR_DRIFT');
  return { schema: 'musicbridge.local-library-signed-stat-fix.admission.v1', task: LOCAL_LIBRARY_SIGNED_STAT_FIX_TASK,
    branch: input.branch, baseSha: LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE, headAtAdmission: input.head,
    exactProductFiles: 9, changedPaths: input.changedPaths, frozenPredecessorFiles: input.frozenFiles,
    oldGateEvidenceReused: true, currentFixSoftwareGateRequired: true, currentFixAppDeviceOwnerProven: false };
}

/** 同一个FD读全件；祖先真实路径、普通文件、精确长度和named/FD前后身份均检查。 */
export function readLocalLibraryFixWhole(file, maxBytes = 16777216) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) fail('SIGNED_STAT_FILE_NOT_CANONICAL');
  const named = lstatSync(file, { bigint: true }), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd, { bigint: true });
    const stable = row => ['dev','ino','size','mtimeNs','ctimeNs','mode','uid','gid','nlink'].every(key => first[key] === row[key]);
    if (!first.isFile() || first.size < 1n || first.size > BigInt(maxBytes) || !stable(named)) fail('SIGNED_STAT_FILE_KIND_OR_BUDGET');
    const bytes = Buffer.alloc(Number(first.size)); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) fail('SIGNED_STAT_FILE_TRUNCATED'); offset += n; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || !stable(fstatSync(fd, { bigint: true }))
      || !stable(lstatSync(file, { bigint: true }))) fail('SIGNED_STAT_FILE_DRIFT');
    return bytes;
  } finally { closeSync(fd); }
}
function parse(bytes) { if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16777216) fail('SIGNED_STAT_JSON_INVALID'); try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('SIGNED_STAT_JSON_INVALID'); } }
function git(directory, args) { return execFileSync('git', args, { cwd: directory, timeout: 10000, maxBuffer: 16777216, stdio: ['ignore','pipe','pipe'] }); }
function pin(directory, row) { const bytes = readLocalLibraryFixWhole(path.join(directory, row.path)); return { path: row.path, bytes: bytes.length, sha256: hash(bytes) }; }

/** 实际dispatcher仅本修复分支取得新task；其余全部交原003 inspector，保持原拒绝语义。 */
export function inspectLocalLibrarySignedStatFixAdmission(directory = repository, env = process.env) {
  const json = relativePath => parse(readLocalLibraryFixWhole(path.join(directory, relativePath)));
  const statusBytes = readLocalLibraryFixWhole(path.join(directory,'project/STATUS.json')), planBytes = readLocalLibraryFixWhole(path.join(directory,'project/POSTRUST_PLAN.json'));
  const status = parse(statusBytes), plan = parse(planBytes);
  const observedBranch = git(directory, ['branch','--show-current']).toString('utf8').trim();
  const branch = observedBranch || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (localLibraryFixRoute(branch, status, plan) === 'ORIGINAL_PREDECESSOR_INSPECTOR') return inspectMbm003PredecessorReuse(directory, env);
  const head = git(directory, ['rev-parse','HEAD']).toString('utf8').trim();
  let baseIsAncestor = false;
  try { git(directory, ['merge-base','--is-ancestor',LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE,'HEAD']); baseIsAncestor = true; } catch { fail('SIGNED_STAT_BASE_MISMATCH'); }
  const rawDiff = git(directory, ['diff','--name-status','--no-renames','-z',LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE,'--']).toString('utf8').split('\0');
  if (rawDiff.pop() !== '') fail('SIGNED_STAT_GIT_DIFF_INVALID');
  const changedPaths = [];
  while (rawDiff.length) { const change = rawDiff.shift(), file = rawDiff.shift(); if (!['A','M','D'].includes(change) || !relative(file)) fail('SIGNED_STAT_GIT_DIFF_INVALID'); changedPaths.push({ path:file,status:change }); }
  const untracked = git(directory, ['ls-files','--others','--exclude-standard','-z']).toString('utf8').split('\0');
  if (untracked.pop() !== '') fail('SIGNED_STAT_GIT_DIFF_INVALID');
  changedPaths.push(...untracked.map(file => ({ path:file,status:'A' }))); changedPaths.sort((a,b) => a.path.localeCompare(b.path));
  const productFiles = LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.productPins.map(row => {
    const original = git(directory, ['show', LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE + ':' + row.path]);
    if (original.length !== row.before.bytes || hash(original) !== row.before.sha256) fail('SIGNED_STAT_BASE_PRODUCT_CHANGED');
    return pin(directory, row);
  });
  const frozenFiles = LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.protectedFiles.map(row => pin(directory, row));
  const result = assertLocalLibrarySignedStatFixAdmission({ branch,head,baseIsAncestor,statusBytes,planBytes,
    baselineStatusBytes:git(directory, ['show', LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE + ':project/STATUS.json']),
    baselinePlanBytes:git(directory, ['show', LOCAL_LIBRARY_SIGNED_STAT_FIX_BASE + ':project/POSTRUST_PLAN.json']),
    execution:json(LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE_PATH),changedPaths,productFiles,frozenFiles });
  for (const row of changedPaths) readLocalLibraryFixWhole(path.join(directory, row.path));
  if (git(directory, ['rev-parse','HEAD']).toString('utf8').trim() !== head
    || !same(productFiles, LOCAL_LIBRARY_SIGNED_STAT_FIX_SCOPE.productPins.map(row => pin(directory,row)))) fail('SIGNED_STAT_ADMISSION_DRIFT');
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('SIGNED_STAT_UNKNOWN_ARGUMENT');
    const result = inspectLocalLibrarySignedStatFixAdmission();
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, 'task=' + result.task + '\n', { flag:'a' });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write('本地库修复准入拒绝：' + (/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'SIGNED_STAT_ADMISSION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
