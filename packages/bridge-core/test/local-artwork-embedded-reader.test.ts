import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, truncate, writeFile, type FileHandle } from 'node:fs/promises';
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

test('未知格式、未支持 ID3 主版本或高位伪造 magic 返回空，扩展名不参与识别', async () => {
  for (const source of [Buffer.alloc(0), Buffer.from('RIFF合成'), Buffer.from('OggS合成'), id3(2, []), id3(5, []), Buffer.from([0xe6, 0x4c, 0x61, 0x43])]) {
    await withSource(source, async (handle, size) => {
      const spy = observed(handle);
      assert.deepEqual(await readLocalEmbeddedArtwork(spy.handle, size, new AbortController().signal), []);
      assert.ok(spy.calls.reduce((sum, call) => sum + call.bytesRead, 0) <= 4);
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
