import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createMobileNeteaseHttpStreams, type MobileNeteaseHttpSource } from '../../src/netease/mobile-http-stream.js';
import type { MobileNeteaseScope } from '../../src/mobile/netease-source-types.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { closeMobileCapabilityContext, createMobileCapabilityContext, createMobileCapabilityTraceReader,
  copyMobileCapabilityTraceRecord, MOBILE_CAPABILITY_STAGES, withMobileCapabilityContext, type MobileCapabilityTraceRecord } from '../../src/mobile/capability-trace.js';
import type { GatewayFetch } from '../../src/stream/upstream-policy.js';

const scope: MobileNeteaseScope = { serverId: 'server-1', datasetId: 'dataset-1', deviceId: 'device-1',
  deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner-1', accountDomain: 'account-1', providerEpoch: 'provider-1' };
const reasons = ['non206', 'body-missing', 'etag-missing', 'etag-weak', 'etag-invalid',
  'redirect-location-missing', 'redirect-limit', 'redirect-policy', 'parser'] as const;
type Reason = typeof reasons[number];
const denied = (error: unknown) => error instanceof MobileServiceError && error.status === 409 && error.code === 'UNSUPPORTED_FORMAT';
function fixture(t: TestContext, enabled: boolean | 'default' = true) {
  const data = Buffer.alloc(4096); data.write('fLaC'); data[4] = 0x80; data.writeUIntBE(34, 5, 3);
  data.writeUInt16BE(4096, 8); data.writeUInt16BE(4096, 10);
  data.writeBigUInt64BE(192000n << 44n | 1n << 41n | 23n << 36n | 192000n, 18);
  let mode: Reason | 'valid' | 'bad-cancel' | 'source-changed' | 'date-200' | 'date-412' = 'valid', requests = 0, cancels = 0;
  let customEtag: string | undefined, dateHeaderReads = 0, bodyReads = 0, failDateReadsAfter: number | undefined;
  const requestHeaders: Headers[] = [];
  let dates: { modified: string | null; date: string | null } | null = null;
  const source: MobileNeteaseHttpSource = { account: { accountDomain: scope.accountDomain, providerEpoch: scope.providerEpoch! },
    sourceIdentity: 'private-source-identity', size: data.length, expiresAtMs: 1700000300000,
    upstreamUrl: 'https://music-source.invalid/private-audio?token=synthetic-private-token',
    requestHeaders: { 'Accept-Encoding': 'identity', 'User-Agent': 'synthetic-private-agent' } };
  const fetcher: GatewayFetch = async (_url, init) => {
    requests++; requestHeaders.push(new Headers(init.headers)); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    const range = new Headers(init.headers).get('range'), match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range ?? ''); assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]), body = Uint8Array.from(data.subarray(start, end + 1));
    if (mode === 'parser') body.fill(0);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); }, pull(c) { c.close(); },
      cancel() { cancels++; if (mode === 'bad-cancel') throw new Error('synthetic-private-cancel https://sensitive.invalid/'); } });
    if (mode.startsWith('redirect-')) return new Response(stream, { status: 302,
      headers: mode === 'redirect-location-missing' ? {} : { location: mode === 'redirect-policy' ? 'http://unsafe.invalid/private' : '/next-private-audio' } });
    const etag = customEtag ?? (mode === 'etag-weak' ? 'W/"synthetic-private-etag"' : mode === 'etag-invalid' ? 'synthetic-private-unquoted-etag' : '"fixed-source-1"');
    const response = new Response(mode === 'body-missing' ? null : stream, { status: mode === 'date-412' ? 412 : mode === 'non206' || mode === 'bad-cancel' || mode === 'date-200' ? 200 : 206,
      headers: { 'content-range': mode === 'source-changed' ? 'bytes 0-0/1' : `bytes ${start}-${end}/${data.length}`,
        ...(dates?.modified === null || !dates ? {} : { 'last-modified': dates.modified }),
        ...(dates?.date === null || !dates ? {} : { date: dates.date }),
        'content-length': String(body.length), ...(mode === 'etag-missing' ? {} : { etag: /[^\x00-\xff]/u.test(etag) ? 'synthetic-header-placeholder' : etag }) } });
    const get = response.headers.get.bind(response.headers);
    response.headers.get = name => {
      if (name.toLowerCase() === 'date' || name.toLowerCase() === 'last-modified') {
        dateHeaderReads++; if (failDateReadsAfter !== undefined && dateHeaderReads > failDateReadsAfter) throw new Error('synthetic-private-date-access');
      }
      return name.toLowerCase() === 'etag' && /[^\x00-\xff]/u.test(etag) ? etag : get(name);
    };
    if (response.body) {
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (() => {
        const reader = getReader(), read = reader.read.bind(reader);
        reader.read = () => { bodyReads++; return read(); }; return reader;
      }) as typeof response.body.getReader;
    }
    return response;
  };
  const manager = createMobileNeteaseHttpStreams({ fetch: fetcher, now: () => 1700000000000,
    ...(enabled === 'default' ? {} : { privateDiagnostics: enabled }),
    async assertCurrent() {}, async refresh() { return source; } });
  t.after(async () => { if (manager.snapshot().fatal) await assert.rejects(manager.close()); else await manager.close(); });
  const probe = () => manager.probe(scope, source, new AbortController().signal);
  return { manager, probe, mode(value: typeof mode) { mode = value; }, etag(value: string) { customEtag = value; },
    dates(modified: string | null, date: string | null) { dates = { modified, date }; }, source,
    failDateReads(after = 0) { failDateReadsAfter = after; }, requestHeaders,
    requests: () => requests, cancels: () => cancels, dateHeaderReads: () => dateHeaderReads, bodyReads: () => bodyReads };
}
function context() {
  const lines: string[] = [], rows: MobileCapabilityTraceRecord[] = [], reader = createMobileCapabilityTraceReader(row => { rows.push(row); });
  const value = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, line => { lines.push(line); reader(line); });
  assert.ok(value); return { value, rows, lines };
}

