import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CanonicalReference } from '@music-bridge/contracts'
import { createCollectionRepository } from '../../../../packages/bridge-core/src/collection/repository.js'
import { seedRustCollection } from '../../../../packages/bridge-core/test/helpers/rust-core-collection-fixture.js'

// 图片是本期生成的纯色 8×8 JPEG，未读取任何用户图片或第三方资源。
const image = { dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDo6KKK9g8s/9k=', width: 8, height: 8 }
export async function seedCollectionHost(directory: string, models: number) {
  const data = path.join(directory, 'data'); await mkdir(data)
  const filePath = path.join(data, 'collection.v1.sqlite')
  let repository = createCollectionRepository({ filePath }); repository.list({ offset: 0, limit: 1 }); repository.close()
  seedRustCollection(filePath, models)
  // 旧规模夹具只提供库存矩阵；本期使用有效的合成图片替换其测试占位字节。
  const db = new DatabaseSync(filePath)
  db.prepare('UPDATE collection_photos SET content=?,content_hash=?,width=8,height=8').run(Buffer.from(image.dataUrl.slice(23), 'base64'), createHash('sha256').update(Buffer.from(image.dataUrl.slice(23), 'base64')).digest('hex'))
  db.close()
  repository = createCollectionRepository({ filePath })
  try {
    const first = repository.list({ offset: 0, limit: 1 }).items[0]!
    repository.close()
    const detailDb = new DatabaseSync(filePath)
    for (let index=0; index<21; index++) {
      const sku = randomUUID()
      detailDb.prepare('INSERT INTO collection_skus(id,model_id,minutes) VALUES (?,?,?)').run(sku,first.id,60+index)
      detailDb.prepare('INSERT INTO inventory_lots(id,sku_id,acquired,sealed,opened,legacy,unknown,quantity_adjustment) VALUES (?,?,1,1,0,0,0,0)').run(randomUUID(),sku)
    }
    detailDb.close(); repository = createCollectionRepository({ filePath })
    const savedPhoto = repository.addPhoto({ commandId: randomUUID(), modelId: first.id, image })
    repository.changePhoto({ commandId: randomUUID(), modelId: first.id, photoId: savedPhoto.photoId!, expectedRevision:repository.detail(first.id,{offset:0,limit:1}).model.revision, action: 'feature' })
    const bookId = 'rust009-synthetic-book'
    const items: CanonicalReference[] = [
      { referenceId:'owned', bookId, brand:first.brand, series:'本期合成系列', model:first.name, edition:first.edition, lengths:[60,90], iec:'II', era:'1990', image:{ kind:'reference', image, caption:'本期合成纯色参考图' }, pages:['1'], notes:'仅隔离Gate', confidence:'high' },
      { referenceId:'unknown', bookId, brand:'合成品牌', series:'本期合成系列', model:'未知参考型号', edition:'测试版', lengths:[90], iec:'II', era:'1990', image:{kind:'none'}, pages:['2'], notes:'不自动推断缺失', confidence:'high' },
    ]
    function publish(previous: string | null, version: string) {
      const rawPack = JSON.stringify({ schemaVersion:1, bookId, title:'本期合成参考目录', sourceVersion:version, items })
      const source = repository.catalog.registerSource({ commandId:randomUUID(), rawPack, packHash:createHash('sha256').update(rawPack).digest('hex'), userConfirmed:true })
      const input = { sourceId:source.id, expectedCurrentRevisionId:previous, items, mappings:previous ? items.map(item => ({fromReferenceIds:[item.referenceId],toReferenceIds:[item.referenceId]})) : [] }
      const preview = repository.catalog.previewRevision(input)
      const revision = repository.catalog.publishRevision({ ...input, commandId:randomUUID(), baselineFingerprint:preview.baselineFingerprint, userConfirmed:true }).revision
      return { source, revision }
    }
    const old = publish(null,'合成第一版')
    repository.catalog.setMatch({ commandId:randomUUID(), revisionId:old.revision.id, expectedMatchVersion:0, match:{referenceId:'owned',modelId:first.id,status:'confirmed',availability:'unknown'},userConfirmed:true })
    const wantInput = {commandId:randomUUID(),id:null,expectedVersion:0,revisionId:old.revision.id,referenceId:'owned',priority:'normal' as const,preferredCondition:'良好',notes:'合成求购第一版',targetLengthMinutes:90,packagingTarget:'未拆封',priceTarget:{currency:'CNY',amount:'120.50'},userConfirmed:true as const}
    const want = repository.collectionProgress.saveWant(wantInput)
    const oldProgress = repository.collectionProgress.current({revisionId:old.revision.id,page:{offset:0,limit:25}})
    const snapshot = repository.collectionProgress.capture({commandId:randomUUID(),revisionId:old.revision.id,expectedFingerprint:oldProgress.fingerprint,userConfirmed:true})
    const current = publish(old.revision.id,'合成第二版')
    const updated = repository.collectionProgress.saveWant({...wantInput,commandId:randomUUID(),id:want.id,expectedVersion:want.version,revisionId:current.revision.id,notes:'合成求购第二版'})
    const progress = repository.collectionProgress.current({revisionId:current.revision.id,page:{offset:0,limit:25}})
    return { models, modelId:first.id, bookId, wants:repository.collectionProgress.wants({page:{offset:0,limit:25}}).total,
      currentCatalogRevision:current.revision.id, previousCatalogRevision:old.revision.id, wantId:updated.id,
      wantHistory:repository.collectionProgress.wantHistory({id:updated.id,page:{offset:0,limit:25}}).total,
      snapshots:repository.collectionProgress.snapshots({page:{offset:0,limit:25}}).total,snapshotId:snapshot.id,
      photos:repository.detail(first.id,{offset:0,limit:20}).photos?.length ?? 0, detailsLots:repository.detail(first.id,{offset:0,limit:20}).lots.total }
  } finally { repository.close() }
}
