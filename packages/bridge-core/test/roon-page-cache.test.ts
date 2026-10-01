import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRoonLibraryService,
  type RoonBrowseApi,
  type RoonEntityDescriptor,
  type RoonCapturedTrackActions,
} from '../src/roon/library.js';
import { createRoonPublicLibrary } from '../src/roon/public-library.js';
import { withLibraryRead } from '../src/shared/library-read-lifetime.js';

type Row = { title: string; hint: string; subtitle?: string; child?: string };
type Node = { rows: Row[]; unknown?: boolean };
type Load = { key: string; node: string; offset: number; count: number; returned: number };
type Callback = Parameters<RoonBrowseApi['load']>[1];
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const track = (title: string): Row => ({ title, subtitle: '合成艺人', hint: 'action_list' });
const album = (title: string): Row => ({ title, subtitle: '合成艺人', hint: 'list' });
const header = (title = '分类标题'): Row => ({ title, hint: 'header' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// 使用真实Service；这里只替换不可重复的Browse SDK，按每个真实session分别保存路径。
function fixture(kind: 'album' | 'playlist' | 'artist' | 'genre', details: Node, extra: Record<string, Node> = {}) {
  const nodes: Record<string, Node> = { root: { rows: [{ title: '稳定实体', hint: 'list', child: 'detail' }] }, detail: details, ...extra };
  const paths = new Map<string, string[]>();
  const keys = new Map<string, { node: string; index: number }>();
  const loads: Load[] = [];
  const browses: Array<{ key: string; node: string; itemKey?: string }> = [];
  const actions: Array<{ key: string; title: string; zone: unknown }> = [];
  let zone = '合成Zone-A';
  let failNextNode: string | undefined;
  let holdNextNode: string | undefined;
  let held: { callback: Callback; body: { offset: number; items: unknown[] }; load: Load } | undefined;
  let maximumReturned = Number.POSITIVE_INFINITY;
  let wrongNextOffset = false;
  const rowsFor = (node: string, key: string, offset: number, count: number) => nodes[node]!.rows
    .slice(offset, offset + Math.min(count, maximumReturned))
    .map((row, i) => {
      const index = offset + i;
      const itemKey = `${key}/${node}/${index}`;
      keys.set(itemKey, { node, index });
      const { child: _child, ...visible } = row;
      return { ...visible, ...(row.hint === 'header' ? {} : { item_key: itemKey }) };
    });
  const browse: RoonBrowseApi = {
    browse(options, callback) {
      const key = String(options.multi_session_key);
      let path = paths.get(key) ?? ['root'];
      if (options.pop_all) path = ['root'];
      else if (options.pop_levels) path = path.slice(0, Math.max(1, path.length - Number(options.pop_levels)));
      else if (options.item_key) {
        const itemKey = String(options.item_key);
        const location = keys.get(itemKey);
        assert.ok(location, '派发只能使用SDK真实提供过的item_key');
        assert.equal(itemKey.startsWith(`${key}/`), true, '稳定重定位必须取得本session的新key');
        const row = nodes[location.node]!.rows[location.index]!;
        if (row.hint === 'action') {
          actions.push({ key, title: row.title, zone: options.zone_or_output_id });
          callback(false, { action: 'none' });
          return;
        }
        let child = row.child;
        if (!child) {
          child = `actions:${location.node}:${location.index}`;
          nodes[child] = { rows: [{ title: 'Play Now', hint: 'action' }, { title: 'Add Next', hint: 'action' }] };
        }
        path = [...path, child];
      }
      paths.set(key, path);
      const node = path.at(-1)!;
      browses.push({ key, node, ...(options.item_key ? { itemKey: String(options.item_key) } : {}) });
      callback(false, { action: 'list', list: { level: path.length - 1, ...(nodes[node]!.unknown ? {} : { count: nodes[node]!.rows.length }) } });
    },
    load(options, callback) {
      const key = String(options.multi_session_key);
      const node = paths.get(key)?.at(-1);
      assert.ok(node);
      assert.equal(options.level, paths.get(key)!.length - 1, 'load不能读取另一层的raw索引');
      const offset = Number(options.offset), count = Number(options.count);
      const items = rowsFor(node, key, offset, count);
      const load = { key, node, offset, count, returned: items.length };
      loads.push(load);
      if (failNextNode === node) { failNextNode = undefined; callback('合成普通分页失败', undefined); return; }
      const body = { offset: wrongNextOffset ? offset + 1 : offset, items };
      wrongNextOffset = false;
      if (holdNextNode === node) { holdNextNode = undefined; held = { callback, body, load }; return; }
      callback(false, body);
    },
  };
  const service = createRoonLibraryService({ browse, image: { get_image() {} }, zoneOrOutputId: () => zone, requestTimeoutMs: 100 });
  const root = async () => (kind === 'album' ? await service.browseAlbums({ offset: 0, limit: 1 })
    : kind === 'artist' ? await service.browseArtists({ offset: 0, limit: 1 })
      : kind === 'genre' ? await service.browseGenres({ offset: 0, limit: 1 }) : await service.browsePlaylists({ offset: 0, limit: 1 })).items[0]!;
  const read = (entity: RoonEntityDescriptor, offset = 0, limit = 4) => kind === 'album'
    ? service.browseAlbum(entity, { offset, limit })
    : kind === 'artist' ? service.browseArtist(entity, { offset, limit })
      : service.browsePlaylist(entity, { offset, limit });
  return {
    service, nodes, loads, browses, actions, root, read,
    shortPages: (maximum: number) => { maximumReturned = maximum; },
    wrongOffset: () => { wrongNextOffset = true; },
    fail: (node = 'detail') => { failNextNode = node; },
    hold: (node = 'detail') => { holdNextNode = node; },
    held: () => { assert.ok(held); return held; },
    release: (items?: unknown[]) => { const current = held; assert.ok(current); held = undefined; current.callback(false, { ...current.body, ...(items ? { items } : {}) }); },
    zone: (value: string) => { zone = value; },
  };
}

function reload<T>(work:()=>T):T {
  const read = { signal:new AbortController().signal, deadlineAtMs:Date.now()+10000, now:Date.now, isCurrent:()=>true, cacheMode:'reload' as const };
  return withLibraryRead(read,work);
}
for (const size of [50,500,5000]) test(`缓存与目标刷新：${size}项`,async t=>{
  const f=fixture('album',{rows:Array.from({length:size},(_,i)=>track(`曲目${i}`))});
  let detailCalls=0; const originalDetail=f.service.browseAlbum.bind(f.service);
  f.service.browseAlbum=(...args)=>{detailCalls++;return originalDetail(...args);};
  let now=0;
  const library=createRoonPublicLibrary(()=>f.service,{now:()=>now});
  const root=await library.browseAlbums({offset:0,limit:1});
  const before=f.loads.length;
  assert.deepEqual(await library.browseAlbums({offset:0,limit:1}),root);
  assert.equal(f.loads.length,before,'DTO根页命中不重复SDK');
  const parent=root.items[0]!;
  const first=await library.browseAlbum(parent.reference,{offset:0,limit:4});
  const lease=library.acquirePlaybackContext(first.playbackContextHandle!,first.items[0]!.reference,'合成Zone-A');
  const hot=f.loads.length;
  const coldRaw=f.loads.filter(load=>load.node==='detail').reduce((sum,load)=>sum+load.returned,0);
  assert.ok(coldRaw<=100,'冷首屏上游raw读取不随大作品集线性增长');
  assert.equal(detailCalls,1);
  assert.deepEqual(await library.browseAlbum(parent.reference,{offset:0,limit:4}),first);
  assert.equal(f.loads.length,hot);
  assert.equal(detailCalls,1,'热详情收益是跳过Core调用和descriptor映射，不能声称原来会发SDK');
  t.diagnostic(JSON.stringify({size,coldDetailRaw:coldRaw,hotRootAdditionalSDK:0,hotDetailAdditionalSDK:0,hotDetailAdditionalCoreCalls:0}));
  f.nodes.detail!.rows[0]=track('真正新曲目');
  const fresh=await reload(()=>library.browseAlbum(parent.reference,{offset:0,limit:4}));
  assert.equal(fresh.items[0]!.title,'真正新曲目');
  assert.notEqual(fresh.sourceEpoch,first.sourceEpoch);
  assert.ok(f.loads.length>hot,'不能以旧增量前缀伪装刷新');
  assert.equal(lease.isCurrent(),true,'刷新UI不撤销独立播放来源');
  now=15001; const expired=await library.browseAlbum(parent.reference,{offset:0,limit:4});
  assert.notEqual(expired.sourceEpoch,fresh.sourceEpoch,'TTL超期必须真实刷新');
  lease.release();
});
test('已物化详情reload不能返回旧前缀',async()=>{
  const f=fixture('album',{rows:[track('旧曲目'),track('第二首')]});
  const library=createRoonPublicLibrary(()=>f.service);
  const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  await library.browseAlbum(parent.reference,{offset:0,limit:1});
  f.nodes.detail!.rows[0]=track('新曲目');
  const page=await reload(()=>library.browseAlbum(parent.reference,{offset:0,limit:1}));
  assert.equal(page.items[0]!.title,'新曲目');
});
test('作用域闭包构造不调用；Zone/credential/scope换代拒命中且迟到不映射',async()=>{
  const f=fixture('album',{rows:[track('曲目')]});
  let ready=false,scope='A';
  const library=createRoonPublicLibrary(()=>f.service,{getPageCacheScope:()=>{assert.ok(ready);return scope;}});
  ready=true;
  const first=await library.browseAlbums({offset:0,limit:1});
  scope='B'; const second=await library.browseAlbums({offset:0,limit:1});
  assert.notEqual(second.sourceEpoch,first.sourceEpoch);
  f.zone('合成Zone-B'); const third=await library.browseAlbums({offset:0,limit:1});
  assert.notEqual(third.sourceEpoch,second.sourceEpoch);
  f.hold('root'); const pending=reload(()=>library.browseAlbums({offset:0,limit:1}));
  await turn(); scope='C'; f.release();
  await assert.rejects(pending,{code:'ROON_LIBRARY_INVALID_REFERENCE'});
});
test('失败refresh不缓存伪新页；abort/过期ALS不能热命中；DTO互不污染',async()=>{
  const f=fixture('album',{rows:[track('曲目')]});
  const library=createRoonPublicLibrary(()=>f.service);
  const first=await library.browseAlbums({offset:0,limit:1});
  first.items[0]!.title='调用方修改';
  const second=await library.browseAlbums({offset:0,limit:1});
  assert.equal(second.items[0]!.title,'稳定实体');
  const controller=new AbortController(); controller.abort();
  assert.throws(()=>withLibraryRead({signal:controller.signal,deadlineAtMs:Date.now()+1000,now:Date.now,isCurrent:()=>true},()=>library.browseAlbums({offset:0,limit:1})),{code:'READ_CANCELLED'});
  f.fail('root'); await assert.rejects(reload(()=>library.browseAlbums({offset:0,limit:1})));
  const next=await library.browseAlbums({offset:0,limit:1});
  assert.equal(next.items[0]!.title,'稳定实体'); assert.notEqual(next.sourceEpoch,second.sourceEpoch);
});
test('源context退休/registration失效不能从热DTO恢复播放授权',async()=>{
  const f=fixture('album',{rows:Array.from({length:12},(_,i)=>track(`曲目${i}`))});
  let now=0; const library=createRoonPublicLibrary(()=>f.service,{now:()=>now});
  const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  const first=await library.browseAlbum(parent.reference,{offset:0,limit:4});
  const selector={kind:'detail' as const,entity:(await f.root())};
  assert.ok(f.service.getReadCacheStamp!(selector));
  await reload(()=>library.browseAlbums({offset:0,limit:1}));
  assert.equal(f.service.getReadCacheStamp!(selector),undefined);
  const next=await library.browseAlbum(parent.reference,{offset:0,limit:4});
  assert.notEqual(next.sourceEpoch,first.sourceEpoch);
  now=300001;
  assert.throws(()=>library.acquirePlaybackContext(next.playbackContextHandle!,next.items[0]!.reference,'合成Zone-A'),{code:'ROON_LIBRARY_INVALID_REFERENCE'});
  const fresh=await library.browseAlbum(parent.reference,{offset:0,limit:4});
  assert.notEqual(fresh.playbackContextHandle,next.playbackContextHandle);
});
test('搜索query/kind独立；5秒TTL/reload新epoch；完整性与当前页hasMore独立',async()=>{
  const f=fixture('album',{rows:[album('专辑A'),album('专辑B'),album('专辑C')]});
  f.nodes.root!.rows=[{title:'Albums',hint:'list',child:'detail'}];
  let now=0; const library=createRoonPublicLibrary(()=>f.service,{now:()=>now});
  const first=await library.searchLibrary('query',{offset:0,limit:1},'album');
  const before=f.loads.length;
  assert.deepEqual(await library.searchLibrary('query',{offset:0,limit:1},'album'),first); assert.equal(f.loads.length,before);
  const other=await library.searchLibrary('query2',{offset:0,limit:1},'album'); assert.notEqual(other.sourceEpoch,first.sourceEpoch);
  const artist=await library.searchLibrary('query',{offset:0,limit:1},'artist'); assert.notEqual(artist.sourceEpoch,first.sourceEpoch);
  f.nodes.detail!.rows[0]=album('真实新专辑'); now=5001;
  const fresh=await library.searchLibrary('query',{offset:0,limit:1},'album');
  assert.equal(fresh.items[0]!.title,'真实新专辑'); assert.notEqual(fresh.sourceEpoch,first.sourceEpoch);
  const end=await library.searchLibrary('query',{offset:1,limit:2},'album'); assert.equal(end.sourceEpoch,fresh.sourceEpoch); assert.equal(end.complete,true);
  const newStart=await reload(()=>library.searchLibrary('query',{offset:0,limit:1},'album'));
  const tail=await library.searchLibrary('query',{offset:1,limit:2},'album'); assert.equal(tail.sourceEpoch,newStart.sourceEpoch);
});
// 保留真实Public mapper；Fake只提供受控分页与readonly origin，区分映射与SDK收益。
async function budgetFixture(chars=12,limit=1) {
  const f=fixture('album',{rows:[track('曲目')]}); const template=await f.root();
  const origin='00000000-0000-4000-8000-000000000001'; let calls=0;
  const service={...f.service,getReadCacheStamp:()=>origin,browseAlbums:async(request:{offset:number;limit:number})=>{
    calls++;
    const items=Array.from({length:request.limit},(_,i)=>({...template,title:`专辑${request.offset+i}${'字'.repeat(chars)}`,itemKey:`合成key${request.offset+i}`}));
    return {items,offset:request.offset,level:0,sourceEpoch:origin,total:100000,hasMore:true,complete:false,nextOffset:request.offset+request.limit};
  }};
  const library=createRoonPublicLibrary(()=>service);
  return {library,read:(offset:number)=>library.browseAlbums({offset,limit}),calls:()=>calls};
}
test('128页LRU上限：第129页驱逐旧页但引用继续可用',async()=>{
  const f=await budgetFixture(); const first=await f.read(0);
  for(let i=1;i<=128;i++)await f.read(i);
  const before=f.calls(); await f.read(128); assert.equal(f.calls(),before);
  await f.read(0); assert.equal(f.calls(),before+1);
  assert.equal(f.library.getAlbumSnapshot(first.items[0]!.reference).title,first.items[0]!.title);
});
test('16MiB总计量预算先于128页生效',async()=>{
  const f=await budgetFixture(4000,100);
  for(let i=0;i<22;i++)await f.read(i*100);
  const before=f.calls(); await f.read(2100); assert.equal(f.calls(),before);
  await f.read(0); assert.equal(f.calls(),before+1);
});
test('超过1MiB页正常返回但不缓存；未实现stamp的旧Service不缓存',async()=>{
  const f=await budgetFixture(6000,100);const first=await f.read(0); assert.equal(first.items.length,100);
  const before=f.calls();await f.read(0);assert.equal(f.calls(),before+1);
  const raw=fixture('album',{rows:[track('曲目')]});delete raw.service.getReadCacheStamp;
  const library=createRoonPublicLibrary(()=>raw.service);await library.browseAlbums({offset:0,limit:1});
  const old=raw.loads.length;await library.browseAlbums({offset:0,limit:1});assert.equal(raw.loads.length,old+1);
});
test('注入时钟倒退拒热命中，不把旧页无限续命',async()=>{
  const f=fixture('album',{rows:[track('曲目')]});let now=10000;
  const library=createRoonPublicLibrary(()=>f.service,{now:()=>now});
  const first=await library.browseAlbums({offset:0,limit:1});const before=f.loads.length;
  now=9000;const fresh=await library.browseAlbums({offset:0,limit:1});
  assert.ok(f.loads.length>before);assert.notEqual(fresh.sourceEpoch,first.sourceEpoch);
});
test('页缓存不替代action SDK重定位；UI刷新后旧稳定track仍须真实授权',async()=>{
  const f=fixture('album',{rows:[track('稳定曲目'),track('另一首')]});const library=createRoonPublicLibrary(()=>f.service);
  const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  const first=await library.browseAlbum(parent.reference,{offset:0,limit:1});
  await reload(()=>library.browseAlbum(parent.reference,{offset:0,limit:1}));
  const before=f.loads.length;await library.playTrack(first.items[0]!.reference,'合成Zone-A');
  assert.ok(f.loads.length>before);assert.equal(f.actions.at(-1)!.title,'Play Now');
  f.nodes.detail!.rows[0]=track('源身份已变');
  const dispatched=f.actions.length;await assert.rejects(library.playTrack(first.items[0]!.reference,'合成Zone-A'));
  assert.equal(f.actions.length,dispatched);
});
test('旧incrementalDetails关闭时，targeted refresh也能重读已缓存空详情',async()=>{
  const f=fixture('album',{rows:[]});
  // SDK路径保留fixture实现；仅另建关闭增量的服务。
  const browse: RoonBrowseApi={
    browse(options,cb){ const child=options.item_key!==undefined;cb(false,{action:'list',list:{level:child?1:0,count:child?f.nodes.detail!.rows.length:1}}); },
    load(options,cb){ const child=options.level===1;cb(false,{offset:options.offset,items:child?f.nodes.detail!.rows.map(row=>({...row,item_key:'track'})):[{title:'稳定实体',hint:'list',item_key:'album'}]}); },
  };
  const service=createRoonLibraryService({browse,image:{get_image(){}},incrementalDetails:false});
  const album=(await service.browseAlbums({offset:0,limit:1})).items[0]!;
  assert.equal((await service.browseAlbum(album,{offset:0,limit:1})).items.length,0);
  f.nodes.detail!.rows=[track('新出现曲目')];
  assert.equal((await service.browseAlbum(album,{offset:0,limit:1},{refresh:true})).items[0]!.title,'新出现曲目');
});
test('同公开parent连续六次reload仍可真实重采样，不耗尽旧alias',async()=>{
  const f=fixture('album',{rows:[track('曲目')]});const library=createRoonPublicLibrary(()=>f.service);
  const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  let previous=await library.browseAlbum(parent.reference,{offset:0,limit:1});
  for(let i=0;i<6;i++){
    const fresh=await reload(()=>library.browseAlbum(parent.reference,{offset:0,limit:1}));
    assert.notEqual(fresh.sourceEpoch,previous.sourceEpoch);previous=fresh;
  }
});
test('timeout未实际返回的SDK旧key仍旋转；late callback不污染刷新页',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture('album',{rows:[track('曲目')]});const library=createRoonPublicLibrary(()=>f.service);
  f.hold('root');const old=reload(()=>library.browseAlbums({offset:0,limit:1})); const rejected=assert.rejects(old);
  await turn();const oldKey=f.held().load.key;t.mock.timers.tick(101);await rejected;
  const fresh=await reload(()=>library.browseAlbums({offset:0,limit:1}));assert.notEqual(f.loads.at(-1)!.key,oldKey);
  f.release();const before=f.loads.length;
  assert.deepEqual(await library.browseAlbums({offset:0,limit:1}),fresh);assert.equal(f.loads.length,before);
});
test('32个SDK本地timeout不归还物理read预算，真callback后才恢复',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const callbacks:Callback[]=[];let hold=true;
  const row={title:'合成专辑',hint:'list',item_key:'合成album'};
  const service=createRoonLibraryService({requestTimeoutMs:10,browse:{
    browse(_options,callback){callback(false,{action:'list',list:{level:0,count:1}});},
    load(_options,callback){if(hold)callbacks.push(callback);else callback(false,{offset:0,items:[row]});},
  },image:{get_image(){}}});
  for(let i=0;i<32;i++){
    const pending=reload(()=>service.browseAlbums({offset:0,limit:1}));const rejected=assert.rejects(pending);
    await turn();t.mock.timers.tick(11);await rejected;
  }
  assert.equal(callbacks.length,32);
  await assert.rejects(reload(()=>service.browseAlbums({offset:0,limit:1})),/未返回 Browse 请求预算已满/u);
  assert.equal(callbacks.length,32);
  for(const callback of callbacks)callback(false,{offset:0,items:[row]});hold=false;
  assert.equal((await reload(()=>service.browseAlbums({offset:0,limit:1}))).items.length,1);
});
