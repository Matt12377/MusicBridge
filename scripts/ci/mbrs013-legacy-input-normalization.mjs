import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  COMPATIBILITY_LEGACY_INPUTS, COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION,
  COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION, COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION,
  COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION,
} from './verify-mbrs014-compatibility.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = () => {
  const error = new Error('旧012输入只准精确已核增量的逆变换。');
  error.code = 'SEALED012_LEGACY_INPUT_CHANGED';
  throw error;
};
const manifestBytes = readFileSync(new URL('../../' + COMPATIBILITY_LEGACY_INPUTS.path, import.meta.url));
if (manifestBytes.length !== COMPATIBILITY_LEGACY_INPUTS.bytes
  || sha(manifestBytes) !== COMPATIBILITY_LEGACY_INPUTS.sha256) reject();
const manifest = JSON.parse(manifestBytes);
const original = file => {
  const value = manifest.files.find(input => input.path === file);
  if (!value) reject();
  return value;
};
const entries = [
  {
    before: COMPATIBILITY_SOURCE_WRITES_PRELOAD_EXTENSION,
    after: COMPATIBILITY_RELOCATION_PRELOAD_EXTENSION,
    additions: ["    'localRelocationPlan',\n"],
  },
  {
    before: original(COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION.path),
    after: COMPATIBILITY_RELOCATION_LIBRARY_UI_EXTENSION,
    additions: [
      "import * as localRelocation from '../src/renderer/src/composables/application/useLocalRelocationPlans.js'\n",
      "      if (name.endsWith('/useLocalRelocationPlans.js')) return localRelocation\n",
    ],
  },
  {
    before: original(COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION.path),
    after: COMPATIBILITY_RELOCATION_ORGANIZER_UI_EXTENSION,
    additions: [
      "import * as relocationComposables from '../src/renderer/src/composables/application/useLocalRelocationPlans.js'\n",
      "      if (name.endsWith('/useLocalRelocationPlans.js')) return relocationComposables\n",
    ],
  },
];
const matches = (bytes, identity) => bytes.length === identity.bytes && sha(bytes) === identity.sha256;

/** 原31个012断言继续消费封存字节；当前013原始字节由独立守卫验证。 */
export function normalizeSealed012LegacyInput(file, bytes) {
  if (typeof file !== 'string' || !Buffer.isBuffer(bytes)) reject();
  const entry = entries.find(value => value.after.path === file);
  if (!entry) return bytes;
  if (matches(bytes, entry.before)) return bytes;
  if (!matches(bytes, entry.after)) reject();
  let text = bytes.toString('utf8');
  for (const addition of entry.additions) {
    if (text.split(addition).length !== 2) reject();
    text = text.replace(addition, '');
  }
  const previous = Buffer.from(text, 'utf8');
  if (!matches(previous, entry.before)) reject();
  return previous;
}
