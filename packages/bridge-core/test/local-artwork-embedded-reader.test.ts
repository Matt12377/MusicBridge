import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readLocalEmbeddedArtwork } from '../src/library/local-artwork-embedded-reader.js';

const MiB = 1024 * 1024;
// 仅测试容器和原字节提取；这些合成载荷没有完整图像解码证据。
const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 0, 6, 5]);
const u32 = (value: number): Buffer => { const result = Buffer.alloc(4); result.writeUInt32BE(value); return result; };
function syncsafe(value: number): Buffer {
  return Buffer.from([Math.floor(value / 128 ** 3) & 127, Math.floor(value / 128 ** 2) & 127, Math.floor(value / 128) & 127, value & 127]);
}
function flacBlock(type: number, body: Buffer, last = false, declared = body.length): Buffer {
  const header = Buffer.alloc(4); header[0] = type | (last ? 0x80 : 0); header.writeUIntBE(declared, 1, 3);
  return Buffer.concat([header, body]);
}
function pictureBody(bytes = image, mime = 'image/png', description = Buffer.from('合成封面')): Buffer {
  const type = Buffer.from(mime, 'ascii');
  return Buffer.concat([u32(3), u32(type.length), type, u32(description.length), description,
    u32(2), u32(2), u32(24), u32(0), u32(bytes.length), bytes]);
}
function flac(blocks: Buffer[], audio = Buffer.from([0xff, 0xf8, 33, 44])): Buffer {
  return Buffer.concat([Buffer.from('fLaC'), flacBlock(0, Buffer.alloc(34), blocks.length === 0), ...blocks, audio]);
}
function apicBody(bytes = image, encoding = 0, description?: Buffer, mime = 'image/png'): Buffer {
  const text = description ?? (encoding === 1 ? Buffer.from([0xff, 0xfe, 0x41, 0]) : encoding === 2 ? Buffer.from([0, 0x41]) : Buffer.from('合成', encoding === 3 ? 'utf8' : 'latin1'));
  return Buffer.concat([Buffer.from([encoding]), Buffer.from(mime, 'ascii'), Buffer.from([0, 3]), text,
    Buffer.alloc(encoding === 1 || encoding === 2 ? 2 : 1), bytes]);
}
function frame(version: number, name: string, body: Buffer, flags = [0, 0], declared = body.length): Buffer {
  return Buffer.concat([Buffer.from(name, 'latin1'), version === 4 ? syncsafe(declared) : u32(declared), Buffer.from(flags), body]);
}
function id3(version: number, frames: Buffer[], flags = 0, audio = Buffer.from([0xff, 0xfb, 55, 66])): Buffer {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([version, 0, flags]), syncsafe(body.length), body, audio]);
}
const hasCode = (suffix: string) => (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === `ARTWORK_EMBEDDED_${suffix}`;

async function withSource(bytes: Buffer, body: (handle: FileHandle, size: number, path: string) => Promise<void>, name = '合成源.bin'): Promise<void> {
  // 本机运行者将 TMPDIR 指向任务外置目录；CI 使用它自己的临时根。
  const directory = await mkdtemp(join(tmpdir(), 'mbrs010-embedded-'));
  const path = join(directory, name);
  let handle: FileHandle | undefined;
  try {
    await writeFile(path, bytes);
    handle = await open(path, 'r');
    await body(handle, bytes.length, path);
    assert.equal((await handle.stat()).isFile(), true, '提取器必须保留调用者的 FD');
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
interface ReadCall { position: number; length: number; bytesRead: number }
function observed(handle: FileHandle, options: { short?: number; after?: (call: ReadCall) => Promise<void> | void } = {}): { handle: FileHandle; calls: ReadCall[] } {
  const calls: ReadCall[] = [];
  const proxy = new Proxy(handle, { get(target, key) {
    if (key === 'close') return () => { throw new Error('提取器不得关闭借用 FD'); };
    if (key === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
      assert.equal(Number.isSafeInteger(position), true, '所有读取必须指定固定文件位置');
      assert.ok(length <= 64 * 1024, '每次读取必须遵守 chunk 上限');
      const result = await target.read(buffer, offset, Math.min(length, options.short ?? length), position);
      const call = { position, length, bytesRead: result.bytesRead }; calls.push(call);
      await options.after?.(call);
      return result;
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { handle: proxy, calls };
}
const notRead = (calls: ReadCall[], start: number, end: number): void => {
  assert.ok(calls.every(call => call.position + call.length <= start || call.position >= end), '不应读取被跳过的区域');
};

test('真实只读 FD 提取 FLAC 两张原图，跳过非图片块且不读音频', async () => {
  const ignored = Buffer.alloc(2 * MiB, 0x41), second = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const source = flac([flacBlock(1, ignored), flacBlock(6, pictureBody(image)), flacBlock(6, pictureBody(second, 'image/jpeg'), true)], Buffer.alloc(MiB, 0xff));
  await withSource(source, async (handle, size) => {
    await handle.read(Buffer.alloc(2), 0, 2, null);
    const spy = observed(handle), pictures = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
    assert.deepEqual(pictures.map(p => Buffer.from(p.bytes)), [image, second]);
    assert.deepEqual(pictures.map(p => p.pictureIndex), [0, 1]);
    assert.equal(Object.isFrozen(pictures), true);
    notRead(spy.calls, 46, 46 + ignored.length);
    notRead(spy.calls, source.length - MiB, source.length);
    const next = Buffer.alloc(1); await handle.read(next, 0, 1, null);
    assert.equal(next[0], source[2], '固定位置读取不得改变借用 FD 的当前位置');
  }, '合成源.wav');
});

test('ID3v2.3/v2.4 APIC 提取原字节，非图片 frame 和标签后音频不读取', async () => {
  for (const version of [3, 4]) {
    const ignored = Buffer.alloc(MiB, 0x41), audio = Buffer.alloc(MiB, 0xff);
    const source = id3(version, [frame(version, 'TIT2', ignored), frame(version, 'APIC', apicBody()), Buffer.alloc(9)], 0, audio);
    await withSource(source, async (handle, size) => {
      const spy = observed(handle), pictures = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
      assert.equal(pictures.length, 1); assert.deepEqual(Buffer.from(pictures[0]!.bytes), image);
      assert.equal(pictures[0]!.pictureIndex, 0);
      notRead(spy.calls, 20, 20 + ignored.length); notRead(spy.calls, source.length - audio.length, source.length);
    });
  }
});

test('APIC 有界识别四种说明编码，UTF-16 按代码单元找到终止符', async () => {
  for (const [version, encoding] of [[3, 0], [3, 1], [4, 0], [4, 1], [4, 2], [4, 3]]) {
    await withSource(id3(version!, [frame(version!, 'APIC', apicBody(image, encoding))]), async (handle, size) => {
      const pictures = await readLocalEmbeddedArtwork(handle, size, new AbortController().signal);
      assert.deepEqual(Buffer.from(pictures[0]!.bytes), image);
    });
  }
});

test('真实 FD 短读会继续读取，输出不包含未填充字节', async () => {
  await withSource(flac([flacBlock(6, pictureBody(), true)]), async (handle, size) => {
    const spy = observed(handle, { short: 3 });
    const pictures = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
    assert.deepEqual(Buffer.from(pictures[0]!.bytes), image); assert.ok(spy.calls.length > 10);
  });
});

test('未知格式、未支持 ID3 主版本或高位伪造 magic 明确拒绝，扩展名不参与识别', async () => {
  for (const source of [Buffer.alloc(0), Buffer.from('NOPE合成'), id3(2, []), id3(5, []), Buffer.from([0xe6, 0x4c, 0x61, 0x43])]) {
    await withSource(source, async (handle, size) => {
      const spy = observed(handle);
      await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('UNSUPPORTED'));
      assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) <= 8);
    }, '合成未知.flac');
  }
});

test('无图的 FLAC 和 ID3 返回空并保留 FD', async () => {
  for (const source of [flac([]), id3(3, [frame(3, 'TIT2', Buffer.from([0, 65]))]), id3(4, [])]) {
    await withSource(source, async (handle, size) => assert.deepEqual(await readLocalEmbeddedArtwork(handle, size, new AbortController().signal), []));
  }
});

test('容器截断、恶意大声明和块/frame 越界在图片分配前拒绝', async () => {
  const validFlac = flac([flacBlock(6, pictureBody(), true)], Buffer.alloc(0));
  const validId3 = id3(4, [frame(4, 'APIC', apicBody())], 0, Buffer.alloc(0));
  const badSources = [validFlac.subarray(0, validFlac.length - 2), Buffer.from('fLaC'),
    flac([flacBlock(6, Buffer.alloc(0), true, 0xffffff)], Buffer.alloc(0)),
    validId3.subarray(0, validId3.length - 2), Buffer.from('ID3'),
    id3(3, [frame(3, 'APIC', Buffer.alloc(1), [0, 0], 0xffffffff)])];
  for (const source of badSources) await withSource(source, async (handle, size) => {
    const spy = observed(handle);
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('INVALID'));
    assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) < 128);
  });
});

test('读取中实际文件被截断也拒绝，不将零字节短读当成成功', async () => {
  await withSource(flac([flacBlock(6, pictureBody(), true)]), async (handle, size, path) => {
    let cut = false;
    const spy = observed(handle, { after: async () => { if (!cut) { cut = true; await truncate(path, 0); } } });
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('INVALID'));
  });
});

