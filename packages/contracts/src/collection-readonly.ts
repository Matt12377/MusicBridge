export type CollectionReadonlyState = 'off' | 'enabling' | 'ready' | 'stale' | 'refreshing' | 'failed' | 'blocked' | 'closing';
export type CollectionReadonlyErrorCode = 'RUST_UNAVAILABLE' | 'RUST_STALE' | 'RUST_BLOCKED';
export interface CollectionReadonlySettings {
  schemaVersion: 1;
  enabled: boolean;
  mode: 'node' | 'rust';
  state: CollectionReadonlyState;
  errorCode?: CollectionReadonlyErrorCode;
}
export interface CollectionRefreshResult { schemaVersion: 1; refreshed: boolean; settings: CollectionReadonlySettings }
export interface CollectionReadonlyPublicApi {
  getCollectionReadonlySettings(): Promise<CollectionReadonlySettings>;
  setCollectionReadonlyEnabled(enabled: boolean): Promise<CollectionReadonlySettings>;
  refreshCollection(): Promise<CollectionRefreshResult>;
}

function dataObject(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return required.every(key => Object.hasOwn(descriptors, key)) && Reflect.ownKeys(descriptors).every(key => {
      if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return false;
      const descriptor = descriptors[key];
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
  } catch { return false; }
}
export function isCollectionReadonlySettings(value: unknown): value is CollectionReadonlySettings {
  return dataObject(value, ['schemaVersion', 'enabled', 'mode', 'state'], ['errorCode'])
    && value.schemaVersion === 1 && typeof value.enabled === 'boolean'
    && typeof value.mode === 'string' && ['node', 'rust'].includes(value.mode)
    && typeof value.state === 'string' && ['off', 'enabling', 'ready', 'stale', 'refreshing', 'failed', 'blocked', 'closing'].includes(value.state)
    && (!Object.hasOwn(value, 'errorCode') || typeof value.errorCode === 'string' && ['RUST_UNAVAILABLE', 'RUST_STALE', 'RUST_BLOCKED'].includes(value.errorCode));
}
export function isCollectionRefreshResult(value: unknown): value is CollectionRefreshResult {
  return dataObject(value, ['schemaVersion', 'refreshed', 'settings']) && value.schemaVersion === 1 && typeof value.refreshed === 'boolean'
    && isCollectionReadonlySettings(value.settings)
    && (!value.refreshed || value.settings.mode === 'rust' && value.settings.state === 'ready');
}
