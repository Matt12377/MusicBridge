import {
  encodeMobileJsonReply, isMobileConnectionOrigin,
  type MobileEncodedJsonReply, type MobileReplyMap, type MobileResource,
  type MobileResourceSemanticContext, type MobileWireCodecContext,
} from '@music-bridge/contracts';
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js';
import type { MobilePlaybackControlOperation } from '../../../../packages/bridge-core/src/mobile/playback-types.js';

const busy = (): never => { throw new MobileServiceError(503, 'BUSY'); };

/**
 * Persisted state/history/receipt/ticket authority remains canonical and unique.
 * Only after canonical codec validation may Main project an own media URL to an explicitly owned listener.
 * This is not a client redirect, a new resource, a ticket re-sign, or a replay of the control operation.
 */
export function encodeMobileEndpointPlaybackReply(input: {
  operation: MobilePlaybackControlOperation;
  reply: MobileReplyMap[MobilePlaybackControlOperation];
  context: MobileWireCodecContext;
  requestedOrigin: string;
  allowedOrigins: ReadonlySet<string>;
}): { encoded: MobileEncodedJsonReply; resourceContext?: MobileResourceSemanticContext } {
  const canonical = input.context.responseOrigin, target = input.requestedOrigin;
  if (target !== canonical && !isMobileConnectionOrigin(target)
    || !input.allowedOrigins.has(canonical) || !input.allowedOrigins.has(target)
    || input.context.resource && input.context.resource.responseOrigin !== canonical) return busy();
  const first = encodeMobileJsonReply(input.operation, input.reply, input.context);
  if (!first.ok) return busy();
  if (canonical === target) return { encoded: first.value, ...(input.context.resource ? { resourceContext: input.context.resource } : {}) };
  function project(resource: MobileResource): MobileResource {
    if (resource.state !== 'ready') return resource;
    const url = resource.media.url;
    if (!url.startsWith(canonical + '/mobile/v1/media/') || new URL(url).origin !== canonical) return busy();
    return { ...resource, media: { ...resource.media, url: target + url.slice(canonical.length) } };
  }
  try {
    // Use the validated bytes, not a second read of the caller's mutable object.
    let body = first.value.body.byteLength ? JSON.parse(Buffer.from(first.value.body).toString('utf8')) as MobileReplyMap[MobilePlaybackControlOperation]['body'] : null;
    const resourceContext = input.context.resource ? structuredClone(input.context.resource) : undefined;
    if (resourceContext) {
      resourceContext.responseOrigin = target;
      if (resourceContext.previousResource) resourceContext.previousResource = project(resourceContext.previousResource);
    }
    if (input.reply.category === 'success' && ['createResource', 'getResource', 'renewResource'].includes(input.operation)) {
      body = project(body as MobileResource);
    }
    // The operation/body relation was proved above and is checked again after the one permitted transformation.
    const projectedReply = { ...input.reply, body } as MobileReplyMap[MobilePlaybackControlOperation];
    const second = encodeMobileJsonReply(input.operation, projectedReply, { ...input.context, responseOrigin: target,
      ...(resourceContext ? { resource: resourceContext } : {}) });
    if (!second.ok) return busy();
    return { encoded: second.value, ...(resourceContext ? { resourceContext } : {}) };
  } catch { return busy(); }
}
