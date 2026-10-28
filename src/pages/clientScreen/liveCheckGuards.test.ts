import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore plain ESM helper of the browser scripts, no types
import {
  createSettingsChange, customerWindowBlockedProblem, customerWindowRequestProblem, expectedMaterialColumns, frameDifferences, isForbiddenDataRequest,
  isStageRelayTarget, isStageSettingsRequest, settingsRestorePlan, stageTargetProblem,
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

describe('live check: codes added for its own browser only', () => {
  it('rewrites the answer of the stage settings address and of nothing else', () => {
    expect(isStageSettingsRequest('https://backend-test.mebelkz.app/api/v1/client-screen/settings')).toBe(true);
    expect(isStageSettingsRequest('https://backend-test.mebelkz.app/api/v1/client-screen/settings?x=1')).toBe(true);
    // Another backend, a look-alike host, another path, the same path elsewhere: all go on to the destination guard.
    for (const url of ['https://backend-ovh.mebelkz.app/api/v1/client-screen/settings', 'https://backend-test.mebelkz.app.example.com/api/v1/client-screen/settings',
      'https://backend-test.mebelkz.app/api/v1/client-screen/settings/history', 'https://backend-test.mebelkz.app/api/v1/orders/client-screen/settings',
      'http://backend-test.mebelkz.app/api/v1/client-screen/settings', 'https://evil.example/api/v1/client-screen/settings', 'not a url']) {
      expect(isStageSettingsRequest(url), url).toBe(false);
    }
  });

  it('the settings rewrite of the script sits behind that predicate', () => {
    const script = readFileSync(new URL('../../../tests/client-screen-manager-live.mjs', import.meta.url), 'utf8');
    expect(script).toContain('await context.route((url) => isStageSettingsRequest(url.href), async (route) => {');
    expect(script).not.toMatch(/context\.route\(\/[^\n]*client-screen[^\n]*settings/);
  });
});

describe('live check: columns expected on the customer materials tables', () => {
  const film = [{ code: 'requirements.film_name', label: 'Пленка' }, { code: 'requirements.film_area', label: 'м²' },
    { code: 'requirements.film_stock', label: 'На складе, пог. м' }, { code: 'requirements.film_coverage', label: 'Покрытие' }];
  const manager = ['Пленка', 'м²', 'Детали'];

  it('ticked ∩ what the manager table has, in the order of the tab', () => {
    expect(expectedMaterialColumns(film, film.map((column) => column.code), manager)).toEqual(['Пленка', 'м²']);
    expect(expectedMaterialColumns(film, ['requirements.film_area'], manager)).toEqual(['м²']);
    expect(expectedMaterialColumns(film, film.map((column) => column.code), [...manager, 'На складе, пог. м', 'Покрытие'])).toEqual(['Пленка', 'м²', 'На складе, пог. м', 'Покрытие']);
  });

  it('only stock columns ticked and the manager has none: no table is expected', () => {
    expect(expectedMaterialColumns(film, ['requirements.film_stock', 'requirements.film_coverage'], manager)).toEqual([]);
    expect(expectedMaterialColumns(film, [], manager)).toEqual([]);
  });
});


describe('live check: the customer window asks the network only for its own page', () => {
  const origin = 'https://app-test.mebelkz.app';
  const problem = (url: string, type: string) => customerWindowRequestProblem(url, type, origin);

  it('lets through the page, the files of the build, the runtime configuration and inline data', () => {
    expect(problem(`${origin}/client-screen.html`, 'document')).toBeNull();
    expect(problem(`${origin}/client-screen.html?x-vercel-set-bypass-cookie=true`, 'document')).toBeNull();
    expect(problem(`${origin}/assets/clientScreen-B1a2.js`, 'script')).toBeNull();
    expect(problem(`${origin}/assets/clientScreen-B1a2.css`, 'stylesheet')).toBeNull();
    expect(problem(`${origin}/assets/Onest-cyrillic-400-700.woff2`, 'font')).toBeNull();
    expect(problem(`${origin}/runtime-config.json`, 'fetch')).toBeNull();
    expect(problem(`${origin}/vite.svg`, 'image')).toBeNull();
    expect(problem('data:image/webp;base64,UklGRg==', 'image')).toBeNull();
    expect(problem('about:srcdoc', 'document')).toBeNull();
  });

  it('fails on a data call, whatever carries it: fetch, picture, stylesheet, font, navigation', () => {
    const bad: Array<[string, string]> = [
      [`${origin}/api/v1/orders/5`, 'fetch'], ['https://backend-test.mebelkz.app/api/v1/orders/5', 'fetch'], ['https://hasura-test.mebelkz.app/v1/graphql', 'xhr'],
      [`${origin}/api/v1/files/7`, 'image'], ['https://backend-test.mebelkz.app/api/v1/files/7', 'image'], [`${origin}/assets/sheet.png`, 'image'],
      [`${origin}/api/v1/styles.css`, 'stylesheet'], ['https://evil.example/a.css', 'stylesheet'], [`${origin}/api/v1/font.woff2`, 'font'],
      [`${origin}/orders/edit/5`, 'document'], [`${origin}/index.html`, 'document'], [`${origin}/`, 'document'], ['https://evil.example/', 'document'],
      [`${origin}/assets/../api/v1/x.js`, 'script'], [`${origin}/runtime-config.json`, 'image'], ['blob:https://app-test.mebelkz.app/1b2c', 'image'],
      ['wss://backend-test.mebelkz.app/socket', 'websocket'], [`${origin}/api/v1/events`, 'eventsource'], ['not a url', 'fetch'],
    ];
    for (const [url, type] of bad) expect(problem(url, type), `${type} ${url}`).not.toBeNull();
  });

  it('a refused load is fine only for a file of this build named by the copied styles', () => {
    const refusedLoad = (address: string) => `Refused to load the image '${address}' because it violates the following Content Security Policy directive: "img-src data:".`;
    expect(customerWindowBlockedProblem(refusedLoad(`${origin}/assets/bg-1a2b.png`), origin)).toBeNull();
    expect(customerWindowBlockedProblem(refusedLoad('/assets/icons.svg'), origin)).toBeNull();
    expect(customerWindowBlockedProblem('Failed to load resource: net::ERR_FAILED', origin)).toBeNull();
    for (const address of [`${origin}/api/v1/files/7`, 'https://backend-test.mebelkz.app/api/v1/files/7', 'blob:https://app-test.mebelkz.app/1b2c', 'https://evil.example/a.png', `${origin}/orders/edit/5`]) {
      expect(customerWindowBlockedProblem(refusedLoad(address), origin), address).not.toBeNull();
    }
    expect(customerWindowBlockedProblem("Refused to execute inline script because it violates the following Content Security Policy directive: \"default-src 'none'\".", origin)).not.toBeNull();
  });

  it('compares the copy with the tab node by node', () => {
    const node = (over = {}) => ({ tag: 'div', cls: 'cut-sheet', x: 10, y: 20, w: 300, h: 40, color: 'rgb(0, 0, 0)', font: '14px 400 Onest', position: 'static', ...over });
    expect(frameDifferences([node()], [node({ x: 11, h: 41 })])).toEqual([]);
    expect(frameDifferences([node()], [node({ y: 23 })])).toEqual(['#0 div.cut-sheet: y 20 → 23']);
    expect(frameDifferences([node()], [node({ position: 'sticky' })])).toEqual(['#0 div: position «static» → «sticky»']);
    expect(frameDifferences([node(), node()], [node()])).toEqual(["control nodes: 2 on the manager's tab, 1 in the copy"]);
  });
});
