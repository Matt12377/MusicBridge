export type ViewId =
  | 'home'
  | 'collection'
  | 'recording'
  | 'search'
  | 'liked'
  | 'daily-recommendations'
  | 'playlists'
  | 'playlist-detail'
  | 'roon-albums'
  | 'roon-artists'
  | 'roon-genres'
  | 'roon-playlists'
  | 'roon-favorites'
  | 'roon-album-detail'
  | 'roon-artist-detail'
  | 'roon-genre-detail'
  | 'roon-playlist-detail'
  | 'now-playing'
  | 'queue'
  | 'settings'
  | 'diagnostics'

export type SidebarSource =
  | { type: 'home' }
  | { type: 'collection' }
  | { type: 'recording' }
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
  | { type: 'roon-genre'; reference: string }
  | { type: 'roon-playlist'; reference: string }