for (const reason of reasons) test(`受控 HTTP 拒绝 ${reason} 只记录固定原因，保留原 409 与真实关闭`, async t => {
  const f = fixture(t), c = context(); f.mode(reason);
  try { await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); }
  finally { closeMobileCapabilityContext(c.value); }
  assert.equal(c.rows.length, 1); const row = c.rows[0]!;
  assert.equal(row.stage, `provider.audio-probe.reject.${reason === 'etag-invalid' ? 'etag-date.missing' : reason}`);
  assert.equal(row.phase, 'reject'); assert.equal(row.code, 'UNSUPPORTED_FORMAT');
  assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  assert.equal(f.manager.qualified, true); assert.equal(f.requests(), reason === 'redirect-limit' ? 6 : reason === 'parser' ? 2 : 1);
  if (reason !== 'body-missing' && reason !== 'parser') assert.ok(f.cancels() > 0);
  assert.doesNotMatch(c.lines.join(''), /https?:|token|private-audio|private-source|private-agent|private-etag|headers|stack|message|raw/u);
});

test('HTTP 首拒按每个请求 context 独立；同一请求重复探测不重复，后续请求仍可诊断', async t => {
  const f = fixture(t), first = context(), second = context();
  await withMobileCapabilityContext(first.value, async () => {
    f.mode('non206'); await assert.rejects(f.probe(), denied);
    f.mode('etag-weak'); await assert.rejects(f.probe(), denied);
  });
  await withMobileCapabilityContext(second.value, async () => { f.mode('etag-missing'); await assert.rejects(f.probe(), denied); });
  closeMobileCapabilityContext(first.value); closeMobileCapabilityContext(second.value);
  assert.deepEqual(first.rows.map(r => r.stage), ['provider.audio-probe.reject.non206']);
  assert.deepEqual(second.rows.map(r => r.stage), ['provider.audio-probe.reject.etag-missing']);
  assert.notEqual(first.rows[0]!.requestSha256, second.rows[0]!.requestSha256);
});

test('默认关闭和显式关闭均不新增 HTTP 原因，未绑定或已关闭 context 不记录', async t => {
  for (const enabled of ['default', false] as const) {
    const f = fixture(t, enabled), c = context(); f.mode('non206');
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.lines.length, 0);
  }
  const f = fixture(t), c = context(); f.mode('etag-missing');
  await assert.rejects(f.probe(), denied); closeMobileCapabilityContext(c.value);
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); assert.equal(c.lines.length, 0);
});

test('诊断不替代真实清理失败：取消拒绝仍置 fatal BUSY；SOURCE_CHANGED 不误记格式原因', async t => {
  const f = fixture(t), c = context(); f.mode('bad-cancel');
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), error => error instanceof MobileServiceError && error.code === 'BUSY' && error.status === 503));
  closeMobileCapabilityContext(c.value); assert.equal(f.manager.qualified, false); assert.equal(f.manager.snapshot().fatal, true);
  assert.deepEqual(c.rows.map(r => r.stage), ['provider.audio-probe.reject.non206']);
  const changed = fixture(t), next = context(); changed.mode('source-changed');
  await withMobileCapabilityContext(next.value, () => assert.rejects(changed.probe(), error => error instanceof MobileServiceError && error.code === 'SOURCE_CHANGED'));
  closeMobileCapabilityContext(next.value); assert.equal(next.lines.length, 0);
});

test('成功的真实字节探测不产生拒绝原因，旁注 sink 失败也不替换原拒绝或重演 HTTP', async t => {
  const f = fixture(t), c = context();
  const facts = await withMobileCapabilityContext(c.value, f.probe); closeMobileCapabilityContext(c.value);
  assert.deepEqual(facts.audio, { codec: 'flac', container: 'flac', sampleRateHz: 192000, bitsPerSample: 24, channels: 2 }); assert.equal(c.lines.length, 0);
  const failed = fixture(t); failed.mode('etag-weak');
  const next = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, () => { throw new Error('synthetic-private-sink'); }); assert.ok(next);
  await withMobileCapabilityContext(next, () => assert.rejects(failed.probe(), denied)); closeMobileCapabilityContext(next); assert.equal(failed.requests(), 1);
});

