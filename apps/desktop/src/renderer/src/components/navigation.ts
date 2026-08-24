export type ViewId =
  | 'home'
  | 'search'
  | 'liked'
  | 'daily-recommendations'
  | 'playlists'
  | 'playlist-detail'
  | 'roon-albums'
  | 'roon-favorites'
  | 'roon-album-detail'
  | 'roon-artist-detail'
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
  | { type: 'roon-artists' }
  | { type: 'roon-genres' }
  | { type: 'roon-playlists' }
  | { type: 'roon-favorites' }
  | { type: 'roon-album'; reference: string }
  | { type: 'roon-artist'; reference: string }
