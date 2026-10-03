"""仅对已自然关闭的 RUST015 合成库建立不可变只读 SQL 参照。"""
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
    match=re.fullmatch(r'scale-(0|100|2000|2001|5000|5001)-(fresh|cold)',run_key); assert match
    count=int(match[1]); assert receipt_path.is_absolute()
    receipt_artifact=artifact(receipt_path)
    receipt=json.loads(receipt_path.read_text())
    assert receipt['mainExit']=={'code':0,'signal':None}
    assert receipt['completion']=='closed' and not receipt['timedOut'] and not receipt['forceKilled']
    profile=secure(Path(receipt['profileDirectory']), True)
    assert re.fullmatch(r'musicbridge-ui-diagnostics-[A-Za-z0-9._-]+',profile.name)
    marker=json.loads(secure(profile/'rust015-profile.json').read_text())
    assert set(marker)=={'schemaVersion','kind','nonce','modelCount','seedReceipt'} and marker['schemaVersion']==1 and marker['kind']=='rust015-synthetic-profile'
    assert re.fullmatch(r'[a-f0-9-]{36}',marker['nonce']) and marker['modelCount']==count and receipt['kind']=='scale-'+str(count)
    seed_path=secure(Path(marker['seedReceipt']['path'])); assert seed_path==profile/'rust015-seed.json' and digest(seed_path)==marker['seedReceipt']['sha256']
    seed=json.loads(seed_path.read_text()); assert seed['modelCount']==count and seed['nonce']==marker['nonce'] and seed['seedDomainLedger']==seed['seedMainOutbox']==0 and seed['handlesClosedBeforeLaunch'] is True
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
    assert len(models)==count and len(lots)==count and len(skus)==count and len(ledger)==len(outbox)==(1 if count else 0)
    assert {r['id'] for r in models}=={r['modelId'] for r in seed['models']} and {r['id'] for r in skus}=={r['skuId'] for r in seed['models']} and {r['id'] for r in lots}=={r['lotId'] for r in seed['models']}
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
    assert len(dataset_ids)==(1 if count else 0)
    identities=[e['data']['identity']['datasetId'] for e in receipt['events'] if e['event']=='node.prepared']; assert len(identities)==1
    dataset_id=identities[0]; assert not dataset_ids or dataset_ids=={dataset_id}
    sku_by_id={r['id']:r for r in skus}
    model_skus={r['id']:[] for r in models}; model_lots={r['id']:[] for r in models}
    for r in skus:model_skus[r['model_id']].append(r)
    for r in lots:model_lots[sku_by_id[r['sku_id']]['model_id']].append(r)
    changed=json.loads(ledger[0]['event_data']) if ledger else None
    assert not changed or ledger[0]['action']=='set-policy' and changed['kind']=='POLICY_CHANGED'
    target_id=seed['policyModelId']
    def full_model(row, policy_done):
        identifier=row['id']; quantity=[sum(l[k] for l in model_lots[identifier]) for k in ('sealed','opened','legacy','unknown')]
        c=dict(zip(('sealedBlank','openedBlank','legacyUsed','unknown'),quantity));c.update(total=sum(quantity),recorded=0,reserved=0,unavailable=0)
        policy=row['policy'];minimum=row['minimum_sealed'];revision=row['revision']
        if changed and identifier==target_id and not policy_done:
            policy=changed['before']['policy'];minimum=changed['before']['minimumSealedReserve'];revision-=1
        return {**json.loads(row['descriptor']),'id':identifier,'collectorPolicy':policy,'minimumSealedReserve':minimum,'revision':revision,
          'lengths':[r['minutes'] or None for r in sorted(model_skus[identifier],key=lambda r:r['minutes'])], 'counts':c,'photoCount':0}
    final_models=[full_model(r,True) for r in models];before_models=[full_model(r,False) for r in models]
    assert sum(m['counts']['total'] for m in final_models)==count and all(m['counts']['openedBlank']==1 for m in final_models)
    if count:
        target=next(r for r in final_models if r['id']==target_id)
        assert target['collectorPolicy']=='collector' and target['minimumSealedReserve']==2 and target['revision']==2
    events=receipt['events']; requests=[e for e in events if e['actor']=='main' and e['event']=='main.request']
    responses={e['data']['reply']['id']:e for e in events if e['actor']=='main' and e['event']=='main.response'}
    writes=[]
    for e in requests:
        q=e['data']['request']
        if q['command']=='commandOutbox.execute':
            response=responses[q['id']]
            assert response['data']['reply']['ok'] is True
            writes.append((response['sequence'],q['payload'],response['data']['reply']['result']))
    assert len(writes)==(1 if count and run_key.endswith('fresh') else 0)
    assert all(w[1]['command']=='collection.setPolicy' for w in writes)
    refs=[]
    for e in requests:
        q=e['data']['request']; command=q['command']
        if command not in ('collection.list','collection.detail'):continue
        policy_done=run_key.endswith('cold') or any(w[0]<e['sequence'] for w in writes)
        items=final_models if policy_done else before_models
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
            eligible=[l for l in sorted(lots,key=lambda x:x['rowid'],reverse=True) if sku_by_id[l['sku_id']]['model_id']==identifier]
            dl=[]
            for l in eligible:
                sku=sku_by_id[l['sku_id']]
                dl.append({'id':l['id'],'skuId':l['sku_id'],'lengthMinutes':sku['minutes'] or None,'quantityAcquired':l['acquired'],'quantityAdjustment':l['quantity_adjustment'],
                'quantities':{'sealedBlank':l['sealed'],'openedBlank':l['opened'],'legacyUsed':l['legacy'],'unclassified':l['unknown']}})
            result={'model':model,'photos':[],'lots':page(dl,p),'copies':page([],p)}
        response=responses[q['id']]['data']['reply']
        assert response['ok'] is True and response['result']==result, '实际完整DTO与关闭SQL参照不同：'+q['id']
        refs.append({'requestId':q['id'],'command':command,'request':q,'oracle':result})
    db.close();box.close()
    assert frozen_before==[artifact(p) for p in copies]
    result={'schemaVersion':1,'task':'RUST-015','runKey':run_key,'runtimeEvidence':receipt_artifact,'profileDirectory':str(profile),
      'profileNonce':marker['nonce'],'datasetId':dataset_id,'modelCount':count,'seedReceipt':artifact(seed_path),'sourceFilesBefore':source_before,'sourceFilesAfter':[artifact(p) for p in files],
      'frozenFilesBefore':frozen_before,'frozenFilesAfter':[artifact(p) for p in copies],'immutableReadOnly':True,'integrityCheck':'ok','foreignKeyCheck':[],
      'models':models,'fullModels':final_models,'lots':lots,'skus':skus,'ledger':ledger,'outbox':outbox,'queryReferences':refs,'realUserData':'NOT_RUN'}
    assert result['sourceFilesAfter']==source_before
    output=destination/'reference.json'
    with output.open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.write('\n')
    print(json.dumps({'state':'PASS','reference':artifact(output),'queries':len(refs),'models':count,'writes':len(writes)},ensure_ascii=False))

if __name__=='__main__':
    assert len(sys.argv)==4
    capture(Path(sys.argv[1]),sys.argv[2],Path(sys.argv[3]))
