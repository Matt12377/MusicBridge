import type { LyricsSnapshot, PlaybackSnapshot } from '@music-bridge/contracts';
import { emptyLyricsSnapshot } from '../netease/lyrics.js';

const MAX_LYRICS_CACHE_ENTRIES = 50;
const LYRICS_PUSH_INTERVAL_MS = 250;

export interface LyricsCoordinatorOptions {
  load: (trackId: string) => Promise<LyricsSnapshot>;
  now?: () => number;
  onChange?: (snapshot: LyricsSnapshot) => void;
  scheduleEstimatedUpdates?: (callback: () => void) => () => void;
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function cloneSnapshot(snapshot: LyricsSnapshot): LyricsSnapshot {
  return {
    status: snapshot.status,
    lines: snapshot.lines.map((line) => ({
      startMs: line.startMs,
      ...(line.endMs !== undefined ? { endMs: line.endMs } : {}),
      text: line.text,
      ...(line.translation !== undefined ? { translation: line.translation } : {}),
      ...(line.romanization !== undefined ? { romanization: line.romanization } : {}),
      ...(line.words
        ? { words: line.words.map((word) => ({ ...word })) }
        : {}),
    })),
    activeLineIndex: snapshot.activeLineIndex,
    ...(snapshot.activeWordIndex !== undefined
      ? { activeWordIndex: snapshot.activeWordIndex }
      : {}),
    timingSource: snapshot.timingSource,
  };
}

function loadingSnapshot(): LyricsSnapshot {
  return emptyLyricsSnapshot('loading');
}

function errorSnapshot(): LyricsSnapshot {
  return emptyLyricsSnapshot('error');
}

function lineAtPosition(snapshot: LyricsSnapshot, positionMs: number): number {
  let candidate = -1;
  for (let index = 0; index < snapshot.lines.length; index += 1) {
    const line = snapshot.lines[index];
    if (!line || line.startMs > positionMs) break;
    if (line.endMs === undefined || positionMs < line.endMs) return index;
    candidate = index;
  }
  return candidate >= 0 && candidate === snapshot.lines.length - 1 ? candidate : -1;
}

function wordAtPosition(
  snapshot: LyricsSnapshot,
  lineIndex: number,
  positionMs: number,
): number {
  const line = snapshot.lines[lineIndex];
  if (!line?.words) return -1;
  for (let index = 0; index < line.words.length; index += 1) {
    const word = line.words[index];
    if (!word) continue;
    if (positionMs < word.startMs) return -1;
    if (positionMs < word.endMs) return index;
  }
  return -1;
}

export class LyricsCoordinator {
  private readonly cache = new Map<string, LyricsSnapshot>();
  private readonly now: () => number;
  private readonly onChange: (snapshot: LyricsSnapshot) => void;
  private generation = 0;
  private activeTrackId: string | undefined;
  private activeSnapshot: LyricsSnapshot = emptyLyricsSnapshot();
  private positionAnchorMs: number | undefined;
  private positionAnchorClockMs: number | undefined;
  private cancelEstimatedUpdates: () => void = () => undefined;
  private lastEmittedAt = Number.NEGATIVE_INFINITY;
  private lastEmittedKey = '';
  private readonly scheduleEstimatedUpdates: (callback: () => void) => () => void;

