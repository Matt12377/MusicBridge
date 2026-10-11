import type { MobileCodecLimits } from '@music-bridge/contracts';
import { captureMobileContentRequest } from './content-protocol.js';
import {
  captureMobileContentScope, type MobileContentOperation, type MobileContentPort,
  type MobileContentScope, type MobileContentServiceInput, type MobileContentSnapshot,
} from './content-types.js';
import { createMobileContentService } from './content-service.js';
import { MobileServiceError } from './types.js';

export interface MobileContentLyricsOptions {
  /** 必须按原 track/source/version/content 查询；两端口不能互相回退。 */
  local: MobileContentPort;
  provider: MobileContentPort;
  assertCurrent(scope: Readonly<MobileContentScope>): void | Promise<void>;
  limits?: MobileCodecLimits;
  requestMs?: number;
  closeMs?: number;
}

/** 完整歌词的 source 路由；缺失或纯音乐由来源显式给出，故障不转换为空内容。 */
export function createMobileContentLyricsPort(options: MobileContentLyricsOptions): MobileContentPort & { close(): Promise<void> } {
  const rejectOther: MobileContentPort = { async dispatch() { throw new MobileServiceError(400, 'INVALID_REQUEST'); } };
  const route: MobileContentPort = {
    async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>): Promise<MobileContentSnapshot<O>> {
      if (input.operation !== 'getExactTrackLyrics') throw new MobileServiceError(400, 'INVALID_REQUEST');
      const scope = captureMobileContentScope(input.scope);
      const request = captureMobileContentRequest(input.operation, input.request,
        options.limits === undefined ? {} : { limits: options.limits });
      const port = request.query.source === 'local' ? options.local : options.provider;
      return port.dispatch({ ...input, scope, request });
    },
  };
  const service = createMobileContentService({ owner: rejectOther, provider: rejectOther, lyrics: route,
    assertCurrent: options.assertCurrent,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.requestMs === undefined ? {} : { requestMs: options.requestMs }),
    ...(options.closeMs === undefined ? {} : { closeMs: options.closeMs }),
  });
  return {
    async dispatch<O extends MobileContentOperation>(input: MobileContentServiceInput<O>): Promise<MobileContentSnapshot<O>> {
      if (input.operation !== 'getExactTrackLyrics') throw new MobileServiceError(400, 'INVALID_REQUEST');
      return service.dispatch(input);
    },
    close: () => service.close(),
  };
}
