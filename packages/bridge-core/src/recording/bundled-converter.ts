import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createFfmpegConverter, type FfmpegConverter, type PinnedFfmpegBuild } from './audio-converter.js';
import { conversionFail, verifyConverterFile } from './conversion-process.js';
import { ffmpegBuildPolicy } from './ffmpeg-build-policy.js';

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]): boolean => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);

/** expectedHash 来自应用编译期常量，不得取自旁边的清单或用户设置。只加载，不运行音频任务。 */
export async function loadBundledConverter(root: string, expectedHash: string | null): Promise<FfmpegConverter | undefined> {
  if (expectedHash === null) return undefined;
  if (!path.isAbsolute(root) || !hash(expectedHash)) return conversionFail('INVALID_INPUT');
  const deadline = performance.now() + 10_000;
  const check = (): void => { if (performance.now() > deadline) conversionFail('LIMIT_EXCEEDED'); };
  try {
    const manifestPath = path.join(root, 'manifest.json'), info = await lstat(manifestPath);
    if (!info.isFile() || info.size > 64 * 1024) return conversionFail('BACKEND_CHANGED');
    await verifyConverterFile({ path: manifestPath, sha256: expectedHash }, check);
    const bytes = await readFile(manifestPath);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) return conversionFail('BACKEND_CHANGED');
    const m: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(m) || !keys(m, ['schemaVersion','platform','arch','minimumMacOS','sourceSha256','license','build']) || m.schemaVersion !== 1 || m.platform !== 'darwin' || m.arch !== 'arm64' || m.minimumMacOS !== '13.0' || m.sourceSha256 !== ffmpegBuildPolicy.source.sha256 || m.license !== 'LGPL-2.1-or-later' || !object(m.build)) return conversionFail('BACKEND_CHANGED');
    const b = m.build;
    if (!keys(b, ['version','ffmpeg','ffprobe','dependencies','components']) || b.version !== '8.1.2' || !Array.isArray(b.dependencies) || b.dependencies.length !== ffmpegBuildPolicy.libraries.length || !Array.isArray(b.components) || b.components.length !== ffmpegBuildPolicy.libraries.length) return conversionFail('BACKEND_CHANGED');
    function binary(value: unknown, relative: string) {
      if (!object(value) || !keys(value, ['path','sha256','versionSha256']) || value.path !== relative || !hash(value.sha256) || !hash(value.versionSha256)) return conversionFail('BACKEND_CHANGED');
      return { path: path.join(root, relative), sha256: value.sha256, versionSha256: value.versionSha256 };
    }
    const dependencies = ffmpegBuildPolicy.libraries.map(library => {
      const values = b.dependencies as unknown[], components = b.components as unknown[];
      const pin = values.find(v => object(v) && v.id === library.id), component = components.find(v => object(v) && v.name === library.name);
      if (!object(pin) || !keys(pin, ['id','path','sha256']) || pin.path !== `lib/${library.id}` || !hash(pin.sha256) || !object(component) || !keys(component, ['name','version']) || component.version !== library.version) return conversionFail('BACKEND_CHANGED');
      return { id: library.id, path: path.join(root, `lib/${library.id}`), sha256: pin.sha256 };
    });
    const build: PinnedFfmpegBuild = { version: '8.1.2', ffmpeg: binary(b.ffmpeg, 'bin/ffmpeg'), ffprobe: binary(b.ffprobe, 'bin/ffprobe'), dependencies, components: ffmpegBuildPolicy.libraries.map(l => ({ name: l.name, version: l.version })) };
    for (const pin of [build.ffmpeg, build.ffprobe, ...dependencies]) await verifyConverterFile(pin, check);
    return createFfmpegConverter(build);
  } catch { return conversionFail('BACKEND_UNAVAILABLE'); }
}
