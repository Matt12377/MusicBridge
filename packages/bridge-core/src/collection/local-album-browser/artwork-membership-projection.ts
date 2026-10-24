import type { DatabaseSync } from 'node:sqlite'
import type { LocalAlbumScanPoint } from './scan-delta.js'

/** 仅当前同步SQL回调的纯成员摘要；不授予Source、FD或资源写入能力，不进入wire。 */
export type LocalAlbumArtworkMembershipProjection = Readonly<Record<never, never>>
export interface LocalAlbumArtworkMembershipFact {
  albumKey: string; rootId: string; editionId: null; representativeTrackId: string; membership: string
}
interface Issuer { db: DatabaseSync; point: Readonly<LocalAlbumScanPoint>; author: object; active: boolean }
const records = new WeakMap<LocalAlbumArtworkMembershipProjection, { issuer: Issuer; fact: Readonly<LocalAlbumArtworkMembershipFact> }>()
const samePoint = (a: LocalAlbumScanPoint, b: LocalAlbumScanPoint): boolean => a.changes === b.changes && a.version === b.version && a.schema === b.schema
export function readLocalAlbumArtworkMembershipProjection(projection: LocalAlbumArtworkMembershipProjection, author?: object, db?: DatabaseSync, point?: LocalAlbumScanPoint | null): Readonly<LocalAlbumArtworkMembershipFact> | undefined {
  const saved = records.get(projection)
  if (!saved?.issuer.active || author !== undefined && saved.issuer.author !== author || db !== undefined && saved.issuer.db !== db
    || point !== undefined && (!point || !samePoint(saved.issuer.point, point))) return undefined
  return saved.fact
}
/** 每次UDF调用结束即删证书，run退出再封issuer；捕获旧对象不能跨回调或await重放。 */
export function createLocalAlbumArtworkMembershipIssuer(db: DatabaseSync, point: LocalAlbumScanPoint, author: object) {
  const issuer: Issuer = { db, point: Object.freeze({ ...point }), author, active: true }
  return {
    read<T>(fact: LocalAlbumArtworkMembershipFact, read: (proof: LocalAlbumArtworkMembershipProjection) => T): T | undefined {
      if (!issuer.active || db.isTransaction || fact.editionId !== null || !/^[a-f0-9]{64}$/u.test(fact.membership)
        || !fact.albumKey || fact.albumKey.length > 256 || !fact.rootId || fact.rootId.length > 128 || !fact.representativeTrackId || fact.representativeTrackId.length > 128) return undefined
      const proof = Object.freeze({})
      records.set(proof, { issuer, fact: Object.freeze({ ...fact }) })
      try { return read(proof) } finally { records.delete(proof) }
    },
    close(): void { issuer.active = false },
  }
}
