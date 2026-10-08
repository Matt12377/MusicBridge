import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { observeRelocationRootIdentity, assertRelocationRootIdentity } from '../src/collection/source-relocation-root-identity.js';
import type { RootCapability } from '../src/recording/source-files.js';

const executeFile = promisify(execFile);

async function readonlyRoot(directory: string): Promise<RootCapability> {
  const canonical = await realpath(directory), info = await lstat(canonical, { bigint: true });
  assert.equal(info.isDirectory(), true); assert.equal(info.isSymbolicLink(), false);
  return { id: randomUUID(), path: canonical, dev: String(info.dev), ino: String(info.ino), authorized: true, label: '测试只读底层身份，不代表服务资格或移动授权' };
}

async function ownedRoot(t: TestContext): Promise<RootCapability> {
  const candidate = process.env.TMPDIR;
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error('只读回归须显式提供批准根内的TMPDIR。');
  const temporary = buildStoragePolicy().check(candidate, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-relocation-root-identity-'));
  const capability = await readonlyRoot(directory);
  t.diagnostic('只新建批准临时根内的自有空目录；不读取HOME内容、不写用户目录、不取得服务资格。');
  return capability;
}

/** 用实际JS模板生成的Python，不直接把TypeScript源码中的反斜线当作运行时程序。 */
async function nativeProgram(): Promise<string> {
  const source = await readFile(new URL('../src/collection/source-relocation-root-identity.ts', import.meta.url), 'utf8');
  const literal = /const nativeIdentityScript = (`[\s\S]*?`);/u.exec(source)?.[1];
  assert.ok(literal); assert.equal(literal.includes('${'), false);
  const cooked: unknown = runInNewContext(literal, Object.create(null), { timeout: 1000 });
  assert.equal(typeof cooked, 'string');
  if (typeof cooked !== 'string') throw new Error('实际原生身份脚本不是完整字符串。');
  return cooked;
}

/*
 * 受控unit：Darwin ABI、statfs读出与diskutil输出不是此宿主的真实卷事实。
 * 原cooked程序完整执行；os.open/close以及底层fstat/stat仍读取真实自有目录FD。
 * Linux仅为Darwin的birthtime增加稳定unit轴；真实Linux身份另由上面原observe正例执行。
 * 故障输出只有有限stage及FD集合，不输出HOME、实际设备、UUID或原始stderr。
 */
const controlledDarwinReads = String.raw`import os,sys,json,ctypes,subprocess,plistlib,uuid,types,io,contextlib,errno
program,owned,fault=sys.argv[1:]
real_open,real_close,real_fstat,real_stat=os.open,os.close,os.fstat,os.stat
initial=real_stat(owned,follow_symlinks=False)
birth=getattr(initial,'st_birthtime',17.0)
opened=[]; closed=[]; roles={}; fstat_calls={}; probe_calls={}; named_calls=0; fault_applied=False
device='/dev/musicbridge-controlled-unit-only'

def opened_fd(name,flags,*args,**kwargs):
 if name!=owned or flags!=(os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW) or len(opened)>=2: raise RuntimeError('unexpected_open')
 value=real_open(name,flags,*args,**kwargs)
 role='root' if not opened else 'mount'
 roles[value]=role; opened.append({'kind':role,'fd':value})
 return value

def closed_fd(value):
 real_close(value)
 try: real_fstat(value)
 except OSError as error:
  if error.errno!=errno.EBADF: raise
 else: raise RuntimeError('fd_still_open')
 closed.append({'kind':roles[value],'fd':value})

def physical(raw,point):
 global fault_applied
 values={'st_dev':raw.st_dev,'st_ino':raw.st_ino,'st_birthtime':getattr(raw,'st_birthtime',birth)}
 for axis in ('dev','ino','birth'):
  if fault==point+':'+axis:
   field={'dev':'st_dev','ino':'st_ino','birth':'st_birthtime'}[axis]
   values[field]+=1; fault_applied=True
 return types.SimpleNamespace(**values)

def read_fd(value):
 raw=real_fstat(value); fstat_calls[value]=fstat_calls.get(value,0)+1
 role=roles[value]; count=fstat_calls[value]
 point=('physical-before' if count==1 else 'physical-after') if role=='mount' else 'root-read'
 return physical(raw,point)

def read_name(name,*args,**kwargs):
 global named_calls
 if name!=owned or kwargs!={'follow_symlinks':False}: raise RuntimeError('unexpected_named_read')
 named_calls+=1
 return physical(real_stat(name,*args,**kwargs),'named-after' if named_calls==2 else 'named-stable')

class Probe:
 def __call__(self,value,pointer):
  global fault_applied
  probe_calls[value]=probe_calls.get(value,0)+1
  out=pointer._obj; out.fsid[0]=17; out.fsid[1]=29
  out.fstype=b'apfs'; out.source=device.encode('ascii'); out.mountpoint=os.fsencode(owned)
  point='mount-before' if probe_calls[value]==1 else 'mount-after'
  if roles[value]=='mount':
   for axis in ('fsid','fstype','source','mountpoint'):
    if fault==point+':'+axis:
     if axis=='fsid': out.fsid[0]+=1
     elif axis=='fstype': out.fstype=b'hfs'
     elif axis=='source': out.source=b'/dev/musicbridge-other-unit-only'
     else: out.mountpoint=os.fsencode(owned+'/changed-unit-only')
     fault_applied=True
  return 0

probe=Probe(); library=types.SimpleNamespace(fstatfs=probe)
setattr(library,'fstatfs$INODE64',probe)

def diskutil_read(arguments,**kwargs):
 if arguments!=['/usr/sbin/diskutil','info','-plist',device] or kwargs!={'check':True,'stdout':subprocess.PIPE,'stderr':subprocess.PIPE,'timeout':3,'env':{'LANG':'C','LC_ALL':'C'}}: raise RuntimeError('unexpected_diskutil')
 data={'VolumeUUID':'63a17150-0307-4cd0-b744-4f1a59fb8c62','Mounted':True,'DeviceNode':device,'MountPoint':owned}
 return subprocess.CompletedProcess(arguments,0,stdout=plistlib.dumps(data),stderr=b'')

os.open,os.close,os.fstat,os.stat=opened_fd,closed_fd,read_fd,read_name
os.path.ismount=lambda value:False
ctypes.CDLL=lambda *args,**kwargs:library
subprocess.run=diskutil_read
sys.platform='darwin'
sys.argv=['controlled-unit-original-native',owned,str(initial.st_dev),str(initial.st_ino)]
native_stdout=io.StringIO(); native_stderr=io.StringIO(); stage=None
try:
 with contextlib.redirect_stdout(native_stdout),contextlib.redirect_stderr(native_stderr):
  exec(compile(program,'original-cooked-native-identity','exec'),{'__builtins__':__builtins__})
except BaseException as error:
 stage=str(error) if isinstance(error,RuntimeError) and str(error) in ('unproven','changed','root_changed') else 'unexpected_native_exception'
alive=[]
for entry in opened:
 try: real_fstat(entry['fd'])
 except OSError as error:
  if error.errno!=errno.EBADF: raise
 else: alive.append(entry)
emitted=native_stdout.getvalue()
result={'fixture':'CONTROLLED_DARWIN_ABI_UNIT_REAL_DIRECTORY_FDS_NOT_OS_QUALIFICATION','stage':stage,'faultApplied':fault_applied,'opened':opened,'closed':closed,'stillOpen':alive,'nativeOutputWritten':bool(emitted),'nativeStderrWritten':bool(native_stderr.getvalue())}
if fault=='none' and stage is None: result['nativeIdentity']=json.loads(emitted)
print(json.dumps(result,separators=(',',':')))
`;

interface FdEvent { kind: 'root' | 'mount'; fd: number }
interface NativeReadResult {
  fixture: string; stage: string | null; faultApplied: boolean; opened: FdEvent[]; closed: FdEvent[]; stillOpen: FdEvent[];
  nativeOutputWritten: boolean; nativeStderrWritten: boolean;
  nativeIdentity?: { kind: string; provider: string; identity: string; mountIdentity: string; fileSystem: string };
}

async function controlledRead(root: RootCapability, program: string, fault: string): Promise<NativeReadResult> {
  const result = await executeFile('/usr/bin/python3', ['-I', '-S', '-B', '-c', controlledDarwinReads, program, root.path, fault], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 16384, env: { LANG: 'C', LC_ALL: 'C' },
  });
  // Python内部只记录有限错误stage；不把原始原生stderr转成公开断言输出。
  assert.equal(result.stderr.length, 0, '受控unit不得泄漏原始原生stderr。');
  const value = JSON.parse(result.stdout) as NativeReadResult;
  assert.equal(value.fixture, 'CONTROLLED_DARWIN_ABI_UNIT_REAL_DIRECTORY_FDS_NOT_OS_QUALIFICATION');
  return value;
}

