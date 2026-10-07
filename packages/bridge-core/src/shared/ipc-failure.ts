import { IPC_VERSION, LOCAL_LEGACY_LINKS_ISSUES, type IpcFailure, type IpcRequest } from '@music-bridge/contracts';
import { LegacyLinksError } from '../collection/local-legacy-links-journal.js';
import { asBridgeError } from './errors.js';
import { RecordingPrintError } from '../recording/print-integrity.js';
import { RecordingReplicaError } from '../recording/replica-error.js';
import { AttemptError, AttemptNotAcceptedError } from '../recording/attempt-integrity.js';
import { RecordingRecordError } from '../recording/record-integrity.js';
import { OutputCheckError } from '../recording/output-error.js';
import { DeviceSelectionError } from '../recording/device-selection-broker.js';
import { RecordingPlanError } from '../recording/plan-integrity.js';
import { BackupWorkflowError } from '../recording/backup-workflow-store.js';
import { DatasetScopeError } from '../recording/dataset-identity.js';
import { CollectionError } from '../collection/repository.js';
import { SpreadsheetReadError } from '../collection/spreadsheet-files.js';
import { SpreadsheetParseError } from '../collection/spreadsheet-parser.js';

// 线程内领域异常只在持有原型的所有者处投影；跨线程传递沿用原公开错误合同。
export function responseFailure(
  id: string,
  code: IpcFailure['error']['code'],
  message: string,
): IpcFailure {
  return {
    version: IPC_VERSION,
    id,
    ok: false,
    error: { code, message },
  };
}