test('单图恰好 4 MiB 可以提取，超过 4 MiB 不读取整张载荷', async () => {
  for (const version of [0, 4]) {
    for (const length of [4 * MiB, 4 * MiB + 1]) {
      const large = Buffer.alloc(length, 0x5a), source = version === 0 ? flac([flacBlock(6, pictureBody(large), true)]) : id3(version, [frame(version, 'APIC', apicBody(large))]);
      await withSource(source, async (handle, size) => {
        const spy = observed(handle);
        if (length === 4 * MiB) {
          const pictures = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
          assert.deepEqual(Buffer.from(pictures[0]!.bytes), large);
        } else {
          await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('LIMIT'));
          assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) < 8 * 1024);
        }
      });
    }
  }
});

test('最多三图及总量 8 MiB 围栏拒绝整次结果，累计读取低于 12 MiB', async () => {
  const sources = [flac(Array.from({ length: 4 }, (_, n) => flacBlock(6, pictureBody(), n === 3))),
    id3(4, Array.from({ length: 4 }, () => frame(4, 'APIC', apicBody()))),
    flac([flacBlock(6, pictureBody(Buffer.alloc(4 * MiB))), flacBlock(6, pictureBody(Buffer.alloc(4 * MiB))), flacBlock(6, pictureBody(), true)])];
  for (const source of sources) await withSource(source, async (handle, size) => {
    const spy = observed(handle);
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('LIMIT'));
    assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) <= 12 * MiB);
  });
  await withSource(flac([flacBlock(6, pictureBody()), flacBlock(6, pictureBody()), flacBlock(6, pictureBody(), true)]), async (handle, size) => {
    assert.equal((await readLocalEmbeddedArtwork(handle, size, new AbortController().signal)).length, 3);
  });
  await withSource(flac([flacBlock(6, pictureBody(Buffer.alloc(4 * MiB))), flacBlock(6, pictureBody(Buffer.alloc(4 * MiB)), true)]), async (handle, size) => {
    const pictures = await readLocalEmbeddedArtwork(handle, size, new AbortController().signal);
    assert.equal(pictures.reduce((sum, picture) => sum + picture.bytes.length, 0), 8 * MiB);
  });
});

