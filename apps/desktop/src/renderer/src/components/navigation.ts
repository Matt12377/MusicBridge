export type ViewId =
  | 'home'
  | 'search'
  | 'liked'
  | 'daily-recommendations'
  | 'playlists'
  | 'playlist-detail'
  | 'roon-albums'
  | 'roon-album-detail'
  | 'now-playing'
  | 'queue'
  | 'settings'
  | 'diagnostics'

export type SidebarSource =
  | { type: 'home' }
  | { type: 'liked' }
  | { type: 'playlists' }
  | { type: 'playlist'; playlistId: string }
  | { type: 'roon-albums' }
  | { type: 'roon-album'; reference: string }
