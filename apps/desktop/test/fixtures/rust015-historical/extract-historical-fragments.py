import argparse, pathlib, hashlib, json
p=argparse.ArgumentParser();p.add_argument('--source05',required=True);p.add_argument('--source08',required=True);p.add_argument('--output',required=True);a=p.parse_args()
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
expected={'05':'03ed7e49782d32c422da6d6d8ec653442862b48f830610f743fd3119391026ef','08':'4cf19b78de49a243b425bcf56a67d6ceea3bdaf287568e4b91e0555001f2b4c5'}
raw={};events={};manifest={'kind':'HISTORICAL_LOCAL_FRAGMENTS_NOT_APP_GATE','sources':{},'fragments':[]}
for key,file in [('05',a.source05),('08',a.source08)]:
 raw[key]=pathlib.Path(file).read_bytes();digest=hashlib.sha256(raw[key]).hexdigest();assert digest==expected[key];events[key]=json.loads(raw[key])['events'];manifest['sources'][key]={'raw_sha256':digest,'raw_bytes':len(raw[key]),'raw_event_count':len(events[key]),'source_relative_ref':f'candidate-015-{key}/runs/scale-0-fresh/runtime-evidence.json'}
def save(name,key,indices,selector):
 value={'kind':'HISTORICAL_LOCAL_FRAGMENT','source':key,'source_raw_sha256':expected[key],'selector':selector,'original_event_indices':indices,'events':[events[key][i] for i in indices]};data=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode();(out/name).write_bytes(data)
 assert all(value['events'][n]==events[key][i] for n,i in enumerate(indices));manifest['fragments'].append({'file':name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'events':len(indices),'indices':indices,'selector':selector,'field_policy':'完整原事件对象；不改字段、顺序、PID、actor序号或时钟'})
action='bbff1a25-949c-4054-812d-5a8c755a2130';indices=[i for i,e in enumerate(events['05']) if e['data'].get('actionId')==action];assert len(indices)==47;save('source05-multi-read-fragment.json','05',indices,{'action_id':action})
main=[(i,e) for i,e in enumerate(events['05']) if e['actor']=='main'];skips=[(i,e) for i,e in main if e['event']=='main.domResetSkipped'];assert len(skips)==2
for ordinal,(si,skip) in enumerate(skips):
 prefix=[(i,e) for i,e in main if e['sequence']<skip['sequence']];settled=[(i,e) for i,e in prefix if e['event']=='main.domSettled'][-1];last=[(i,e) for i,e in prefix if e['event']=='main.ipcReply' and e['data']['channel']=='collection:list'][-1]
 catalog=[(i,e) for i,e in prefix if e['event']=='main.ipcReply' and any(r['event']=='main.ipcRequest' and r['data']['invokeId']==e['data']['invokeId'] and r['data']['channel']=='collection:list' and r['data']['args'][0].get('limit')==24 for _,r in prefix)][-1]
 request=next((i,e) for i,e in prefix if e['event']=='main.ipcRequest' and e['data']['invokeId']==catalog[1]['data']['invokeId']);background=next((i,e) for i,e in prefix if e['event']=='main.ipcRequest' and e['data']['invokeId']==last[1]['data']['invokeId']);assert background[1]['data']['args'][0]['limit']==1
 indices=[i for i,e in sorted([settled,request,catalog,background,last,(si,skip)],key=lambda t:t[1]['sequence'])];save(f'source05-reset-{ordinal+1}-fragment.json','05',indices,{'skip_main_sequence':skip['sequence'],'algorithm':'原测试same latestCatalog/settled/background/skip六事件'})
action=next(e for e in events['08'] if e['event']=='main.domAction' and e['data'].get('operation')=='settings-open')['data']['actionId'];indices=[i for i,e in enumerate(events['08']) if e['data'].get('actionId')==action];assert len(indices)==15;save('source08-settings-discard-fragment.json','08',indices,{'first_settings_open_action_id':action,'algorithm':'原action所有事件；完整保留settled和late renderer.discarded'})
(out/'provenance.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'fragment_count':len(manifest['fragments']),'events':sum(x['events'] for x in manifest['fragments'])}))