for (const [shape, tag] of [['bare32hex', 'a'.repeat(32)], ['overlimit', '"' + 'x'.repeat(255) + '"'],
  ['malformedquoted', '"synthetic-private-unclosed'], ['malformedquoted', '"synthetic private tag"'],
  ['malformedquoted', '"synthetic-private-\u0100"'], ['unquotedother', 'synthetic-private-unquoted']] as const) {
  test(`R10_ETAG HTTP私有首拒只给闭集${shape}，不输出头值且真实关闭`, async t => {
    const f = fixture(t), c = context(); f.etag(tag);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.rows.length, 1); const row = c.rows[0]!;
    assert.equal(row.stage, `provider.audio-probe.reject.${shape === 'unquotedother' ? 'etag-date.missing' : `etag-invalid.${shape}`}`);
    assert.equal(row.phase, 'reject'); assert.equal(row.code, 'UNSUPPORTED_FORMAT'); assert.equal(Object.keys(row).length, 15);
    assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1); assert.equal(f.manager.snapshot().pending, 0);
    assert.doesNotMatch(c.lines.join(''), /https?:|token|synthetic|private-audio|private-source|headers|stack|message|raw/u);
  });
}

test('R10_ETAG 合法空opaque-tag成功时不产生拒绝原因', async t => {
  const f = fixture(t), c = context(); f.etag('""');
  const facts = await withMobileCapabilityContext(c.value, f.probe); closeMobileCapabilityContext(c.value);
  assert.equal(facts.audio.codec, 'flac'); assert.equal(c.rows.length, 0);
  assert.equal(f.manager.snapshot().probes, 0); assert.equal(f.manager.snapshot().pending, 0);
});

test('R10_ETAG 新形态分类默认关闭，显式关闭也不创建诊断', async t => {
  for (const enabled of ['default', false] as const) {
    const f = fixture(t, enabled), c = context(); f.etag('a'.repeat(32));
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.lines.length, 0); assert.equal(f.requests(), 1); assert.equal(f.manager.snapshot().pending, 0);
  }
});

const dateNow = new Date(1700000000000).toUTCString(), dateModified = new Date(1699999880000).toUTCString();
test('R11_DATE 私有日期资格拒绝只给有限原因且不泄漏日期/裸标记，默认关闭保持', async t => {
  const cases: [string, string | null, string | null, string?][] = [
    ['missing', null, dateNow], ['invalid', dateModified.replace('Tue', 'Mon'), dateNow],
    ['future', dateModified, new Date(1700000001000).toUTCString()],
    ['not-strong', new Date(1699999941000).toUTCString(), dateNow], ['shape', dateModified, dateNow, 'synthetic,combined'],
  ];
  for (const [reason, modified, date, tag] of cases) await t.test(reason, async child => {
    const f = fixture(child), c = context(); f.etag(tag ?? 'synthetic-private-unquoted'); f.dates(modified, date);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.rows.length, 1); assert.equal(c.rows[0]!.stage, `provider.audio-probe.reject.etag-date.${reason === 'invalid' ? 'invalid.last-modified.valid.imf-weekday' : reason}`);
    assert.equal(Object.keys(c.rows[0]!).length, 15); assert.equal(c.rows[0]!.code, 'UNSUPPORTED_FORMAT');
    assert.equal(f.requests(), 2); assert.equal(f.cancels(), 2); assert.equal(f.manager.snapshot().pending, 0);
    assert.doesNotMatch(c.lines.join(''), /GMT|Tue|Mon|\b2023\b|synthetic|https?:|token|private-audio|private-source|headers|stack|message/u);
  });
  for (const enabled of ['default', false] as const) {
    const f = fixture(t, enabled), c = context(); f.etag('synthetic-private-unquoted'); f.dates(null, dateNow);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.lines.length, 0); assert.equal(f.requests(), 1);
  }
});

test('R11_DATE 成功日期探测不新增拒绝；实际条件失败与validator变化保留SOURCE_CHANGED的闭集首拒', async t => {
  for (const mode of ['date-200', 'date-412', 'changed'] as const) await t.test(mode, async child => {
    const f = fixture(child), initial = context(); f.etag('synthetic-private-unquoted'); f.dates(dateModified, dateNow);
    const { lease } = await withMobileCapabilityContext(initial.value, () => f.manager.openFromSource(scope, f.source,
      { trackId: 'track-1', source: 'netease', versionId: 'version-1', contentRevision: 'content-1' }, new AbortController().signal));
    closeMobileCapabilityContext(initial.value); assert.equal(initial.lines.length, 0);
    if (mode === 'changed') f.etag('synthetic-private-changed'); else f.mode(mode);
    const rejected = context(); await withMobileCapabilityContext(rejected.value, () => assert.rejects(lease.verify(new AbortController().signal),
      value => value instanceof MobileServiceError && value.status === 409 && value.code === 'SOURCE_CHANGED'));
    closeMobileCapabilityContext(rejected.value); assert.equal(rejected.rows.length, 1);
    assert.equal(rejected.rows[0]!.stage, `provider.audio-probe.reject.etag-date.${mode === 'changed' ? 'changed' : 'conditional'}`);
    assert.equal(rejected.rows[0]!.code, 'SOURCE_CHANGED'); assert.equal(f.cancels(), 1); await lease.release();
    assert.equal(f.manager.snapshot().pending, 0);
    assert.doesNotMatch(rejected.lines.join(''), /GMT|Tue|\b2023\b|synthetic|https?:|token|private-audio|headers|stack|message/u);
  });
});

