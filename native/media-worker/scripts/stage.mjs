import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertExternalPath, assertRegularOutput, ensureOwnedOutput, publishOutputBytes, sourceIdentity } from './storage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1]
  if (!['--source', '--destination'].includes(key) || !value || options.has(key)) throw new Error('媒体 Worker staging 参数无效。')
  options.set(key, value)
}
const source = options.get('--source') ?? path.join(root, 'native/media-worker/bin', `${process.platform}-${process.arch}`)
if (!path.isAbsolute(source)) throw new Error('媒体 Worker 来源目录必须是绝对路径。')
assertExternalPath(source)
assertRegularOutput(path.join(source, 'manifest.json'))
const manifest = JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8'))
const identity = sourceIdentity(path.join(root, 'native/media-worker'))
const executable = manifest.platform === 'win32' ? 'musicbridge-media-worker.exe' : 'musicbridge-media-worker'
if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1 || manifest.parserVersion !== 'musicbridge-rust-media/v1'
  || !['release', 'development'].includes(manifest.buildProfile === undefined ? 'release' : manifest.buildProfile)
  || !['darwin', 'linux', 'win32'].includes(manifest.platform) || !['arm64', 'x64'].includes(manifest.arch)
  || manifest.sourceIdentity !== identity || manifest.binary?.relativePath !== executable || !/^[a-f0-9]{64}$/u.test(manifest.binary.sha256)) throw new Error('媒体 Worker 构建清单无效。')
const destination = options.get('--destination') ?? path.join(root, 'apps/desktop/native/media-worker', `${manifest.platform}-${manifest.arch}`)
if (!path.isAbsolute(destination)) throw new Error('媒体 Worker staging 目录必须是绝对路径。')
assertExternalPath(destination)
const sourceBinary = path.join(source, executable), facts = lstatSync(sourceBinary)
assertRegularOutput(sourceBinary)
if (!facts.isFile() || facts.isSymbolicLink() || facts.mode & 0o022 || facts.size !== manifest.binary.size || facts.size > 96 * 1024 * 1024) throw new Error('媒体 Worker 构建文件身份无效。')
const bytes = readFileSync(sourceBinary)
if (createHash('sha256').update(bytes).digest('hex') !== manifest.binary.sha256) throw new Error('媒体 Worker 构建摘要不匹配。')
ensureOwnedOutput(destination, identity, `stage-${manifest.platform}-${manifest.arch}`, ['bin', 'manifest.json'])
assertExternalPath(path.join(destination, 'bin'))
if (existsSync(path.join(destination, 'bin')) && readdirSync(path.join(destination, 'bin')).some(name => name !== executable)) throw new Error('媒体 Worker staging 二进制目录含其他文件，已停止。')
mkdirSync(path.join(destination, 'bin'), { recursive: true })
const binary = path.join(destination, 'bin', executable)
assertRegularOutput(binary); assertRegularOutput(path.join(destination, 'manifest.json'))
publishOutputBytes(binary, bytes, 0o755)
publishOutputBytes(path.join(destination, 'manifest.json'), JSON.stringify({ ...manifest, binary: { ...manifest.binary, relativePath: `bin/${executable}` } }, null, 2) + '\n')
console.info(JSON.stringify({ message: '媒体 Worker staging 完成', binary, sha256: manifest.binary.sha256 }))
