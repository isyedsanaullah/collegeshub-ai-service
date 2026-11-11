process.env.NODE_ENV = 'test';
process.env.PORT = '4005';
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-test-secret-test-secret-32b';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.MASTER_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { CredentialVault } from '../src/security/CredentialVault';

describe('CredentialVault Envelope Encryption (AES-256-GCM)', () => {
  const secretKey = 'sk-gemini-test-secret-key-1234567890';

  it('should encrypt and decrypt a sensitive credential string correctly', () => {
    const encrypted = CredentialVault.encrypt(secretKey);
    expect(encrypted).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    const decrypted = CredentialVault.decrypt(encrypted);
    expect(decrypted).toBe(secretKey);
  });

  it('should generate distinct ciphertexts for identical plaintexts (unique IV per encryption)', () => {
    const enc1 = CredentialVault.encrypt(secretKey);
    const enc2 = CredentialVault.encrypt(secretKey);

    expect(enc1).not.toBe(enc2);
    expect(CredentialVault.decrypt(enc1)).toBe(secretKey);
    expect(CredentialVault.decrypt(enc2)).toBe(secretKey);
  });

  it('should throw an error when attempting to decrypt tampered cipherText', () => {
    const encrypted = CredentialVault.encrypt(secretKey);
    const parts = encrypted.split(':');
    
    // Tamper with the ciphertext payload
    const tamperedPayload = parts[3].slice(0, -2) + (parts[3].endsWith('a') ? 'b' : 'a');
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedPayload}`;

    expect(() => {
      CredentialVault.decrypt(tampered);
    }).toThrow();
  });

  it('should throw an error when attempting to decrypt with a tampered auth tag', () => {
    const encrypted = CredentialVault.encrypt(secretKey);
    const parts = encrypted.split(':');
    
    // Tamper with the authentication tag
    const tamperedTag = '00' + parts[2].slice(2);
    const tampered = `${parts[0]}:${parts[1]}:${tamperedTag}:${parts[3]}`;

    expect(() => {
      CredentialVault.decrypt(tampered);
    }).toThrow();
  });

  it('should throw an error for malformed payload structures', () => {
    expect(() => CredentialVault.decrypt('invalid-string')).toThrow('Invalid encrypted credential format');
    expect(() => CredentialVault.decrypt('v1:only:three:parts:extra:parts')).toThrow();
  });

  it('should support key rotation with multiple key versions', () => {
    process.env.MASTER_ENCRYPTION_KEY_V2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    
    // Encrypt with v1
    const encV1 = CredentialVault.encrypt(secretKey, 1);
    expect(encV1.startsWith('v1:')).toBe(true);

    // Encrypt with v2
    const encV2 = CredentialVault.encrypt(secretKey, 2);
    expect(encV2.startsWith('v2:')).toBe(true);

    // Both should decrypt correctly
    expect(CredentialVault.decrypt(encV1)).toBe(secretKey);
    expect(CredentialVault.decrypt(encV2)).toBe(secretKey);
  });
});
