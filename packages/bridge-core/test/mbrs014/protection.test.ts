import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { createCollectionRepository } from '../../src/collection/repository.js';

test('014 持久保护：无 AssetID 的 Frozen 绑定仍有当前与历史物理投影，重开保留', async t => {
  const f = await preparationFixture(t), job = await f.freeze(); await f.versions.idle();
  assert.equal(f.versions.job(job.id).job?.state, 'completed');
  assert.ok('sourceProtection' in f.repository, '独立来源保护必须由原 SQLite Owner 提供');
  const initial = f.repository.sourceProtection.snapshot();
  assert.equal(initial.complete, true);
  assert.ok(initial.references.some(ref => ref.kind === 'MASTER' && ref.locations.some(location => location.physical !== null)));
  const bytes = await readFile(f.file);
  const alternate = path.join(f.directory, 'alternate'); await mkdir(alternate);
  const hardlink = path.join(alternate, 'same.wav'); await link(f.file, hardlink);
  const relocated = path.join(alternate, 'copy.wav'); await copyFile(f.file, relocated);
  const root = await f.sources.authorize(randomUUID(), alternate), trackId = f.draft.trackIds[0]!;
  const before = f.repository.sources.linked(f.draft.draftId, trackId)!;
  const moved = f.sources.start({ commandId: randomUUID(), draftId: f.draft.draftId, trackId, rootId: root.id, relocateBindingId: before.id, acquisition: 'userFileBind' }, relocated);
  await f.sources.idle(); assert.equal(f.sources.job(moved.id).job?.state, 'completed');
  const projected = f.repository.sourceProtection.snapshot();
  const reference = projected.references.find(ref => ref.kind === 'MASTER' && ref.bindingId === before.id)!;
  assert.ok(reference.locations.some(location => location.relative === 'fixture.wav'));
  assert.ok(reference.locations.some(location => location.relative === 'copy.wav'));
  assert.equal(new Set(reference.locations.map(location => location.physical && `${location.physical.dev}:${location.physical.ino}`)).size, 2);
  assert.deepEqual(await readFile(f.file), bytes);
  const reopened = createCollectionRepository({ filePath: f.filePath });
  try { assert.deepEqual(reopened.sourceProtection.snapshot().references, projected.references); }
  finally { reopened.close(); }
});

test('014 损坏历史：重复键 snapshot 不能被解析覆盖后自证，原字节保持', async t => {
  const f = await preparationFixture(t); await f.freeze(); await f.versions.idle();
  assert.ok('sourceProtection' in f.repository);
  const db = new DatabaseSync(f.filePath);
  const row = db.prepare("SELECT command_id,result FROM source_ledger WHERE result LIKE '{%' LIMIT 1").get()!;
  const original = String(row.result), damaged = original.replace('{', '{"invalidated":true,');
  db.exec('DROP TRIGGER source_ledger_no_update'); db.prepare('UPDATE source_ledger SET result=? WHERE command_id=?').run(damaged, String(row.command_id)); db.close();
  const evidence = f.repository.sourceProtection.snapshot();
  assert.equal(evidence.complete, false); assert.ok(evidence.issues.includes('HISTORY_CORRUPT'));
  const verify = new DatabaseSync(f.filePath, { readOnly: true });
  try { assert.equal(verify.prepare('SELECT result FROM source_ledger WHERE command_id=?').get(String(row.command_id))?.result, damaged); }
  finally { verify.close(); }
});

test('014 巨型旧行：SQLite长度预检先拒超预算，不能先把JSON搬入Node再检查',async t=>{
  const f=await preparationFixture(t);await f.freeze();await f.versions.idle();
  const db=new DatabaseSync(f.filePath),damagedRow=db.prepare('SELECT rowid AS n FROM source_bindings LIMIT 1').get()!.n;
  db.prepare('UPDATE source_bindings SET data=? WHERE rowid=?').run(JSON.stringify({damaged:'x'.repeat(9*1024*1024)}),damagedRow as number);db.close();
  const prepare=DatabaseSync.prototype.prepare;let loaded=0;
  t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
    const statement=prepare.call(this,sql);if(sql!=='SELECT * FROM source_bindings WHERE rowid=?')return statement;
    return new Proxy(statement,{get(target,key){if(key==='get')return(...args:unknown[])=>{if(args[0]===damagedRow)loaded++;return Reflect.apply(target.get,target,args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  });
  const projection=f.repository.sourceProtection.snapshot();assert.equal(projection.complete,false);assert.ok(projection.issues.includes('SOURCE_PROTECTION_BUDGET_EXCEEDED'));assert.equal(loaded,0);
});
