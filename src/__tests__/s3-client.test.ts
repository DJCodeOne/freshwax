import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dom-polyfill import so it doesn't execute side effects
vi.mock('../lib/dom-polyfill', () => ({}));

// Mock @aws-sdk/client-s3 to avoid real AWS SDK initialization
// Must use a class so `new S3Client(...)` works
const mockS3Configs: unknown[] = [];
vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class MockS3Client {
      _config: unknown;
      constructor(config: unknown) {
        this._config = config;
        mockS3Configs.push(config);
      }
      send() {}
      destroy() {}
    },
  };
});

import { createS3Client } from '../lib/s3-client';

// =============================================
// createS3Client
// =============================================
describe('createS3Client', () => {
  beforeEach(() => {
    mockS3Configs.length = 0;
  });

  it('returns a defined client object', () => {
    const config = {
      accountId: 'test-account-id',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      bucketName: 'test-bucket',
      uploadsBucket: 'test-uploads',
      publicUrl: 'https://example.r2.dev',
      publicDomain: 'https://cdn.example.com',
    };

    const client = createS3Client(config);
    expect(client).toBeDefined();
    expect(mockS3Configs).toHaveLength(1);
  });

  it('configures region as auto for R2', () => {
    const config = {
      accountId: 'abc123',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucketName: 'bucket',
      uploadsBucket: 'uploads',
      publicUrl: 'https://example.r2.dev',
      publicDomain: 'https://cdn.example.com',
    };

    createS3Client(config);
    const passedConfig = mockS3Configs[0] as Record<string, unknown>;
    expect(passedConfig.region).toBe('auto');
  });

  it('constructs the correct R2 endpoint from accountId', () => {
    const config = {
      accountId: 'my-account-123',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucketName: 'bucket',
      uploadsBucket: 'uploads',
      publicUrl: 'https://example.r2.dev',
      publicDomain: 'https://cdn.example.com',
    };

    createS3Client(config);
    const passedConfig = mockS3Configs[0] as Record<string, unknown>;
    expect(passedConfig.endpoint).toBe('https://my-account-123.r2.cloudflarestorage.com');
  });

  it('passes credentials from config', () => {
    const config = {
      accountId: 'acc',
      accessKeyId: 'AKID_TEST',
      secretAccessKey: 'SECRET_TEST_KEY',
      bucketName: 'bucket',
      uploadsBucket: 'uploads',
      publicUrl: 'https://example.r2.dev',
      publicDomain: 'https://cdn.example.com',
    };

    createS3Client(config);
    const passedConfig = mockS3Configs[0] as Record<string, unknown>;
    expect(passedConfig.credentials).toEqual({
      accessKeyId: 'AKID_TEST',
      secretAccessKey: 'SECRET_TEST_KEY',
    });
  });

  it('handles empty string credentials without throwing', () => {
    const config = {
      accountId: '',
      accessKeyId: '',
      secretAccessKey: '',
      bucketName: '',
      uploadsBucket: '',
      publicUrl: '',
      publicDomain: '',
    };

    expect(() => createS3Client(config)).not.toThrow();
    const passedConfig = mockS3Configs[0] as Record<string, unknown>;
    expect(passedConfig.endpoint).toBe('https://.r2.cloudflarestorage.com');
    expect(passedConfig.credentials).toEqual({
      accessKeyId: '',
      secretAccessKey: '',
    });
  });
});