test('FLAC block 与 ID3 frame 的 4096 次头预算阻止超长序列', async () => {
  for (const source of [flac(Array.from({ length: 4096 }, (_, n) => flacBlock(1, Buffer.alloc(0), n === 4095))),
    id3(4, Array.from({ length: 4097 }, () => frame(4, 'TIT2', Buffer.from([0]))))]) {
    await withSource(source, async (handle, size) => {
      const spy = observed(handle);
      await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('LIMIT'));
      assert.ok(spy.calls.length <= 4098); assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) < 48 * 1024);
    });
  }
});

test('ID3 标签和 frame 的不支持标记保守拒绝，不产生部分候选', async () => {
  for (const version of [3, 4]) {
    for (const flags of [0x80, 0x40, 0x20, 0x10]) await withSource(id3(version, [frame(version, 'APIC', apicBody())], flags), async (handle, size) => {
      await assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('UNSUPPORTED'));
    });
    for (const flags of [[0x80, 0], [0, 0x80], [0, 0x40], [0, 0x20], [0, 0x08], [0, 0x04], [0, 0x02], [0, 0x01]]) {
      await withSource(id3(version, [frame(version, 'APIC', apicBody()), frame(version, 'TIT2', Buffer.from([0]), flags)]), async (handle, size) => {
        await assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('UNSUPPORTED'));
      });
    }
  }
});

test('坏 frame 标识、同步安全长度、零长度和 FLAC 块顺序明确拒绝', async () => {
  const badSync = id3(4, [frame(4, 'APIC', apicBody())]); badSync[14] = 0x80;
  const badTagSync = id3(3, []); badTagSync[6] = 0x80;
  const sources = [id3(3, [frame(3, '\xc1PIC', apicBody())]), id3(4, [frame(4, 'APIC', Buffer.alloc(0))]),
    badSync, badTagSync, Buffer.concat([Buffer.from('fLaC'), flacBlock(6, pictureBody(), true)]),
    flac([flacBlock(0, Buffer.alloc(34), true)]), flac([flacBlock(127, Buffer.alloc(0), true)])];
  for (const source of sources) await withSource(source, async (handle, size) => {
    await assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('INVALID'));
  });
});

