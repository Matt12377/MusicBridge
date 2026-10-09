import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MobileAuthPersistenceError, MOBILE_AUTH_STATE_MAX_BYTES, type MobileAuthCrypto } from './types.js';

/** 移动认证独立密钥；AAD 由服务绑定 server、dataset 和原提交修订。 */
export function createMobileAuthCrypto(input: Uint8Array): MobileAuthCrypto {
  if (!(input instanceof Uint8Array) || input.length !== 32) throw new MobileAuthPersistenceError('not-sent');
  const key = Buffer.from(input);
  return {
    seal(plain, aad) {
      if (!(plain instanceof Uint8Array) || !plain.length || plain.length > MOBILE_AUTH_STATE_MAX_BYTES) throw new MobileAuthPersistenceError('not-sent');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      return new Uint8Array(Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]));
    },
    open(sealed, aad) {
      try {
        if (!(sealed instanceof Uint8Array) || sealed.length < 30 || sealed.length > MOBILE_AUTH_STATE_MAX_BYTES + 29 || sealed[0] !== 1) throw new Error('密文格式无效。');
        const decipher = createDecipheriv('aes-256-gcm', key, sealed.slice(1, 13));
        decipher.setAAD(aad); decipher.setAuthTag(sealed.slice(13, 29));
        return new Uint8Array(Buffer.concat([decipher.update(sealed.slice(29)), decipher.final()]));
      } catch { throw new MobileAuthPersistenceError('not-sent'); }
    },
  };
}
