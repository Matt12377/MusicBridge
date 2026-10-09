import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMobileMediaStreamHeaders, validateMobileMediaStreamCompletion } from '../src/mobile-media-stream.js';
import type { MobileMediaStreamSnapshot } from '../src/mobile-media-stream.js';
import { MOBILE_API_RESPONSE_MAX_BYTES, MOBILE_JSON_REQUEST_MAX_BYTES, parseMobileJson } from '../src/mobile-common.js';
import type { MobileDecodeResult } from '../src/mobile-common.js';
import { decodeMobileResponse } from '../src/mobile-wire.js';
import type { MobileHeaderPairs } from '../src/mobile-wire.js';

// 仅合成 HTTP 头部与发送计数，不打开文件、不读取音频、不自报真实设备或资源授权。
const fields = (length:number,...extra:[string,string][]):MobileHeaderPairs => [['Content-Length',String(length)],['Accept-Ranges','bytes'],...extra];
function accepted(result:MobileDecodeResult<MobileMediaStreamSnapshot>):MobileMediaStreamSnapshot { assert(result.ok,result.ok ? '' : `${result.issue.code}:${result.issue.field}`); return result.value; }

test('手机流式媒体：大于2MiB的完整表示可校验头部和实际发送计数',() => {
  const length = 8*1024*1024+17;
  const snapshot = accepted(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(length,['Content-Type','audio/mp4']),length));
  assert.equal(snapshot.expectedBodyBytes,length); assert.equal(snapshot.contentLength,length); assert.equal(snapshot.contentType,'audio/mp4');
  assert.equal(validateMobileMediaStreamCompletion(snapshot,length).ok,true);
  for (const actual of [length-1,length+1]) assert.equal(validateMobileMediaStreamCompletion(snapshot,actual).ok,false);
});

test('手机流式媒体：独立入口不放宽原JSON限额或whole正文长度',() => {
  assert.equal(MOBILE_JSON_REQUEST_MAX_BYTES,262144); assert.equal(MOBILE_API_RESPONSE_MAX_BYTES,2097152);
  const oversized = new Uint8Array(MOBILE_API_RESPONSE_MAX_BYTES+1); oversized.fill(0x20); oversized[0]=0x30;
  const parsed = parseMobileJson(oversized); assert.equal(parsed.ok,false); if (!parsed.ok) assert.equal(parsed.issue.code,'LIMIT_EXCEEDED');
  const context = {responseOrigin:'https://studio.example.ts.net:9443',requestPath:'/mobile/v1/media/resource.fixture.1/main',media:{totalBytes:32,resourceId:'resource.fixture.1',asset:'main'}};
  const whole = (body:Uint8Array) => decodeMobileResponse('getMediaAsset',{status:200,headers:fields(32),body,finalUrl:`${context.responseOrigin}${context.requestPath}`},context);
  assert.equal(whole(new Uint8Array(32)).ok,true);
  for (const bytes of [0,31,33]) assert.equal(whole(new Uint8Array(bytes)).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(32),32).ok,true);
});