test('MIME、说明和 UTF-16 结构扫描有界，外部图片 URL 与新编码不解释', async () => {
  const longMime = Buffer.concat([Buffer.from([0]), Buffer.alloc(256, 0x61), Buffer.from([0, 3, 0]), image]);
  const longDescription = Buffer.concat([Buffer.from([0]), Buffer.from('image/png'), Buffer.from([0, 3]), Buffer.alloc(4099, 0x61), image]);
  for (const body of [longMime, longDescription]) await withSource(id3(4, [frame(4, 'APIC', body)]), async (handle, size) => {
    const spy = observed(handle);
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('LIMIT'));
    assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) < 8 * 1024);
  });
  for (const source of [id3(3, [frame(3, 'APIC', apicBody(image, 2))]), id3(4, [frame(4, 'APIC', apicBody(image, 4))]),
    id3(4, [frame(4, 'APIC', apicBody(image, 0, Buffer.alloc(0), '-->'))]),
    flac([flacBlock(6, pictureBody(image, '-->'), true)])]) await withSource(source, async (handle, size) => {
    await assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('UNSUPPORTED'));
  });
  await withSource(id3(4, [frame(4, 'APIC', apicBody(image, 1, Buffer.from([65, 0])))]), async (handle, size) => {
    await assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('INVALID'));
  });
});

test('预先取消和读取途中取消均拒绝结果，FD 仍由调用者持有', async () => {
  await withSource(flac([flacBlock(6, pictureBody(Buffer.alloc(MiB)), true)]), async (handle, size) => {
    const before = new AbortController(); before.abort(); const noRead = observed(handle);
    await assert.rejects(readLocalEmbeddedArtwork(noRead.handle, size, before.signal), hasCode('CANCELLED')); assert.equal(noRead.calls.length, 0);
    const during = new AbortController();
    const spy = observed(handle, { after: call => { if (call.length === 64 * 1024) during.abort(); } });
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, during.signal), hasCode('CANCELLED'));
    assert.equal(spy.calls.filter(call => call.length === 64 * 1024).length, 1);
    assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) < 128 * 1024);
  });
});

test('借用 FD 读取晚于三秒期限时拒绝迟到结果', async () => {
  await withSource(flac([]), async (handle, size) => {
    const spy = observed(handle, { after: async () => { await delay(3100); } });
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('TIMEOUT'));
    assert.equal(spy.calls.length, 1);
  });
});

test('无效 size 在实际 FD 读取之前拒绝', async () => {
  await withSource(Buffer.from('合成'), async (handle) => {
    const spy = observed(handle);
    for (const size of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('INVALID'));
    }
    assert.equal(spy.calls.length, 0);
  });
});

