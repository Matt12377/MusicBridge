import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { after, before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import threads, { type WorkerOptions } from 'node:worker_threads';
import { PLAYBACK_CODEC_PROTOCOL } from '../src/main/mobile-playback-state-codec-protocol.js';

const EXTERNAL_VOLUME = '/Volumes/LifeWeave';
const EXTERNAL_TEMPORARY = EXTERNAL_VOLUME + '/Developer/CommandLine/tmp';
const COMPILER_VERSION = '0.28.2';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const sourceEntry = fileURLToPath(new URL('../src/main/mobile-playback-state-worker-entry.ts', import.meta.url));
const defaultWorker = new URL('../src/main/mobile-playback-state-worker-entry.js', import.meta.url);
const coreManifest = fileURLToPath(new URL('../../../packages/bridge-core/package.json', import.meta.url));

interface FrozenFile { file: string; sha256: string; bytes: number }
interface Metafile {
  inputs: Record<string, { bytes: number }>;
  outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
}
interface Compiler {
  version: string;
  build(options: Record<string, unknown>): Promise<{
    outputFiles?: { path: string; contents: Uint8Array }[];
    metafile?: Metafile;
  }>;
  stop(): void | Promise<void>;
}
interface LoaderBuild {
  onLoad(options: { filter: RegExp; namespace: string }, load: (args: { path: string }) => {
    contents: Uint8Array; loader: string; resolveDir: string;
  }): void;
}

function snapshot(file: string, bytes = readFileSync(file)): FrozenFile {
  return { file: realpathSync(file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
}
function unchanged(files: readonly FrozenFile[]): void {
  for (const file of files) assert.deepEqual(snapshot(file.file), file, '真实Worker产物或其编译输入在测试期间发生变化。');
}
function writePrivate(file: string, bytes: string | Uint8Array): void {
  writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' }); chmodSync(file, 0o600);
}
function writeRecord(file: string, value: unknown): void { writePrivate(file, JSON.stringify(value, null, 2) + '\n'); }
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function temporaryDirectory(): string {
  // 先验证真实挂载与既有TMPDIR，绝不创建同名卷或回落本机临时目录。
  assert.equal(realpathSync(EXTERNAL_VOLUME), EXTERNAL_VOLUME, '真实Worker测试必须使用已挂载LifeWeave卷。');
  const volume = statSync(EXTERNAL_VOLUME);
  assert.ok(volume.isDirectory());
  assert.notEqual(volume.dev, statSync(path.dirname(EXTERNAL_VOLUME)).dev, 'LifeWeave不是独立挂载卷。');
  const requested = process.env.TMPDIR ?? EXTERNAL_TEMPORARY;
  assert.ok(path.isAbsolute(requested), '真实Worker测试TMPDIR必须为外置绝对路径。');
  const parent = realpathSync(requested), approved = realpathSync(EXTERNAL_TEMPORARY);
  assert.ok(inside(approved, parent), '真实Worker测试TMPDIR不在批准的外置临时根内。');
  assert.ok(statSync(parent).isDirectory()); assert.equal(statSync(parent).dev, volume.dev);
  accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
  const directory = mkdtempSync(path.join(parent, 'mobile-main-codec-')); chmodSync(directory, 0o700);
  return directory;
}

async function prepareEntry(directory: string): Promise<{ entry: URL; mode: 'compiled' | 'declared'; files: FrozenFile[] }> {
  const entry = process.env.MUSIC_BRIDGE_PLAYBACK_CODEC_TEST_ENTRY;
  const sha = process.env.MB_MAC69_CODEC_ENTRY_SHA256;
  assert.equal(entry !== undefined, sha !== undefined, '显式Worker入口与SHA必须成对声明，不能回退到临时编译。');
  if (entry !== undefined) {
    assert.ok(path.isAbsolute(entry) && inside(EXTERNAL_VOLUME, entry), '显式Worker入口必须位于外置卷。');
    assert.equal(realpathSync(entry), entry); assert.ok(lstatSync(entry).isFile());
    assert.equal(statSync(entry).dev, statSync(EXTERNAL_VOLUME).dev);
    assert.match(sha!, /^[a-f0-9]{64}$/u);
    const frozen = snapshot(entry); assert.equal(frozen.sha256, sha);
    writeRecord(path.join(directory, 'entry-before.json'), { mode: 'declared', files: [frozen] });
    return { entry: pathToFileURL(entry), mode: 'declared', files: [frozen] };
  }

  // 从Core已明确声明的依赖解析，不能借用tsx的未声明传递依赖。
  const manifest = snapshot(coreManifest);
  const declared = JSON.parse(readFileSync(coreManifest, 'utf8')) as { devDependencies?: Record<string, string> };
  assert.equal(declared.devDependencies?.esbuild, COMPILER_VERSION);
  const requireCore = createRequire(coreManifest);
  const compilerFiles = [manifest, snapshot(requireCore.resolve('esbuild/package.json')), snapshot(requireCore.resolve('esbuild')),
    ...['package.json', 'apps/desktop/package.json', 'packages/contracts/package.json', 'pnpm-lock.yaml'].map(file => snapshot(path.join(repository, file)))];
  const compiler = requireCore('esbuild') as Compiler;
  assert.equal(compiler.version, COMPILER_VERSION, '真实Worker测试必须使用仓库声明的固定编译器版本。');
  const consumed = new Map<string, FrozenFile>(), output = path.join(directory, 'mobile-playback-state-worker-entry.mjs');
  let result: Awaited<ReturnType<Compiler['build']>>;
  try {
    result = await compiler.build({
      absWorkingDir: repository, entryPoints: [sourceEntry], outfile: output, bundle: true,
      platform: 'node', target: 'node22', format: 'esm', write: false, metafile: true,
      sourcemap: false, legalComments: 'none', logLevel: 'silent', tsconfigRaw: { compilerOptions: {} },
      plugins: [{ name: 'freeze-real-worker-inputs', setup(build: LoaderBuild) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
          const bytes = readFileSync(args.path), file = snapshot(args.path, bytes), prior = consumed.get(file.file);
          if (prior) assert.deepEqual(file, prior, '编译同一真实Worker输入时内容发生变化。');
          consumed.set(file.file, file);
          const extension = path.extname(args.path);
          const loader = ({ '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.json': 'json' } as Record<string, string>)[extension];
          assert.ok(loader, '真实Worker出现未声明的编译输入格式。');
          return { contents: bytes, loader, resolveDir: path.dirname(args.path) };
        });
      } }],
    });
  } finally { await compiler.stop(); }
  assert.ok(result.metafile); assert.equal(result.outputFiles?.length, 1);
  assert.equal(result.outputFiles![0]!.path, output);
  const inputNames = Object.keys(result.metafile.inputs), inputs = inputNames.map(name => {
    const file = consumed.get(realpathSync(path.resolve(repository, name)));
    assert.ok(file, 'metafile输入必须有编译读取前SHA证据。');
    assert.equal(file.bytes, result.metafile!.inputs[name]!.bytes); return file;
  });
  assert.equal(new Set(inputs.map(file => file.file)).size, consumed.size, '真实编译读取与metafile输入闭包必须一致。');
  assert.ok(inputs.some(file => file.file === realpathSync(sourceEntry)), '编译闭包必须包含真实生产Worker入口。');
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/u, '')));
  for (const built of Object.values(result.metafile.outputs)) for (const dependency of built.imports) {
    assert.ok(dependency.external && builtins.has(dependency.path.replace(/^node:/u, '')), '真实Worker产物不能留下未冻结的外部模块。');
  }
  unchanged([...compilerFiles, ...inputs]);
  writePrivate(output, result.outputFiles![0]!.contents);
  const metafile = path.join(directory, 'worker.metafile.json'); writeRecord(metafile, result.metafile);
  const files = [...compilerFiles, ...inputs, snapshot(output), snapshot(metafile)];
  const record = path.join(directory, 'entry-before.json');
  writeRecord(record, { mode: 'compiled', compilerVersion: compiler.version, files }); files.push(snapshot(record));
  return { entry: pathToFileURL(output), mode: 'compiled', files };
}

