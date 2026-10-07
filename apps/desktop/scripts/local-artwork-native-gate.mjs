import { builtinModules, createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildStoragePolicy } from './build-storage-root.mjs'
import { verifiedElectronExecution } from './electron-identity.mjs'
import { runStartupProcess } from './startup-gate-process.mjs'
import { testElectronArguments } from './test-keychain.mjs'

// 真实 Electron nativeImage 门禁；合成图片，不连接账号或真实媒体库。
const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repository = path.resolve(desktop, '../..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
let directory
let stage = 'storage-admission'
try {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('父门禁要求 Node22。')
  const storage = buildStoragePolicy()
  storage.check(os.tmpdir(), { mustExist: true })
  directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-artwork-native-'))
  storage.check(directory, { mustExist: true })
  const helper = path.join(desktop, 'src/main/local-artwork-image.ts')
  const png = path.join(repository, 'packages/bridge-core/test/fixtures/mbrs003/audio/inputs/cover-small.png')
  const before = [helper, png].map(async file => ({ file: path.relative(repository, file), sha256: digest(await readFile(file)) }))
  const inputs = await Promise.all(before)
  const require = createRequire(path.join(repository, 'packages/bridge-core/package.json'))
  const esbuild = await import(pathToFileURL(require.resolve('esbuild')).href)
  const entry = path.join(directory, 'entry.mjs'), bundle = path.join(directory, 'gate.cjs')
  const source = `
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {app,nativeImage} from 'electron';
import {normalizeLocalArtwork as normalizeLocalArtworkImage} from ${JSON.stringify(helper)};
const sha=b=>createHash('sha256').update(b).digest('hex');
app.setPath('userData',${JSON.stringify(directory)});
app.setPath('sessionData',${JSON.stringify(directory)});
;(async()=>{
try {
  await app.whenReady();
  let nativeCalls=0;
  const decode=b=>{nativeCalls++;return nativeImage.createFromBuffer(b)};
  const small=await readFile(${JSON.stringify(png)});
  const first=normalizeLocalArtworkImage(small,decode);
  assert.equal(first.original.sha256,sha(small));
  assert.equal(first.original.width,16);assert.equal(first.original.height,16);
  const decoded=nativeImage.createFromDataURL(first.display.dataUrl);
  assert.equal(decoded.isEmpty(),false);assert.deepEqual(decoded.getSize(),{width:16,height:16});
  const bitmap=Buffer.alloc(1500*800*4,127);
  for(let i=3;i<bitmap.length;i+=4)bitmap[i]=255;
  const generated=nativeImage.createFromBitmap(bitmap,{width:1500,height:800,scaleFactor:1}).toPNG();
  const resized=normalizeLocalArtworkImage(generated,decode);
  assert.equal(resized.original.sha256,sha(generated));assert.equal(resized.original.width,1500);
  assert.ok(resized.display.width<=1200&&resized.display.height<=1200);assert.ok(resized.display.bytes<=1024*1024);
  assert.notEqual(resized.original.sha256,resized.display.sha256);
  assert.deepEqual(nativeImage.createFromDataURL(resized.display.dataUrl).getSize(),{width:resized.display.width,height:resized.display.height});
  const jpeg=nativeImage.createFromBuffer(generated).toJPEG(85);
  const reencoded=normalizeLocalArtworkImage(jpeg,decode);
  assert.equal(reencoded.original.mime,'image/jpeg');assert.equal(reencoded.original.sha256,sha(jpeg));
  const damaged=Buffer.from(small);damaged[29]^=1;
  const beforeReject=nativeCalls;assert.throws(()=>normalizeLocalArtworkImage(damaged,decode));assert.equal(nativeCalls,beforeReject);
  await writeFile(${JSON.stringify(path.join(directory, 'native-result.json'))},JSON.stringify({schema:'mbrs010.native-image.v1',electron:process.versions.electron,node:process.versions.node,pngOriginal:first.original,pngDisplay:{...first.display,dataUrl:undefined},largeOriginal:resized.original,largeDisplay:{...resized.display,dataUrl:undefined},jpegOriginal:reencoded.original,nativeCalls,damagedRejectedBeforeNative:true,account:'NOT_RUN',roon:'NOT_RUN',audio:'NOT_RUN',owner:'NOT_RUN'})+String.fromCharCode(10),{flag:'wx',mode:0o600});
  console.log('LOCAL_ARTWORK_NATIVE_GATE_PASS');
  app.quit();
} catch (error) {await writeFile(${JSON.stringify(path.join(directory, 'native-failure.json'))},JSON.stringify({name:error?.name,message:error?.message})+String.fromCharCode(10),{flag:'wx',mode:0o600});console.error('LOCAL_ARTWORK_NATIVE_GATE_FAIL');app.exit(1)}
})();
`
  await writeFile(entry, source, { flag: 'wx', mode: 0o600 })
  stage = 'esbuild-native-entry'
  try { await esbuild.build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'cjs', platform: 'node', target: 'node22', external: ['electron', ...builtinModules.flatMap(value => [value, value.startsWith('node:') ? value : 'node:' + value])], logLevel: 'silent' }) }
  finally { esbuild.stop() }
  const electron = verifiedElectronExecution()
  stage = 'native-electron-process'
  const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete childEnv.NETEASE_COOKIE
  delete childEnv.ELECTRON_RUN_AS_NODE
  const result = await runStartupProcess(electron.executablePath, testElectronArguments([bundle], 'mock'), { cwd: directory, env: childEnv, expectedMarker: 'LOCAL_ARTWORK_NATIVE_GATE_PASS', readyMarker: 'LOCAL_ARTWORK_NATIVE_GATE_PASS' })
  const after = await Promise.all([helper, png].map(async file => ({ file: path.relative(repository, file), sha256: digest(await readFile(file)) })))
  const closed = result.closed && result.code === 0 && result.signal === null && result.markerSeen && !result.failure
  const unchanged = JSON.stringify(inputs) === JSON.stringify(after)
  const nativeProof = closed ? JSON.parse(await readFile(path.join(directory, 'native-result.json'), 'utf8')) : null
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify({ schema: 'mbrs010.native-gate-receipt.v1', inputIdentities: inputs, unchanged, electronIdentity: electron, result, nativeProof, pass: closed && unchanged, realKeychain: 'NOT_RUN', ordinaryApp: 'NOT_RUN', owner: 'NOT_RUN' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  if (!closed || !unchanged) throw new Error('原生门禁未闭合。')
  console.log('封面原生图片门禁通过；合成图片，真实账号与 Owner 验收另行记录。')
  console.log(`NATIVE_ARTWORK_EVIDENCE=${directory}`)
} catch (error) {
  if (directory) await writeFile(path.join(directory, 'failure.json'), JSON.stringify({stage,errorName:error instanceof Error?error.name:'Unknown',message:error instanceof Error?error.message.slice(0,2048):'准备未完成'},null,2)+'\n',{flag:'wx',mode:0o600})
  console.error('封面原生图片门禁失败，保留当前证据。')
  if (directory) console.error(`NATIVE_ARTWORK_EVIDENCE=${directory}`)
  process.exitCode = 1
}
