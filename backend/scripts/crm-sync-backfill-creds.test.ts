import { describe, expect, it } from 'vitest';
import { resolveTwentyCreds } from './crm-sync-backfill-creds';

describe('crm-sync backfill credential resolution', () => {
  it('returns trimmed creds when both are non-blank', () => {
    expect(
      resolveTwentyCreds({
        TWENTY_SYNC_BASE_URL: '  http://twenty:3000  ',
        TWENTY_SYNC_API_KEY: '  secret-key  ',
      } as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: 'http://twenty:3000', apiKey: 'secret-key' });
  });

  it('rejects (null) when base url is whitespace-only', () => {
    expect(
      resolveTwentyCreds({
        TWENTY_SYNC_BASE_URL: '   ',
        TWENTY_SYNC_API_KEY: 'secret-key',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('rejects (null) when api key is whitespace-only', () => {
    expect(
      resolveTwentyCreds({
        TWENTY_SYNC_BASE_URL: 'http://twenty:3000',
        TWENTY_SYNC_API_KEY: '\t\n ',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('rejects (null) when either is missing entirely', () => {
    expect(resolveTwentyCreds({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      resolveTwentyCreds({
        TWENTY_SYNC_BASE_URL: 'http://twenty:3000',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
