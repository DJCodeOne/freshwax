import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the firebase modules before importing admin-query
vi.mock('../lib/firebase-rest', () => ({
  queryCollection: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/firebase-service-account', () => ({
  saQueryCollection: vi.fn().mockResolvedValue([]),
}));

import { getSaQuery } from '../lib/admin-query';
import { queryCollection } from '../lib/firebase-rest';
import { saQueryCollection } from '../lib/firebase-service-account';

// =============================================
// getSaQuery
// =============================================
describe('getSaQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a function', () => {
    const locals = { runtime: { env: {} } } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);
    expect(typeof queryFn).toBe('function');
  });

  it('falls back to queryCollection when no service account creds', () => {
    const locals = { runtime: { env: {} } } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    queryFn('users');
    expect(queryCollection).toHaveBeenCalledWith('users', undefined);
  });

  it('falls back to queryCollection when clientEmail is missing', () => {
    const locals = {
      runtime: {
        env: {
          FIREBASE_PRIVATE_KEY: 'some-key',
          // no FIREBASE_CLIENT_EMAIL
        },
      },
    } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    queryFn('orders', { limit: 10 });
    expect(queryCollection).toHaveBeenCalledWith('orders', { limit: 10 });
    expect(saQueryCollection).not.toHaveBeenCalled();
  });

  it('falls back to queryCollection when privateKey is missing', () => {
    const locals = {
      runtime: {
        env: {
          FIREBASE_CLIENT_EMAIL: 'sa@project.iam.gserviceaccount.com',
          // no FIREBASE_PRIVATE_KEY
        },
      },
    } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    queryFn('artists');
    expect(queryCollection).toHaveBeenCalledWith('artists', undefined);
    expect(saQueryCollection).not.toHaveBeenCalled();
  });

  it('uses saQueryCollection when both creds are present', () => {
    const locals = {
      runtime: {
        env: {
          FIREBASE_CLIENT_EMAIL: 'sa@project.iam.gserviceaccount.com',
          FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----',
          FIREBASE_PROJECT_ID: 'my-project',
        },
      },
    } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    queryFn('users', { filters: [{ field: 'role', op: 'EQUAL', value: 'admin' }] });
    expect(saQueryCollection).toHaveBeenCalled();
    expect(queryCollection).not.toHaveBeenCalled();
  });

  it('passes correct projectId to saQueryCollection', () => {
    const locals = {
      runtime: {
        env: {
          FIREBASE_CLIENT_EMAIL: 'sa@project.iam.gserviceaccount.com',
          FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
          FIREBASE_PROJECT_ID: 'custom-project',
        },
      },
    } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    queryFn('users');
    expect(saQueryCollection).toHaveBeenCalledWith(
      expect.any(String),
      'custom-project',
      'users',
      undefined,
    );
  });

  it('defaults projectId to freshwax-store when not in env', () => {
    const locals = {
      runtime: {
        env: {
          FIREBASE_CLIENT_EMAIL: 'sa@project.iam.gserviceaccount.com',
          FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
        },
      },
    } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    queryFn('orders');
    expect(saQueryCollection).toHaveBeenCalledWith(
      expect.any(String),
      'freshwax-store',
      'orders',
      undefined,
    );
  });

  it('constructs service account key JSON with newline replacement', () => {
    const locals = {
      runtime: {
        env: {
          FIREBASE_CLIENT_EMAIL: 'test@test.iam.gserviceaccount.com',
          FIREBASE_PRIVATE_KEY: 'line1\\nline2\\nline3',
          FIREBASE_PROJECT_ID: 'test-project',
        },
      },
    } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    queryFn('collection');
    const keyArg = (saQueryCollection as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(keyArg);
    expect(parsed.type).toBe('service_account');
    expect(parsed.client_email).toBe('test@test.iam.gserviceaccount.com');
    expect(parsed.project_id).toBe('test-project');
    // Literal \\n in env value should be replaced with actual newlines
    expect(parsed.private_key).toContain('\n');
  });

  it('handles locals with no runtime gracefully', () => {
    const locals = {} as unknown as App.Locals;
    const queryFn = getSaQuery(locals);
    expect(typeof queryFn).toBe('function');

    // Should fall back to queryCollection since no creds
    queryFn('test');
    expect(queryCollection).toHaveBeenCalledWith('test', undefined);
  });

  it('passes query options through to saQueryCollection', () => {
    const locals = {
      runtime: {
        env: {
          FIREBASE_CLIENT_EMAIL: 'sa@proj.iam.gserviceaccount.com',
          FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----',
          FIREBASE_PROJECT_ID: 'proj',
        },
      },
    } as unknown as App.Locals;
    const queryFn = getSaQuery(locals);

    const opts = {
      filters: [{ field: 'status', op: 'EQUAL', value: 'active' }],
      orderBy: { field: 'createdAt', direction: 'DESCENDING' as const },
      limit: 25,
    };
    queryFn('orders', opts);
    expect(saQueryCollection).toHaveBeenCalledWith(
      expect.any(String),
      'proj',
      'orders',
      opts,
    );
  });
});
