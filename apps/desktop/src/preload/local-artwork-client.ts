import * as dto from '@music-bridge/contracts';

/** dataset在原preload会话中固定；图片读取/解码和选图业务写分别采用可信Main与持久outbox。 */
export function createLocalArtworkClient(invoke:(channel:string,value?:unknown)=>Promise<unknown>,scope:()=>Promise<string>,write:{apply(request:dto.ApplyLocalArtworkSelection):Promise<dto.LocalArtworkSelection>;create(request:dto.CreateLocalArtworkEdition):Promise<dto.AlbumEdition>}):dto.LocalArtworkPublicApi {
  const bad=()=>new Error('封面请求或回执无效，原选择保留。');
  async function context(channel:string,target:dto.LocalArtworkTarget):Promise<dto.LocalArtworkContext|null> {
    if (!dto.isLocalArtworkTarget(target)) throw bad(); const value=await invoke(channel,{datasetId:await scope(),target:structuredClone(target)});
    if (value===null && channel==='localArtwork:pick') return null;
    if (!dto.isLocalArtworkContext(value) || value.target?.editionId!==target.editionId || value.trackId!==target.trackId) throw bad(); return value;
  }
  return Object.freeze({
    async getLocalArtworkContext(request:dto.LocalArtworkCommandPayloads['localArtwork.context']) {
      if (!dto.isLocalArtworkCommandPayload('localArtwork.context',request)) throw bad(); const value=await invoke('localArtwork:context',{datasetId:await scope(),request:structuredClone(request)});
      if (!dto.isLocalArtworkContext(value) || value.trackId!==request.trackId || request.editionId!==null && value.target?.editionId!==request.editionId) throw bad(); return value;
    },
    async findLocalArtworkCandidates(target:dto.LocalArtworkTarget) { return (await context('localArtwork:find',target))!; },
    async searchLocalArtworkCandidates(request:dto.SearchLocalArtworkCandidates) {
      if (!dto.isLocalArtworkSearchRequest(request)) throw bad();
      const value=await invoke('localArtwork:search',{datasetId:await scope(),target:structuredClone(request.target),query:request.query,...(request.provider?{provider:request.provider}:{})});
      if (!dto.isLocalArtworkContext(value) || value.target?.editionId!==request.target.editionId || value.trackId!==request.target.trackId) throw bad(); return value;
    },
    chooseLocalArtworkFile:(target:dto.LocalArtworkTarget)=>context('localArtwork:pick',target),
    async importLocalArtworkBytes(request:{target:dto.LocalArtworkTarget;bytes:Uint8Array}) {
      if (!dto.isLocalArtworkRecord(request,['target','bytes']) || !dto.isLocalArtworkTarget(request.target) || !(request.bytes instanceof Uint8Array) || !(request.bytes.buffer instanceof ArrayBuffer) || request.bytes.length<4 || request.bytes.length>dto.LOCAL_ARTWORK_INPUT_BYTES) throw bad();
      const value=await invoke('localArtwork:import',{datasetId:await scope(),target:structuredClone(request.target),bytes:new Uint8Array(request.bytes)});
      if (!dto.isLocalArtworkContext(value) || value.target?.editionId!==request.target.editionId || value.trackId!==request.target.trackId) throw bad(); return value;
    },
    async applyLocalArtworkSelection(request:dto.ApplyLocalArtworkSelection) { if (!dto.isApplyLocalArtworkSelection(request)) throw bad(); const value=await write.apply(structuredClone(request)); if (!dto.isLocalArtworkSelection(value) || value.editionId!==request.target.editionId) throw bad(); return value; },
    async createLocalArtworkEdition(request:dto.CreateLocalArtworkEdition) { if (!dto.isCreateLocalArtworkEdition(request)) throw bad(); const value=await write.create(structuredClone(request)); if (!dto.isAlbumEdition(value)) throw bad(); return value; },
    async cancelLocalArtworkLookup(target:dto.LocalArtworkTarget) { if (!dto.isLocalArtworkTarget(target)) throw bad(); const value=await invoke('localArtwork:cancel',{datasetId:await scope(),target:structuredClone(target)}); if (!dto.isLocalArtworkRecord(value,['cancelled']) || typeof value.cancelled!=='boolean') throw bad(); },
  });
}