// 这里只给合成形态命名；日期原值、裸标记及其摘要都不得进入诊断。
const dateShapes = {
  valid: dateNow,
  'imf-shape': 'Tue, 14 Nov 2023 22:13:20 UTC',
  'imf-parse': 'Tue, 14 Nov 2023 99:13:20 GMT',
  'imf-negative': 'Wed, 31 Dec 1969 23:59:59 GMT',
  'imf-weekday': 'Mon, 14 Nov 2023 22:13:20 GMT',
  'imf-roundtrip': 'Fri, 31 Feb 2023 12:00:00 GMT',
  obsolete: 'Tuesday, 14-Nov-23 22:13:20 GMT',
  iso: '2023-11-14T22:13:20Z',
  combined: `${dateNow}, ${dateModified}`,
  other: 'synthetic-private-date-unrecognized',
} as const;
type DateShape = keyof typeof dateShapes;
const dateClasses = Object.keys(dateShapes) as DateShape[];
const expectedDateStage = (date: DateShape, modified: DateShape) =>
  `provider.audio-probe.reject.etag-date.invalid.${date === 'valid' ? 'last-modified' : modified === 'valid' ? 'date' : 'both'}.${date}.${modified}`;

test('R12_DATE_DIAGNOSTICS 九十九种字段/形态组合都由真实原拒绝闭合且只含十五字段', async t => {
  let cases = 0;
  for (const date of dateClasses) for (const modified of dateClasses) {
    if (date === 'valid' && modified === 'valid') continue;
    await t.test(`${date}/${modified}`, async child => {
      cases++; const f = fixture(child), c = context(); f.etag('synthetic-private-unquoted');
      f.dates(modified === 'valid' ? dateModified : dateShapes[modified], dateShapes[date]);
      await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
      assert.equal(c.rows.length, 1); assert.equal(c.rows[0]!.stage, expectedDateStage(date, modified));
      assert.equal(c.rows[0]!.code, 'UNSUPPORTED_FORMAT'); assert.equal(c.rows[0]!.phase, 'reject');
      assert.equal(Object.keys(c.rows[0]!).length, 15); assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1);
      assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
      assert.doesNotMatch(c.lines.join(''), /GMT|Tue|Mon|Wed|Fri|\b(?:2023|1969)\b|synthetic|https?:|token|private-audio|private-source|headers|stack|message/u);
    });
  }
  assert.equal(cases, 99);
});

test('R12_DATE_DIAGNOSTICS 分类顺序只识别有限形态；超界及不属于IMF结构的字符串归other', async t => {
  const variants: [DateShape, string][] = [
    ['obsolete', 'Tue Nov 14 22:13:20 2023'],
    ['iso', '2023-11-14T22:13:20.123+00:00'],
    ['iso', '2023-11-14'],
    ['combined', 'Tuesday, 14-Nov-23 22:13:20 GMT, Tue Nov 14 22:13:20 2023'],
    ['combined', '2023-11-14T22:13:20Z, 2023-11-14T22:11:20Z'],
    ['imf-shape', 'Tue, 4 Nov 2023 22:13:20 GMT'],
    ['imf-shape', 'Tue, 14 Xxx 2023 22:13:20 GMT'],
    ['imf-shape', 'Xxx, 14 Nov 2023 22:13:20 GMT'],
    ['other', 'Fri, synthetic-private-date'],
    ['other', `${dateNow}, synthetic-private-date`],
    ['other', 'x'.repeat(513)],
    ['other', `${dateNow}${'x'.repeat(512)}`],
  ];
  for (const [expected, value] of variants) await t.test(`${expected}/${variants.findIndex(row => row[1] === value)}`, async child => {
    const f = fixture(child), c = context(); f.etag('synthetic-private-unquoted'); f.dates(dateModified, value);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.rows[0]!.stage, expectedDateStage(expected, 'valid')); assert.equal(f.cancels(), 1); assert.equal(f.requests(), 1);
    assert.doesNotMatch(c.lines.join(''), /GMT|Tue|Nov|\b2023\b|synthetic|private|https?:|token|headers|stack|message/u);
  });
});

test('R12_DATE_DIAGNOSTICS 只有原invalid且可信private及活动context才读诊断日期，首拒仅一次', async t => {
  for (const enabled of ['default', false, true] as const) await t.test(String(enabled), async child => {
    const f = fixture(child, enabled), c = context(); f.etag('synthetic-private-unquoted'); f.dates(dateModified, dateShapes.other);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
    assert.equal(f.dateHeaderReads(), enabled === true ? 4 : 2);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(f.dateHeaderReads(), enabled === true ? 6 : 4); assert.equal(c.rows.length, enabled === true ? 1 : 0);
    assert.equal(f.requests(), 2); assert.equal(f.cancels(), 2);
  });
  const f = fixture(t), c = context(); f.etag('synthetic-private-unquoted'); f.dates(dateModified, dateShapes.other);
  await assert.rejects(f.probe(), denied); closeMobileCapabilityContext(c.value);
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
  assert.equal(f.dateHeaderReads(), 4); assert.equal(c.lines.length, 0);
  const strong = fixture(t), active = context(); strong.dates(dateShapes.other, dateShapes.other);
  await withMobileCapabilityContext(active.value, strong.probe); closeMobileCapabilityContext(active.value);
  assert.equal(strong.dateHeaderReads(), 0); assert.equal(active.rows.length, 0);
});