test('手机流式HEAD：忽略Range但只接受完整200且零实际正文',() => {
  const snapshot = accepted(validateMobileMediaStreamHeaders('headMediaAsset',200,fields(9000000,['If-Range','W/"stat"']),9000000,'bytes=0-0,2-2'));
  assert.equal(snapshot.contentLength,9000000); assert.equal(snapshot.expectedBodyBytes,0);
  assert.equal(validateMobileMediaStreamCompletion(snapshot,0).ok,true); assert.equal(validateMobileMediaStreamCompletion(snapshot,1).ok,false);
  for (const status of [206,416,201,204]) assert.equal(validateMobileMediaStreamHeaders('headMediaAsset',status,fields(32),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('headMediaAsset',200,fields(31),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('headMediaAsset',200,fields(32,['Content-Range','bytes 0-31/32']),32).ok,false);
});

test('手机流式GET206：闭区间长度总长和Accept-Ranges全部精确',() => {
  const snapshot = accepted(validateMobileMediaStreamHeaders('getMediaAsset',206,fields(8,['Content-Range','bytes 5-12/32']),32,'bytes=5-12'));
  assert.equal(snapshot.contentRange,'bytes 5-12/32'); assert.equal(snapshot.expectedBodyBytes,8);
  assert.equal(validateMobileMediaStreamCompletion(snapshot,8).ok,true); assert.equal(validateMobileMediaStreamCompletion(snapshot,7).ok,false);
  for (const range of ['bytes 12-5/32','bytes 0-32/32','bytes 5-12/33','bytes */32','bytes 5-12/*']) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',206,fields(8,['Content-Range',range]),32).ok,false,range);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',206,fields(9,['Content-Range','bytes 5-12/32']),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',206,[['Content-Length','8'],['Content-Range','bytes 5-12/32']],32).ok,false);
});

test('手机流式单Range：闭区间开放尾suffix和边界裁剪对齐实际请求',() => {
  for (const [request,response,length] of [['bytes=0-7','bytes 0-7/32',8],['bytes=24-','bytes 24-31/32',8],['bytes=-8','bytes 24-31/32',8],['bytes=24-99','bytes 24-31/32',8],['bytes=-99','bytes 0-31/32',32]] as const) {
    assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',206,fields(length,['Content-Range',response]),32,request).ok,true,request);
  }
  for (const request of ['bytes=1-8','bytes=','bytes=0-0,2-2','bytes=9-2','bytes=-0','bytes=32-','bytes=9007199254740992-','bytes=0-7\n','bytes='+'0'.repeat(129)+'-7']) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',206,fields(8,['Content-Range','bytes 0-7/32']),32,request).ok,false,request);
});

test('手机流式GET200：全长无Content-Range且允许完整表示回退',() => {
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(32),32,'bytes=0-7').ok,true);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(31),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(32,['Content-Range','bytes 0-31/32']),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,[['Content-Length','32']],32).ok,false);
  const empty = accepted(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(0),0));
  assert.equal(validateMobileMediaStreamCompletion(empty,0).ok,true);
});

test('手机流式范围拒绝：400和416必须零正文且416完整总长准确',() => {
  const malformed = accepted(validateMobileMediaStreamHeaders('getMediaAsset',400,fields(0),32,'bytes=0-0,2-2'));
  const outside = accepted(validateMobileMediaStreamHeaders('getMediaAsset',416,fields(0,['Content-Range','bytes */32']),32,'bytes=32-'));
  for (const snapshot of [malformed,outside]) { assert.equal(snapshot.expectedBodyBytes,0); assert.equal(validateMobileMediaStreamCompletion(snapshot,0).ok,true); assert.equal(validateMobileMediaStreamCompletion(snapshot,1).ok,false); }
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',400,fields(1),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',400,fields(0,['Content-Range','bytes */32']),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',400,fields(0),32,'bytes=0-7').ok,false);
  for (const range of ['bytes */31','bytes */9007199254740992','bytes 0-0/32','bytes */032']) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',416,fields(0,['Content-Range',range]),32).ok,false,range);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',416,fields(1,['Content-Range','bytes */32']),32).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',416,fields(0,['Content-Range','bytes */32']),32,'bytes=0-7').ok,false);
});

test('手机流式整数：缺失畸形和安全整数溢出不能声明媒体长度',() => {
  for (const raw of ['-1','01','1.5','1e3',' 32','32 ','+32','NaN','Infinity','9007199254740992']) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,[['Content-Length',raw],['Accept-Ranges','bytes']],32).ok,false,raw);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,[['Accept-Ranges','bytes']],32).ok,false);
  for (const full of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(32),full).ok,false);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(Number.MAX_SAFE_INTEGER),Number.MAX_SAFE_INTEGER).ok,true);
  assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',206,fields(1,['Content-Range','bytes 0-0/9007199254740992']),32).ok,false);
  for (const status of [0,201,202,204,301,500,NaN]) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',status,fields(32),32).ok,false);
});

