import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, lstatSync, openSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { withDatasetVolumeIdentity } from '../src/recording/dataset-volume-identity.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-volume-fd-')), file = path.join(directory, 'owned.sqlite');
  await writeFile(file, '合成工作库物理身份', { mode: 0o600 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const info = lstatSync(file, { bigint: true });
  return { directory, file, expected: { dev: String(info.dev), ino: String(info.ino), birthtime_ns: String(info.birthtimeNs) } };
}

test('真实自有文件FD读取稳定卷；非Darwin保持原物理路径且不伪造UUID', async t => {
  const f = await fixture(t);
  const first = withDatasetVolumeIdentity(f.file, f.expected, value => value);
  const second = withDatasetVolumeIdentity(f.file, f.expected, value => value);
  assert.equal(first, second);
  if (process.platform === 'darwin') assert.match(first ?? '', /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
  else assert.equal(first, undefined);
});

test('Darwin持有原FD跨绑定回调，文件替换或新增硬链接均不能完成绑定', { skip: process.platform !== 'darwin' }, async t => {
  for (const action of ['replace', 'hardlink', 'symlink'] as const) await t.test(action, async child => {
    const f = await fixture(child), { renameSync, writeFileSync, linkSync } = await import('node:fs');
    if (action === 'symlink') {
      const alias = path.join(f.directory, 'alias.sqlite'); await symlink(f.file, alias);
      assert.throws(() => withDatasetVolumeIdentity(alias, f.expected, () => assert.fail('符号链接不能进入绑定。')));
      return;
    }
    let entered = false;
    assert.throws(() => withDatasetVolumeIdentity(f.file, f.expected, () => {
      entered = true;
      if (action === 'replace') { renameSync(f.file, f.file + '.old'); writeFileSync(f.file, '合成替换文件'); }
      else linkSync(f.file, f.file + '.hardlink');
      return true;
    }), error => error instanceof Error && 'code' in error && error.code === 'OUTBOX_SCOPE_MISMATCH');
    assert.equal(entered, true, '必须到达已证明原FD后的绑定窗口。');
  });
});

/** 只模拟原生读出叶；实际执行完整生产Python程序，fd3和mount FD仍指向自有真实文件/目录。 */
const controlledNative = String.raw`import os,sys,json,ctypes,subprocess,types,io,contextlib,errno,time
program,file,fault,*markers=sys.argv[1:]
directory=os.path.dirname(file); real_fstat,real_stat,real_open=os.fstat,os.stat,os.open
initial=real_fstat(3); calls={}; named_calls={}; mounts=[]; volumes=0; children=0; objects={}; retained=set(); next_ref=100
def forbidden_process(*args,**kwargs):
 global children
 children+=1
 raise RuntimeError('unexpected_process')
subprocess.Popen=forbidden_process
for name in ('fork','forkpty','posix_spawn','posix_spawnp','system'):
 if hasattr(os,name): setattr(os,name,forbidden_process)
def physical(s):
 return types.SimpleNamespace(st_mode=s.st_mode,st_nlink=s.st_nlink,st_dev=s.st_dev,st_ino=s.st_ino,st_birthtime=getattr(s,'st_birthtime',17.0))
def fstat(fd): return physical(real_fstat(fd))
def named(name,*args,**kwargs):
 value=physical(real_stat(name,*args,**kwargs)); named_calls[name]=named_calls.get(name,0)+1
 if fault=='file-replaced' and name==file and named_calls[name]>1: value.st_ino+=1
 if fault=='mount-replaced' and name==directory and named_calls[name]>1: value.st_ino+=1
 return value
def opened(name,flags,*args,**kwargs):
 if name!=directory or flags!=(os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW): raise RuntimeError('unexpected_open')
 fd=real_open(name,flags,*args,**kwargs); mounts.append(fd); return fd
class Probe:
 def __call__(self,fd,pointer):
  calls[fd]=calls.get(fd,0)+1; out=pointer._obj
  out.fsid[0]=17; out.fsid[1]=29; out.fstype=b'apfs'; out.source=b'/dev/musicbridge-controlled-volume'; out.mountpoint=os.fsencode(directory)
  if fault=='source-changed' and fd==3 and calls[fd]>1: out.source=b'/dev/musicbridge-other-volume'
  return 0
probe=Probe(); library=types.SimpleNamespace(fstatfs=probe); setattr(library,'fstatfs$INODE64',probe)
keys={'kDADiskDescriptionVolumeUUIDKey':1,'kDADiskDescriptionVolumeKindKey':2,'kDADiskDescriptionVolumePathKey':3,'kDADiskDescriptionMediaBSDNameKey':4}
class Pointer(ctypes.c_void_p):
 @classmethod
 def in_dll(cls,lib,name): return cls(keys[name])
ctypes.c_void_p=Pointer
class NativeCall:
 def __init__(self,callback): self.callback=callback
 def __call__(self,*args): return self.callback(*args)
def reference(kind,value=None,owned=False):
 global next_ref
 next_ref+=1; objects[next_ref]=(kind,value)
 if owned: retained.add(next_ref)
 return next_ref
def release(ref):
 if ref not in retained: raise RuntimeError('unexpected_release')
 retained.remove(ref)
def session(allocator): return 0 if fault=='session-unavailable' else reference(10,owned=True)
def disk(allocator,session,device):
 if device!=b'/dev/musicbridge-controlled-volume': raise RuntimeError('unexpected_device')
 return 0 if fault=='disk-unavailable' else reference(11,owned=True)
def bsd_name(disk): return b'musicbridge-other-volume' if fault=='wrong-source' else b'musicbridge-controlled-volume'
def description(disk):
 global volumes
 volumes+=1
 if fault=='outer-timeout':
  with open(markers[0],'x') as marker: marker.write(str(os.getpid()))
  time.sleep(30)
 if fault=='description-unavailable': return 0
 value='2c68789d-2c95-4232-bcaf-87ba18e56861' if fault=='uuid-changed' and volumes>1 else '7f7df5a2-31ad-4dbc-9d0f-9ee197e46c1d'
 if fault=='zero-uuid': value='00000000-0000-0000-0000-000000000000'
 if fault=='malformed-uuid': value='not-a-volume-uuid'
 values={1:reference(2 if fault=='uuid-wrong-type' else 1,value),2:reference(2,'hfs' if fault=='wrong-kind' else 'apfs'),3:reference(3,directory+'/other' if fault=='wrong-mount' else directory),4:reference(2,'other' if fault=='wrong-description-source' else 'musicbridge-controlled-volume')}
 if fault=='uuid-unavailable': del values[1]
 return reference(4,values,True)
def text(ref,buffer,length,encoding):
 value=objects[ref][1].encode('utf-8')
 if fault=='string-budget': value=b'x'*2048
 if encoding!=0x08000100 or len(value)>=length: return 0
 buffer.value=value; return 1
def url(ref,resolve,buffer,length):
 value=os.fsencode(objects[ref][1])
 if not resolve or len(value)>=length: return 0
 buffer.value=value; return 1
cf=types.SimpleNamespace(**{name:NativeCall(callback) for name,callback in {
 'CFGetTypeID':lambda ref:objects[ref][0],'CFDictionaryGetTypeID':lambda:4,'CFUUIDGetTypeID':lambda:1,'CFStringGetTypeID':lambda:2,'CFURLGetTypeID':lambda:3,
 'CFDictionaryGetValue':lambda ref,key:objects[ref][1].get(key,0),'CFStringGetCString':text,'CFURLGetFileSystemRepresentation':url,
 'CFUUIDCreateString':lambda allocator,ref:reference(2,objects[ref][1],True),'CFRelease':release}.items()})
da=types.SimpleNamespace(**{name:NativeCall(callback) for name,callback in {'DASessionCreate':session,'DADiskCreateFromBSDName':disk,'DADiskGetBSDName':bsd_name,'DADiskCopyDescription':description}.items()})
def load(name,*args,**kwargs):
 if name is None: return library
 if name=='/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation': return cf
 if name=='/System/Library/Frameworks/DiskArbitration.framework/DiskArbitration': return da
 raise RuntimeError('unexpected_library')
os.fstat,os.stat,os.open=fstat,named,opened; ctypes.CDLL=load; sys.platform='darwin'
sys.argv=['original-native',file,str(initial.st_dev),str(initial.st_ino)]
output=io.StringIO(); errors=io.StringIO(); stage=None
try:
 with contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors): exec(compile(program,'original-dataset-volume','exec'),{'__builtins__':__builtins__})
except BaseException as error: stage=str(error) if isinstance(error,RuntimeError) and str(error) in ('unproven','changed') else 'unexpected'
alive=0
for fd in mounts:
 try: real_fstat(fd); alive+=1
 except OSError as error:
  if error.errno!=errno.EBADF: raise
print(json.dumps({'stage':stage,'mounts':len(mounts),'mountsStillOpen':alive,'outputPresent':bool(output.getvalue()),'stderrPresent':bool(errors.getvalue()),'volumes':volumes,'children':children,'retained':len(retained)},separators=(',',':')))
`;

async function nativeProgram(): Promise<string> {
  const source = await readFile(new URL('../src/recording/dataset-volume-identity.ts', import.meta.url), 'utf8');
  const literal = /const nativeDatasetVolumeScript = (`[\s\S]*?`);/u.exec(source)?.[1]; assert.ok(literal); assert.equal(literal.includes('${'), false);
  const program: unknown = runInNewContext(literal, Object.create(null), { timeout: 1000 }); assert.equal(typeof program, 'string');
  return program as string;
}

test('受控原生读出：只在原Python进程读取UUID，所有拒绝均释放mount与CF引用且不派生进程', async t => {
  const f = await fixture(t), program = await nativeProgram();
  for (const fault of ['none', 'uuid-changed', 'source-changed', 'file-replaced', 'mount-replaced', 'wrong-source', 'wrong-description-source', 'wrong-mount', 'wrong-kind', 'string-budget', 'session-unavailable', 'disk-unavailable', 'description-unavailable', 'uuid-unavailable', 'uuid-wrong-type', 'zero-uuid', 'malformed-uuid']) {
    const fd = openSync(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let result: { stage: string | null; mounts: number; mountsStillOpen: number; outputPresent: boolean; stderrPresent: boolean; volumes: number; children: number; retained: number };
    try {
      result = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', controlledNative, program, f.file, fault], {
        encoding: 'utf8', timeout: 6000, maxBuffer: 16_384, env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', fd],
      }));
    } finally { closeSync(fd); }
    assert.equal(result.mounts, 1, fault); assert.equal(result.mountsStillOpen, 0, fault); assert.equal(result.stderrPresent, false, fault);
    assert.equal(result.children, 0, fault); assert.equal(result.retained, 0, fault);
    assert.equal(result.stage, fault === 'none' ? null : ['uuid-changed', 'source-changed', 'file-replaced', 'mount-replaced'].includes(fault) ? 'changed' : 'unproven', fault);
    assert.equal(result.outputPresent, fault === 'none', fault);
    if (fault === 'none' || fault === 'uuid-changed') assert.equal(result.volumes, 2, fault);
  }
});

test('原生读取阻塞时外层超时回收唯一Python进程，不遗留diskutil孙进程', async t => {
  const f = await fixture(t), program = await nativeProgram(), marker = path.join(f.directory, 'helper.pid');
  const fd = openSync(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.throws(() => execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', controlledNative, program, f.file, 'outer-timeout', marker], {
      encoding: 'utf8', timeout: 1500, maxBuffer: 16_384, killSignal: 'SIGKILL', env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', fd],
    }), error => error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT' && 'signal' in error && error.signal === 'SIGKILL');
  } finally { closeSync(fd); }
  const pid = Number(readFileSync(marker, 'utf8')); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), error => error instanceof Error && 'code' in error && error.code === 'ESRCH');
});
