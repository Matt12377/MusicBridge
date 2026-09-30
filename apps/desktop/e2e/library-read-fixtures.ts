import type { ElectronApplication } from '@playwright/test'

/** 旧规格仍按具名 IPC 安装合成数据；只有被规格替换的处理器才接入新读取协议。 */
export async function connectLibraryReadFixtures(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const routes: Record<string, { channel: string; fields: string[] }> = {
      'library.search': { channel: 'library:search', fields: ['query', 'page'] },
      'library.searchArtists': { channel: 'library:search-artists', fields: ['query', 'page'] },
      'library.searchAlbums': { channel: 'library:search-albums', fields: ['query', 'page'] },
      'library.artist': { channel: 'library:artist', fields: ['artistId', 'page'] },
      'library.album': { channel: 'library:album', fields: ['albumId', 'page'] },
      'library.liked': { channel: 'library:liked', fields: ['page'] },
      'library.likeStatus': { channel: 'library:like-status', fields: ['trackId'] },
      'library.match': { channel: 'library:match', fields: ['track'] },
      'library.aggregateSearch': { channel: 'library:aggregate-search', fields: ['query', 'page'] },
      'library.playlists': { channel: 'library:playlists', fields: [] },
      'library.playlist': { channel: 'library:playlist', fields: ['playlistId', 'page'] },
      'library.dailyRecommendations': { channel: 'library:daily-recommendations', fields: [] },
      'favorites.list': { channel: 'favorites:list', fields: ['kind', 'page'] },
      'favorites.check': { channel: 'favorites:check', fields: ['descriptor'] },
      'roon.library.albums': { channel: 'roon:library:albums', fields: ['page'] },
      'roon.library.artists': { channel: 'roon:library:artists', fields: ['page'] },
      'roon.library.genres': { channel: 'roon:library:genres', fields: ['page'] },
      'roon.library.playlists': { channel: 'roon:library:playlists', fields: ['page'] },
      'roon.library.album': { channel: 'roon:library:album', fields: ['reference', 'page'] },
      'roon.library.artist': { channel: 'roon:library:artist', fields: ['reference', 'page'] },
      'roon.library.genre': { channel: 'roon:library:genre', fields: ['reference', 'page'] },
      'roon.library.playlist': { channel: 'roon:library:playlist', fields: ['reference', 'page'] },
      'roon.library.search': { channel: 'roon:library:search', fields: ['query', 'page', 'kind'] },
      'roon.library.image': { channel: 'roon:library:image', fields: ['reference', 'options'] },
    }
    const originals = new Map(Object.values(routes).map(route => [route.channel, handlers.get(route.channel)]))
    const read = handlers.get('library:read')!
    const cancel = handlers.get('library:cancel-read')!
    const pending = new Map<string, { owner: number; end: (error: Error) => void }>()
    ipcMain.removeHandler('library:read')
    ipcMain.handle('library:read', (event, request: { id: string; command: string; payload: Record<string, unknown>; deadlineAtMs: number }) => {
      const route = routes[request.command]
      const handler = route && handlers.get(route.channel)
      if (!route || !handler || handler === originals.get(route.channel)) return read(event, request)
      if (pending.has(request.id)) throw new Error('[INVALID_IPC_REQUEST] 合成读取 ID 冲突')
      return new Promise((resolve, reject) => {
        let finished = false
        const finish = (operation: () => void) => {
          if (finished) return
          finished = true; clearTimeout(timer); pending.delete(request.id); operation()
        }
        const end = (error: Error) => finish(() => reject(error))
        const timer = setTimeout(() => end(new Error('[TIMEOUT] 合成读取超时')), Math.max(0, request.deadlineAtMs - Date.now()))
        pending.set(request.id, { owner: event.sender.id, end })
        // 消费迟到失败；取消不意味着受控假服务已经物理完成。
        void Promise.resolve().then(() => handler(event, ...route.fields.map(field => request.payload[field]))).then(value => {
          if (Date.now() >= request.deadlineAtMs) { end(new Error('[TIMEOUT] 合成读取超时')); return }
          if (request.command === 'roon.library.image') {
            const envelope = value as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
            if (!envelope.ok) { end(new Error(`[${envelope.error?.code ?? 'INTERNAL_ERROR'}] 合成图片读取失败`)); return }
            value = envelope.value
          }
          finish(() => resolve(value))
        }, error => finish(() => reject(error)))
      })
    })
    ipcMain.removeHandler('library:cancel-read')
    ipcMain.handle('library:cancel-read', (event, id: string) => {
      const read = pending.get(id)
      if (!read) return cancel(event, id)
      if (read.owner !== event.sender.id) throw new Error('[INVALID_IPC_REQUEST] 不能取消其他窗口的合成读取')
      read.end(new Error('[CANCELLED] 合成读取已取消'))
    })
  })
}
