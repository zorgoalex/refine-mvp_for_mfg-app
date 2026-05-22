import { test, expect } from '@playwright/test';

const CANARY_ENABLED = process.env.DEADLINE_ENGINE_STAGE_WORKER_WRITE_CANARY === 'true';

test.describe('deadline engine worker stage write canary', () => {
  test.skip(!CANARY_ENABLED, 'Set DEADLINE_ENGINE_STAGE_WORKER_WRITE_CANARY=true to enable the stage worker write canary scaffold.');

  test.beforeAll(() => {
    if (!process.env.DEADLINE_WORKER_FIXTURE_KEY) {
      throw new Error('Refusing to run deadline worker stage canary: DEADLINE_WORKER_FIXTURE_KEY is required.');
    }

    if (process.env.DEADLINE_WORKER_FIXTURE_RESTORE !== 'true') {
      throw new Error('Refusing to run deadline worker stage canary: DEADLINE_WORKER_FIXTURE_RESTORE=true is required.');
    }
  });

  test('refuses to perform real stage worker writes until fixture workflow is implemented', async () => {
    expect(CANARY_ENABLED).toBe(true);
    throw new Error('Deadline worker stage canary scaffold only: real stage writes are not implemented.');
  });
});
