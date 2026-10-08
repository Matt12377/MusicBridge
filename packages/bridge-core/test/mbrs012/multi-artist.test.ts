import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sourceServiceFixture,owned,hash} from './service-fixture.js';

const first='测试艺人',second='第二位原艺人';
function syncsafe(value:number):Buffer{assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=0x0fffffff);return Buffer.from([(value>>>21)&127,(value>>>14)&127,(value>>>7)&127,value&127]);}
function readSyncsafe(bytes:Buffer,offset:number):number{const field=bytes.subarray(offset,offset+4);assert.equal(field.length,4);assert.ok(field.every(v=>v<128));return field.reduce((n,v)=>(n<<7)|v,0);}
/** 仅构造自有输入的第二个ARTIST，不调用产品writer；整体标签长度/音频起点不改变。 */
function multiArtistInput(bytes:Buffer,audioStart:number):Buffer{
  const blocks:Buffer[]=[];
  if(bytes.subarray(0,4).equals(Buffer.from('fLaC'))){
    let offset=4,last=false,commentIndex=-1,paddingIndex=-1;
    while(!last){assert.ok(offset+4<=audioStart);last=!!(bytes[offset]!&128);const size=bytes.readUIntBE(offset+1,3),block=Buffer.from(bytes.subarray(offset,offset+4+size));assert.equal(block.length,size+4);blocks.push(block);if((block[0]!&127)===4){assert.equal(commentIndex,-1);commentIndex=blocks.length-1;}if((block[0]!&127)===1)paddingIndex=blocks.length-1;offset+=4+size;}
    assert.equal(offset,audioStart);assert.ok(commentIndex>=0&&paddingIndex>=0);const comment=blocks[commentIndex]!;let at=4;const vendorLength=comment.readUInt32LE(at);at+=4+vendorLength;const countPosition=at,count=comment.readUInt32LE(at);at+=4;const entries:Buffer[]=[];
    for(let index=0;index<count;index++){const size=comment.readUInt32LE(at);at+=4;const entry=comment.subarray(at,at+size);assert.equal(entry.length,size);entries.push(entry);at+=size;}assert.equal(at,comment.length);assert.deepEqual(entries.filter(v=>v.toString('utf8').startsWith('ARTIST=')).map(v=>v.toString('utf8')),['ARTIST='+first]);
    const entry=Buffer.from('ARTIST='+second,'utf8'),length=Buffer.alloc(4);length.writeUInt32LE(entry.length);const added=Buffer.concat([length,entry]),replacement=Buffer.concat([comment,added]);replacement.writeUInt32LE(count+1,countPosition);replacement.writeUIntBE(replacement.length-4,1,3);blocks[commentIndex]=replacement;
    const padding=blocks[paddingIndex]!;assert.ok(padding.length>4+added.length);assert.ok(padding.subarray(4).every(v=>v===0));blocks[paddingIndex]=Buffer.from(padding.subarray(0,padding.length-added.length));blocks[paddingIndex]!.writeUIntBE(blocks[paddingIndex]!.length-4,1,3);
    const prefix=Buffer.concat([bytes.subarray(0,4),...blocks]);assert.equal(prefix.length,audioStart);return Buffer.concat([prefix,bytes.subarray(audioStart)]);
  }
  assert.equal(bytes.subarray(0,3).toString('ascii'),'ID3');assert.equal(bytes[3],4);assert.equal(audioStart,10+readSyncsafe(bytes,6));let at=10,found=false;
  while(at+10<=audioStart&&bytes[at]!==0){const length=readSyncsafe(bytes,at+4),frame=Buffer.from(bytes.subarray(at,at+10+length));assert.equal(frame.length,length+10);if(frame.subarray(0,4).toString('ascii')==='TPE1'){
      assert.equal(found,false);found=true;assert.equal(frame[10],3);assert.equal(frame.subarray(11).toString('utf8'),first);const value=Buffer.from(`${first}\0${second}`,'utf8'),header=Buffer.from(frame.subarray(0,10));syncsafe(value.length+1).copy(header,4);blocks.push(Buffer.concat([header,Buffer.from([3]),value]));
    }else blocks.push(frame);at+=10+length;}
  assert.equal(found,true);assert.ok(bytes.subarray(at,audioStart).every(v=>v===0));const frames=Buffer.concat(blocks);assert.ok(frames.length<=audioStart-10);return Buffer.concat([bytes.subarray(0,10),frames,Buffer.alloc(audioStart-10-frames.length),bytes.subarray(audioStart)]);
}