// 以下只构造元数据容器；载荷是可由独立图片解码器打开的 2×2 合成图片，不代表音频解码证据。
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGPc51bBwMDAxAAGABJAAYCBd8GBAAAAAElFTkSuQmCC', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDPooorQ+yP/9k=', 'base64');
function atom(name: string, bytes: Buffer, extended = false): Buffer {
  if (!extended) return Buffer.concat([u32(8 + bytes.length), Buffer.from(name, 'latin1'), bytes]);
  const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(16 + bytes.length));
  return Buffer.concat([u32(1), Buffer.from(name, 'latin1'), length, bytes]);
}
function mp4Cover(bytes = png, type = 14): Buffer { return atom('data', Buffer.concat([u32(type), u32(0), bytes])); }
function mp4(covers: Buffer[], options: { before?: Buffer; extended?: boolean; codec?: string; metaFlags?: number; handler?: string } = {}): Buffer {
  const hdlr = atom('hdlr', Buffer.concat([u32(0), u32(0), Buffer.from(options.handler ?? 'mdir'), Buffer.alloc(12)]));
  const meta = atom('meta', Buffer.concat([u32(options.metaFlags ?? 0), hdlr,
    atom('ilst', Buffer.concat([atom('©nam', atom('data', Buffer.concat([u32(1), u32(0), Buffer.from('合成专辑')]))),
      ...(covers.length ? [atom('covr', Buffer.concat(covers), options.extended)] : [])]))]), options.extended);
  return Buffer.concat([atom('ftyp', Buffer.concat([Buffer.from('M4A '), u32(0), Buffer.from('isomM4A ')])),
    options.before ?? Buffer.alloc(0),
    atom('moov', Buffer.concat([atom('trak', atom('stsd', atom(options.codec ?? 'mp4a', Buffer.alloc(28)))), atom('udta', meta)]), options.extended)]);
}
const le32 = (value: number): Buffer => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
function oggPage(laces: number[], body: Buffer, sequence: number, flags: number, serial = 17): Buffer {
  const header = Buffer.alloc(27); header.write('OggS'); header[5] = flags;
  header.writeUInt32LE(serial, 14); header.writeUInt32LE(sequence, 18); header[26] = laces.length;
  const page = Buffer.concat([header, Buffer.from(laces), body]);
  // 合成页也带真实 CRC，便于独立容器工具使用；提取器只验证有界元数据结构。
  let crc = 0;
  for (const byte of page) { crc = (crc ^ byte << 24) >>> 0; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0; }
  page.writeUInt32LE(crc, 22); return page;
}
function oggPackets(packets: Buffer[], options: { pageSegments?: number; serial?: number } = {}): Buffer {
  const pages: Buffer[] = []; let sequence = 0;
  for (const packet of packets) {
    const laces = Array.from({ length: Math.floor(packet.length / 255) }, () => 255); laces.push(packet.length % 255);
    let offset = 0;
    while (laces.length) {
      const part = laces.splice(0, options.pageSegments ?? 255), length = part.reduce((a, b) => a + b, 0);
      pages.push(oggPage(part, packet.subarray(offset, offset + length), sequence, (sequence === 0 ? 2 : 0) | (offset ? 1 : 0), options.serial));
      offset += length; sequence++;
    }
  }
  return Buffer.concat(pages);
}
function vorbisHead(): Buffer { return Buffer.concat([Buffer.from([1]), Buffer.from('vorbis'), le32(0), Buffer.from([2]), le32(48000), Buffer.alloc(12), Buffer.from([0xb8, 1])]); }
function opusHead(): Buffer { return Buffer.concat([Buffer.from('OpusHead'), Buffer.from([1, 2]), Buffer.alloc(8), Buffer.from([0])]); }
function comments(codec: 'vorbis' | 'opus', fields: Array<string | Buffer>): Buffer {
  return Buffer.concat([Buffer.from(codec === 'vorbis' ? '\x03vorbis' : 'OpusTags'), le32(4), Buffer.from('test'), le32(fields.length),
    ...fields.flatMap(field => { const bytes = typeof field === 'string' ? Buffer.from(field) : field; return [le32(bytes.length), bytes]; }),
    ...(codec === 'vorbis' ? [Buffer.from([1])] : [])]);
}
function ogg(codec: 'vorbis' | 'opus', fields: Array<string | Buffer>, pageSegments = 255): Buffer {
  return oggPackets([codec === 'vorbis' ? vorbisHead() : opusHead(), comments(codec, fields)], { pageSegments });
}
const pictureComment = (bytes = png, mime = 'image/png'): string => 'METADATA_BLOCK_PICTURE=' + pictureBody(bytes, mime).toString('base64');

test('MP4 AAC/ALAC 样式元数据提取原 PNG/JPEG；支持扩展长度并跳过 mdat', async () => {
  for (const codec of ['mp4a', 'alac']) for (const extended of [false, true]) {
    const ignored = atom('mdat', Buffer.alloc(2 * MiB, 0xa5)), source = mp4([mp4Cover(), mp4Cover(jpeg, 13)], { codec, extended, before: ignored });
    await withSource(source, async (handle, size) => {
      const spy = observed(handle), result = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
      assert.deepEqual(result.map(p => Buffer.from(p.bytes)), [png, jpeg]); assert.deepEqual(result.map(p => p.pictureIndex), [0, 1]);
      notRead(spy.calls, 24 + 8, 24 + ignored.length);
    }, '合成容器.m4a');
  }
});

test('MP4 合法无 covr 可确认无图；未知 meta/图片类型不得确认无图', async () => {
  await withSource(mp4([]), async (handle, size) => assert.deepEqual(await readLocalEmbeddedArtwork(handle, size, new AbortController().signal), []));
  for (const source of [mp4([mp4Cover(png, 0)]), mp4([], { metaFlags: 1 }), mp4([], { handler: 'mdta' })]) {
    await withSource(source, async (handle, size) => assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('UNSUPPORTED')));
  }
});

test('MP4 atom 截断、父范围越界、超大 64 位声明和缺 moov 整次拒绝', async () => {
  const large = Buffer.alloc(16); large.writeUInt32BE(1); large.write('moov', 4); large.writeBigUInt64BE(2n ** 63n, 8);
  const sources = [mp4([mp4Cover()]).subarray(0, -1), Buffer.concat([u32(4), Buffer.from('ftyp')]),
    Buffer.concat([atom('ftyp', Buffer.concat([Buffer.from('M4A '), u32(0)])), large]),
    Buffer.concat([atom('ftyp', Buffer.concat([Buffer.from('M4A '), u32(0)])), atom('mdat', Buffer.alloc(20))]),
    mp4([Buffer.concat([u32(0xffffffff), Buffer.from('data')])]), mp4([atom('data', Buffer.alloc(3))])];
  for (const source of sources) await withSource(source, async (handle, size) => {
    await assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('INVALID'));
  });
});

