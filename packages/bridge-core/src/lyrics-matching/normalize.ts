const ARTIST_SEPARATOR = /\s*(?:,|，|、|&|；|;|\/|\b(?:and|feat\.?|featuring|with)\b)\s*/giu

export function normalizeLyricsText(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[()[\]{}。、，,。:：;；!！?？'"“”‘’·•_\-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function normalizeLyricsArtists(artists: readonly string[]): readonly string[] {
  const normalized = artists
    .flatMap((artist) => artist.split(ARTIST_SEPARATOR))
    .map((artist) => normalizeLyricsText(artist))
    .filter(Boolean)

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function lyricsArtistsIntersect(
  recordingArtists: readonly string[],
  candidateArtists: readonly string[],
): boolean {
  const recording = new Set(normalizeLyricsArtists(recordingArtists))
  return normalizeLyricsArtists(candidateArtists).some((artist) => recording.has(artist))
}