test('手机流式头部：重复字段非法token和控制字符拒绝，未知合法头有界',() => {
  for (const extra of [['content-length','32'],['ACCEPT-RANGES','bytes'],['Bad Header','x'],['X-Diagnostic','x\r\ny'],['Content-Type','audio/mp4\u0000']] as [string,string][]) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(32,extra),32).ok,false,extra[0]);
  const snapshot = accepted(validateMobileMediaStreamHeaders('getMediaAsset',200,fields(32,['X-Finite-Unknown','有限合成值'],['Cache-Control','no-store']),32));
  assert.equal(Object.hasOwn(snapshot,'X-Finite-Unknown'),false); assert.equal(Object.keys(snapshot).length,7);
  const tooLarge = validateMobileMediaStreamHeaders('getMediaAsset',200,fields(32,['X-Finite-Unknown','x'.repeat(MOBILE_JSON_REQUEST_MAX_BYTES)]),32);
  assert.equal(tooLarge.ok,false); if (!tooLarge.ok) assert.equal(tooLarge.issue.code,'LIMIT_EXCEEDED');
});

test('手机流式捕获：getter洞额外数组属性和隐式转换均不能进入头部',() => {
  let calls = 0;
  const accessor = ['Content-Length','32']; Object.defineProperty(accessor,'1',{enumerable:true,get:() => {calls++;return '32';}});
  const hole = new Array(2); hole[0]='Content-Length';
  const extra = Object.assign(['Content-Length','32'],{unrelated:'x'});
  const implicit = {toString:() => {calls++;return '32';}};
  for (const headers of [[accessor,['Accept-Ranges','bytes']],[hole,['Accept-Ranges','bytes']],[extra,['Accept-Ranges','bytes']],[['Content-Length',implicit],['Accept-Ranges','bytes']],[['Content-Length',32],['Accept-Ranges','bytes']]]) assert.equal(validateMobileMediaStreamHeaders('getMediaAsset',200,headers as unknown as MobileHeaderPairs,32).ok,false);
  assert.equal(calls,0);
});

test('手机流式快照：调用方后改头部不改计数且伪造闭键不能收口',() => {
  const input:[string,string][] = [['Content-Length','32'],['Accept-Ranges','bytes']];
  const snapshot = accepted(validateMobileMediaStreamHeaders('getMediaAsset',200,input,32));
  input[0]![1]='1'; assert.equal(Object.isFrozen(snapshot),true); assert.equal(snapshot.contentLength,32);
  assert.equal(validateMobileMediaStreamCompletion(snapshot,32).ok,true);
  for (const bad of [{...snapshot,expectedBodyBytes:1},{...snapshot,contentLength:31},{...snapshot,fullContentLength:31},{...snapshot,authority:'qualified'},{...snapshot,status:206,contentRange:'bytes 0-31/32',expectedBodyBytes:1}]) assert.equal(validateMobileMediaStreamCompletion(bad as MobileMediaStreamSnapshot,32).ok,false);
  let calls = 0; const getter = Object.defineProperty({...snapshot},'expectedBodyBytes',{enumerable:true,get:() => {calls++;return 32;}});
  assert.equal(validateMobileMediaStreamCompletion(getter,32).ok,false); assert.equal(calls,0);
});

test('手机流式完成：实际发送计数必须安全整数并且严格等于完整预期',() => {
  const snapshot = accepted(validateMobileMediaStreamHeaders('getMediaAsset',206,fields(8,['Content-Range','bytes 0-7/32']),32));
  for (const actual of [-1,0,7,9,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(validateMobileMediaStreamCompletion(snapshot,actual).ok,false);
  assert.equal(validateMobileMediaStreamCompletion(snapshot,8).ok,true);
  assert.equal(validateMobileMediaStreamCompletion(null as unknown as MobileMediaStreamSnapshot,0).ok,false);
});