test('R12_DATE_DIAGNOSTICS 新白名单恰99日期组合及32magic形态，错误归属和valid/valid拒收', async t => {
  const expected = dateClasses.flatMap(date => dateClasses.filter(modified => date !== 'valid' || modified !== 'valid')
    .map(modified => expectedDateStage(date, modified)));
  const actual = MOBILE_CAPABILITY_STAGES.filter(stage => stage.startsWith('provider.audio-probe.reject.etag-date.invalid.'));
  assert.equal(new Set(actual).size, 99); assert.deepEqual([...actual].sort(), expected.sort());
  const magic = MOBILE_CAPABILITY_STAGES.filter(stage => stage.startsWith('provider.artwork.download.magic.'));
  assert.equal(magic.length, 32); assert.equal(new Set(magic).size, 32);
  const f = fixture(t), c = context(); f.etag('synthetic-private-unquoted'); f.dates(dateModified, dateShapes.other);
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
  const row = c.rows[0]!;
  for (const stage of ['provider.audio-probe.reject.etag-date.invalid.both.valid.valid',
    'provider.audio-probe.reject.etag-date.invalid.both.other.valid', 'provider.audio-probe.reject.etag-date.invalid.date.other.other',
    'provider.audio-probe.reject.etag-date.invalid.date.synthetic-private-date.valid']) assert.equal(copyMobileCapabilityTraceRecord({ ...row, stage }), null);
  assert.equal(copyMobileCapabilityTraceRecord({ ...row, rawDate: dateShapes.other }), null);
});

const validatorDiagnosticPrefix = 'provider.audio-probe.validator.';
for (const [shape, tag, digest, relation] of [
  ['bare32hex', 'a'.repeat(32), 'A'.repeat(32), 'equal'],
  ['bare32hex', 'a'.repeat(32), 'b'.repeat(32), 'mismatch'],
  ['bare32hex', 'a'.repeat(32), undefined, 'not-comparable'],
  ['unquotedother', 'synthetic-private-unquoted', 'a'.repeat(32), 'not-comparable'],
] as const) {
  test(`R13_ETAG_RELATION ${shape}/${relation} 诊断摘要不授予正式准入，原拒绝与quiet保留`, async t => {
    const f = fixture(t), c = context(); c.value.privateContentDiagnostic = true;
    f.etag(tag); f.dates(dateShapes.other, dateNow);
    if (digest !== undefined) Object.assign(f.source, { diagnosticMediaMd5: digest });
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
    closeMobileCapabilityContext(c.value);
    assert.deepEqual(c.rows.map(row => row.stage), [
      shape === 'bare32hex' ? 'provider.audio-probe.reject.etag-invalid.bare32hex' : 'provider.audio-probe.reject.etag-date.invalid.last-modified.valid.other',
      `${validatorDiagnosticPrefix}${shape}.${relation}`,
    ]);
    const [rejected, note] = c.rows; assert.ok(rejected && note);
    assert.equal(rejected.phase, 'reject'); assert.equal(rejected.code, 'UNSUPPORTED_FORMAT');
    assert.equal(note.phase, 'cache'); assert.equal(note.code, 'OK'); assert.equal(note.initState, 'none');
    assert.equal(note.relatedSha256, null); assert.equal(note.requestSha256, rejected.requestSha256);
    assert.equal(Object.keys(note).length, 15); assert.equal(c.value.firstBusiness, true);
    assert.equal(f.requests(), 2); assert.equal(f.cancels(), 2);
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
    assert.doesNotMatch(c.lines.join(''), /GMT|synthetic|https?:|token|private-audio|private-source|headers|message|stack/u);
    if (digest !== undefined) assert.equal(c.lines.join('').includes(digest), false);
    assert.equal(c.lines.join('').includes(tag), false);
  });
}

test('R13_ETAG_RELATION 默认关闭、无可信私有context、已关闭context均不新增关联，合法强标签仍成功', async t => {
  for (const enabled of ['default', false, true] as const) await t.test(String(enabled), async child => {
    const f = fixture(child, enabled), c = context();
    if (enabled !== true) c.value.privateContentDiagnostic = true;
    Object.assign(f.source, { diagnosticMediaMd5: 'a'.repeat(32) });
    f.etag('a'.repeat(32)); f.dates(dateShapes.other, dateNow);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.rows.some(row => row.stage.startsWith(validatorDiagnosticPrefix)), false);
    assert.equal(c.rows.length, enabled === true ? 1 : 0); assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1);
  });
  const closed = fixture(t), closedContext = context(); closedContext.value.privateContentDiagnostic = true;
  Object.assign(closed.source, { diagnosticMediaMd5: 'a'.repeat(32) });
  closed.etag('a'.repeat(32)); closed.dates(dateShapes.other, dateNow); closeMobileCapabilityContext(closedContext.value);
  await withMobileCapabilityContext(closedContext.value, () => assert.rejects(closed.probe(), denied)); assert.equal(closedContext.lines.length, 0);
  const strong = fixture(t), active = context(); active.value.privateContentDiagnostic = true;
  Object.assign(strong.source, { diagnosticMediaMd5: 'b'.repeat(32) });
  const facts = await withMobileCapabilityContext(active.value, strong.probe); closeMobileCapabilityContext(active.value);
  assert.equal(facts.audio.codec, 'flac'); assert.equal(active.rows.length, 0);
  const baseline = fixture(t), plainContext = context(); plainContext.value.privateContentDiagnostic = true;
  const original = await withMobileCapabilityContext(plainContext.value, baseline.probe); closeMobileCapabilityContext(plainContext.value);
  assert.deepEqual(facts.audio, original.audio); assert.equal(strong.requests(), baseline.requests()); assert.equal(strong.dateHeaderReads(), 0);
});

