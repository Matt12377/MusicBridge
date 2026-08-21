import { createRequire } from 'node:module';
import { BridgeError } from '../shared/errors.js';
import { enforceNeteaseSafetyEnvironment, normalizeTrackId } from './policy.js';
import { parseResolvedAudioStream, parseTrackMetadata } from './parse.js';
import type {
  NeteasePort,
  QualityLevel,
  ResolvedAudioStream,
  TrackMetadata,
} from './types.js';
import {
  parseLoginStatusResponse,
  parseQrCheckResponse,
  parseQrImageResponse,
  parseQrKeyResponse,
} from './parse.js';
import type { QrLoginCheckResult, QrLoginProvider } from './qr-login.js';

type ApiResponse = Promise<unknown>;

interface NeteaseApiModule {
  song_detail(params: Record<string, unknown>): ApiResponse;
  song_url_v1(params: Record<string, unknown>): ApiResponse;
  login_qr_key(params: Record<string, unknown>): ApiResponse;
  login_qr_create(params: Record<string, unknown>): ApiResponse;
  login_qr_check(params: Record<string, unknown>): ApiResponse;
  login_status(params: Record<string, unknown>): ApiResponse;
  logout(params: Record<string, unknown>): ApiResponse;
}

function loadApi(): NeteaseApiModule {
  enforceNeteaseSafetyEnvironment(process.env);
  const require = createRequire(import.meta.url);
  return require('@neteasecloudmusicapienhanced/api') as NeteaseApiModule;
}

export class NeteaseClient implements NeteasePort, QrLoginProvider {
  private cookie: string | undefined;
  private readonly api: NeteaseApiModule;

  constructor(cookie: string | undefined, api: NeteaseApiModule = loadApi()) {
    this.cookie = cookie?.trim() || undefined;
    this.api = api;
  }

  get configured(): boolean {
    return this.cookie !== undefined;
  }

  setCredential(credential: string): void {
    this.cookie = credential.trim() || undefined;
  }

  clearCredential(): void {
    this.cookie = undefined;
  }

  async createQr(): Promise<{ key: string; qrImage: string }> {
    const keyResponse = await this.api.login_qr_key({})
    const key = parseQrKeyResponse(keyResponse)
    const imageResponse = await this.api.login_qr_create({ key, qrimg: true })
    return { key, qrImage: parseQrImageResponse(imageResponse) }
  }

  async checkQr(key: string): Promise<QrLoginCheckResult> {
    return parseQrCheckResponse(await this.api.login_qr_check({ key }))
  }

  async verifyCredential(credential: string): Promise<boolean> {
    try {
      return parseLoginStatusResponse(
        await this.api.login_status({ cookie: credential }),
      )
    } catch {
      return false
    }
  }

  async logout(): Promise<void> {
    const cookie = this.cookie
    try {
      if (cookie) {
        await this.api.logout({ cookie })
      }
    } finally {
      this.clearCredential()
    }
  }

  async getTrack(trackIdInput: string): Promise<TrackMetadata> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    try {
      const response = await this.api.song_detail({
        ids: trackId,
        cookie,
      });
      return parseTrackMetadata(response, trackId);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'NETEASE_REQUEST_FAILED',
        'NetEase song metadata request failed',
        { cause: error, httpStatus: 502, details: { trackId } },
      );
    }
  }

  async resolveStream(
    trackIdInput: string,
    quality: QualityLevel,
  ): Promise<ResolvedAudioStream> {
    const trackId = normalizeTrackId(trackIdInput);
    const cookie = this.requireCookie();
    try {
      // Intentionally no `unblock`, `source`, proxy, randomIP or match parameter.
      const response = await this.api.song_url_v1({
        id: trackId,
        level: quality,
        cookie,
      });
      return parseResolvedAudioStream(response, trackId, quality);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'NETEASE_REQUEST_FAILED',
        'NetEase audio URL request failed',
        { cause: error, httpStatus: 502, details: { trackId, quality } },
      );
    }
  }

  private requireCookie(): string {
    if (!this.cookie) {
      throw new BridgeError(
        'NETEASE_NOT_CONFIGURED',
        'NETEASE_COOKIE is not configured',
        { httpStatus: 503 },
      );
    }
    return this.cookie;
  }
}