test('Ogg Vorbis/Opus 分页图片注释返回真实原图，保持短读与 FD 位置合同', async () => {
  for (const codec of ['vorbis', 'opus'] as const) {
    const source = ogg(codec, ['TITLE=合成', pictureComment(), pictureComment(jpeg, 'image/jpeg')], 1);
    await withSource(source, async (handle, size) => {
      await handle.read(Buffer.alloc(2), 0, 2, null);
      const spy = observed(handle, { short: 7 }), result = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
      assert.deepEqual(result.map(p => Buffer.from(p.bytes)), [png, jpeg]); assert.deepEqual(result.map(p => p.pictureIndex), [0, 1]);
      const next = Buffer.alloc(1); await handle.read(next, 0, 1, null); assert.equal(next[0], source[2]);
    }, '合成容器.ogg');
  }
});

test('Ogg 同页多个 packet 不读 setup/音频，合法无图才返回空', async () => {
  for (const codec of ['vorbis', 'opus'] as const) {
    const first = codec === 'vorbis' ? vorbisHead() : opusHead(), tags = comments(codec, ['TITLE=合成']), audio = Buffer.alloc(20, 0xff);
    const source = oggPage([first.length, tags.length, audio.length], Buffer.concat([first, tags, audio]), 0, 2);
    await withSource(source, async (handle, size) => {
      const spy = observed(handle); assert.deepEqual(await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), []);
      notRead(spy.calls, source.length - audio.length, source.length);
    });
  }
});

test('Ogg 未支持 codec、旧式 COVERART、URL 图片及非 PNG/JPEG 不得确认无图', async () => {
  for (const source of [oggPackets([Buffer.from('fishead\0合成')]), ogg('opus', ['COVERART=' + png.toString('base64')]),
    ogg('vorbis', [pictureComment(Buffer.from('https://example.invalid/cover'), '-->')]), ogg('opus', [pictureComment(png, 'image/webp')])]) {
    await withSource(source, async (handle, size) => assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('UNSUPPORTED')));
  }
});

test('Ogg 截断、乱序、跨 serial、错误 continuation 和 comment 范围整次拒绝', async () => {
  const valid = ogg('opus', [pictureComment()], 1), secondPage = 27 + 1 + opusHead().length;
  const wrongSequence = Buffer.from(valid); wrongSequence.writeUInt32LE(5, secondPage + 18);
  const wrongSerial = Buffer.from(valid); wrongSerial.writeUInt32LE(88, secondPage + 14);
  const wrongContinuation = Buffer.from(valid); wrongContinuation[secondPage + 5] = 1;
  const truncatedComment = Buffer.concat([Buffer.from('OpusTags'), le32(0xffffffff)]);
  const badFraming = comments('vorbis', []); badFraming[badFraming.length - 1] = 0;
  const sources = [valid.subarray(0, -1), wrongSequence, wrongSerial, wrongContinuation, Buffer.from('OggS'),
    oggPackets([opusHead(), truncatedComment]), oggPackets([vorbisHead(), badFraming])];
  for (const source of sources) await withSource(source, async (handle, size) => {
    await assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('INVALID'));
  });
});

test('Ogg base64 无效字符、非规范 padding、图片尾随数据和超长字段拒绝', async () => {
  const encoded = pictureBody(png).toString('base64');
  for (const value of ['!' + encoded.slice(1), encoded.slice(0, -1), encoded + 'AAAA', encoded.slice(0, -4) + 'AB==']) {
    await withSource(ogg('opus', ['METADATA_BLOCK_PICTURE=' + value]), async (handle, size) =>
      assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('INVALID')));
  }
  await withSource(ogg('opus', [pictureComment(Buffer.alloc(4 * MiB + 1))]), async (handle, size) => {
    const spy = observed(handle);
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('LIMIT'));
    assert.ok(spy.calls.reduce((n, c) => n + c.bytesRead, 0) < 80 * 1024);
  });
});

test('MP4/Ogg 保留单图 4 MiB、总图 8 MiB、三张及 12 MiB 读取围栏', async () => {
  const large = Buffer.alloc(4 * MiB, 0x55);
  for (const source of [mp4([mp4Cover(large), mp4Cover(large)]), ogg('opus', [pictureComment(large), pictureComment(large)])]) {
    await withSource(source, async (handle, size) => {
      const spy = observed(handle), result = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
      assert.equal(result.reduce((n, p) => n + p.bytes.length, 0), 8 * MiB);
      assert.ok(spy.calls.reduce((n, c) => n + c.bytesRead, 0) <= 12 * MiB);
    });
  }
  for (const source of [mp4(Array.from({ length: 4 }, () => mp4Cover())), ogg('vorbis', Array.from({ length: 4 }, () => pictureComment())),
    mp4([mp4Cover(large), mp4Cover(large), mp4Cover()]), ogg('opus', [pictureComment(large), pictureComment(large), pictureComment()]),
    mp4([mp4Cover(Buffer.alloc(4 * MiB + 1))])]) {
    await withSource(source, async (handle, size) =>
      assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('LIMIT')));
  }
});