test('R13_ETAG_RELATION 旁注服从原64槽和首拒预留，sink失败也不重演请求或改变真实quiet', async t => {
  const limited = fixture(t), c = context(); c.value.privateContentDiagnostic = true; c.value.records = 60;
  limited.etag('a'.repeat(32)); limited.dates(dateShapes.other, dateNow);
  await withMobileCapabilityContext(c.value, () => assert.rejects(limited.probe(), denied)); closeMobileCapabilityContext(c.value);
  assert.deepEqual(c.rows.map(row => row.stage), ['provider.audio-probe.reject.etag-invalid.bare32hex']);
  assert.equal(c.value.records, 61); assert.equal(limited.requests(), 1); assert.equal(limited.cancels(), 1);
  const f = fixture(t), failedSink = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, () => { throw new Error('synthetic-private-sink'); });
  assert.ok(failedSink); failedSink.privateContentDiagnostic = true; f.etag('a'.repeat(32)); f.dates(dateShapes.other, dateNow);
  await withMobileCapabilityContext(failedSink, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(failedSink);
  assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1);
  assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
});

test('R13_ETAG_RELATION 只允许四个闭集stage，未知形态、摘要值和附加字段均拒收', () => {
  const expected = ['bare32hex.equal', 'bare32hex.mismatch', 'bare32hex.not-comparable', 'unquotedother.not-comparable']
    .map(value => `${validatorDiagnosticPrefix}${value}`);
  assert.deepEqual(MOBILE_CAPABILITY_STAGES.filter(stage => stage.startsWith(validatorDiagnosticPrefix)).sort(), expected.sort());
  const row = { schema: 'mb.mobile-capability-trace.v1', component: 'core', requestSha256: 'a'.repeat(64), parentSha256: null,
    relatedSha256: null, epochMs: 1700000000000, elapsedMs: 1, stage: expected[0], phase: 'cache', role: 'business',
    name: 'UNKNOWN', code: 'OK', outcome: null, aborted: false, initState: 'none' };
  assert.ok(copyMobileCapabilityTraceRecord(row));
  for (const suffix of ['bare32hex.unknown', 'unquotedother.equal', 'unknown.equal', `bare32hex.${'a'.repeat(32)}`]) {
    assert.equal(copyMobileCapabilityTraceRecord({ ...row, stage: validatorDiagnosticPrefix + suffix }), null);
  }
  assert.equal(copyMobileCapabilityTraceRecord({ ...row, md5: 'a'.repeat(32) }), null);
});

const unquotedDiagnosticPrefix = 'provider.audio-probe.reject.etag-invalid.unquotedother.';
const multipartTag = `${'a'.repeat(32)}-2`;
test('R15_ETAG_BRANCH 已锁定强标签后变裸值只细分首拒，不能借日期降级或读取body', async t => {
  const f = fixture(t), c = context();
  const { lease } = await f.manager.openFromSource(scope, f.source,
    { trackId: 'track-1', source: 'netease', versionId: 'version-1', contentRevision: 'content-1' }, new AbortController().signal);
  const reads = f.bodyReads(), requests = f.requests();
  f.etag(multipartTag); f.dates(dateModified, dateNow);
  await withMobileCapabilityContext(c.value, () => assert.rejects(lease.verify(new AbortController().signal), denied));
  closeMobileCapabilityContext(c.value);
  assert.deepEqual(c.rows.map(row => row.stage), [`${unquotedDiagnosticPrefix}after-strong`]);
  assert.equal(c.rows[0]!.code, 'UNSUPPORTED_FORMAT'); assert.equal(c.value.privateContentDiagnostic, undefined);
  assert.equal(f.requests(), requests + 1); assert.equal(f.bodyReads(), reads); assert.equal(f.cancels(), 1);
  assert.equal(f.dateHeaderReads(), 0); assert.equal(f.requestHeaders.at(-1)!.get('if-match'), '"fixed-source-1"');
  assert.equal(f.requestHeaders.at(-1)!.get('if-range'), null); await lease.release();
  assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  assert.doesNotMatch(c.lines.join(''), /GMT|synthetic|https?:|token|private|headers|stack|message/u);
});

