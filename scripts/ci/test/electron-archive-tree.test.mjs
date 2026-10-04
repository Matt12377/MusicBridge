import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const script = fileURLToPath(new URL('../../../apps/desktop/scripts/electron-archive-tree.py', import.meta.url));
// 合成ZIP覆盖同一生产比较器；这里不宣称官方Electron输入已准备或执行。
const producer = `import pathlib,zipfile,stat,hashlib,os,sys,json
r=pathlib.Path(sys.argv[1]);mode=sys.argv[2];p=r/'package';d=p/'dist';d.mkdir(parents=True)
a=r/'synthetic.zip';exe='Electron.app/Contents/MacOS/Electron'
entries={exe:b'official-synthetic-exe', 'Electron.app/Contents/Frameworks/fixture.dylib':b'framework', 'version':b'43.4.0', 'electron.d.ts':b'types'}
with zipfile.ZipFile(a,'w') as z:
 for name,data in entries.items():
  info=zipfile.ZipInfo(name);info.external_attr=(stat.S_IFREG|0o755)<<16;z.writestr(info,data)
  item=p/name if name=='electron.d.ts' else d/name;item.parent.mkdir(parents=True,exist_ok=True);item.write_bytes(data);item.chmod(0o755)
 info=zipfile.ZipInfo('Electron.app/Contents/link');info.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(info,'MacOS/Electron');(d/'Electron.app/Contents/link').symlink_to('MacOS/Electron')
 if mode=='traversal': z.writestr('../outside',b'bad')
 if mode=='duplicate': z.writestr(exe,b'duplicate')
 if mode=='escaping':
  info=zipfile.ZipInfo('escape');info.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(info,'../outside')
if mode=='changed': (d/exe).write_bytes(b'changed')
if mode=='extra': (d/'extra').write_bytes(b'extra')
if mode=='missing': (d/'Electron.app/Contents/Frameworks/fixture.dylib').unlink()
if mode=='link': (d/'Electron.app/Contents/link').unlink();(d/'Electron.app/Contents/link').symlink_to('../outside')
print(json.dumps([str(a),str(p),hashlib.sha256(a.read_bytes()).hexdigest(),exe]))
`;
for (const mode of ['valid', 'changed', 'extra', 'missing', 'link', 'traversal', 'duplicate', 'escaping', 'wrong-sha']) test('官方ZIP全树比较器合成边界：' + mode, () => {
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
  const run = mkdtempSync(path.join(process.env.TMPDIR, 'musicbridge-electron-tree-')), file = path.join(run, 'produce.py'); writeFileSync(file, producer);
  const prepare = spawnSync('python3', [file, run, mode], { encoding: 'utf8' }); assert.equal(prepare.status, 0, prepare.stderr);
  const args = JSON.parse(prepare.stdout); if (mode === 'wrong-sha') args[2] = '0'.repeat(64);
  const result = spawnSync('python3', [script, ...args], { encoding: 'utf8' });
  if (mode === 'valid') { assert.equal(result.status, 0, result.stderr); assert.match(JSON.parse(result.stdout).executableSha256, /^[a-f0-9]{64}$/u); }
  else assert.equal(result.status, 1, result.stdout);
});
