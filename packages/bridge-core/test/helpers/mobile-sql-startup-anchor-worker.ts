// 合成测试固定实现身份；不从环境、移动请求或配置取得核验资格。
export {};
Object.defineProperty(globalThis, '__MUSIC_BRIDGE_LOCAL_AUDIT_VERSION__', { configurable: true, value: 'a'.repeat(64) });
await import('../../src/collection/local-album-browser/mobile-sql-worker-entry.js');
