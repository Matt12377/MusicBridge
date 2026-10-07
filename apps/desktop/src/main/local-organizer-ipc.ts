import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { CoreIpcError, type CoreSupervisor } from './core-supervisor.js';

const ordinary = ['localOrganizer.preview', 'localOrganizer.get', 'localOrganizer.history', 'localOrganizer.cancel'] as const;
/** 四个具名查询/预览/取消入口；confirm与undo仅走原持久outbox。 */
export function installLocalOrganizerHandlers<E>(options: {
  handle(channel: string, handler: (event: E, value?: unknown) => unknown): void;
  requireTrusted(event: E): void; supervisor: Pick<CoreSupervisor, 'request'>;
}): void {
  options.handle('localOrganizer:request', async (event, value) => {
    options.requireTrusted(event);
    if (!dto.organizerRecord(value, ['datasetId', 'command', 'payload']) || !dto.isCommandOutboxDatasetId(value.datasetId)
      || typeof value.command !== 'string' || !(ordinary as readonly string[]).includes(value.command)) throw new Error('[INVALID_IPC_REQUEST] 整理请求无效。');
    const command = value.command as typeof ordinary[number];
    if (!dto.isLocalOrganizerCommandPayload(command, value.payload)) throw new Error('[INVALID_IPC_REQUEST] 整理字段、目标或范围无效。');
    const request = dto.validateIpcRequest({ version: dto.IPC_VERSION, id: randomUUID(), command, payload: value.payload, expectedDatasetId: value.datasetId });
    if (!request.ok) throw new Error('[INVALID_IPC_REQUEST] 整理逻辑请求无效。');
    try {
      const result = await options.supervisor.request(command, value.payload as dto.IpcCommandPayloads[typeof command], value.datasetId);
      if (!dto.isLocalOrganizerCommandResult(command, result) || command !== 'localOrganizer.history' && 'datasetId' in result && result.datasetId !== value.datasetId) throw new Error('整理回执身份无效。'); return result;
    } catch (error) {
      if (error instanceof CoreIpcError && error.code === 'INVENTORY_CONFLICT') throw new Error('[INVENTORY_CONFLICT] 整理范围或修订已改变，请重新预览。');
      throw new Error('[INVENTORY_UNAVAILABLE] 整理结果未确认，现有音乐库保留；请读取计划和未确认操作。');
    }
  });
}
