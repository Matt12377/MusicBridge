import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_METADATA_READ_BUDGET,
  RUST_MEDIA_METADATA_PARSER_VERSION,
  type MetadataReadBudget,
} from '../../src/library/metadata-reader-types.js';
import {
  createRustMediaWorkerPool,
  resolveRustMediaWorkerBinary,
  type RustMetadataReadResult,
} from '../../src/library/rust-media-worker.js';

type Success = Extract<RustMetadataReadResult, { status: 'ok' }>;
type InfoEntry = readonly [key: string, bytes: Buffer];

function chunk(key: string, bytes: Buffer, padding = true): Buffer {
  const header = Buffer.alloc(8);
  assert.equal(Buffer.byteLength(key, 'ascii'), 4);
  header.write(key, 0, 'ascii');
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, Buffer.alloc(padding ? bytes.length % 2 : 0)]);
}

function riff(chunks: readonly Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function pcmFormat(): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt16LE(1, 0);
  bytes.writeUInt16LE(2, 2);
  bytes.writeUInt32LE(44_100, 4);
  bytes.writeUInt32LE(176_400, 8);
  bytes.writeUInt16LE(4, 12);
  bytes.writeUInt16LE(16, 14);
  return bytes;
}

function info(entries: readonly InfoEntry[]): Buffer {
  return Buffer.concat([Buffer.from('INFO', 'ascii'), ...entries.map(([key, bytes]) => chunk(key, bytes))]);
}

function infoWave(entries: readonly InfoEntry[]): Buffer {
  return riff([chunk('fmt ', pcmFormat()), chunk('data', Buffer.alloc(400)), chunk('LIST', info(entries))]);
}

function terminated(text: string): Buffer { return Buffer.from(`${text}\0`, 'utf8'); }

function syncsafe(value: number): Buffer {
  return Buffer.from([(value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]);
}

/** 完整 ID3v2.4 帧；只通过标签内部零填充保证末尾块大小为奇数。 */
function id3(): Buffer {
  const fields = { TIT2: '有效ID3曲名', TPE1: '有效ID3艺人', TALB: '有效ID3专辑' };
  const frames = Object.entries(fields).map(([key, value]) => {
    const payload = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]);
    return Buffer.concat([Buffer.from(key, 'ascii'), syncsafe(payload.length), Buffer.alloc(2), payload]);
  });
  let body = Buffer.concat(frames);
  if ((body.length + 10) % 2 === 0) body = Buffer.concat([body, Buffer.alloc(1)]);
  return Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0]), syncsafe(body.length), body]);
}

function success(result: RustMetadataReadResult): Success {
  if (result.status !== 'ok') assert.fail(`真实 Rust Worker 解析失败：${result.code}`);
  return result;
}

function failure(result: RustMetadataReadResult, code: 'PARSE_FAILED' | 'BUDGET_EXCEEDED'): void {
  if (result.status !== 'failure') assert.fail(`应拒收 ${code}，实际得到成功事实`);
  assert.equal(result.code, code);
}

