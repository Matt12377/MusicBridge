import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeMobileJsonReply, decodeMobileResponse, type MobileResource, type MobileReplyMap } from '@music-bridge/contracts';
import { fixtureJson, loadMobileFixtures, responseContext } from '../../../packages/contracts/test/mbm000/fixture-helpers.js';
import { MobileServiceError } from '../../../packages/bridge-core/src/mobile/types.js';
import type { MobilePlaybackControlOperation } from '../../../packages/bridge-core/src/mobile/playback-types.js';
import { encodeMobileEndpointPlaybackReply } from '../src/main/mobile-endpoint-projection.js';

const fixtures = loadMobileFixtures(), tail = 'https://100.100.100.10:45391';
function sample(id = 'createResource--success-201') {
  const row = fixtures.cases.find(value => value.id === id); assert.ok(row);
  const operation = row.operationId as MobilePlaybackControlOperation;
  const context = structuredClone(responseContext(fixtures, row)); assert.ok(context.resource);
  const body = fixtureJson<MobileResource>(row.response.body);
  // A detached derivative of the frozen DNS fixture, never a rewrite of the canonical fixture itself.
  const originalOrigin = context.responseOrigin, canonical = 'https://192.168.20.2:45391';
  const adapt = (resource: MobileResource) => {
    if (resource.state === 'ready') {
      assert.ok(resource.media.url.startsWith(originalOrigin + '/mobile/v1/media/'));
      resource.media.url = canonical + resource.media.url.slice(originalOrigin.length);
    }
  };
  adapt(body); if (context.resource.previousResource) adapt(context.resource.previousResource);
  context.responseOrigin = canonical; context.resource.responseOrigin = canonical;
  const reply: MobileReplyMap[MobilePlaybackControlOperation] = { status: row.response.status, category: 'success', body };
  return { operation, context, reply, requestedOrigin: tail, allowedOrigins: new Set([context.responseOrigin, tail]) };
}
const busy = (error: unknown) => error instanceof MobileServiceError && error.status === 503;

test('endpoint primary fast path remains byte-identical to the existing resource encoder', () => {
  const input = sample(); input.requestedOrigin = input.context.responseOrigin;
  const baseline = encodeMobileJsonReply(input.operation, input.reply, input.context); assert.ok(baseline.ok);
  const result = encodeMobileEndpointPlaybackReply(input);
  assert.deepEqual(result.encoded, baseline.value);
});

test('endpoint projection changes only the validated own media origin, preserving ticket, resource identity and canonical history', () => {
  const input = sample(), before = JSON.stringify({ reply: input.reply, context: input.context });
  const original = input.reply.body as MobileResource; assert.equal(original.state, 'ready');
  if (original.state !== 'ready') return;
  const result = encodeMobileEndpointPlaybackReply(input), body = JSON.parse(Buffer.from(result.encoded.body).toString()) as MobileResource;
  assert.equal(body.state, 'ready'); if (body.state !== 'ready') return;
  assert.equal(new URL(body.media.url).origin, tail);
  assert.equal(body.media.url.slice(tail.length), original.media.url.slice(input.context.responseOrigin.length));
  assert.equal(body.id, original.id); assert.equal(body.sessionId, original.sessionId);
  assert.equal(new URL(body.media.url).search, new URL(original.media.url).search);
  assert.equal(result.resourceContext?.responseOrigin, tail);
  assert.deepEqual(result.resourceContext?.scope, input.context.resource?.scope);
  assert.equal(JSON.stringify({ reply: input.reply, context: input.context }), before);
  const context = { ...input.context, responseOrigin: tail, resource: result.resourceContext };
  assert.equal(decodeMobileResponse(input.operation, { ...result.encoded, finalUrl: tail + context.requestPath }, context).ok, true);
  assert.equal(decodeMobileResponse(input.operation, { ...result.encoded, finalUrl: input.context.responseOrigin + context.requestPath }, input.context).ok, false);
});

test('endpoint projection rejects any origin not explicitly owned by the active listener set', () => {
  for (const requestedOrigin of ['https://8.8.8.8:45391', 'https://100.100.100.12:45391', 'https://example.ts.net:45391']) {
    assert.throws(() => encodeMobileEndpointPlaybackReply({ ...sample(), requestedOrigin }), busy);
  }
  const input = sample(); input.allowedOrigins.delete(input.context.responseOrigin);
  assert.throws(() => encodeMobileEndpointPlaybackReply(input), busy);
});

test('endpoint projection validates canonical media before projection instead of laundering foreign or mismatched URLs', () => {
  for (const url of ['https://8.8.8.8:45391/mobile/v1/media/resource.fixture.1/asset?ticket=x', tail + '/mobile/v1/media/resource.fixture.1/asset?ticket=x']) {
    const input = sample(), resource = input.reply.body as MobileResource; assert.equal(resource.state, 'ready');
    if (resource.state === 'ready') resource.media.url = url;
    assert.throws(() => encodeMobileEndpointPlaybackReply(input), busy);
  }
});

test('endpoint projection retains preparing 202 exactly without manufacturing a ready resource or new command', () => {
  const input = sample('createResource--success-202'), before = JSON.stringify(input.reply.body);
  const result = encodeMobileEndpointPlaybackReply(input), body = JSON.parse(Buffer.from(result.encoded.body).toString());
  assert.equal(result.encoded.status, 202); assert.equal(body.state, 'preparing'); assert.equal(Object.hasOwn(body, 'media'), false);
  assert.equal(JSON.stringify(input.reply.body), before);
});

test('endpoint renewal projection also binds the previous resource to the same alias without changing continuity facts', () => {
  const input = sample('renewResource--success-200'), before = JSON.stringify(input.context);
  const result = encodeMobileEndpointPlaybackReply(input);
  const context = { ...input.context, responseOrigin: tail, resource: result.resourceContext };
  assert.equal(decodeMobileResponse(input.operation, { ...result.encoded, finalUrl: tail + context.requestPath }, context).ok, true);
  assert.equal(JSON.stringify(input.context), before);
  const previous = result.resourceContext?.previousResource;
  if (previous?.state === 'ready') assert.equal(new URL(previous.media.url).origin, tail);
});
