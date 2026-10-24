import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, type BigIntStats } from 'node:fs';
import path from 'node:path';

export interface DatasetFileIdentity { readonly dev: string; readonly ino: string; readonly birthtime_ns: string }
export const isDatasetVolumeUUID = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  && value !== '00000000-0000-0000-0000-000000000000';
class DatasetVolumeIdentityError extends Error {
  readonly code = 'OUTBOX_SCOPE_MISMATCH';
  constructor() { super('原数据库的稳定卷身份尚未获得完整证明，原登记保留。'); }
}
const unproven = (): never => { throw new DatasetVolumeIdentityError(); };

/** 只读继承的原数据库FD；卷UUID必须与真实fstatfs来源、持有挂载FD及命名对象前后相符。 */
const nativeDatasetVolumeScript = `import os,sys,json,ctypes,uuid,stat
p,dev,ino=sys.argv[1:]
if sys.platform!='darwin': raise RuntimeError('unproven')
fd=3
def physical(s): return (s.st_dev,s.st_ino,s.st_birthtime)
def named():
 s=os.stat(p,follow_symlinks=False)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise RuntimeError('changed')
 return s
a=os.fstat(fd)
if not stat.S_ISREG(a.st_mode) or a.st_nlink!=1 or str(a.st_dev)!=dev or str(a.st_ino)!=ino or physical(a)!=physical(named()): raise RuntimeError('changed')
class S(ctypes.Structure):
 _fields_=[('bsize',ctypes.c_uint32),('iosize',ctypes.c_int32),('blocks',ctypes.c_uint64),('bfree',ctypes.c_uint64),('bavail',ctypes.c_uint64),('files',ctypes.c_uint64),('ffree',ctypes.c_uint64),('fsid',ctypes.c_int32*2),('owner',ctypes.c_uint32),('type',ctypes.c_uint32),('flags',ctypes.c_uint32),('subtype',ctypes.c_uint32),('fstype',ctypes.c_char*16),('mountpoint',ctypes.c_char*1024),('source',ctypes.c_char*1024),('extended',ctypes.c_uint32),('reserved',ctypes.c_uint32*7)]
libc=ctypes.CDLL(None,use_errno=True); probe=getattr(libc,'fstatfs$INODE64',None) or libc.fstatfs
probe.argtypes=[ctypes.c_int,ctypes.POINTER(S)]; probe.restype=ctypes.c_int
def mount(fd):
 s=S()
 if ctypes.sizeof(S)!=2168 or probe(fd,ctypes.byref(s))!=0: raise RuntimeError('unproven')
 return (tuple(int(v) for v in s.fsid),bytes(s.fstype),bytes(s.source),bytes(s.mountpoint))
initial=mount(fd); fs=initial[1].decode('ascii','strict'); device=initial[2].decode('utf-8','strict'); mountpoint=initial[3].decode('utf-8','strict')
if initial[0]==(0,0) or fs not in ('apfs','hfs','exfat','msdos') or not device.startswith('/dev/') or not os.path.isabs(mountpoint) or os.path.normpath(mountpoint)!=mountpoint: raise RuntimeError('unproven')
# 本机SDK的DADisk.h/CFUUID.h/CFString.h/CFURL.h：同步只读描述，不创建子进程或注册回调。
cf=ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
da=ctypes.CDLL('/System/Library/Frameworks/DiskArbitration.framework/DiskArbitration')
pointer=ctypes.c_void_p
def declare(library,name,arguments,result):
 call=getattr(library,name); call.argtypes=arguments; call.restype=result; return call
session_create=declare(da,'DASessionCreate',[pointer],pointer)
disk_create=declare(da,'DADiskCreateFromBSDName',[pointer,pointer,ctypes.c_char_p],pointer)
disk_name=declare(da,'DADiskGetBSDName',[pointer],ctypes.c_char_p)
description_copy=declare(da,'DADiskCopyDescription',[pointer],pointer)
type_id=declare(cf,'CFGetTypeID',[pointer],ctypes.c_ulong)
dictionary_type=declare(cf,'CFDictionaryGetTypeID',[],ctypes.c_ulong)()
uuid_type=declare(cf,'CFUUIDGetTypeID',[],ctypes.c_ulong)()
string_type=declare(cf,'CFStringGetTypeID',[],ctypes.c_ulong)()
url_type=declare(cf,'CFURLGetTypeID',[],ctypes.c_ulong)()
dictionary_value=declare(cf,'CFDictionaryGetValue',[pointer,pointer],pointer)
string_copy=declare(cf,'CFStringGetCString',[pointer,pointer,ctypes.c_long,ctypes.c_uint32],ctypes.c_ubyte)
url_copy=declare(cf,'CFURLGetFileSystemRepresentation',[pointer,ctypes.c_ubyte,pointer,ctypes.c_long],ctypes.c_ubyte)
uuid_string=declare(cf,'CFUUIDCreateString',[pointer,pointer],pointer)
release=declare(cf,'CFRelease',[pointer],None)
keys={name:pointer.in_dll(da,name).value for name in ('kDADiskDescriptionVolumeUUIDKey','kDADiskDescriptionVolumeKindKey','kDADiskDescriptionVolumePathKey','kDADiskDescriptionMediaBSDNameKey')}
if not all(keys.values()): raise RuntimeError('unproven')
def field(description,key,kind):
 value=dictionary_value(description,keys[key])
 if not value or type_id(value)!=kind: raise RuntimeError('unproven')
 return value
def text(value):
 if not value or type_id(value)!=string_type: raise RuntimeError('unproven')
 buffer=ctypes.create_string_buffer(1024)
 if not string_copy(value,buffer,len(buffer),0x08000100): raise RuntimeError('unproven')
 return buffer.value.decode('utf-8','strict')
def volume():
 session=disk=description=identifier=None
 try:
  session=session_create(None)
  if not session: raise RuntimeError('unproven')
  disk=disk_create(None,session,device.encode('utf-8'))
  if not disk: raise RuntimeError('unproven')
  bsd=disk_name(disk)
  if not bsd or '/dev/'+bsd.decode('utf-8','strict')!=device: raise RuntimeError('unproven')
  description=description_copy(disk)
  if not description or type_id(description)!=dictionary_type: raise RuntimeError('unproven')
  if '/dev/'+text(field(description,'kDADiskDescriptionMediaBSDNameKey',string_type))!=device or text(field(description,'kDADiskDescriptionVolumeKindKey',string_type))!=fs: raise RuntimeError('unproven')
  location=field(description,'kDADiskDescriptionVolumePathKey',url_type); buffer=ctypes.create_string_buffer(1024)
  if not url_copy(location,1,buffer,len(buffer)) or buffer.value.decode('utf-8','strict')!=mountpoint: raise RuntimeError('unproven')
  identifier=uuid_string(None,field(description,'kDADiskDescriptionVolumeUUIDKey',uuid_type))
  value=text(identifier)
  if len(value)!=36: raise RuntimeError('unproven')
  try: canonical=str(uuid.UUID(value))
  except ValueError: raise RuntimeError('unproven')
  if canonical!=value.lower() or uuid.UUID(canonical).int==0: raise RuntimeError('unproven')
  return canonical
 finally:
  for value in (identifier,description,disk,session):
   if value: release(value)
mount_named=os.stat(mountpoint,follow_symlinks=False)
if not stat.S_ISDIR(mount_named.st_mode) or mount_named.st_dev!=a.st_dev: raise RuntimeError('unproven')
mount_fd=os.open(mountpoint,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 opened=os.fstat(mount_fd)
 if physical(opened)!=physical(mount_named) or mount(mount_fd)!=initial: raise RuntimeError('changed')
 before=volume()
 if mount(fd)!=initial or mount(mount_fd)!=initial: raise RuntimeError('changed')
 after=volume()
 if before!=after or mount(fd)!=initial or mount(mount_fd)!=initial or physical(opened)!=physical(os.fstat(mount_fd)) or physical(opened)!=physical(os.stat(mountpoint,follow_symlinks=False)) or physical(a)!=physical(os.fstat(fd)) or physical(a)!=physical(named()): raise RuntimeError('changed')
 print(json.dumps({'version':1,'volumeUUID':before},separators=(',',':')))
finally: os.close(mount_fd)
`;

