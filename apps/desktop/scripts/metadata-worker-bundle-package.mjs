/** Desktop只复制同一Core已核bundle；Rollup定位asset，不重新打包Worker。 */
import path from 'node:path';
import { readFixedMetadataWorkerBundle } from '../../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';
export async function fixedMetadataWorkerBundlePlugin(coreRoot) {
  const fixed=await readFixedMetadataWorkerBundle(coreRoot);
  const parentSource=path.join(coreRoot,'src/library/metadata-reader.ts');let entryRef,successfulReplacements=0;
  return {name:'fixed-metadata-worker-bundle',enforce:'pre',
    buildStart(){successfulReplacements=0;entryRef=this.emitFile({type:'asset',fileName:'chunks/metadata-reader-worker.bundle.mjs',source:fixed.entryBytes});
      this.emitFile({type:'asset',fileName:'chunks/metadata-reader-worker.bundle.mjs.map',source:fixed.mapBytes});},
    shouldTransformCachedModule({id}){return id.split('?')[0]===parentSource?true:null;},
    transform(code,id){
      if(id.split('?')[0]!==parentSource)return null;
      const needle="new URL('./metadata-reader-worker.bundle.mjs', import.meta.url)";
      if(!entryRef||code.split(needle).length!==2)throw new Error('固定Metadata Worker URL源码锚点错误。');
      const transformed=code.replace(needle,'new URL(import.meta.ROLLUP_FILE_URL_'+entryRef+')');
      successfulReplacements++;return{code:transformed,map:null};
    },
    async generateBundle(_options,bundle){
      if(successfulReplacements!==1)throw new Error('Desktop父Reader固定Worker URL必须恰好替换一次。');
      const after=await readFixedMetadataWorkerBundle(coreRoot);
      if(JSON.stringify(after.manifest)!==JSON.stringify(fixed.manifest))throw new Error('Core bundle构建期间漂移。');
      const emitted=bundle['chunks/metadata-reader-worker.bundle.mjs'];
      if(!emitted||emitted.type!=='asset'||!Buffer.from(emitted.source).equals(Buffer.from(fixed.entryBytes)))throw new Error('Desktop Worker不是同一固定产物。');
    },
  };
}
