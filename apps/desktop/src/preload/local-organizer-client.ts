import * as dto from '@music-bridge/contracts';
import type { DatasetScope } from './command-outbox-client.js';

const bad = (): Error => new Error('[INVALID_IPC_REQUEST] 整理请求或回执无效，请重新预览当前工作库。');
/** 原输入先闭集检查再clone；确认与反向预览交给Main原outbox，固定当前窗口dataset。 */
export function createLocalOrganizerClient(invoke: (channel: string, value?: unknown) => Promise<unknown>, scope: DatasetScope, write: {
  confirm(request: dto.ConfirmLocalOrganizer): Promise<dto.LocalOrganizerPlan>;
  undo(request: dto.ChangeLocalOrganizer): Promise<dto.LocalOrganizerPlan>;
}): dto.LocalOrganizerPublicApi {
  async function send<C extends dto.LocalOrganizerCommand>(command: C, request: dto.LocalOrganizerCommandPayloads[C]): Promise<dto.LocalOrganizerCommandResults[C]> {
    if (!dto.isLocalOrganizerCommandPayload(command, request)) throw bad();
    const captured = structuredClone(request), datasetId = await scope();
    const value = command === 'localOrganizer.confirm' ? await write.confirm(captured as dto.ConfirmLocalOrganizer)
      : command === 'localOrganizer.undo' ? await write.undo(captured as dto.ChangeLocalOrganizer)
        : await invoke('localOrganizer:request', { datasetId, command, payload: captured });
    if (!dto.isLocalOrganizerCommandResult(command, value)) throw bad();
    if (command !== 'localOrganizer.history') {
      const plan = value as dto.LocalOrganizerPlan, input = captured as dto.PreviewLocalOrganizer & dto.ChangeLocalOrganizer & dto.ConfirmLocalOrganizer;
      if (plan.datasetId !== datasetId || plan.planId !== (command === 'localOrganizer.preview' || command === 'localOrganizer.undo' ? input.commandId : input.planId)) throw bad();
      if (command === 'localOrganizer.preview' && plan.scope !== input.scope || command === 'localOrganizer.undo' && plan.undoOf !== input.planId
        || command === 'localOrganizer.confirm' && (plan.scope !== input.scope || plan.planHash !== input.planHash || plan.contextFingerprint !== input.contextFingerprint)) throw bad();
    }
    return value;
  }
  return Object.freeze({
    previewLocalOrganizer: (request: dto.PreviewLocalOrganizer) => send('localOrganizer.preview', request),
    getLocalOrganizerPlan: (request: { planId: string }) => send('localOrganizer.get', request),
    listLocalOrganizerHistory: (request: { offset: number; limit: number }) => send('localOrganizer.history', request),
    confirmLocalOrganizer: (request: dto.ConfirmLocalOrganizer) => send('localOrganizer.confirm', request),
    undoLocalOrganizer: (request: dto.ChangeLocalOrganizer) => send('localOrganizer.undo', request),
    cancelLocalOrganizer: (request: dto.ChangeLocalOrganizer) => send('localOrganizer.cancel', request),
  });
}
