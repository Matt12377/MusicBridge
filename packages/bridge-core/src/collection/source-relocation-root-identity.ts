import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RootCapability } from '../recording/source-files.js';
import { relocationHash, relocationFail, type RelocationRootIdentityData } from './local-relocation-journal.js';
import { checkRelocationIo, type RelocationIoOptions } from './source-relocation-verify.js';

const executeFile = promisify(execFile);
/** 原生statfs的fsid+实际挂载来源，卷再加实际diskutil UUID；任何输出都不打印挂载用户名或凭据。 */
const nativeIdentityScript = `import os,sys,json,hashlib,ctypes,subprocess,plistlib
p,dev,ino=sys.argv[1:]
fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 a=os.fstat(fd)
 if str(a.st_dev)!=dev or str(a.st_ino)!=ino: raise RuntimeError('root_changed')
 if sys.platform=='darwin':
  class S(ctypes.Structure):
   _fields_=[('bsize',ctypes.c_uint32),('iosize',ctypes.c_int32),('blocks',ctypes.c_uint64),('bfree',ctypes.c_uint64),('bavail',ctypes.c_uint64),('files',ctypes.c_uint64),('ffree',ctypes.c_uint64),('fsid',ctypes.c_int32*2),('owner',ctypes.c_uint32),('type',ctypes.c_uint32),('flags',ctypes.c_uint32),('subtype',ctypes.c_uint32),('fstype',ctypes.c_char*16),('mountpoint',ctypes.c_char*1024),('source',ctypes.c_char*1024),('extended',ctypes.c_uint32),('reserved',ctypes.c_uint32*7)]
  libc=ctypes.CDLL(None,use_errno=True); probe=getattr(libc,'fstatfs$INODE64',None) or libc.fstatfs
  probe.argtypes=[ctypes.c_int,ctypes.POINTER(S)]; probe.restype=ctypes.c_int
  x=S()
  if ctypes.sizeof(S)!=2168 or probe(fd,ctypes.byref(x))!=0: raise RuntimeError('unproven')
  fs=str(bytes(x.fstype),'ascii'); fsid=':'.join(str(int(v)&0xffffffff) for v in x.fsid)
  if fsid=='0:0' or not bytes(x.source): raise RuntimeError('unproven')
  share=fs in ('smbfs','nfs')
  if not share and fs not in ('apfs','hfs','exfat','msdos'): raise RuntimeError('unproven')
  source_hash=hashlib.sha256(bytes(x.source)).hexdigest()
  volume=None
  if not share:
   device=bytes(x.source).decode('utf-8','strict'); mountpoint=bytes(x.mountpoint).decode('utf-8','strict')
   if not device.startswith('/dev/') or not os.path.isabs(mountpoint) or os.path.normpath(mountpoint)!=mountpoint: raise RuntimeError('unproven')
   if not os.path.ismount(mountpoint) or os.stat(mountpoint,follow_symlinks=False).st_dev!=a.st_dev: raise RuntimeError('unproven')
   q=subprocess.run(['/usr/sbin/diskutil','info','-plist',device],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3,env={'LANG':'C','LC_ALL':'C'})
   if q.stderr or len(q.stdout)>65536: raise RuntimeError('unproven')
   d=plistlib.loads(q.stdout); volume=d.get('VolumeUUID') or d.get('APFSVolumeUUID')
   if not isinstance(volume,str) or len(volume)!=36 or ('Mounted' in d and d['Mounted'] is not True) or d.get('DeviceNode')!=device or d.get('MountPoint')!=mountpoint: raise RuntimeError('unproven')
   import uuid
   if str(uuid.UUID(volume))!=volume.lower(): raise RuntimeError('unproven')
   volume=volume.lower()
  y=S()
  if probe(fd,ctypes.byref(y))!=0 or list(x.fsid)!=list(y.fsid) or x.fstype!=y.fstype or x.source!=y.source or x.mountpoint!=y.mountpoint: raise RuntimeError('changed')
  identity=hashlib.sha256(json.dumps({'fsid':fsid,'source':source_hash,'volume':volume,'fs':fs},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  mount=hashlib.sha256(json.dumps({'fsid':fsid,'source':source_hash},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  print(json.dumps({'kind':'share' if share else 'volume','provider':'DARWIN_KERNEL_FSTATFS_SHARE_V1' if share else 'DARWIN_KERNEL_FSTATFS_DISKUTIL_UUID_V1','identity':identity,'mountIdentity':mount,'fileSystem':fs},separators=(',',':')))
 elif sys.platform.startswith('linux'):
  with open('/proc/self/mountinfo','rb') as f: raw=f.read(1048577)
  if len(raw)>1048576: raise RuntimeError('unproven')
  def unescape(v):
   import re
   return re.sub(rb'\\([0-7]{3})',lambda m: bytes([int(m.group(1),8)]),v)
  selected=[]; owned=os.fsencode(p)
  for line in raw.splitlines():
   before,after=line.split(b' - ',1); left=before.split(); right=after.split(); mount=unescape(left[4])
   if owned==mount or owned.startswith(mount.rstrip(b'/')+b'/'): selected.append((len(mount),left,right))
  if not selected: raise RuntimeError('unproven')
  _,left,right=max(selected,key=lambda v:v[0]); fs=right[0].decode('ascii'); source=unescape(right[1])
  share=fs in ('cifs','nfs','nfs4')
  if not share and fs not in ('ext2','ext3','ext4','xfs','btrfs','overlay','tmpfs','vfat','exfat'): raise RuntimeError('unproven')
  q=subprocess.run(['/usr/bin/stat','-f','-c','%i',p],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3,env={'LANG':'C','LC_ALL':'C'})
  fsid=q.stdout.strip().decode('ascii')
  if q.stderr or not fsid or len(fsid)>32 or set(fsid)<=set('0') or any(c not in '0123456789abcdefABCDEF' for c in fsid): raise RuntimeError('unproven')
  if share and (not source or source==b'none'): raise RuntimeError('unproven')
  source_hash=hashlib.sha256(source).hexdigest()
  identity=hashlib.sha256(json.dumps({'fsid':fsid,'source':source_hash,'fs':fs},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  mount=hashlib.sha256(json.dumps({'id':left[0].decode('ascii'),'parent':left[1].decode('ascii'),'device':left[2].decode('ascii'),'root':hashlib.sha256(unescape(left[3])).hexdigest(),'source':source_hash,'fsid':fsid},sort_keys=True,separators=(',',':')).encode()).hexdigest()
  print(json.dumps({'kind':'share' if share else 'volume','provider':'LINUX_KERNEL_MOUNTINFO_STATFS_SHARE_V1' if share else 'LINUX_KERNEL_MOUNTINFO_STATFS_VOLUME_V1','identity':identity,'mountIdentity':mount,'fileSystem':fs},separators=(',',':')))
 else: raise RuntimeError('unproven')
 b=os.fstat(fd); named=os.stat(p,follow_symlinks=False)
 if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino) or (b.st_dev,b.st_ino)!=(named.st_dev,named.st_ino): raise RuntimeError('changed')
finally: os.close(fd)
`;