test('真实 Rust Worker 兼容 WAVE 末尾缺 pad 与旧 INFO，保留原 v1 字段和拒收边界', { timeout: 30_000 }, async t => {
  assert.equal(process.versions.node.split('.')[0], '22', '真实 Worker 集成测试使用 Node.js 22');
  // 使用本轮摘要已核对的真实二进制；没有产物时失败，不跳过或替换解析器。
  const binary = await resolveRustMediaWorkerBinary();
  const pool = createRustMediaWorkerPool({ binaryPath: binary, concurrency: 1, maxPending: 1 });
  t.after(async () => { await pool.close(); });

  async function read(bytes: Buffer, budget: MetadataReadBudget = { ...DEFAULT_METADATA_READ_BUDGET }): Promise<RustMetadataReadResult> {
    const before = Buffer.from(bytes);
    const calls: number[] = [];
    let settled = false;
    const result = await pool.readMetadata({
      size: bytes.length,
      budget,
      includeEmbeddedArtwork: false,
      async read(offset, length): Promise<Uint8Array> {
        assert.equal(settled, false, '任务结束后不得再次读取已归还的源');
        assert.ok(Number.isSafeInteger(offset) && offset >= 0);
        assert.ok(Number.isSafeInteger(length) && length > 0 && length <= 64 * 1024);
        assert.ok(offset + length <= bytes.length, '逻辑 pad 不得扩大真实源的可读范围');
        calls.push(length);
        return bytes.subarray(offset, offset + length);
      },
    });
    settled = true;
    assert.deepEqual(bytes, before, '兼容解析不得改写调用者的合成源字节');
    if (result.status === 'ok') {
      assert.equal(result.parserVersion, RUST_MEDIA_METADATA_PARSER_VERSION);
      assert.deepEqual(result.technical, {
        container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 44_100,
        channels: 2, bitsPerSample: 16, durationSeconds: 100 / 44_100,
        evidence: 'bounded-parser-reported',
      });
      assert.deepEqual(result.coverEvidence, []);
      assert.equal(result.readEvidence.readCalls, calls.length);
      assert.equal(result.readEvidence.bytesRead, calls.reduce((sum, length) => sum + length, 0));
      assert.ok(calls.length > 0 && result.readEvidence.maxReadBytes <= 64 * 1024);
      assert.equal(result.readEvidence.wholeAudioHash, false);
      assert.equal(result.readEvidence.wholeAudioDecode, false);
    }
    return result;
  }

  const mixedInfo = info([
    ['INAM', terminated('有效INFO曲名')],
    ['IART', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0])],
  ]);
  const prefix = [chunk('fmt ', pcmFormat()), chunk('data', Buffer.alloc(400)), chunk('LIST', mixedInfo)];
  const loose = riff([...prefix, chunk('id3 ', id3(), false)]);
  const padded = riff([...prefix, chunk('id3 ', id3())]);

  await t.test('终端奇数 ID3 缺 pad 与混合 INFO 可读，ID3 保持优先', async () => {
    const result = success(await read(loose));
    assert.deepEqual(result.fields, { title: '有效ID3曲名', artist: '有效ID3艺人', album: '有效ID3专辑' });
  });

  await t.test('补齐 pad 的控制组保留相同字段和 PCM 事实', async () => {
    const original = success(await read(loose)), control = success(await read(padded));
    assert.deepEqual(control.fields, original.fields);
    assert.deepEqual(control.technical, original.technical);
  });

  await t.test('末尾 payload 截断仍拒收', async () => {
    failure(await read(loose.subarray(0, loose.length - 1)), 'PARSE_FAILED');
  });

  await t.test('RIFF limit 与真实 EOF 不等时不能使用尾部例外', async () => {
    failure(await read(Buffer.concat([loose, Buffer.alloc(2)])), 'PARSE_FAILED');
  });

  await t.test('中间奇数块缺 pad 仍拒收', async () => {
    failure(await read(riff([...prefix, chunk('id3 ', id3(), false), chunk('JUNK', Buffer.alloc(2))])), 'PARSE_FAILED');
  });

  await t.test('PCM blockAlign 错误仍拒收', async () => {
    const format = pcmFormat();
    format.writeUInt16LE(3, 12);
    const bytes = riff([chunk('fmt ', format), chunk('data', Buffer.alloc(400)), chunk('id3 ', id3(), false)]);
    failure(await read(bytes), 'PARSE_FAILED');
  });

  await t.test('INFO 子项声明越过 LIST 边界仍拒收', async () => {
    const malformed = Buffer.from(mixedInfo);
    malformed.writeUInt32LE(100_000, 8);
    const bytes = riff([chunk('fmt ', pcmFormat()), chunk('data', Buffer.alloc(400)),
      chunk('LIST', malformed), chunk('id3 ', id3(), false)]);
    failure(await read(bytes), 'PARSE_FAILED');
  });

  await t.test('无 ID3 时保留有效 INFO 与 IPRT，跳过未知编码', async () => {
    const entries = Buffer.concat([mixedInfo, chunk('IPRT', terminated('7'))]);
    const bytes = riff([chunk('fmt ', pcmFormat()), chunk('data', Buffer.alloc(400)), chunk('LIST', entries)]);
    assert.deepEqual(success(await read(bytes)).fields, { title: '有效INFO曲名', track: '7' });
  });

  await t.test('INFO 非法 key 仍拒收', async () => {
    failure(await read(infoWave([['bad!', terminated('值')]])), 'PARSE_FAILED');
  });

  for (const [value, expected] of [['1983abc', '1983'], ['198', undefined], ['19830', '1983']] as const) {
    await t.test(`INFO year 保留原 v1 规则：${JSON.stringify(value)}`, async () => {
      const fields = success(await read(infoWave([['ICRD', terminated(value)]]))).fields;
      assert.deepEqual(fields, expected === undefined ? {} : { year: expected });
    });
  }

  for (const [value, expected] of [['3/12', undefined], [' 3 ', undefined], ['7', '7'], ['3-1', undefined]] as const) {
    await t.test(`INFO ITRK 保留直接整数解析：${JSON.stringify(value)}`, async () => {
      const fields = success(await read(infoWave([['ITRK', terminated(value)]]))).fields;
      assert.deepEqual(fields, expected === undefined ? {} : { track: expected });
    });
  }

  await t.test('跳过未知 INFO 编码仍受单字段原始字节预算限制', async () => {
    const bytes = infoWave([['IART', Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0])]]);
    assert.deepEqual(success(await read(bytes)).fields, {});
    failure(await read(bytes, { ...DEFAULT_METADATA_READ_BUDGET, textFieldBytes: 4 }), 'BUDGET_EXCEEDED');
  });

  await t.test('单字段各自合规时 INFO 总文本仍受小限额约束', async () => {
    const bytes = infoWave([['INAM', terminated('abcde')], ['IPRD', terminated('fghij')]]);
    assert.deepEqual(success(await read(bytes)).fields, { title: 'abcde', album: 'fghij' });
    failure(await read(bytes, { ...DEFAULT_METADATA_READ_BUDGET, textFieldBytes: 8, totalTextBytes: 8 }), 'BUDGET_EXCEEDED');
  });
});