/** 仅为源码Main测试绑定真实产物；不替换codec、Owner、协议、持久ACK或生产预算。 */
export function installTestMobilePlaybackCodecWorker(): void {
  let cleanup: (() => Promise<void>) | undefined;
  before(async () => {
    const directory = temporaryDirectory(), prepared = await prepareEntry(directory);
    const OriginalWorker = threads.Worker;
    const workers: { jobs: number; closeMessages: number; errors: number; messageErrors: number;
      exitCode: number | null; joined: Promise<void> }[] = [];
    class BoundCodecWorker extends OriginalWorker {
      constructor(file: string | URL, options?: WorkerOptions) {
        const selected = file instanceof URL && file.href === defaultWorker.href;
        if (selected) {
          unchanged(prepared.files);
          assert.deepEqual(options, { execArgv: [], env: {}, name: 'mobile-playback-codec',
            workerData: { resourceCapacityDiagnostic: process.argv.includes('--mb-private-resource-capacity-trace') },
            resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 } });
        }
        super(selected ? prepared.entry : file, options);
        if (!selected) return;
        let exited!: () => void;
        const record = { jobs: 0, closeMessages: 0, errors: 0, messageErrors: 0, exitCode: null as number | null,
          joined: new Promise<void>(resolve => { exited = resolve; }) };
        workers.push(record);
        const originalPost = this.postMessage.bind(this);
        this.postMessage = (...args: Parameters<InstanceType<typeof OriginalWorker>['postMessage']>) => {
          const packet = args[0] as { protocol?: unknown; kind?: unknown } | null;
          if (packet && typeof packet === 'object' && packet.protocol === PLAYBACK_CODEC_PROTOCOL) {
            if (packet.kind === 'job') record.jobs++;
            if (packet.kind === 'close') record.closeMessages++;
          }
          originalPost(...args);
        };
        this.on('error', () => { record.errors++; }); this.on('messageerror', () => { record.messageErrors++; });
        this.once('exit', code => { record.exitCode = code; exited(); });
      }
    }
    (threads as unknown as { Worker: typeof OriginalWorker }).Worker = BoundCodecWorker; syncBuiltinESMExports();
    let closeFlight: Promise<void> | undefined;
    cleanup = () => closeFlight ??= (async () => {
      // 先还原进程级绑定；只接受产品close已完成的真实exit/join，不terminate或unref伪造静止。
      const currentWorker = threads.Worker;
      (threads as unknown as { Worker: typeof OriginalWorker }).Worker = OriginalWorker; syncBuiltinESMExports();
      const failures: unknown[] = [];
      try {
        assert.equal(currentWorker, BoundCodecWorker);
        assert.ok(workers.length > 0, '本组必须实际使用已核产物的真实codec Worker。');
        assert.ok(workers.every(worker => worker.exitCode !== null), '所有真实codec Worker必须在测试收尾前实际退出。');
        await Promise.all(workers.map(worker => worker.joined));
        for (const worker of workers) {
          assert.ok(worker.jobs > 0); assert.equal(worker.closeMessages, 1); assert.equal(worker.exitCode, 0);
          assert.equal(worker.errors, 0); assert.equal(worker.messageErrors, 0);
        }
      } catch (error) { failures.push(error); }
      let filesUnchanged = true;
      try { unchanged(prepared.files); } catch (error) { filesUnchanged = false; failures.push(error); }
      writeRecord(path.join(directory, 'worker-after.json'), { mode: prepared.mode, filesUnchanged,
        workerCount: workers.length, exitCount: workers.filter(worker => worker.exitCode !== null).length,
        workers: workers.map(({ joined: _joined, ...record }) => record) });
      if (failures.length) throw new AggregateError(failures, '真实codec Worker或编译输入未满足测试生命周期证据。');
    })();
  });
  after(async () => { await cleanup?.(); });
}