  constructor(private readonly options: LyricsCoordinatorOptions) {
    this.now = options.now ?? monotonicNowMs;
    this.onChange = options.onChange ?? (() => undefined);
    this.scheduleEstimatedUpdates = options.scheduleEstimatedUpdates ?? (() => () => undefined);
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  getSnapshot(): LyricsSnapshot {
    return cloneSnapshot(this.activeSnapshot);
  }

  async getLyrics(trackId: string): Promise<LyricsSnapshot> {
    if (this.activeTrackId === trackId) return this.getSnapshot();
    const cached = this.readCache(trackId);
    if (cached) return cloneSnapshot(cached);
    return this.loadSnapshot(trackId);
  }

  onPlaybackChanged(snapshot: PlaybackSnapshot): void {
    const trackId = snapshot.currentTrack?.id;
    if (!trackId || snapshot.state === 'idle' || snapshot.state === 'stopping' || snapshot.state === 'error') {
      this.invalidateActive();
      return;
    }

    if (this.activeTrackId !== trackId) {
      this.stopEstimatedUpdates();
      this.generation += 1;
      const generation = this.generation;
      this.activeTrackId = trackId;
      this.positionAnchorMs = undefined;
      this.positionAnchorClockMs = undefined;
      const cached = this.readCache(trackId);
      this.activeSnapshot = cached ? cloneSnapshot(cached) : loadingSnapshot();
      this.emit(true);
      if (!cached) void this.loadActive(trackId, generation);
    }

    if (snapshot.state === 'playing') {
      if (snapshot.positionMs > 0) this.updateRoonTime(snapshot.positionMs);
      else this.markPlaying(trackId);
    }
  }

  setActiveLyrics(trackId: string, snapshot: LyricsSnapshot): void {
    this.stopEstimatedUpdates();
    this.generation += 1;
    this.activeTrackId = trackId;
    this.positionAnchorMs = undefined;
    this.positionAnchorClockMs = undefined;
    this.activeSnapshot = {
      ...cloneSnapshot(snapshot),
      activeLineIndex: -1,
      timingSource: 'static',
    };
    delete this.activeSnapshot.activeWordIndex;
    this.emit(true);
  }

  markPlaying(trackId: string): void {
    if (this.activeTrackId !== trackId) return;
    if (this.positionAnchorMs === undefined || this.positionAnchorClockMs === undefined) {
      this.positionAnchorMs = 0;
      this.positionAnchorClockMs = this.now();
      this.startEstimatedUpdates(trackId, this.generation);
    }
    this.updateEstimated();
  }

  updateEstimated(): void {
    if (this.positionAnchorMs === undefined || this.positionAnchorClockMs === undefined) return;
    this.applyPosition(
      Math.max(0, this.positionAnchorMs + this.now() - this.positionAnchorClockMs),
      'estimated',
    );
  }

  updateRoonTime(positionMs: number): void {
    if (!Number.isSafeInteger(positionMs) || positionMs < 0) return;
    if (this.activeTrackId === undefined) return;
    this.positionAnchorMs = positionMs;
    this.positionAnchorClockMs = this.now();
    this.startEstimatedUpdates(this.activeTrackId, this.generation);
    this.applyPosition(positionMs, 'roon-time');
  }

  shutdown(): void {
    this.stopEstimatedUpdates();
    this.generation += 1;
    this.activeTrackId = undefined;
    this.positionAnchorMs = undefined;
    this.positionAnchorClockMs = undefined;
    this.activeSnapshot = emptyLyricsSnapshot();
    this.emit(true);
  }

  private async loadActive(trackId: string, generation: number): Promise<void> {
    try {
      const loaded = await this.loadSnapshot(trackId);
      if (generation !== this.generation || this.activeTrackId !== trackId) return;
      this.activeSnapshot = cloneSnapshot(loaded);
      this.emit(true);
      if (this.positionAnchorMs !== undefined) this.updateEstimated();
    } catch {
      if (generation !== this.generation || this.activeTrackId !== trackId) return;
      this.activeSnapshot = errorSnapshot();
      this.emit(true);
    }
  }

  private async loadSnapshot(trackId: string): Promise<LyricsSnapshot> {
    try {
      const loaded = cloneSnapshot(await this.options.load(trackId));
      if (loaded.status !== 'error') this.writeCache(trackId, loaded);
      return loaded;
    } catch {
      return errorSnapshot();
    }
  }

  private readCache(trackId: string): LyricsSnapshot | undefined {
    const cached = this.cache.get(trackId);
    if (!cached) return undefined;
    this.cache.delete(trackId);
    this.cache.set(trackId, cached);
    return cached;
  }

  private writeCache(trackId: string, snapshot: LyricsSnapshot): void {
    this.cache.delete(trackId);
    this.cache.set(trackId, cloneSnapshot(snapshot));
    while (this.cache.size > MAX_LYRICS_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private invalidateActive(): void {
    if (this.activeTrackId === undefined && this.activeSnapshot.status === 'idle') return;
    this.generation += 1;
    this.stopEstimatedUpdates();
    this.activeTrackId = undefined;
    this.positionAnchorMs = undefined;
    this.positionAnchorClockMs = undefined;
    this.activeSnapshot = emptyLyricsSnapshot();
    this.emit(true);
  }

  private startEstimatedUpdates(trackId: string, generation: number): void {
    this.stopEstimatedUpdates();
    this.cancelEstimatedUpdates = this.scheduleEstimatedUpdates(() => {
      if (generation !== this.generation || this.activeTrackId !== trackId) {
        this.stopEstimatedUpdates();
        return;
      }
      this.updateEstimated();
    });
  }

  private stopEstimatedUpdates(): void {
    this.cancelEstimatedUpdates();
    this.cancelEstimatedUpdates = () => undefined;
  }

  private applyPosition(
    positionMs: number,
    timingSource: LyricsSnapshot['timingSource'],
  ): void {
    if (this.activeSnapshot.status !== 'ready') return;
    const activeLineIndex = lineAtPosition(this.activeSnapshot, positionMs);
    const activeWordIndex = wordAtPosition(this.activeSnapshot, activeLineIndex, positionMs);
    const next: LyricsSnapshot = {
      ...this.activeSnapshot,
      activeLineIndex,
      ...(activeWordIndex >= 0 ? { activeWordIndex } : {}),
      timingSource,
    };
    if (activeWordIndex < 0) delete next.activeWordIndex;
    this.activeSnapshot = next;
    this.emit(false);
  }

  private emit(force: boolean): void {
    const snapshot = cloneSnapshot(this.activeSnapshot);
    const key = `${snapshot.status}:${snapshot.activeLineIndex}:${snapshot.activeWordIndex ?? -1}:${snapshot.timingSource}:${snapshot.lines.length}`;
    if (!force && key === this.lastEmittedKey) return;
    const now = this.now();
    if (!force && now - this.lastEmittedAt < LYRICS_PUSH_INTERVAL_MS) return;
    this.lastEmittedAt = now;
    this.lastEmittedKey = key;
    this.onChange(snapshot);
  }
}