for(const file of ['owned-stereo-fixed-tags.flac','owned-stereo-id3v240.mp3'] as const)test(`012 ${file} 实际artist多值：未选原span保持，显式合并为单值，验证备份撤销恢复原顺序多值`,async t=>{
  const f=await sourceServiceFixture(t,{files:[file]}),sample=await owned(file);assert.ok(sample.entry.audioStart);const audioStart=sample.entry.audioStart,input=multiArtistInput(sample.bytes,audioStart),target=path.join(f.media,file),track=f.tracks[0]!;
  assert.equal(input.length,sample.bytes.length);assert.deepEqual(input.subarray(audioStart),sample.bytes.subarray(audioStart));await writeFile(target,input);
  const scan=f.scanner.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});await f.scanner.privateWait(scan.jobId);assert.equal(f.scanner.get(scan.jobId).phase,'completed');f.enable();
  const untouched=await f.ready({kind:'tags',target:f.target(),fields:{title:{action:'set',value:'艺人多值未选应逐字节保留'}}}),writtenUntouched=await f.complete(untouched),unselected=await f.retain('multi-artist-unselected');assert.equal(writtenUntouched.items[0]!.verification.unselectedMetadata,'verified');await f.undo(writtenUntouched);assert.deepEqual(await readFile(target),input);
  const plan=await f.ready({kind:'tags',target:f.target(),fields:{artist:{action:'set',value:'明确合并后的唯一艺人'}}}),change=plan.items[0]!.changes.find(v=>v.field==='artist');assert.ok(change);assert.deepEqual(change.before,[first,second]);assert.deepEqual(change.after,['明确合并后的唯一艺人']);
  const completed=await f.complete(plan),after=await f.retain('multi-artist-explicit-merged');assert.equal(completed.items[0]!.verification.audio,'verified');assert.equal(f.repository.localCatalog.trackDetail(track.id).metadata.raw.artist,'明确合并后的唯一艺人');
  const undone=await f.undo(completed),restored=await f.retain('multi-artist-backup-restored'),inverse=undone.items[0]!.changes.find(v=>v.field==='artist');assert.ok(inverse);assert.deepEqual(inverse.after,[first,second]);assert.equal(undone.items[0]!.restoration!.kind,'restore-audio-file');assert.deepEqual(await readFile(restored),input);
  const previous=f.beforeOperations.get(plan.items[0]!.operationId);assert.ok(previous?.file&&previous.originalStat);assert.deepEqual(await readFile(previous.file),input);const manifest=path.join(f.directory,'multi-artist-source-evidence.json');await writeFile(manifest,JSON.stringify({owned:true,input:file,sourceRoot:f.media,safetyRoot:path.join(f.directory,'source-writes','safety'),before:previous.file,originalStat:previous.originalStat,originalAttributes:previous.originalAttributes,backup:path.join(f.directory,'source-writes','safety',plan.items[0]!.operationId,'backup'),target,after,restored,unselected,selectedFields:{artist:'明确合并后的唯一艺人'},originalArtistValues:[first,second],audioStart,beforeAudioSha256:hash(input.subarray(audioStart)),syntheticInputConstruction:'仅在冻结owned输入前区增第二artist并缩padding，真实增量scan确认新事实。'},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source实际多artist预览/独立backup/撤销材料：${manifest}`);
});