function descriptorsClosed(value: NativeReadResult): void {
  assert.deepEqual(value.opened.map(entry => entry.kind), ['root', 'mount'], '故障必须到达真实持有mount FD，不能由更早拒绝替代。');
  assert.equal(new Set(value.opened.map(entry => entry.fd)).size, 2);
  assert.deepEqual(value.closed, [...value.opened].reverse(), '原程序必须先关闭mount FD，再关闭root FD。');
  assert.deepEqual(value.stillOpen, []); assert.equal(value.nativeStderrWritten, false);
}

test('现有HOME规范目录经实际原生observe只读证明底层身份，不证明服务资格', async () => {
  assert.ok(['darwin', 'linux'].includes(process.platform), '此真实回归须在受支持的Darwin或Linux实际执行，不跳过。');
  const root = await readonlyRoot(await realpath(homedir()));
  const before = await lstat(root.path, { bigint: true }), proof = await observeRelocationRootIdentity(root), after = await lstat(root.path, { bigint: true });
  assert.equal(proof.platform, process.platform); assert.deepEqual(proof.rootPhysical, { dev: root.dev, ino: root.ino });
  assert.match(proof.fingerprint, /^[a-f0-9]{64}$/u); assert.match(proof.identity, /^[a-f0-9]{64}$/u); assert.match(proof.mountIdentity, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(proof), true); assert.equal(Object.isFrozen(proof.rootPhysical), true);
  for (const axis of ['dev', 'ino', 'birthtimeNs'] as const) assert.equal(after[axis], before[axis]);
  // 不创建HOME下的材料，不读目录内容，不启用service/policy/grant。
});

