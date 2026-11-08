import { Buffer } from 'node:buffer';

export const syntheticLrc = '[ar:合成作者]\n[00:00.00]\n[00:01.00]第一行\n[00:03.00]第二行\n[00:04.00]\n';
export function syncsafe(value: number): Buffer { return Buffer.from([(value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]); }
export function riffChunk(id: string, data: Buffer, padding = true): Buffer {
  const header = Buffer.alloc(8); header.write(id, 0, 'ascii'); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(padding ? data.length % 2 : 0)]);
}
export function id3Frame(id: string, data: Buffer, version: 2 | 3 | 4 = 4, flags = 0): Buffer {
  const header = Buffer.alloc(version === 2 ? 6 : 10); header.write(id, 0, 'ascii');
  if (version === 2) header.writeUIntBE(data.length, 3, 3);
  else { if (version === 4) syncsafe(data.length).copy(header, 4); else header.writeUInt32BE(data.length, 4); header.writeUInt16BE(flags, 8); }
  return Buffer.concat([header, data]);
}
export function id3Tag(frames: readonly Buffer[], version: 2 | 3 | 4 = 4, flags = 0): Buffer {
  const body = Buffer.concat(frames); return Buffer.concat([Buffer.from([73, 68, 51, version, 0, flags]), syncsafe(body.length), body]);
}
export function uslt(text = syntheticLrc, encoding: 0 | 1 | 2 | 3 = 3): Buffer {
  if (encoding === 1 || encoding === 2) {
    const body = Buffer.from(text, 'utf16le'); if (encoding === 2) body.swap16();
    return Buffer.concat([Buffer.from([encoding]), Buffer.from('eng'), ...(encoding === 1 ? [Buffer.from([255, 254])] : []), Buffer.alloc(2),
      ...(encoding === 1 ? [Buffer.from([255, 254])] : []), body]);
  }
  return Buffer.concat([Buffer.from([encoding]), Buffer.from('eng'), Buffer.alloc(1), Buffer.from(text, encoding === 0 ? 'latin1' : 'utf8')]);
}
export function sylt(lines: readonly { startMs: number; text: string }[], unit = 2): Buffer {
  return Buffer.concat([Buffer.from([3]), Buffer.from('eng'), Buffer.from([unit, 1, 0]), ...lines.flatMap(line => {
    const time = Buffer.alloc(4); time.writeUInt32BE(line.startMs); return [Buffer.from(line.text, 'utf8'), Buffer.alloc(1), time];
  })]);
}
export function wave(frames: readonly Buffer[] = [id3Frame('USLT', uslt())], options: { version?: 2 | 3 | 4; flags?: number; missingTailPad?: boolean; id3Name?: string } = {}) {
  const format = Buffer.alloc(16); format.writeUInt16LE(1); format.writeUInt16LE(2, 2); format.writeUInt32LE(48_000, 4);
  format.writeUInt32LE(192_000, 8); format.writeUInt16LE(4, 12); format.writeUInt16LE(16, 14);
  const fmt = riffChunk('fmt ', format), data = riffChunk('data', Buffer.alloc(192_000)), tag = id3Tag(frames, options.version ?? 4, options.flags ?? 0);
  const list = riffChunk('LIST', Buffer.from('INFO')), id3 = riffChunk(options.id3Name ?? 'id3 ', tag, !options.missingTailPad);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, data, list, id3]), header = Buffer.alloc(8);
  header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  const bytes = Buffer.concat([header, body]), dataStart = 12 + fmt.length + 8, tagStart = 12 + fmt.length + data.length + list.length + 8;
  const forbidden: { start: number; end: number }[] = [{ start: dataStart, end: dataStart + 192_000 }];
  let at = tagStart + 10;
  for (const frame of frames) {
    const width = (options.version ?? 4) === 2 ? 6 : 10;
    if (frame.toString('ascii', 0, width === 6 ? 3 : 4) === 'APIC') forbidden.push({ start: at + width, end: at + frame.length });
    at += frame.length;
  }
  return { bytes, forbidden, tagStart };
}

export function flacBlock(kind: number, body: Buffer, last = false): Buffer {
  const header = Buffer.alloc(4); header[0] = kind | (last ? 128 : 0); header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}
export function vorbisComments(comments: readonly (string | Buffer)[]): Buffer {
  const length = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const vendor = Buffer.from('synthetic fixture');
  return Buffer.concat([length(vendor.length), vendor, length(comments.length), ...comments.flatMap(value => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value; return [length(bytes.length), bytes];
  })]);
}
/** 真实编码的10ms双声道静音；只替换metadata，不含用户歌曲或外部音频夹具。 */
export function flac(comments: readonly (string | Buffer)[] = [`LYRICS=${syntheticLrc}`], options: { pictureBytes?: number; pictureFirst?: boolean } = {}) {
  const info = Buffer.from('EgASAAAAEAAAEAu4AvAAAAHgPaFYLaIu9UkHpPTNbV0aYA==', 'base64');
  const audio = Buffer.from('//h6GAAB36YAAAAAAAAZBw==', 'base64');
  const picture = options.pictureBytes ? Buffer.alloc(options.pictureBytes, 0x61) : undefined;
  const blocks = [{ kind: 0, body: info }, ...(picture && options.pictureFirst ? [{ kind: 6, body: picture }] : []),
    { kind: 4, body: vorbisComments(comments) }, ...(picture && !options.pictureFirst ? [{ kind: 6, body: picture }] : [])];
  const chunks: Buffer[] = [Buffer.from('fLaC')], forbidden: { start: number; end: number }[] = [];
  let at = 4, commentStart = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 6) forbidden.push({ start: at + 4, end: at + 4 + block.body.length });
    if (block.kind === 4) {
      commentStart = at + 4;
      let position = commentStart + 4 + block.body.readUInt32LE(0) + 4;
      for (const comment of comments) {
        const value = typeof comment === 'string' ? Buffer.from(comment) : comment;
        const prefix = Buffer.from('METADATA_BLOCK_PICTURE=');
        if (value.subarray(0, prefix.length).equals(prefix)) forbidden.push({ start: position + 4 + prefix.length, end: position + 4 + value.length });
        position += 4 + value.length;
      }
    }
    const bytes = flacBlock(block.kind, block.body, index === blocks.length - 1); chunks.push(bytes); at += bytes.length;
  }
  forbidden.push({ start: at, end: at + audio.length }); chunks.push(audio);
  return { bytes: Buffer.concat(chunks), forbidden, commentStart };
}