/** 捕获实际OS卷或已挂载share身份；挂载显示名、label、JSON proof、单独dev/inode均不是替代。 */
export async function observeRelocationRootIdentity(root: RootCapability, options: RelocationIoOptions = {}): Promise<RelocationRootIdentityData> {
  checkRelocationIo(options);
  if (!root.authorized || !path.isAbsolute(root.path) || path.resolve(root.path) !== root.path || !['darwin', 'linux'].includes(process.platform)
      || !['arm64', 'x64'].includes(process.arch)) return relocationFail('ROOT_IDENTITY_UNPROVEN');
  const before = await lstat(root.path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || String(before.dev) !== root.dev || String(before.ino) !== root.ino || await realpath(root.path) !== root.path) return relocationFail('ROOT_CHANGED');
  const handle = await open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.birthtimeNs !== before.birthtimeNs) return relocationFail('ROOT_CHANGED');
    const result = await executeFile('/usr/bin/python3', ['-I', '-S', '-c', nativeIdentityScript, root.path, root.dev, root.ino],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16_384, env: { LANG: 'C', LC_ALL: 'C' }, ...(options.signal ? { signal: options.signal } : {}) });
    checkRelocationIo(options);
    if (result.stderr !== '') return relocationFail('ROOT_IDENTITY_UNPROVEN');
    const proof = JSON.parse(result.stdout) as Record<string, unknown>;
    if (Object.keys(proof).length !== 5 || !['volume', 'share'].includes(String(proof.kind)) || typeof proof.provider !== 'string'
      || typeof proof.fileSystem !== 'string' || !/^[a-z0-9]+$/u.test(proof.fileSystem)
      || ![proof.identity, proof.mountIdentity].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) return relocationFail('ROOT_IDENTITY_UNPROVEN');
    const after = await lstat(root.path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs || await realpath(root.path) !== root.path) return relocationFail('ROOT_CHANGED');
    const body = { version: 1 as const, platform: process.platform as 'darwin' | 'linux', kind: proof.kind as 'volume' | 'share',
      provider: proof.provider, identity: proof.identity as string, mountIdentity: proof.mountIdentity as string, fileSystem: proof.fileSystem,
      rootPhysical: { dev: root.dev, ino: root.ino } };
    return Object.freeze({ ...body, rootPhysical: Object.freeze(body.rootPhysical), fingerprint: relocationHash(body) });
  } catch { return relocationFail('ROOT_IDENTITY_UNPROVEN'); }
  finally { await handle.close(); }
}
export async function assertRelocationRootIdentity(root: RootCapability, expected: RelocationRootIdentityData, options: RelocationIoOptions = {}): Promise<void> {
  const current = await observeRelocationRootIdentity(root, options);
  if (current.fingerprint !== expected.fingerprint) relocationFail('ROOT_CHANGED');
}
export const sameRelocationStorage = (a: RelocationRootIdentityData, b: RelocationRootIdentityData): boolean => a.kind === b.kind && a.platform === b.platform
  && a.identity === b.identity && a.fileSystem === b.fileSystem;