test('R15_ETAG_BRANCH 初始multipart只诊断原日期资格，合格日期与正式摘要也不授予准入', async t => {
  const cases: [string, string | null, string | null][] = [
    ['eligible', dateModified, dateNow], ['eligible', new Date(1699999940000).toUTCString(), dateNow],
    ['missing', null, dateNow], ['invalid', dateModified.replace('Tue', 'Mon'), dateNow],
    ['future', dateModified, new Date(1700000001000).toUTCString()],
    ['not-strong', new Date(1699999941000).toUTCString(), dateNow],
  ];
  for (const [reason, modified, date] of cases) await t.test(reason, async child => {
    const f = fixture(child), c = context(); f.etag(multipartTag); f.dates(modified, date);
    Object.assign(f.source, { contentDigest: { algorithm: 'md5', value: 'a'.repeat(32) } });
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.deepEqual(c.rows.map(row => row.stage), [reason === 'invalid' ? expectedDateStage('valid', 'imf-weekday')
      : `${unquotedDiagnosticPrefix}multipart-initial.date-${reason}`]);
    assert.equal(c.rows[0]!.code, 'UNSUPPORTED_FORMAT'); assert.equal(c.rows[0]!.phase, 'reject');
    assert.equal(c.value.privateContentDiagnostic, undefined); assert.equal(Object.keys(c.rows[0]!).length, 15);
    assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1); assert.equal(f.bodyReads(), 0); assert.equal(f.dateHeaderReads(), reason === 'invalid' ? 4 : 2);
    for (const name of ['if-match', 'if-range', 'if-unmodified-since']) assert.equal(f.requestHeaders[0]!.get(name), null);
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
    assert.doesNotMatch(c.lines.join(''), /GMT|Tue|Mon|2023|synthetic|https?:|token|private|headers|stack|message/u);
    assert.equal(c.lines.join('').includes(multipartTag), false);
  });
});

test('R15_ETAG_BRANCH 新日期诊断服从原开关、活动context和每请求首拒，不增加HTTP或body读取', async t => {
  for (const enabled of ['default', false, true] as const) await t.test(String(enabled), async child => {
    const f = fixture(child, enabled), c = context(); f.etag(multipartTag); f.dates(dateModified, dateNow);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.equal(c.rows.length, enabled === true ? 1 : 0); assert.equal(f.dateHeaderReads(), enabled === true ? 2 : 0);
    assert.equal(f.requests(), 2); assert.equal(f.cancels(), 2); assert.equal(f.bodyReads(), 0);
  });
  const f = fixture(t), c = context(); f.etag(multipartTag); f.dates(dateModified, dateNow);
  await assert.rejects(f.probe(), denied); closeMobileCapabilityContext(c.value);
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
  assert.equal(c.rows.length, 0); assert.equal(f.dateHeaderReads(), 0); assert.equal(f.bodyReads(), 0); assert.equal(f.cancels(), 2);
});

test('R15_ETAG_BRANCH 诊断读取或sink异常不替换原409、不重演HTTP，有限预算仍保留原首拒', async t => {
  const f = fixture(t), c = context(); f.etag(multipartTag); f.dates(dateModified, dateNow); f.failDateReads();
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
  assert.deepEqual(c.rows.map(row => row.stage), ['provider.audio-probe.reject.etag-invalid.unquotedother']);
  assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1); assert.equal(f.bodyReads(), 0);
  const limited = fixture(t), limitedContext = context(); limitedContext.value.records = 60;
  limited.etag(multipartTag); limited.dates(dateModified, dateNow);
  await withMobileCapabilityContext(limitedContext.value, () => assert.rejects(limited.probe(), denied)); closeMobileCapabilityContext(limitedContext.value);
  assert.deepEqual(limitedContext.rows.map(row => row.stage), [`${unquotedDiagnosticPrefix}multipart-initial.date-eligible`]);
  assert.equal(limitedContext.value.records, 61); assert.equal(limited.requests(), 1); assert.equal(limited.cancels(), 1);
  const failed = fixture(t); failed.etag(multipartTag); failed.dates(dateModified, dateNow);
  const sink = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, () => { throw new Error('synthetic-private-sink'); });
  assert.ok(sink); await withMobileCapabilityContext(sink, () => assert.rejects(failed.probe(), denied)); closeMobileCapabilityContext(sink);
  assert.equal(failed.requests(), 1); assert.equal(failed.cancels(), 1); assert.equal(failed.bodyReads(), 0);
});

test('R15_ETAG_BRANCH 仅新增七个闭集阶段，未知后缀与原始日期字段仍拒收', () => {
  const expected = ['after-strong', ...['eligible', 'missing', 'invalid', 'future', 'not-strong', 'shape']
    .map(reason => `multipart-initial.date-${reason}`)].map(reason => unquotedDiagnosticPrefix + reason);
  assert.deepEqual(MOBILE_CAPABILITY_STAGES.filter(stage => stage.startsWith(unquotedDiagnosticPrefix)).sort(), expected.sort());
  const row = { schema: 'mb.mobile-capability-trace.v1', component: 'core', requestSha256: 'a'.repeat(64), parentSha256: null,
    relatedSha256: null, epochMs: 1700000000000, elapsedMs: 1, stage: expected[0], phase: 'reject', role: 'business',
    name: 'UNKNOWN', code: 'UNSUPPORTED_FORMAT', outcome: null, aborted: false, initState: 'none' };
  for (const stage of expected) assert.ok(copyMobileCapabilityTraceRecord({ ...row, stage }));
  for (const suffix of ['multipart-initial.date-unknown', 'multipart-initial.date-conditional', 'after-strong.date-eligible', multipartTag]) {
    assert.equal(copyMobileCapabilityTraceRecord({ ...row, stage: unquotedDiagnosticPrefix + suffix }), null);
  }
  assert.equal(copyMobileCapabilityTraceRecord({ ...row, rawDate: dateNow }), null);
});