test('批准临时根内自有空目录真实读取与再验证一致，Linux原分支实际执行', async t => {
  const root = await ownedRoot(t), proof = await observeRelocationRootIdentity(root);
  await assertRelocationRootIdentity(root, proof);
  assert.equal(proof.platform, process.platform); assert.deepEqual(proof.rootPhysical, { dev: root.dev, ino: root.ino });
  assert.match(proof.provider, process.platform === 'darwin' ? /^DARWIN_KERNEL_FSTATFS_(?:SHARE|DISKUTIL_UUID)_V1$/u : /^LINUX_KERNEL_MOUNTINFO_STATFS_(?:SHARE|VOLUME)_V1$/u);
});

test('受控Darwin读出unit：ismount误报false时原cooked程序以真实持有FD完成对账并关闭', async t => {
  const root = await ownedRoot(t), result = await controlledRead(root, await nativeProgram(), 'none');
  descriptorsClosed(result); assert.equal(result.stage, null); assert.equal(result.faultApplied, false); assert.equal(result.nativeOutputWritten, true);
  assert.ok(result.nativeIdentity); assert.equal(result.nativeIdentity.kind, 'volume'); assert.equal(result.nativeIdentity.fileSystem, 'apfs');
  assert.equal(result.nativeIdentity.provider, 'DARWIN_KERNEL_FSTATFS_DISKUTIL_UUID_V1');
  assert.match(result.nativeIdentity.identity, /^[a-f0-9]{64}$/u); assert.match(result.nativeIdentity.mountIdentity, /^[a-f0-9]{64}$/u);
  // 这是受控ABI与原程序行为的unit正例；上面的合成原生读出不是实际Mac卷资格。
});

test('受控Darwin读出unit：mount FD前后四轴任一失配均拒绝且真实FD全部关闭', async t => {
  const root = await ownedRoot(t), program = await nativeProgram();
  for (const point of ['mount-before', 'mount-after']) for (const axis of ['fsid', 'fstype', 'source', 'mountpoint']) {
    const result = await controlledRead(root, program, `${point}:${axis}`);
    descriptorsClosed(result); assert.equal(result.faultApplied, true, '受控故障必须实际进入原程序读出。');
    assert.equal(result.stage, point === 'mount-before' ? 'unproven' : 'changed', `${point} ${axis}必须保守拒绝。`);
    assert.equal(result.nativeOutputWritten, false, '四轴失配不得打印身份成功输出。');
  }
});

test('受控Darwin读出unit：mount持有和命名对象dev/ino/birth变更均拒绝且不残留FD', async t => {
  const root = await ownedRoot(t), program = await nativeProgram();
  for (const point of ['physical-before', 'physical-after', 'named-after']) for (const axis of ['dev', 'ino', 'birth']) {
    const result = await controlledRead(root, program, `${point}:${axis}`);
    descriptorsClosed(result); assert.equal(result.faultApplied, true, '实际fstat/stat读出故障必须进入原始对账。');
    assert.equal(result.stage, 'changed', `${point} ${axis}不能冒充原持有目录对象。`);
    assert.equal(result.nativeOutputWritten, false);
  }
});
