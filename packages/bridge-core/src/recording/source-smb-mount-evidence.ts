import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RootCapability } from './source-files.js';

export interface SourceSmbMountEvidence {
  version: 1;
  provider: 'DARWIN_KERNEL_FSTATFS_SMB_V1';
  mountSourceSha256: string;
  mountEvidenceSha256: string;
}
export class SourceSmbMountEvidenceError extends Error {
  constructor() { super('共享盘实际挂载来源或目录身份尚未证实。'); }
}
const executeFile = promisify(execFile);
const fields = ['version', 'provider', 'mountSourceSha256', 'mountEvidenceSha256'] as const;
export function isSourceSmbMountEvidence(value: unknown): value is SourceSmbMountEvidence {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length
    || fields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) return false;
  const proof = value as SourceSmbMountEvidence;
  return proof.version === 1 && proof.provider === 'DARWIN_KERNEL_FSTATFS_SMB_V1'
    && [proof.mountSourceSha256, proof.mountEvidenceSha256].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item));
}

// 只输出摘要；kernel挂载来源可能含用户名，绝不进入stdout、异常正文或进程参数。
// Python的ino_t是无符号值；与Node负数inode按同一64位位模式比较。
const nativeSmbEvidenceScript = `import os,sys,json,hashlib,ctypes
fd=None
mount_fd=None
try:
 p,dev,ino=sys.argv[1:]
 if sys.platform!='darwin': raise RuntimeError()
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 a=os.fstat(fd)
 mask=(1<<64)-1
 if str(a.st_dev)!=dev or (int(a.st_ino)&mask)!=(int(ino)&mask) or os.path.realpath(p)!=p: raise RuntimeError()
 class S(ctypes.Structure):
  _fields_=[('bsize',ctypes.c_uint32),('iosize',ctypes.c_int32),('blocks',ctypes.c_uint64),('bfree',ctypes.c_uint64),('bavail',ctypes.c_uint64),('files',ctypes.c_uint64),('ffree',ctypes.c_uint64),('fsid',ctypes.c_int32*2),('owner',ctypes.c_uint32),('type',ctypes.c_uint32),('flags',ctypes.c_uint32),('subtype',ctypes.c_uint32),('fstype',ctypes.c_char*16),('mountpoint',ctypes.c_char*1024),('source',ctypes.c_char*1024),('extended',ctypes.c_uint32),('reserved',ctypes.c_uint32*7)]
 libc=ctypes.CDLL(None,use_errno=True)
 probe=getattr(libc,'fstatfs$INODE64',None) or libc.fstatfs
 probe.argtypes=[ctypes.c_int,ctypes.POINTER(S)]
 probe.restype=ctypes.c_int
 x=S()
 if ctypes.sizeof(S)!=2168 or probe(fd,ctypes.byref(x))!=0 or bytes(x.fstype)!=b'smbfs': raise RuntimeError()
 fsid=[int(v)&0xffffffff for v in x.fsid]
 source=bytes(x.source)
 mountpoint=os.fsdecode(bytes(x.mountpoint))
 if fsid==[0,0] or not source.startswith(b'//') or len(source)>1023 or not os.path.isabs(mountpoint) or os.path.normpath(mountpoint)!=mountpoint: raise RuntimeError()
 if p!=mountpoint and not p.startswith(mountpoint.rstrip('/')+'/'): raise RuntimeError()
 if os.path.realpath(mountpoint)!=mountpoint: raise RuntimeError()
 mount_fd=os.open(mountpoint,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 mount_before=os.fstat(mount_fd)
 def same_stat(left,right):
  return left.st_dev==right.st_dev and (int(left.st_ino)&mask)==(int(right.st_ino)&mask) and left.st_birthtime==right.st_birthtime
 def same_mount(left,right):
  return list(left.fsid)==list(right.fsid) and left.fstype==right.fstype and left.source==right.source and left.mountpoint==right.mountpoint
 m=S()
 if mount_before.st_dev!=a.st_dev or not same_stat(mount_before,os.stat(mountpoint,follow_symlinks=False)) or probe(mount_fd,ctypes.byref(m))!=0 or not same_mount(x,m): raise RuntimeError()
 source_hash=hashlib.sha256(b'mousa-smb-source-v1\\0'+source).hexdigest()
 body={'version':1,'source':source_hash,'fsid':fsid,'dev':dev,'rootInoBits':str(int(a.st_ino)&mask),'rootPath':hashlib.sha256(os.fsencode(p)).hexdigest(),'mountPath':hashlib.sha256(os.fsencode(mountpoint)).hexdigest()}
 evidence_hash=hashlib.sha256(json.dumps(body,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 y=S()
 mount_after=S()
 if probe(fd,ctypes.byref(y))!=0 or not same_mount(x,y) or probe(mount_fd,ctypes.byref(mount_after))!=0 or not same_mount(x,mount_after): raise RuntimeError()
 if not same_stat(a,os.fstat(fd)) or not same_stat(a,os.stat(p,follow_symlinks=False)) or not same_stat(mount_before,os.fstat(mount_fd)) or not same_stat(mount_before,os.stat(mountpoint,follow_symlinks=False)): raise RuntimeError()
 print(json.dumps({'version':1,'provider':'DARWIN_KERNEL_FSTATFS_SMB_V1','mountSourceSha256':source_hash,'mountEvidenceSha256':evidence_hash},separators=(',',':')))
except BaseException:
 sys.exit(2)
finally:
 if mount_fd is not None: os.close(mount_fd)
 if fd is not None: os.close(fd)
`;

/** 来源摘要不含fsid/dev；本代证据另绑定实际挂载和原目录。仅持有短期目录FD。 */
export async function observeSourceSmbMountEvidence(root: RootCapability): Promise<SourceSmbMountEvidence> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) || !root.authorized
    || !path.isAbsolute(root.path) || path.resolve(root.path) !== root.path) throw new SourceSmbMountEvidenceError();
  const before = await lstat(root.path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || String(before.dev) !== root.dev || String(before.ino) !== root.ino
    || await realpath(root.path) !== root.path) throw new SourceSmbMountEvidenceError();
  const handle = await open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.birthtimeNs !== before.birthtimeNs) throw new SourceSmbMountEvidenceError();
    const result = await executeFile('/usr/bin/python3', ['-I', '-S', '-c', nativeSmbEvidenceScript, root.path, root.dev, root.ino],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, env: { LANG: 'C', LC_ALL: 'C' } });
    if (result.stderr !== '') throw new SourceSmbMountEvidenceError();
    const proof: unknown = JSON.parse(result.stdout);
    if (!isSourceSmbMountEvidence(proof)) throw new SourceSmbMountEvidenceError();
    const after = await lstat(root.path, { bigint: true }), held = await handle.stat({ bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs
      || held.dev !== before.dev || held.ino !== before.ino || held.birthtimeNs !== before.birthtimeNs || await realpath(root.path) !== root.path) throw new SourceSmbMountEvidenceError();
    return Object.freeze(proof);
  } catch { throw new SourceSmbMountEvidenceError(); }
  finally { try { await handle.close(); } catch { throw new SourceSmbMountEvidenceError(); } }
}
