import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ summary: vi.fn() }));
const flags = vi.hoisted(() => ({ useBackendAuth: true, useBackendPermissions: true }));
vi.mock('../../config/featureFlags', () => ({ featureFlags: flags }));
vi.mock('../../api/paymentsAnalyticsApi', () => ({ paymentsAnalyticsApi: { summary: api.summary } }));
vi.mock('./paymentsAnalytics.css', () => ({}));

import { PaymentsAnalyticsSummaryPanel } from './PaymentsAnalyticsSummaryPanel';

const period = (from: string, to: string) => [
  { field: 'payment_date', operator: 'gte', value: from },
  { field: 'payment_date', operator: 'lte', value: to },
];
const answer = (amount: string, day: string) => ({
  dateFrom: day, dateTo: day, count: 2, amount,
  byType: [{ typePaidName: 'нал', count: 2, amount }],
  byDay: [{ paymentDate: day, count: 2, amount }],
});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

let tree: ReactTestRenderer;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  flags.useBackendAuth = true;
  flags.useBackendPermissions = true;
});
afterEach(() => { if (tree) act(() => tree.unmount()); vi.unstubAllGlobals(); });

describe('PaymentsAnalyticsSummaryPanel', () => {
  it('never shows the previous period totals under a new period', async () => {
    const september = deferred();
    const october = deferred();
    api.summary.mockReturnValueOnce(september.promise).mockReturnValueOnce(october.promise);
    const onDays = vi.fn();

    await act(async () => { tree = create(<PaymentsAnalyticsSummaryPanel filters={period('2026-09-01', '2026-09-30')} onDays={onDays} />); });
    september.resolve(answer('900.00', '2026-09-30'));
    await flush();
    expect(text(tree)).toContain('900');
    expect(onDays).toHaveBeenLastCalledWith({ '2026-09-30': { count: 2, amount: 900 } });

    // the period changes; October has not answered yet
    await act(async () => { tree.update(<PaymentsAnalyticsSummaryPanel filters={period('2026-10-01', '2026-10-05')} onDays={onDays} />); });
    expect(text(tree)).not.toContain('900');
    expect(text(tree)).toContain('загрузка…');
    expect(onDays).toHaveBeenLastCalledWith({});

    october.resolve(answer('150.00', '2026-10-01'));
    await flush();
    expect(text(tree)).toContain('150');
    expect(onDays).toHaveBeenLastCalledWith({ '2026-10-01': { count: 2, amount: 150 } });
  });

  it('a failed request for the new period leaves no stale totals', async () => {
    const first = deferred();
    const second = deferred();
    api.summary.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onDays = vi.fn();

    await act(async () => { tree = create(<PaymentsAnalyticsSummaryPanel filters={period('2026-09-01', '2026-09-30')} onDays={onDays} />); });
    first.resolve(answer('900.00', '2026-09-30'));
    await flush();
    await act(async () => { tree.update(<PaymentsAnalyticsSummaryPanel filters={period('2026-10-01', '2026-10-05')} onDays={onDays} />); });
    second.reject(new Error('boom'));
    await flush();

    expect(text(tree)).not.toContain('900');
    expect(text(tree)).toContain('не удалось загрузить');
    expect(onDays).toHaveBeenLastCalledWith({});
  });

  it('a late answer to the old period is ignored', async () => {
    const slow = deferred();
    const fast = deferred();
    api.summary.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    await act(async () => { tree = create(<PaymentsAnalyticsSummaryPanel filters={period('2026-09-01', '2026-09-30')} />); });
    await act(async () => { tree.update(<PaymentsAnalyticsSummaryPanel filters={period('2026-10-01', '2026-10-05')} />); });
    fast.resolve(answer('150.00', '2026-10-01'));
    await flush();
    slow.resolve(answer('900.00', '2026-09-30'));
    await flush();

    expect(text(tree)).toContain('150');
    expect(text(tree)).not.toContain('900');
  });

  it.each([
    ['legacy login and legacy permissions', false, false],
    ['legacy login', false, true],
    ['legacy permissions', true, false],
  ])('asks the backend nothing under %s', async (_name, backendAuth, backendPermissions) => {
    flags.useBackendAuth = backendAuth;
    flags.useBackendPermissions = backendPermissions;
    const onDays = vi.fn();
    await act(async () => { tree = create(<PaymentsAnalyticsSummaryPanel filters={period('2026-10-01', '2026-10-05')} onDays={onDays} />); });
    await flush();
    // no request means no 401, no refresh attempt and no forced return to the login page
    expect(api.summary).not.toHaveBeenCalled();
    expect(text(tree)).toContain('итоги недоступны в этом режиме входа');
    expect(onDays).toHaveBeenLastCalledWith({});
  });

  it('asks nothing for a period the backend does not summarise', async () => {
    await act(async () => { tree = create(<PaymentsAnalyticsSummaryPanel filters={period('2024-01-01', '2026-10-05')} />); });
    expect(api.summary).not.toHaveBeenCalled();
    expect(text(tree)).toContain('сузьте его');
  });
});