test('MP4/Ogg 读取中取消不返回部分图片，也不关闭借用 FD', async () => {
  for (const source of [mp4([mp4Cover(), mp4Cover(Buffer.alloc(MiB))]), ogg('opus', [pictureComment(), pictureComment(Buffer.alloc(MiB))])]) {
    await withSource(source, async (handle, size) => {
      const controller = new AbortController(), spy = observed(handle, { after: call => { if (call.length >= 16 * 1024) controller.abort(); } });
      await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, controller.signal), hasCode('CANCELLED'));
    });
  }
});

test('MP4/Ogg 元数据头或注释数量到达 4096 预算后拒绝，不扫描音频', async () => {
  const tooManyAtoms = mp4([], { before: Buffer.concat(Array.from({ length: 4096 }, () => atom('free', Buffer.alloc(0)))) });
  const tooManyComments = oggPackets([opusHead(), Buffer.concat([Buffer.from('OpusTags'), le32(0), le32(4097)])]);
  const tooManyPages = Buffer.concat([oggPage([opusHead().length], opusHead(), 0, 2),
    ...Array.from({ length: 4096 }, (_, index) => oggPage([], Buffer.alloc(0), index + 1, 0))]);
  for (const source of [tooManyAtoms, tooManyComments, tooManyPages]) await withSource(source, async (handle, size) => {
    const spy = observed(handle);
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), hasCode('LIMIT'));
    assert.ok(spy.calls.reduce((n, call) => n + call.bytesRead, 0) < MiB);
  });
});

test('MP4 非标准图片层级及后续未知封面不会返回前面的部分候选', async () => {
  const misplaced = Buffer.concat([atom('ftyp', Buffer.concat([Buffer.from('M4A '), u32(0)])),
    atom('moov', atom('udta', atom('ilst', atom('covr', mp4Cover()))))]);
  for (const source of [misplaced, mp4([mp4Cover(), mp4Cover(png, 0)]), ogg('opus', [pictureComment(), 'COVERART=AAAA'])]) {
    await withSource(source, async (handle, size) =>
      assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('UNSUPPORTED')));
  }
});

function riffChunk(type: string, bytes: Buffer, declared = bytes.length): Buffer {
  return Buffer.concat([Buffer.from(type), le32(declared), bytes, Buffer.alloc(bytes.length & 1)]);
}
function wave(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]); return Buffer.concat([Buffer.from('RIFF'), le32(body.length), body]);
}
const waveFormat = (): Buffer => riffChunk('fmt ', Buffer.from('0100020044ac000010b1020004001000', 'hex'));

test('合法 RIFF/WAVE 完整检查后确认无图；奇数块有 padding，音频 data 不读', async () => {
  const audio = Buffer.alloc(2 * MiB, 0x52), source = wave([waveFormat(), riffChunk('JUNK', Buffer.from([1, 2, 3])), riffChunk('data', audio), riffChunk('LIST', Buffer.from('INFO'))]);
  await withSource(source, async (handle, size) => {
    const spy = observed(handle); assert.deepEqual(await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), []);
    const start = source.indexOf('data') + 8; notRead(spy.calls, start, start + audio.length);
    assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) < 128);
  }, '合成无图.wav');
  const original = await readFile(new URL('./fixtures/mbrs003/audio/fixtures/core-wav.wav', import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'), 'cc1eaac76af6c2b237f97c908202e3ded3b1aff6d7052bf20846a487243e5340');
  await withSource(original, async (handle, size) => {
    const spy = observed(handle); assert.deepEqual(await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), []);
    assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) < 1024);
  }, '原有受封合成.wav');
});

test('RIFF/WAVE 在 data 前后提取有界 ID3v2.3/4 APIC，保原 PNG/JPEG 字节', async () => {
  for (const version of [3, 4]) for (const beforeData of [false, true]) {
    const tags = riffChunk(version === 3 ? 'id3 ' : 'ID3 ', id3(version, [frame(version, 'APIC', apicBody(png)), frame(version, 'APIC', apicBody(jpeg, 0, undefined, 'image/jpeg'))], 0, Buffer.alloc(0)));
    const audio = riffChunk('data', Buffer.alloc(4096));
    const source = wave([waveFormat(), ...(beforeData ? [tags, audio] : [audio, tags])]);
    await withSource(source, async (handle, size) => {
      const spy = observed(handle), pictures = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
      assert.deepEqual(pictures.map(p => Buffer.from(p.bytes)), [png, jpeg]);
      const start = source.indexOf('data') + 8; notRead(spy.calls, start, start + 4096);
    }, '合成有图.wav');
  }
});

