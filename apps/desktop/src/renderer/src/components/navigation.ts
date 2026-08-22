export type ViewId =
  | 'home'
  | 'search'
  | 'library'
  | 'playlist-detail'
  | 'now-playing'
  | 'queue'
  | 'settings'
  | 'diagnostics'

export interface NavigationItem {
  id: Exclude<ViewId, 'playlist-detail'>
  label: string
  hint: string
}
