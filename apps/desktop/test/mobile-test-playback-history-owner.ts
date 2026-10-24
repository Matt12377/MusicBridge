import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMobilePlaybackHistoryOwnerStore } from '../../../packages/bridge-core/src/mobile/playback-history-owner-store.js';

/** 仅合成Main夹具使用真实history Owner与CAS；不手造持久ACK，不接真实曲库。 */
export function createTestMobilePlaybackHistoryOwner(datasetId: string) {
  const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const parent = path.resolve(process.env.TMPDIR ?? (process.platform === 'darwin' ? external : tmpdir()));
  if (process.platform === 'darwin') assert.ok(parent === external || parent.startsWith(external + path.sep), '合成history必须使用外置临时目录。');
  const directory = mkdtempSync(path.join(parent, 'mobile-main-history-'));
  chmodSync(directory, 0o700);
  const owner = createMobilePlaybackHistoryOwnerStore({ directory, datasetId, assertCurrent() {} });
  let closeFlight: Promise<void> | undefined;
  return {
    dispatch: owner.dispatch,
    close(): Promise<void> {
      return closeFlight ??= (async () => { owner.close(); await rm(directory, { recursive: true, force: true }); })();
    },
  };
}