function matches(info: BigIntStats, expected: DatasetFileIdentity): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
    && String(info.dev) === expected.dev && String(info.ino) === expected.ino && String(info.birthtimeNs) === expected.birthtime_ns;
}

/** 同步私有启动边界；没有注入卷身份、平台或执行器的IPC/环境配置入口。 */
export function withDatasetVolumeIdentity<T>(file: string, expected: DatasetFileIdentity, work: (volumeUUID: string | undefined) => T): T {
  if (process.platform !== 'darwin') return work(undefined);
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(file) || realpathSync(file) !== file || !matches(lstatSync(file, { bigint: true }), expected)) return unproven();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!matches(fstatSync(fd, { bigint: true }), expected)) return unproven();
    const output = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', nativeDatasetVolumeScript, file, expected.dev, expected.ino], {
      encoding: 'utf8', timeout: 8500, maxBuffer: 16_384, killSignal: 'SIGKILL',
      env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', fd],
    });
    const proof: unknown = JSON.parse(output);
    if (!proof || typeof proof !== 'object' || Reflect.ownKeys(proof).length !== 2
      || !('version' in proof) || proof.version !== 1 || !('volumeUUID' in proof) || !isDatasetVolumeUUID(proof.volumeUUID)) return unproven();
    const current = () => matches(fstatSync(fd!, { bigint: true }), expected) && matches(lstatSync(file, { bigint: true }), expected) && realpathSync(file) === file;
    if (!current()) return unproven();
    const result = work(proof.volumeUUID);
    if (!current()) return unproven();
    return result;
  } catch { return unproven(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
