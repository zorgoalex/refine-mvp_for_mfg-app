import { describe, expect, it } from 'vitest';
// @ts-ignore plain ESM helper of the browser scripts, no types
import { isStageRelayTarget, settingsRestoreRequest, stageTargetProblem } from '../../../tests/helpers/clientScreenLiveGuards.mjs';

describe('live check: stage target only', () => {
  it('accepts a deployment that talks to the stage backend and the stage Hasura', () => {
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app', hasuraUrl: 'https://hasura-test.mebelkz.app/v1/graphql' })).toBeNull();
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app/api/v1' })).toBeNull();
  });

  it('rejects the production backend, an unknown backend and a missing one', () => {
    expect(stageTargetProblem({ apiUrl: 'https://backend-ovh.mebelkz.app', hasuraUrl: 'https://hasura-ovh.mebelkz.app/v1/graphql' })).toMatch(/not the stage backend/);
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app.example.com' })).toMatch(/not the stage backend/);
    expect(stageTargetProblem({ apiUrl: 'http://backend-test.mebelkz.app' })).toMatch(/not the stage backend/);
    expect(stageTargetProblem({})).toMatch(/no apiUrl/);
    expect(stageTargetProblem(null)).toMatch(/no apiUrl/);
  });

  it('rejects the stage backend paired with a production Hasura', () => {
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app', hasuraUrl: 'https://hasura-ovh.mebelkz.app/v1/graphql' })).toMatch(/not the stage Hasura/);
  });

  it('relays only stage endpoints', () => {
    expect(isStageRelayTarget('https://backend-test.mebelkz.app/api/v1/auth/login')).toBe(true);
    expect(isStageRelayTarget('https://hasura-test.mebelkz.app/v1/graphql')).toBe(true);
    expect(isStageRelayTarget('https://backend-ovh.mebelkz.app/api/v1/auth/login')).toBe(false);
    expect(isStageRelayTarget('https://mebelkz.app/api/runtime-config')).toBe(false);
    expect(isStageRelayTarget('not a url')).toBe(false);
  });
});

describe('live check: restoring the shared setting', () => {
  const original = { enabled: false, visibleCodes: ['tab.basic'], version: 7 };

  it('restores against the version this run produced', () => {
    expect(settingsRestoreRequest(original, { enabled: true, visibleCodes: ['tab.basic', 'tab.details'], version: 8 }))
      .toEqual({ enabled: false, visibleCodes: ['tab.basic'], expectedVersion: 8 });
  });

  it('restores nothing when this run changed nothing (its write was rejected or never made)', () => {
    expect(settingsRestoreRequest(original, null)).toBeNull();
    expect(settingsRestoreRequest(null, { version: 8 })).toBeNull();
    expect(settingsRestoreRequest(original, {})).toBeNull();
  });
});
