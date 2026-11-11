import crypto from 'crypto';
import { getEnv } from '../config/env';

export interface EncryptedPayload {
  keyVersion: number;
  iv: string;
  authTag: string;
  cipherText: string;
}

export class CredentialVault {
  private static getKeyBuffer(keyVersion: number = 1): Buffer {
    const env = getEnv();
    const rawKey = keyVersion === 2
      ? (process.env.MASTER_ENCRYPTION_KEY_V2 || env.MASTER_ENCRYPTION_KEY)
      : env.MASTER_ENCRYPTION_KEY;

    if (!rawKey) {
      throw new Error(`Master encryption key for version ${keyVersion} is not configured`);
    }

    // Support both 64-char hex strings and 32-byte UTF-8 strings
    if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      return Buffer.from(rawKey, 'hex');
    }

    if (rawKey.length >= 32) {
      return Buffer.from(rawKey.slice(0, 32), 'utf-8');
    }

    // SHA-256 fallback to derive a strict 32-byte key if shorter
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  /**
   * Encrypt a sensitive API key using AES-256-GCM authenticated encryption.
   * Format: v{version}:{iv_hex}:{authTag_hex}:{cipherText_hex}
   */
  public static encrypt(plainText: string, keyVersion: number = 1): string {
    if (!plainText) throw new Error('Cannot encrypt empty string');

    const key = this.getKeyBuffer(keyVersion);
    const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `v${keyVersion}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt an envelope-encrypted payload.
   */
  public static decrypt(serialized: string): string {
    if (!serialized || !serialized.startsWith('v')) {
      throw new Error('Invalid encrypted credential format. Expected format: v{version}:{iv}:{authTag}:{cipherText}');
    }

    const parts = serialized.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted credential parts count');
    }

    const versionStr = parts[0].slice(1);
    const keyVersion = parseInt(versionStr, 10) || 1;
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const cipherText = Buffer.from(parts[3], 'hex');

    const key = this.getKeyBuffer(keyVersion);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return decrypted.toString('utf-8');
  }

  /**
   * Mask an API key for safe UI rendering and telemetry logs (e.g. "...abcd").
   */
  public static maskKey(key: string): string {
    if (!key) return '••••';
    const trimmed = key.trim();
    if (trimmed.length <= 4) return '••••';
    return `••••••••••••${trimmed.slice(-4)}`;
  }
}
