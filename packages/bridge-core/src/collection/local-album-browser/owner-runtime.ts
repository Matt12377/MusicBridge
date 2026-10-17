import { randomUUID } from 'node:crypto'
import type { LocalRootView } from '@music-bridge/contracts'
import type { CollectionRepository } from '../repository.js'
import type { DatasetProjectionPort } from '../dataset-owner-protocol.js'
import { createLocalAlbumArtworkReader } from './artwork-read-port.js'
import { createLocalAlbumOwnerService } from './owner-port.js'
import type { LocalAlbumArtworkReadResult, LocalAlbumNameEnhancementFact } from './types.js'
import type { LocalAlbumLyricsInventory, LocalAlbumLibraryOrganization } from './sql-types.js'

/** 原 Owner 生命周期内组合；Main 只解码副本，许可与源 FD 始终由原作者收口。 */
export function createLocalAlbumOwnerRuntime(options: {
  repository: CollectionRepository; projection?: DatasetProjectionPort; datasetId?: string; assertCurrent(): void
  readRootViews(): Promise<readonly LocalRootView[]>
  nameEnhancements?: { revision(): string; read(): readonly LocalAlbumNameEnhancementFact[] }
  lyricsInventory?: LocalAlbumLyricsInventory
  readLibraryOrganizations?(): readonly LocalAlbumLibraryOrganization[]
}) {
  const artwork = createLocalAlbumArtworkReader(options)
  const acceptedSources = new WeakMap<LocalAlbumArtworkReadResult, Awaited<ReturnType<typeof artwork.readSources>>>()
  const localAlbums = createLocalAlbumOwnerService({ ...options,
    async readArtwork(request, context) {
      const sources = await artwork.readSources({ request, context }, randomUUID(), undefined, context.readDeadlineAtMs, 'display')
      options.assertCurrent()
      if (sources.image) return { image: sources.image, status: 'ready' }
      if (sources.copies.status === 'source-unavailable') return { image: null, status: 'source-unavailable' }
      if (!sources.copies.items.length) return { image: null, status: 'ready' }
      if (!options.projection) throw new Error('封面规范化服务尚未就绪。')
      const result = await options.projection.call('normalizeLocalAlbumArtwork', { copies: sources.copies }, context.readDeadlineAtMs === undefined ? undefined : { deadlineAtMs: context.readDeadlineAtMs })
      options.assertCurrent(); if (result.image) acceptedSources.set(result, sources); return result
    },
    async acceptArtwork(_request, _context, result, seal) {
      const sources = acceptedSources.get(result); acceptedSources.delete(result)
      if (sources && result.image) await artwork.retainDisplay(sources, result.image, seal)
    },
  })
  return { localAlbums, artwork,
    async close() { await artwork.close(); localAlbums.close() },
  }
}