test('RIFF/WAVE 截断、父范围、缺必要块、坏扩展格式与 ID3 边界拒绝确认无图', async () => {
  const data = riffChunk('data', Buffer.alloc(4));
  const valid = wave([waveFormat(), data]);
  const oddPaddingMissing = wave([waveFormat(), riffChunk('data', Buffer.alloc(4)), Buffer.concat([Buffer.from('JUNK'), le32(1), Buffer.from([0])])]);
  const wrongSize = Buffer.from(valid); wrongSize.writeUInt32LE(1, 4);
  const tag = id3(4, [frame(4, 'APIC', apicBody(png))], 0, Buffer.alloc(0));
  const bad = [Buffer.from('RIFF'), valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]), wrongSize, oddPaddingMissing,
    wave([data]), wave([waveFormat()]), wave([riffChunk('fmt ', Buffer.alloc(15)), data]),
    wave([riffChunk('fmt ', Buffer.alloc(16)), data]), wave([waveFormat(), riffChunk('data', Buffer.alloc(4), 0xffffffff)]),
    wave([waveFormat(), riffChunk('fmt ', Buffer.alloc(16)), data]),
    wave([waveFormat(), data, riffChunk('id3 ', Buffer.concat([tag, Buffer.from([0])]))])];
  for (const source of bad) await withSource(source, async (handle, size) =>
    assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('INVALID')));
});

test('RIFF 非 WAVE、未支持 ID3/URL 图片及 DISP 均未确认，不能冒充无图', async () => {
  const sources = [Buffer.concat([Buffer.from('RIFF'), le32(4), Buffer.from('AVI ')]),
    wave([waveFormat(), riffChunk('data', Buffer.alloc(4)), riffChunk('id3 ', id3(2, [], 0, Buffer.alloc(0)))]),
    wave([waveFormat(), riffChunk('data', Buffer.alloc(4)), riffChunk('DISP', Buffer.from([1, 2, 3, 4]))]),
    wave([waveFormat(), riffChunk('data', Buffer.alloc(4)), riffChunk('id3 ', id3(4, [frame(4, 'APIC', apicBody(png, 0, undefined, '-->'))], 0, Buffer.alloc(0)))])];
  for (const source of sources) await withSource(source, async (handle, size) =>
    assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('UNSUPPORTED')));
});

test('RIFF/WAVE 也保留三秒/字节/头预算；取消不返回已读的部分图片', async () => {
  const tooMany = wave([waveFormat(), ...Array.from({ length: 4096 }, () => riffChunk('JUNK', Buffer.alloc(0))), riffChunk('data', Buffer.alloc(0))]);
  await withSource(tooMany, async (handle, size) => assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal), hasCode('LIMIT')));
  const source = wave([waveFormat(), riffChunk('data', Buffer.alloc(0)),
    riffChunk('id3 ', id3(4, [frame(4, 'APIC', apicBody(png)), frame(4, 'APIC', apicBody(Buffer.alloc(MiB)))], 0, Buffer.alloc(0)))]);
  await withSource(source, async (handle, size) => {
    const abort = new AbortController(), spy = observed(handle, { after: call => { if (call.length >= 16 * 1024) abort.abort(); } });
    await assert.rejects(readLocalEmbeddedArtwork(spy.handle, size, abort.signal), hasCode('CANCELLED'));
  });
});

test('Ogg 尾部跳音频载荷核页头：后置多流、截断和未终结 packet 不得确认无图', async () => {
  const base = ogg('opus', []);
  const chained = Buffer.concat([base, oggPackets([opusHead(), comments('opus', [pictureComment()])], { serial: 88 })]);
  const foreign = Buffer.concat([base, oggPage([1], Buffer.from([0]), 2, 0, 88)]);
  const truncated = Buffer.concat([base, Buffer.from('OggS')]);
  const unfinished = Buffer.concat([base, oggPage([255], Buffer.alloc(255), 2, 4)]);
  for (const source of [chained, foreign, truncated, unfinished]) await withSource(source, async (handle, size) =>
    assert.rejects(readLocalEmbeddedArtwork(handle, size, new AbortController().signal),
      error => hasCode('INVALID')(error) || hasCode('UNSUPPORTED')(error)));
  const audio = Buffer.alloc(20), source = Buffer.concat([ogg('opus', [pictureComment()]), oggPage([audio.length], audio, 2, 4)]);
  await withSource(source, async (handle, size) => {
    const spy = observed(handle), pictures = await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal);
    assert.deepEqual(pictures.map(p => Buffer.from(p.bytes)), [png]);
    notRead(spy.calls, source.length - audio.length, source.length);
  });
});
