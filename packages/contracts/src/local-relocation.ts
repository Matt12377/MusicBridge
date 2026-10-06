import {isCollectionId} from './collection.js';
import type {Page} from './library.js';
import {isLibraryRoot,isAudioAsset,isLocalCatalogRevision,isLocalCatalogText,type LibraryRoot,type AudioAsset,type LocalTrack,type LocalMetadataView} from './local-catalog.js';
import type {LocalScanCommandPayloads,LocalScanCommandResults,LocalScanInternalCommand} from './local-scan.js';

/** 候选只陈述stat观察及人工选择；不能声称相同内容或录音SourceBinding已验证。 */
export interface LocalRootView {root:LibraryRoot;label:string;availability:'ONLINE'|'SOURCE_ROOT_OFFLINE'|'REVOKED'}
export interface LocalRelocationSelection {assetId:string;expectedFileRevision:string;expectedLocationRevision:string;expectedRootRevision:string}
export interface LocalRelocationCandidate {id:string;fileName:string;relativeLabel:string;size:number;modifiedAt:string;evidence:'same-inode-observation'|'user-choice'}
export interface LocalRelocationCandidates {assetId:string;candidates:LocalRelocationCandidate[]}
export interface LocalRelocationConfirm extends LocalRelocationSelection {commandId:string;userConfirmed:true}
export interface LocalRootRelink {commandId:string;rootId:string;expectedRevision:string;targetSourceRootId:string;userConfirmed:true}
export interface LocalRelocationCommandPayloads {
 'localRelocation.roots':Record<string,never>;
 'localRelocation.registerRoot':{commandId:string;sourceRootId:string};
 'localRelocation.capture':LocalRelocationSelection & {absolutePaths:string[]};
 'localRelocation.confirm':LocalRelocationConfirm;
 'localRelocation.relinkRoot':LocalRootRelink;
}
export interface LocalRelocationCommandResults {
 'localRelocation.roots':LocalRootView[];
 'localRelocation.registerRoot':LibraryRoot;
 'localRelocation.capture':LocalRelocationCandidates;
 'localRelocation.confirm':AudioAsset;
 'localRelocation.relinkRoot':LibraryRoot;
}
export const LOCAL_RELOCATION_COMMANDS=['localRelocation.roots','localRelocation.registerRoot','localRelocation.capture','localRelocation.confirm','localRelocation.relinkRoot'] as const;
export type LocalRelocationCommand=typeof LOCAL_RELOCATION_COMMANDS[number];
export type LocalRelocationInternalCommand='localRelocation.registerRoot'|'localRelocation.capture';
export const isLocalRelocationCommand=(v:unknown):v is LocalRelocationCommand=>typeof v==='string'&&(LOCAL_RELOCATION_COMMANDS as readonly string[]).includes(v);
export const isLocalRelocationInternalCommand=(v:unknown):v is LocalRelocationInternalCommand=>v==='localRelocation.registerRoot'||v==='localRelocation.capture';
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const closed=(v:Record<string,unknown>,names:readonly string[])=>Reflect.ownKeys(v).length===names.length&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&names.includes(k)&&Object.prototype.propertyIsEnumerable.call(v,k))&&names.every(k=>Object.hasOwn(v,k));
function array(v:unknown,max:number):v is unknown[]{return Array.isArray(v)&&Object.getPrototypeOf(v)===Array.prototype&&v.length<=max&&Reflect.ownKeys(v).length===v.length+1&&Reflect.ownKeys(v).every(k=>k==='length'||typeof k==='string'&&/^(0|[1-9][0-9]*)$/u.test(k)&&Number(k)<v.length&&Object.prototype.propertyIsEnumerable.call(v,k));}
const selectionKeys=['assetId','expectedFileRevision','expectedLocationRevision','expectedRootRevision'];
function selection(v:Record<string,unknown>):boolean{return isCollectionId(v.assetId)&&['expectedFileRevision','expectedLocationRevision','expectedRootRevision'].every(k=>isLocalCatalogRevision(v[k]));}
export function isLocalRelocationSelection(v:unknown):v is LocalRelocationSelection{return record(v)&&closed(v,selectionKeys)&&selection(v);}
export function isLocalRelocationConfirm(v:unknown):v is LocalRelocationConfirm{return record(v)&&closed(v,[...selectionKeys,'commandId','userConfirmed'])&&selection(v)&&isCollectionId(v.commandId)&&v.userConfirmed===true;}
export function isLocalRootRelink(v:unknown):v is LocalRootRelink{return record(v)&&closed(v,['commandId','rootId','expectedRevision','targetSourceRootId','userConfirmed'])&&isCollectionId(v.commandId)&&isCollectionId(v.rootId)&&isCollectionId(v.targetSourceRootId)&&isLocalCatalogRevision(v.expectedRevision)&&v.userConfirmed===true;}
const resultRoot=(v:unknown):v is LibraryRoot=>record(v)&&closed(v,['id','sourceRootId','role','revision'])&&isLibraryRoot(v);
const resultAsset=(v:unknown):v is AudioAsset=>record(v)&&closed(v,['id','libraryRootId','sourceRootId','rootRevision','fileRevision','locationRevision','sampleFrames','timebaseHz'])&&isAudioAsset(v);
export function isLocalRootView(v:unknown):v is LocalRootView{return record(v)&&closed(v,['root','label','availability'])&&resultRoot(v.root)&&isLocalCatalogText(v.label)&&['ONLINE','SOURCE_ROOT_OFFLINE','REVOKED'].includes(String(v.availability));}
export function isLocalRelocationCandidates(v:unknown):v is LocalRelocationCandidates{return record(v)&&closed(v,['assetId','candidates'])&&isCollectionId(v.assetId)&&array(v.candidates,200)&&v.candidates.every(c=>record(c)&&closed(c,['id','fileName','relativeLabel','size','modifiedAt','evidence'])&&isCollectionId(c.id)&&isLocalCatalogText(c.fileName)&&!/[\/\\]/u.test(c.fileName)&&isLocalCatalogText(c.relativeLabel)&&typeof c.size==='number'&&Number.isSafeInteger(c.size)&&c.size>0&&typeof c.modifiedAt==='string'&&c.modifiedAt.length<=32&&Number.isFinite(Date.parse(c.modifiedAt))&&(c.evidence==='same-inode-observation'||c.evidence==='user-choice'));}
export function isLocalRelocationCommandPayload<C extends LocalRelocationCommand>(command:C,v:unknown):v is LocalRelocationCommandPayloads[C]{
 if(!record(v))return false;
 switch(command){
 case 'localRelocation.roots':return closed(v,[]);
 case 'localRelocation.registerRoot':return closed(v,['commandId','sourceRootId'])&&isCollectionId(v.commandId)&&isCollectionId(v.sourceRootId);
 case 'localRelocation.capture':return closed(v,[...selectionKeys,'absolutePaths'])&&selection(v)&&array(v.absolutePaths,200)&&v.absolutePaths.length>0&&v.absolutePaths.every(p=>typeof p==='string'&&p.length>0&&p.length<=4096&&!/[\u0000-\u001f\u007f]/u.test(p));
 case 'localRelocation.confirm':return isLocalRelocationConfirm(v);
 case 'localRelocation.relinkRoot':return isLocalRootRelink(v);
 }
 return false;
}
export function isLocalRelocationCommandResult<C extends LocalRelocationCommand>(command:C,v:unknown):v is LocalRelocationCommandResults[C]{switch(command){case 'localRelocation.roots':return array(v,100)&&v.every(isLocalRootView);case 'localRelocation.registerRoot':case 'localRelocation.relinkRoot':return resultRoot(v);case 'localRelocation.capture':return isLocalRelocationCandidates(v);case 'localRelocation.confirm':return resultAsset(v);}return false;}
export type LocalLibraryScanCommand=Exclude<keyof LocalScanCommandPayloads,LocalScanInternalCommand>;
export interface LocalLibraryPublicApi {
 playLocalLibraryTrack(request:import('./local-play-request.js').LocalPlayRequest):Promise<import('./local-play-request.js').LocalPlayAccepted|import('./local-play-request.js').LocalSourceUnsupported>;
 listLocalLibraryRoots():Promise<LocalRootView[]>;
 chooseLocalLibraryRoot(commandId:string):Promise<LibraryRoot|null>;
 chooseLocalRelocationCandidates(request:LocalRelocationSelection):Promise<LocalRelocationCandidates|null>;
 confirmLocalRelocation(request:LocalRelocationConfirm):Promise<AudioAsset>;
 relinkLocalLibraryRoot(request:LocalRootRelink):Promise<LibraryRoot>;
 localLibraryScan<C extends LocalLibraryScanCommand>(command:C,payload:LocalScanCommandPayloads[C]):Promise<LocalScanCommandResults[C]>;
 listLocalLibraryTracks(page:{offset:number;limit:number}):Promise<Page<LocalTrack>>;
 getLocalLibraryAsset(assetId:string):Promise<AudioAsset>;
 getLocalLibraryMetadata(trackId:string):Promise<LocalMetadataView>;
}
