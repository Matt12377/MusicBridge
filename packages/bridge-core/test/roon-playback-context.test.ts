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

async function opened(size = 500) {
  const f = fixture('album', { rows: Array.from({ length: size }, (_, i) => track(`曲目${i}`)) });
  const library = createRoonPublicLibrary(() => f.service);
  const parent = (await library.browseAlbums({ offset: 0, limit: 1 })).items[0]!;
  const page = await library.browseAlbum(parent.reference, { offset: 0, limit: 4 });
  return { f, library, parent, page };
}
const opts = () => ({ signal: new AbortController().signal, isCurrent: () => true });
test('同步acquire仅公开窗口零SDK；stateless重读不消费游标', async () => {
  const { f, library, page } = await opened(); assert.ok(page.playbackContextHandle);
  const before=f.loads.length+f.browses.length;
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[2]!.reference,'合成Zone-A');
  assert.equal(f.loads.length+f.browses.length,before);
  assert.deepEqual(lease.initial.items.map(i=>i.roonItem.title),['曲目0','曲目1','曲目2','曲目3']);
  assert.equal(lease.initial.selectedIndex,2); assert.equal(lease.initial.nextOffset,4); assert.equal(lease.initial.complete,false);
  const next=await lease.read({offset:4,limit:4},opts());
  assert.deepEqual(next.items.map(i=>i.roonItem.title),['曲目4','曲目5','曲目6','曲目7']);
  assert.deepEqual(await lease.read({offset:4,limit:4},opts()),next);
  lease.release(); assert.equal(lease.isCurrent(),false);
});
test('第二页累计同handle；有间隙的公开window支持before',async()=>{
  const {library,parent,page}=await opened();
  const second=await library.browseAlbum(parent.reference,{offset:20,limit:4}); assert.ok(second.playbackContextHandle);
  assert.equal(second.playbackContextHandle,page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(second.playbackContextHandle!,second.items[1]!.reference,'合成Zone-A');
  assert.equal(lease.initial.offset,20); assert.equal(lease.initial.nextOffset,24); assert.equal(lease.initial.selectedIndex,1);
  const before=await lease.read({offset:16,limit:4},opts());
  assert.deepEqual(before.items.map(i=>i.roonItem.title),['曲目16','曲目17','曲目18','曲目19']); lease.release();
});
test('UI取消及四次alias退休不伤owned；scope显式撤销',async()=>{
  const {f,library,parent,page}=await opened(); assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  for(let i=0;i<5;i++){
    f.hold(); const cancel=new AbortController();
    const reading=withLibraryRead({signal:cancel.signal,deadlineAtMs:Date.now()+1000,now:Date.now,isCurrent:()=>true},()=>library.browseAlbum(parent.reference,{offset:100+i*4,limit:4}));
    await turn();cancel.abort();await assert.rejects(reading);f.release();
    const root=(await library.browseAlbums({offset:0,limit:1})).items[0]!;assert.equal(root.reference,parent.reference);
  }
  assert.equal(lease.isCurrent(),true);
  assert.equal((await lease.read({offset:4,limit:4},opts())).items[0]?.roonItem.title,'曲目4');
  library.invalidateReferences();assert.equal(lease.isCurrent(),false);await assert.rejects(lease.read({offset:8,limit:4},opts()));
});
test('释放owned后已物化曲目独立重放；改变raw身份不派发',async()=>{
  const {f,library,page}=await opened();assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  const next=await lease.read({offset:4,limit:4},opts());const ref=next.items[0]!.reference;lease.release();
  await library.playTrack(ref,'合成Zone-A');assert.equal(f.actions.length,1);assert.equal(library.getTrackSnapshot(ref).title,'曲目4');
  f.nodes.detail!.rows[4]=track('身份已改变');await assert.rejects(library.playTrack(ref,'合成Zone-A'));assert.equal(f.actions.length,1);
});
test('未授权selected/错误Zone/第三owned拒绝；release恢复槽位',async()=>{
  const {library,page}=await opened();assert.ok(page.playbackContextHandle);const h=page.playbackContextHandle!;
  assert.throws(()=>library.acquirePlaybackContext(h,'伪造reference','合成Zone-A'));
  assert.throws(()=>library.acquirePlaybackContext(h,page.items[0]!.reference,'错误Zone'));
  const a=library.acquirePlaybackContext(h,page.items[0]!.reference,'合成Zone-A');const b=library.acquirePlaybackContext(h,page.items[1]!.reference,'合成Zone-A');
  assert.throws(()=>library.acquirePlaybackContext(h,page.items[2]!.reference,'合成Zone-A'));
  a.release();const c=library.acquirePlaybackContext(h,page.items[2]!.reference,'合成Zone-A');b.release();c.release();
});
test('普通失败同cursor重试；timeout过期，迟到不复活',async()=>{
  const {f,library,page}=await opened();assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  f.fail();await assert.rejects(lease.read({offset:40,limit:4},opts()));assert.equal(lease.isCurrent(),true);
  assert.equal((await lease.read({offset:40,limit:4},opts())).items[0]?.roonItem.title,'曲目40');
  f.hold();await assert.rejects(lease.read({offset:100,limit:4},opts()));assert.equal(lease.isCurrent(),false);f.release();await turn();assert.equal(lease.isCurrent(),false);
});
test('TTL只驱逐未pin注册；重建handle不复活旧授权',async()=>{
  const f=fixture('album',{rows:Array.from({length:20},(_,i)=>track(`曲目${i}`))});let clock=0;
  const library=createRoonPublicLibrary(()=>f.service,{now:()=>clock});const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  const page=await library.browseAlbum(parent.reference,{offset:0,limit:4});assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');clock=400000;assert.equal(lease.isCurrent(),true);
  lease.release();clock+=400000;assert.throws(()=>library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A'));
  const fresh=await library.browseAlbum(parent.reference,{offset:0,limit:4});assert.notEqual(fresh.playbackContextHandle,page.playbackContextHandle);
});
test('genre非曲目占有效位置；零track页正推进且不可伪EOF',async()=>{
  const f=fixture('genre',{rows:[album('专辑0'),album('专辑1'),track('曲目2'),album('专辑3'),album('专辑4'),track('曲目5')]});
  const library=createRoonPublicLibrary(()=>f.service);const parent=(await library.browseGenres({offset:0,limit:1})).items[0]!;
  const page=await library.browseGenre(parent.reference,{offset:0,limit:3});assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[2]!.reference,'合成Zone-A');
  assert.equal(lease.initial.items.length,1);assert.equal(lease.initial.nextOffset,3);
  const empty=await lease.read({offset:3,limit:2},opts());assert.equal(empty.items.length,0);assert.equal(empty.nextOffset,5);assert.equal(empty.complete,false);
  const tail=await lease.read({offset:5,limit:2},opts());assert.equal(tail.items[0]?.roonItem.title,'曲目5');assert.equal(tail.nextOffset,6);assert.equal(tail.complete,true);lease.release();
});
test('完整缓存第一页仍非tailEOF；未知total读到实际EOF',async()=>{
  const {library,page}=await opened(6);assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  assert.equal((await lease.read({offset:4,limit:4},opts())).complete,true);
  assert.equal((await lease.read({offset:0,limit:4},opts())).complete,false);lease.release();
  const f=fixture('playlist',{unknown:true,rows:Array.from({length:6},(_,i)=>track(`曲目${i}`))});f.shortPages(2);
  const other=createRoonPublicLibrary(()=>f.service);const parent=(await other.browsePlaylists({offset:0,limit:1})).items[0]!;
  const p=await other.browsePlaylist(parent.reference,{offset:0,limit:4});assert.ok(p.playbackContextHandle);
  const b=other.acquirePlaybackContext(p.playbackContextHandle!,p.items[0]!.reference,'合成Zone-A');
  const last=await b.read({offset:4,limit:4},opts());assert.equal(last.nextOffset,6);assert.equal(last.complete,true);b.release();
});
test('多碟header/raw索引及重复出现保留，owned新session重绑定',async()=>{
  const f=fixture('album',{rows:[{title:'Disc 1',hint:'list',child:'disc1'},{title:'Disc 2',hint:'list',child:'disc2'}]},
    {disc1:{rows:[header('Disc 1'),track('重复'),track('重复')]},disc2:{rows:[header('Disc 2'),track('曲目2'),track('曲目3'),track('曲目4')]}});
  const library=createRoonPublicLibrary(()=>f.service);const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  const page=await library.browseAlbum(parent.reference,{offset:0,limit:2});assert.ok(page.playbackContextHandle);
  assert.notEqual(page.items[0]!.reference,page.items[1]!.reference);
  const oldkeys=new Set(f.loads.map(x=>x.key));const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[1]!.reference,'合成Zone-A');
  const next=await lease.read({offset:2,limit:3},opts());assert.deepEqual(next.items.map(x=>x.roonItem.discNumber),[2,2,2]);
  assert.ok(f.loads.some(x=>!oldkeys.has(x.key)));
  await library.playTrack(next.items[0]!.reference,'合成Zone-A');assert.equal(f.actions.length,1);lease.release();
});
test('owned原始offset/身份/checkpoint总数变化必须拒绝，不混新代',async()=>{
  const {f,library,page}=await opened();assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  f.nodes.detail!.rows.push(track('新源尾部'));
  await assert.rejects(lease.read({offset:4,limit:4},opts()));assert.equal(lease.isCurrent(),false);lease.release();
});
test('已pin注册更新后释放仍减账；TTL与Zone/service失效',async()=>{
  const f=fixture('album',{rows:Array.from({length:20},(_,i)=>track(`曲目${i}`))});let clock=0;
  let active:typeof f.service|undefined=f.service;const library=createRoonPublicLibrary(()=>active,{now:()=>clock});
  const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;const page=await library.browseAlbum(parent.reference,{offset:0,limit:4});assert.ok(page.playbackContextHandle);
  const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  await library.browseAlbum(parent.reference,{offset:4,limit:4});lease.release();clock=400000;
  assert.throws(()=>library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A'));
  const newpage=await library.browseAlbum(parent.reference,{offset:0,limit:4});const b=library.acquirePlaybackContext(newpage.playbackContextHandle!,newpage.items[0]!.reference,'合成Zone-A');
  f.zone('合成Zone-B');assert.equal(b.isCurrent(),false);b.release();
  active=undefined;await assert.rejects(library.playTrack(page.items[0]!.reference,'合成Zone-A'));
});
test('回滚选项不提供handle；有效旧引用仍走唯一play路径',async()=>{
  const f=fixture('album',{rows:[track('曲目')]});const library=createRoonPublicLibrary(()=>f.service,{incrementalPlaybackContexts:false});
  const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;const page=await library.browseAlbum(parent.reference,{offset:0,limit:4});assert.equal(page.playbackContextHandle,undefined);
  assert.throws(()=>library.acquirePlaybackContext('不存在handle',page.items[0]!.reference,'合成Zone-A'));
  await library.playTrack(page.items[0]!.reference,'合成Zone-A');assert.equal(f.actions.length,1);
});
test('scope失效发生在实际action前，play与queue均零lateSDK写',async()=>{
  for(const kind of ['play','queue']as const){
    const {f,library,page}=await opened();f.hold('root');
    const action=kind==='play'?library.playTrack(page.items[0]!.reference,'合成Zone-A'):library.queueTrack(page.items[0]!.reference,'合成Zone-A');
    await turn();library.invalidateReferences();f.release();await assert.rejects(action);assert.equal(f.actions.length,0);
  }
});
test('release仅撤销本地owned：32个未回SDK仍占预算，实际返回后恢复',async()=>{
  const {f,library,page}=await opened();assert.ok(page.playbackContextHandle);
  const pending:Array<ReturnType<typeof f.held>>=[];
  for(let i=0;i<32;i++){
    const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
    f.hold();const reading=lease.read({offset:40,limit:4},opts());await turn();pending.push(f.held());
    lease.release();await assert.rejects(reading);assert.equal(lease.isCurrent(),false);
  }
  const next=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  await assert.rejects(next.read({offset:40,limit:4},opts()));assert.equal(next.isCurrent(),true);
  const first=pending.shift()!;first.callback(false,first.body);
  const restored=await next.read({offset:40,limit:4},opts());assert.equal(restored.items[0]?.roonItem.title,'曲目40');
  next.release();for(const held of pending)held.callback(false,held.body);
});
test('动作snapshot累计字节拒绝整页，不污染已公开引用/handle',async t=>{
  const f=fixture('album',{rows:[track('曲目0'),track('曲目1'),track('曲目2')]});
  const original=f.service.captureTrackActions!.bind(f.service);
  let reject=false;
  t.mock.method(f.service as typeof f.service & { captureTrackActions(descriptor:RoonEntityDescriptor):RoonCapturedTrackActions },'captureTrackActions',(descriptor:RoonEntityDescriptor)=>{
    const action=original(descriptor);return {...action,retainedBytes:reject?80000:action.retainedBytes};
  });
  const library=createRoonPublicLibrary(()=>f.service,{maxReferenceCacheBytes:131072});
  const parent=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  const first=await library.browseAlbum(parent.reference,{offset:0,limit:1});assert.ok(first.playbackContextHandle);
  reject=true;await assert.rejects(library.browseAlbum(parent.reference,{offset:1,limit:2}));
  const lease=library.acquirePlaybackContext(first.playbackContextHandle!,first.items[0]!.reference,'合成Zone-A');
  assert.equal(lease.initial.nextOffset,1,'失败整页不可扩大授权');lease.release();
  assert.equal(library.getTrackSnapshot(first.items[0]!.reference).title,'曲目0');
  await library.playTrack(first.items[0]!.reference,'合成Zone-A');assert.equal(f.actions.length,1);
  reject=false;const retry=await library.browseAlbum(parent.reference,{offset:1,limit:2});assert.equal(retry.playbackContextHandle,first.playbackContextHandle);
});
test('同reference的owned映射保持原snapshot/metadata；held取消迟到不写新owner',async()=>{
  const {f,library,page}=await opened();assert.ok(page.playbackContextHandle);
  const old=page.items[0]!;const a=library.acquirePlaybackContext(page.playbackContextHandle!,old.reference,'合成Zone-A');
  assert.equal((await a.read({offset:0,limit:4},opts())).items[0]!.reference,old.reference);
  f.hold();const work=a.read({offset:40,limit:4},opts());await turn();const held=f.held();a.release();await assert.rejects(work);
  const b=library.acquirePlaybackContext(page.playbackContextHandle!,old.reference,'合成Zone-A');
  const next=await b.read({offset:4,limit:4},opts());held.callback(false,held.body);await turn();assert.equal(b.isCurrent(),true);
  await library.playTrack(old.reference,'合成Zone-A');assert.equal(f.actions.length,1);
  assert.equal(library.getTrackSnapshot(next.items[0]!.reference).title,'曲目4');b.release();
});
test('Zone仅退休读取：同track token新Zone可重播，准备中换Zone零late写',async()=>{
  const {f,library,parent,page}=await opened();const ref=page.items[0]!.reference;
  f.zone('合成Zone-B');const root=(await library.browseAlbums({offset:0,limit:1})).items[0]!;
  assert.equal(root.reference,parent.reference);
  const fresh=await library.browseAlbum(root.reference,{offset:0,limit:4});assert.equal(fresh.items[0]!.reference,ref);
  await library.playTrack(ref,'合成Zone-B');assert.equal(f.actions.length,1);assert.equal(f.actions[0]!.zone,'合成Zone-B');
  f.hold('root');const late=library.playTrack(ref,'合成Zone-B');await turn();f.zone('合成Zone-C');f.release();
  await assert.rejects(late);assert.equal(f.actions.length,1);
});
test('同owned连续后页重新核来源count，不依旧SDK导航缓存',async()=>{
  const {f,library,page}=await opened();const lease=library.acquirePlaybackContext(page.playbackContextHandle!,page.items[0]!.reference,'合成Zone-A');
  await lease.read({offset:4,limit:4},opts());f.nodes.detail!.rows.push(track('新增尾部'));
  await assert.rejects(lease.read({offset:8,limit:4},opts()));assert.equal(lease.isCurrent(),false);lease.release();
});