export function failureForError(id: string, error: unknown, command: IpcRequest['command']): IpcFailure {
  if (error instanceof LegacyLinksError) {
    const observed = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    const issue = typeof observed === 'string' && (LOCAL_LEGACY_LINKS_ISSUES as readonly string[]).includes(observed) ? observed : 'RECOVERY_REQUIRED';
    const code = issue === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : issue === 'DATASET_SCOPE_MISMATCH' ? 'OUTBOX_SCOPE_MISMATCH'
      : issue === 'RECOVERY_REQUIRED' || issue === 'INVENTORY_UNAVAILABLE' || issue === 'BUDGET_EXCEEDED' ? 'INVENTORY_UNAVAILABLE' : 'INVENTORY_CONFLICT';
    return responseFailure(id, code, `本地旧库关联未获确认。[${issue}]`);
  }
  if (command === 'recordingAttempts.begin' && error instanceof AttemptNotAcceptedError) {
    return responseFailure(id, 'ATTEMPT_NOT_ACCEPTED',
      `正式输出开始已证实未受理，请重新预检并确认。[ATTEMPT_NOT_ACCEPTED] 原因：${error.causeCode}`);
  }
  if (error instanceof DeviceSelectionError) return responseFailure(id,
    error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : error.code === 'CLOSED' || error.code === 'NO_DEVICE_CATALOG' || error.code === 'HELPER_UNAVAILABLE' ? 'NOT_READY' : 'INVENTORY_CONFLICT',
    '输出设备选择未获确认，请重新读取当前候选和代际；不会自动使用默认设备。');
  if (error instanceof RecordingPrintError) {
    const code = error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : error.code === 'CLOSED' ? 'NOT_READY'
      : error.code === 'CONFLICT' || error.code === 'COMMAND_CONFLICT' ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '印刷资料操作未获确认，请核对档案、版本与生成状态；原录音与历史PDF不会改写。');
  }

  if (error instanceof RecordingReplicaError) {
    const code = error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : error.code === 'BACKEND_UNAVAILABLE' ? 'NOT_READY'
      : error.code === 'RUN_CONFLICT' || error.code === 'READ_CONFLICT' ? 'INVENTORY_CONFLICT' : error.code === 'TIMEOUT' ? 'TIMEOUT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '历史音频操作未获确认，请核对原档案与会话；不会自动替换来源或重新播放。');
  }
  if (error instanceof RecordingRecordError) {
    const code = error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST' : error.code === 'NOT_READY' ? 'NOT_READY'
      : error.code === 'CONFLICT' || error.code === 'COMMAND_CONFLICT' ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '档案操作未获确认，请刷新当前实体状态；历史档案不会因此改写。');
  }
  if (error instanceof AttemptError) {
    const code = error.code === 'BACKEND_NOT_CERTIFIED' ? 'NOT_READY' : error.code === 'INVALID_REQUEST' ? 'INVALID_IPC_REQUEST'
      : ['PLAN_CHANGED', 'COPY_UNAVAILABLE', 'ATTEMPT_CONFLICT', 'VERSION_MISMATCH', 'INVALID_TRANSITION', 'COMMAND_CONFLICT'].includes(error.code) ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE';
    return responseFailure(id, code, '录音操作未获确认，请刷新计划与录音状态；未认证后端不能开始正式录音。');
  }
  if (error instanceof OutputCheckError) return responseFailure(id, 'INVENTORY_CONFLICT', error.message);
  if (error instanceof RecordingPlanError) return responseFailure(id, 'INVENTORY_CONFLICT', error.message);
  if (error instanceof DatasetScopeError) return responseFailure(id, error.code, error.message);
  if (error instanceof BackupWorkflowError) return responseFailure(id, error.code === 'BACKUP_CONFLICT' ? 'INVENTORY_CONFLICT' : 'INVENTORY_UNAVAILABLE', error.message);
  if (error instanceof CollectionError) return responseFailure(id, error.code, error.message);
  if (error instanceof SpreadsheetReadError || error instanceof SpreadsheetParseError) return responseFailure(id, 'INVALID_IPC_REQUEST', error.message);
  const bridgeError = asBridgeError(error);
  if (command.startsWith('playback.') && bridgeError.code === 'BAD_REQUEST'
    && bridgeError.details?.reason === 'operation_cancelled') {
    return responseFailure(id, 'CANCELLED', '播放操作已被更新的请求取代。');
  }
  if (bridgeError.code === 'READ_CANCELLED') return responseFailure(id, 'CANCELLED', '读取已取消');
  if (bridgeError.code === 'READ_DEADLINE') return responseFailure(id, 'TIMEOUT', '读取期限已到');
  if (bridgeError.code === 'NETEASE_NOT_CONFIGURED') {
    return responseFailure(id, 'AUTH_REQUIRED', 'Provider login required');
  }
  if (bridgeError.code === 'AUTH_EXPIRED') {
    return responseFailure(id, 'AUTH_EXPIRED', 'Provider session expired');
  }
  if (bridgeError.code === 'ACCOUNT_PROFILE_UNAVAILABLE') {
    return responseFailure(id, 'ACCOUNT_PROFILE_UNAVAILABLE', 'Account profile is temporarily unavailable');
  }
  if (bridgeError.code === 'DAILY_RECOMMENDATIONS_UNAVAILABLE') {
    return responseFailure(id, 'DAILY_RECOMMENDATIONS_UNAVAILABLE', 'Daily recommendations are temporarily unavailable');
  }
  if (bridgeError.code === 'ROON_NOT_PAIRED') {
    return responseFailure(id, 'ROON_CORE_NOT_CONNECTED', 'Roon Core is not connected');
  }
  if (bridgeError.code === 'ROON_TIMEOUT') {
    if (bridgeError.details?.stage === 'post-action-confirmation') {
      const preparationMs = bridgeError.details.preparationMs;
      const confirmationMs = bridgeError.details.confirmationMs;
      const hasTiming = [preparationMs, confirmationMs].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000);
      const timing = hasTiming ? `（命令准备 ${preparationMs}ms，状态确认 ${confirmationMs}ms）` : '';
      return responseFailure(id, 'ROON_TIMEOUT', `未在时限内确认 Roon 新曲状态${timing}。实际声音可能已切换，请勿连续重复点击播放。`);
    }
    return responseFailure(id, 'ROON_TIMEOUT', 'Roon 未确认播放状态，请检查播放设备与远程音频连接。');
  }
  if (bridgeError.code === 'ROON_ZONE_NOT_SELECTED') {
    return responseFailure(id, 'ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected');
  }
  if (bridgeError.code === 'ROON_TRANSPORT_UNAVAILABLE') {
    return responseFailure(id, 'NOT_READY', 'Roon Transport is not ready for this request');
  }
  if (bridgeError.code === 'ROON_LIBRARY_UNAVAILABLE') {
    return responseFailure(id, 'ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not available');
  }
  if (bridgeError.code === 'ROON_LIBRARY_REQUEST_FAILED') {
    return responseFailure(id, 'ROON_LIBRARY_REQUEST_FAILED', 'Roon Library request failed');
  }
  if (bridgeError.code === 'ROON_IMAGE_UNAVAILABLE') {
    return responseFailure(id, 'ROON_IMAGE_UNAVAILABLE', 'Roon image is unavailable');
  }
  if (bridgeError.code === 'ROON_IMAGE_DECODE_FAILED') {
    return responseFailure(id, 'ROON_IMAGE_DECODE_FAILED', 'Roon image decode failed');
  }
  if (bridgeError.code === 'ROON_ALBUM_HIERARCHY_INVALID') {
    return responseFailure(id, 'ROON_ALBUM_HIERARCHY_INVALID', 'Roon album hierarchy is invalid');
  }
  if (bridgeError.code === 'ROON_TRACK_ACTION_UNAVAILABLE') {
    return responseFailure(id, 'ROON_TRACK_ACTION_UNAVAILABLE', 'Roon track action is unavailable');
  }
  if (
    bridgeError.code === 'ROON_LIBRARY_INVALID_REFERENCE' ||
    bridgeError.code === 'ROON_ACTION_BLOCKED' ||
    bridgeError.code === 'BAD_REQUEST'
  ) {
    return responseFailure(id, 'INVALID_IPC_REQUEST', 'Invalid Roon Library request');
  }
  // 保留原公开错误码，只给已知播放失败有界说明；私有消息、URL 与错误栈不跨 IPC。
  if (command.startsWith('playback.')) {
    if (bridgeError.code === 'NETEASE_REQUEST_FAILED' || bridgeError.code === 'STREAM_UPSTREAM_FAILED') {
      return responseFailure(id, 'INTERNAL_ERROR', '音频服务暂时不可用，请重试。');
    }
    if (bridgeError.code === 'ROON_MEDIA_ERROR') return responseFailure(id, 'INTERNAL_ERROR', 'Roon 报告媒体错误，请重试。');
    if (bridgeError.code === 'STREAM_URL_EXPIRED') return responseFailure(id, 'INTERNAL_ERROR', '播放地址已过期，请重试。');
  }
  return responseFailure(id, 'INTERNAL_ERROR', 'Core request failed');
}
