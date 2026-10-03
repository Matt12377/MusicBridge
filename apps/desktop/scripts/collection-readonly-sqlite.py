"""仅对已自然关闭的 RUST014 合成库建立不可变只读 SQL 参照。"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import unicodedata

EXTERNAL = Path('/Volumes/LifeWeave/Developer/CommandLine/tmp')

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def secure(p, directory=False):
    assert p.is_absolute() and p.is_relative_to(EXTERNAL) and p.resolve() == p
    assert not p.is_symlink() and (p.is_dir() if directory else p.is_file())
    assert p.stat().st_dev == EXTERNAL.stat().st_dev
    if not directory:
        assert p.stat().st_nlink == 1
    return p

def artifact(p):
    secure(p)
    return {'path':str(p),'sha256':digest(p),'bytes':p.stat().st_size}

def page(items, p):
    return {'items':items[p['offset']:p['offset']+p['limit']], 'offset':p['offset'],'limit':p['limit'],'total':len(items),'hasMore':p['offset']+p['limit']<len(items)}

def canonical(v):
    return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))

def capture(receipt_path, run_key, destination):
    assert run_key in ('node-fresh','node-cold','rust-fresh','rust-cold')
    receipt_artifact=artifact(receipt_path)
    receipt=json.loads(receipt_path.read_text())
    assert receipt['mainExit']=={'code':0,'signal':None}
    assert receipt['completion']=='closed' and not receipt['timedOut'] and not receipt['forceKilled']
    profile=secure(Path(receipt['profileDirectory']), True)
    assert re.fullmatch(r'musicbridge-ui-diagnostics-[A-Za-z0-9._-]+',profile.name)
    marker=json.loads(secure(profile/'rust014-profile.json').read_text())
    assert set(marker)=={'schemaVersion','kind','nonce'} and marker['schemaVersion']==1 and marker['kind']=='rust014-synthetic-profile'
    assert re.fullmatch(r'[a-f0-9-]{36}',marker['nonce'])
    data=secure(profile/'data',True)
    files=sorted(data.glob('*.sqlite'))
    assert [p.name for p in files]==['backup-maintenance.v1.sqlite','collection.v1.sqlite','command-outbox.v1.sqlite']
    assert not list(data.glob('*-wal')) and not list(data.glob('*-journal'))
    secure(destination.parent,True)
    destination.mkdir(mode=0o700)
    secure(destination,True)
    source_before=[artifact(p) for p in files]
    copies=[]
    for p in files:
        secure(p)
        copied=destination/p.name
        with p.open('rb') as src, copied.open('xb') as dst:
            shutil.copyfileobj(src,dst)
        copied.chmod(0o600)
        assert digest(copied)==digest(p)
        copies.append(copied)
    assert source_before==[artifact(p) for p in files]
    frozen_before=[artifact(p) for p in copies]
    def connection(name):
        db=sqlite3.connect((destination/name).as_uri()+'?mode=ro&immutable=1',uri=True)
        db.row_factory=sqlite3.Row
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        return db
    db=connection('collection.v1.sqlite')
    box=connection('command-outbox.v1.sqlite')
    def rows(db,sql):return [dict(r) for r in db.execute(sql)]
    models=rows(db,'SELECT rowid,id,descriptor,policy,minimum_sealed,revision FROM collection_models ORDER BY rowid DESC')
    lots=rows(db,'SELECT rowid,* FROM inventory_lots ORDER BY rowid')
    skus=rows(db,'SELECT rowid,* FROM collection_skus ORDER BY rowid')
    ledger=rows(db,'SELECT rowid,* FROM inventory_ledger ORDER BY rowid')
    outbox=rows(box,'SELECT e.rowid,e.id,e.command_id,e.request_json,s.state,s.updated_at,s.acknowledged,s.error_code,s.result_json FROM outbox_entries e JOIN outbox_states s ON s.id=e.id ORDER BY e.rowid')
    assert len(models)==26 and len(lots)==26 and len(skus)==26 and len(ledger)==27 and len(outbox)==27
    assert db.execute('SELECT count(*) FROM physical_copies').fetchone()[0]==0
    assert db.execute('SELECT count(*) FROM collection_photos').fetchone()[0]==0
    assert all(r['state']=='succeeded' and r['acknowledged']==1 and r['error_code'] is None for r in outbox)
    for r in outbox:
        req=json.loads(r['request_json']); domain=next(x for x in ledger if x['command_id']==r['command_id'])
        action={'collection.receive':'receive','collection.setPolicy':'set-policy'}[req['command']]
        assert domain['action']==action and json.loads(domain['result'])==json.loads(r['result_json'])
        assert hashlib.sha256(canonical({'action':action,'request':req['payload']}).encode()).hexdigest()==domain['fingerprint']
        assert hashlib.sha256(canonical({k:req[k] for k in ('datasetId','command','payload')}).encode()).hexdigest()==req['fingerprint']
    dataset_ids={json.loads(r['request_json'])['datasetId'] for r in outbox}
    assert len(dataset_ids)==1
    def full_model(row, policy_done):
        identifier=row['id']
        quantity=db.execute('SELECT COALESCE(sum(l.sealed),0),COALESCE(sum(l.opened),0),COALESCE(sum(l.legacy),0),COALESCE(sum(l.unknown),0) FROM inventory_lots l JOIN collection_skus s ON s.id=l.sku_id WHERE s.model_id=?',(identifier,)).fetchone()
        c=dict(zip(('sealedBlank','openedBlank','legacyUsed','unknown'),quantity)); c.update(total=sum(quantity),recorded=0,reserved=0,unavailable=0)
        policy=row['policy'];minimum=row['minimum_sealed'];revision=row['revision']
        if not policy_done and policy=='collector':
            policy='normal';minimum=0;revision-=1
        return {**json.loads(row['descriptor']),'id':identifier,'collectorPolicy':policy,'minimumSealedReserve':minimum,'revision':revision,
          'lengths':[r[0] or None for r in db.execute('SELECT minutes FROM collection_skus WHERE model_id=? ORDER BY minutes',(identifier,))], 'counts':c,'photoCount':0}
    final_models=[full_model(r,True) for r in models]
    target=next(r for r in final_models if r['name']=='RUST014 合成型号 01')
    assert target['collectorPolicy']=='collector' and target['minimumSealedReserve']==2 and target['revision']==2
    assert sum(m['counts']['total'] for m in final_models)==26 and all(m['counts']['openedBlank']==1 for m in final_models)
    events=receipt['events']; requests=[e for e in events if e['actor']=='main' and e['event']=='main.request']
    responses={e['data']['reply']['id']:e for e in events if e['actor']=='main' and e['event']=='main.response'}
    writes=[]
    for e in requests:
        q=e['data']['request']
        if q['command']=='commandOutbox.execute':
            response=responses[q['id']]
            assert response['data']['reply']['ok'] is True
            writes.append((response['sequence'],q['payload'],response['data']['reply']['result']))
    assert len(writes)==(27 if run_key.endswith('fresh') else 0)
    refs=[]
    for e in requests:
        q=e['data']['request']; command=q['command']
        if command not in ('collection.list','collection.detail'):continue
        if run_key.endswith('cold'):
            present={m['id'] for m in final_models};policy_done=True
        else:
            preceding=[w for w in writes if w[0]<e['sequence']]
            present={w[2]['result']['modelId'] for w in preceding if w[1]['command']=='collection.receive'}
            policy_done=any(w[1]['command']=='collection.setPolicy' for w in preceding)
        items=[full_model(r,policy_done) for r in models if r['id'] in present]
        payload=q['payload']; p=payload['page']
        if command=='collection.list':
            f=payload.get('filter') or {}
            conditions=[];values=[]
            if f.get('query','').strip():
                query=re.sub(r'\s+',' ',unicodedata.normalize('NFKC',f['query']).strip()).lower()
                conditions.append("instr(lower(json_extract(descriptor,'$.brand') || ' ' || json_extract(descriptor,'$.name') || ' ' || json_extract(descriptor,'$.edition')), ?) > 0");values.append(query)
            if f.get('brand','').strip():
                conditions.append("lower(json_extract(descriptor,'$.brand'))=?");values.append(re.sub(r'\s+',' ',unicodedata.normalize('NFKC',f['brand']).strip()).lower())
            if f.get('decade')=='unknown':conditions.append("json_extract(descriptor,'$.year') IS NULL")
            elif 'decade' in f:
                conditions.append("json_extract(descriptor,'$.year') BETWEEN ? AND ?");values.extend((f['decade'],f['decade']+9))
            if f.get('stockState')=='identified':conditions.append("json_extract(descriptor,'$.identification')='verified'")
            elif f.get('stockState')=='needs-review':conditions.append("json_extract(descriptor,'$.identification')<>'verified'")
            elif f.get('stockState')=='recorded':conditions.append('0')
            elif f.get('stockState')=='blank':conditions.append('1')
            matching={r[0] for r in db.execute('SELECT id FROM collection_models'+(' WHERE '+' AND '.join(conditions) if conditions else ''),values)}
            result=page([m for m in items if m['id'] in matching],p)
        else:
            identifier=payload['modelId'];model=next(m for m in items if m['id']==identifier)
            eligible=[l for l in sorted(lots,key=lambda x:x['rowid'],reverse=True) if next(s for s in skus if s['id']==l['sku_id'])['model_id']==identifier]
            dl=[]
            for l in eligible:
                sku=next(s for s in skus if s['id']==l['sku_id'])
                dl.append({'id':l['id'],'skuId':l['sku_id'],'lengthMinutes':sku['minutes'] or None,'quantityAcquired':l['acquired'],'quantityAdjustment':l['quantity_adjustment'],
                'quantities':{'sealedBlank':l['sealed'],'openedBlank':l['opened'],'legacyUsed':l['legacy'],'unclassified':l['unknown']}})
            result={'model':model,'photos':[],'lots':page(dl,p),'copies':page([],p)}
        response=responses[q['id']]['data']['reply']
        assert response['ok'] is True and response['result']==result, '实际完整DTO与关闭SQL参照不同：'+q['id']
        refs.append({'requestId':q['id'],'command':command,'request':q,'oracle':result})
    db.close();box.close()
    assert frozen_before==[artifact(p) for p in copies]
    result={'schemaVersion':1,'task':'RUST-014','runKey':run_key,'runtimeEvidence':receipt_artifact,'profileDirectory':str(profile),
      'profileNonce':marker['nonce'],'datasetId':next(iter(dataset_ids)),'sourceFilesBefore':source_before,'sourceFilesAfter':[artifact(p) for p in files],
      'frozenFilesBefore':frozen_before,'frozenFilesAfter':[artifact(p) for p in copies],'immutableReadOnly':True,'integrityCheck':'ok','foreignKeyCheck':[],
      'models':models,'fullModels':final_models,'lots':lots,'skus':skus,'ledger':ledger,'outbox':outbox,'queryReferences':refs,'realUserData':'NOT_RUN'}
    assert result['sourceFilesAfter']==source_before
    output=destination/'reference.json'
    with output.open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
    print(json.dumps({'state':'PASS','reference':artifact(output),'queries':len(refs),'models':26,'writes':len(writes)},ensure_ascii=False))

if __name__=='__main__':
    assert len(sys.argv)==4
    capture(Path(sys.argv[1]),sys.argv[2],Path(sys.argv[3]))
