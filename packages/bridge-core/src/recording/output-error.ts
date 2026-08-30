export type OutputCheckFailure =
  | 'INVALID_REQUEST' | 'RUN_CONFLICT' | 'RUN_LIMIT' | 'CANCELLED' | 'CLOSED'
  | 'PLAN_UNAVAILABLE' | 'PLAN_CHANGED' | 'INPUT_UNAVAILABLE' | 'INPUT_CHANGED'
  | 'EMPTY_SIDE' | 'FORMAT_MISMATCH' | 'FRAME_MISMATCH'
  | 'HELPER_UNAVAILABLE' | 'HELPER_CHANGED' | 'HELPER_PROTOCOL' | 'TIMEOUT' | 'DEVICE_NOT_AUTHORIZED';

/** 公开边界只保留有界原因；不能拼接底层路径、stderr或异常堆栈。 */
export class OutputCheckError extends Error {
  constructor(readonly code: OutputCheckFailure) { super(`无设备输出检查未完成，已有计划与音频保留。 [${code}]`); }
}
export const outputCheckFail = (code: OutputCheckFailure): never => { throw new OutputCheckError(code); };