test('R16_MULTIPART_DATE 初始multipart的九十九种无效日期组合复用现有闭集，始终零body拒绝', async t => {
  let cases = 0;
  for (const date of dateClasses) for (const modified of dateClasses) {
    if (date === 'valid' && modified === 'valid') continue;
    await t.test(`${date}/${modified}`, async child => {
      cases++; const f = fixture(child), c = context(); f.etag(multipartTag);
      f.dates(modified === 'valid' ? dateModified : dateShapes[modified], dateShapes[date]);
      await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
      assert.deepEqual(c.rows.map(row => row.stage), [expectedDateStage(date, modified)]);
      assert.equal(c.rows[0]!.phase, 'reject'); assert.equal(c.rows[0]!.code, 'UNSUPPORTED_FORMAT');
      assert.equal(Object.keys(c.rows[0]!).length, 15); assert.equal(c.value.privateContentDiagnostic, undefined);
      assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1); assert.equal(f.bodyReads(), 0); assert.equal(f.dateHeaderReads(), 4);
      for (const name of ['if-match', 'if-range', 'if-unmodified-since']) assert.equal(f.requestHeaders[0]!.get(name), null);
      assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
      assert.doesNotMatch(c.lines.join(''), /GMT|Tue|Mon|Wed|Fri|2023|1969|synthetic|https?:|token|private|headers|stack|message/u);
      assert.equal(c.lines.join('').includes(multipartTag), false);
    });
  }
  assert.equal(cases, 99);
});

test('R16_MULTIPART_DATE 详细日期读取仍由原开关及活动context守门，同请求只分类一次', async t => {
  for (const enabled of ['default', false, true] as const) await t.test(String(enabled), async child => {
    const f = fixture(child, enabled), c = context(); f.etag(multipartTag); f.dates(dateShapes.other, dateNow);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.deepEqual(c.rows.map(row => row.stage), enabled === true ? [expectedDateStage('valid', 'other')] : []);
    assert.equal(f.dateHeaderReads(), enabled === true ? 4 : 0); assert.equal(f.requests(), 2); assert.equal(f.cancels(), 2); assert.equal(f.bodyReads(), 0);
  });
  const f = fixture(t), c = context(); f.etag(multipartTag); f.dates(dateShapes.other, dateNow);
  await assert.rejects(f.probe(), denied); closeMobileCapabilityContext(c.value);
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied));
  assert.equal(c.rows.length, 0); assert.equal(f.dateHeaderReads(), 0); assert.equal(f.bodyReads(), 0); assert.equal(f.cancels(), 2);
});

test('R16_MULTIPART_DATE 详细读取失败保留原粗分类，sink失败或有限预算均不改变409与真实关闭', async t => {
  for (const after of [2, 3]) await t.test(`第${after + 1}次日期读取失败`, async child => {
    const f = fixture(child), c = context(); f.etag(multipartTag); f.dates(dateShapes.other, dateNow); f.failDateReads(after);
    await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
    assert.deepEqual(c.rows.map(row => row.stage), [`${unquotedDiagnosticPrefix}multipart-initial.date-invalid`]);
    assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1); assert.equal(f.bodyReads(), 0); assert.equal(f.dateHeaderReads(), after + 1);
    assert.deepEqual(f.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
  });
  const f = fixture(t), c = context(); c.value.records = 60; f.etag(multipartTag); f.dates(dateShapes.other, dateNow);
  await withMobileCapabilityContext(c.value, () => assert.rejects(f.probe(), denied)); closeMobileCapabilityContext(c.value);
  assert.deepEqual(c.rows.map(row => row.stage), [expectedDateStage('valid', 'other')]); assert.equal(c.value.records, 61);
  assert.equal(f.requests(), 1); assert.equal(f.cancels(), 1); assert.equal(f.bodyReads(), 0);
  const failed = fixture(t); failed.etag(multipartTag); failed.dates(dateShapes.other, dateNow); let sinkCalls = 0;
  const sink = createMobileCapabilityContext(randomUUID(), 'core', 'content', null, undefined, () => { sinkCalls++; throw new Error('synthetic-private-sink'); });
  assert.ok(sink); await withMobileCapabilityContext(sink, () => assert.rejects(failed.probe(), denied)); closeMobileCapabilityContext(sink);
  assert.equal(sinkCalls, 1); assert.equal(failed.requests(), 1); assert.equal(failed.cancels(), 1); assert.equal(failed.bodyReads(), 0);
  assert.deepEqual(failed.manager.snapshot(), { leases: 0, probes: 0, readers: 0, pending: 0, fatal: false });
});
