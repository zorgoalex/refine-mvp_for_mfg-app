import { describe, expect, it } from 'vitest';
// @ts-ignore plain ESM helper of the browser scripts, no types
import {
  createSettingsChange, isForbiddenDataRequest, isStageRelayTarget, settingsRestorePlan, stageTargetProblem,
} from '../../../tests/helpers/clientScreenLiveGuards.mjs';

describe('live check: stage target only', () => {
  it('accepts a deployment that talks to the stage backend and the stage Hasura', () => {
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app', hasuraUrl: 'https://hasura-test.mebelkz.app/v1/graphql' })).toBeNull();
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app/api/v1', hasuraUrl: 'https://hasura-test.mebelkz.app' })).toBeNull();
  });

  it('rejects the production backend, an unknown backend and a missing one', () => {
    expect(stageTargetProblem({ apiUrl: 'https://backend-ovh.mebelkz.app', hasuraUrl: 'https://hasura-ovh.mebelkz.app/v1/graphql' })).toMatch(/not the stage backend/);
    const hasuraUrl = 'https://hasura-test.mebelkz.app/v1/graphql';
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app.example.com', hasuraUrl })).toMatch(/not the stage backend/);
    expect(stageTargetProblem({ apiUrl: 'http://backend-test.mebelkz.app', hasuraUrl })).toMatch(/not the stage backend/);
    expect(stageTargetProblem({})).toMatch(/no apiUrl/);
    expect(stageTargetProblem(null)).toMatch(/no apiUrl/);
  });

  it('rejects the stage backend paired with a production Hasura', () => {
    expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app', hasuraUrl: 'https://hasura-ovh.mebelkz.app/v1/graphql' })).toMatch(/not the stage Hasura/);
  });

  it('rejects a configuration without a Hasura address (the bundle would fall back to its built-in one)', () => {
    for (const hasuraUrl of [undefined, null, '', 'not a url']) {
      expect(stageTargetProblem({ apiUrl: 'https://backend-test.mebelkz.app', hasuraUrl })).toMatch(/not the stage Hasura/);
    }
  });

  it('relays only stage endpoints', () => {
    expect(isStageRelayTarget('https://backend-test.mebelkz.app/api/v1/auth/login')).toBe(true);
    expect(isStageRelayTarget('https://hasura-test.mebelkz.app/v1/graphql')).toBe(true);
    expect(isStageRelayTarget('https://backend-ovh.mebelkz.app/api/v1/auth/login')).toBe(false);
    expect(isStageRelayTarget('https://mebelkz.app/api/runtime-config')).toBe(false);
    expect(isStageRelayTarget('not a url')).toBe(false);
  });

  it('data calls may go to the page itself and to stage only', () => {
    const page = 'https://preview.example.vercel.app';
    expect(isForbiddenDataRequest('https://backend-test.mebelkz.app/api/v1/orders', 'fetch', page)).toBe(false);
    expect(isForbiddenDataRequest('https://hasura-test.mebelkz.app/v1/graphql', 'xhr', page)).toBe(false);
    expect(isForbiddenDataRequest('wss://hasura-test.mebelkz.app/v1/graphql', 'websocket', page)).toBe(false);
    expect(isForbiddenDataRequest(`${page}/api/runtime-config`, 'fetch', page)).toBe(false);
    expect(isForbiddenDataRequest('https://hasura-ovh.mebelkz.app/v1/graphql', 'fetch', page)).toBe(true);
    expect(isForbiddenDataRequest('https://backend-ovh.mebelkz.app/api/v1/auth/login', 'xhr', page)).toBe(true);
    expect(isForbiddenDataRequest('wss://hasura-ovh.mebelkz.app/v1/graphql', 'websocket', page)).toBe(true);
    expect(isForbiddenDataRequest('https://telemetry.example.com/collect', 'ping', page)).toBe(true);
    expect(isForbiddenDataRequest('https://fonts.example.com/font.woff2', 'font', page)).toBe(false);
    expect(isForbiddenDataRequest('blob:https://preview.example.vercel.app/1', 'fetch', page)).toBe(false);
  });
});

describe('live check: restoring the shared setting', () => {
  const original = { enabled: false, visibleCodes: ['tab.basic'], version: 7 };
  const accepted = { ok: true, status: 200, body: { enabled: true, visibleCodes: ['tab.basic', 'tab.details'], version: 8, changed: true } };

  it('restores its own change against the version that change produced', async () => {
    const change = createSettingsChange();
    await change.run(async () => accepted);
    expect(settingsRestorePlan(original, change.outcome()))
      .toEqual({ action: 'restore', request: { enabled: false, visibleCodes: ['tab.basic'], expectedVersion: 8 } });
  });

  it('nothing was sent → nothing to restore', () => {
    expect(settingsRestorePlan(original, createSettingsChange().outcome()).action).toBe('none');
  });

  it('the server refused the change (somebody was faster: 409) → nothing is restored', async () => {
    const change = createSettingsChange();
    await change.run(async () => ({ ok: false, status: 409, body: null }));
    expect(change.outcome().state).toBe('rejected');
    expect(settingsRestorePlan(original, change.outcome()).action).toBe('none');
  });

  it('somebody else had already written the same values (changed: false) → they are not undone', async () => {
    const change = createSettingsChange();
    await change.run(async () => ({ ok: true, status: 200, body: { ...accepted.body, version: 8, changed: false } }));
    expect(change.outcome().state).toBe('noop');
    expect(settingsRestorePlan(original, change.outcome()).action).toBe('none');
  });

  it('interrupted while the request is on its way → the cleanup waits for the answer and restores', async () => {
    const change = createSettingsChange();
    let answer: (value: typeof accepted) => void = () => undefined;
    void change.run(() => new Promise<typeof accepted>((resolve) => { answer = resolve; }));
    expect(change.outcome().state).toBe('pending');
    const settled = change.settle(5000);
    answer(accepted);
    await settled;
    expect(settingsRestorePlan(original, change.outcome()).action).toBe('restore');
  });

  it('the answer never comes → never "not needed": the setting must be checked by hand', async () => {
    const change = createSettingsChange();
    void change.run(() => new Promise(() => undefined));
    await change.settle(20);
    expect(change.outcome().state).toBe('pending');
    expect(settingsRestorePlan(original, change.outcome())).toMatchObject({ action: 'reconcile' });
  });

  it('the answer was lost (network error, 5xx) → unknown, to be checked by hand', async () => {
    const lost = createSettingsChange();
    await lost.run(async () => { throw new Error('socket hang up'); }).catch(() => undefined);
    expect(lost.outcome().state).toBe('unknown');
    expect(settingsRestorePlan(original, lost.outcome()).action).toBe('reconcile');
    const failed = createSettingsChange();
    await failed.run(async () => ({ ok: false, status: 502, body: null }));
    expect(settingsRestorePlan(original, failed.outcome()).action).toBe('reconcile');
  });
});
