import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authSession } from '../api/authSession';
import { applyFeatureFlags, featureFlags } from '../config/featureFlags';
import { applyRuntimeConfig, resetRuntimeConfigForTests } from '../config/runtimeConfig';
import {
  getCurrentOrderLifecycleCohort,
  resetOrderLifecycleCohortStoreForTests,
  resolveOrderLifecycleCohort,
} from './orderLifecycleCohortStore';

const originalFlags = { ...featureFlags };

describe('order lifecycle cohort store', () => {
  beforeEach(() => {
    authSession.clear();
    resetOrderLifecycleCohortStoreForTests();
    applyRuntimeConfig({
      rollouts: {
        orderLifecycleV2: {
          enabled: true,
          percent: 100,
          allocationSalt: 'stage1-test',
          configVersion: 'stage1-test-v1',
        },
      },
    }, {});
  });

  afterEach(() => {
    authSession.clear();
    resetOrderLifecycleCohortStoreForTests();
    resetRuntimeConfigForTests();
    applyFeatureFlags(originalFlags);
  });

  it('resolves once for the current auth namespace and invalidates synchronously on logout', async () => {
    authSession.setAccessToken('token-a');
    authSession.setUser({ id: '7', username: 'a', role: 'admin', permissions: ['orders.view'] });

    await expect(resolveOrderLifecycleCohort()).resolves.toBe('treatment');
    await expect(resolveOrderLifecycleCohort()).resolves.toBe('treatment');
    expect(getCurrentOrderLifecycleCohort()).toBe('treatment');

    authSession.clear();
    expect(getCurrentOrderLifecycleCohort()).toBe('disabled');
  });

  it('keeps the resolved cohort synchronously through same-owner token rotation', async () => {
    const user = { id: '7', username: 'a', role: 'admin', permissions: ['orders.view'] };
    authSession.setAccessToken('token-a');
    authSession.setUser(user);
    await resolveOrderLifecycleCohort();

    authSession.setAccessToken('token-b');
    expect(getCurrentOrderLifecycleCohort()).toBe('treatment');
    authSession.setUser({ ...user });
    expect(getCurrentOrderLifecycleCohort()).toBe('treatment');
    await expect(resolveOrderLifecycleCohort()).resolves.toBe('treatment');
  });

  it.each(['actor', 'permissions', 'missing-token'] as const)(
    'invalidates synchronously when %s changes', async (boundary) => {
      authSession.setAccessToken('token-a');
      authSession.setUser({ id: '7', username: 'a', role: 'admin', permissions: ['orders.view'] });
      await resolveOrderLifecycleCohort();

      if (boundary === 'missing-token') authSession.setAccessToken(null);
      else authSession.setUser({
        id: boundary === 'actor' ? '8' : '7', username: 'a', role: 'admin',
        permissions: boundary === 'permissions' ? ['orders.view', 'orders.create'] : ['orders.view'],
      });
      expect(getCurrentOrderLifecycleCohort()).toBe('disabled');
      await expect(resolveOrderLifecycleCohort()).resolves.toBe(boundary === 'missing-token' ? 'disabled' : 'treatment');
    },
  );

  it('keeps rollout disabled without complete local auth', async () => {
    await expect(resolveOrderLifecycleCohort()).resolves.toBe('disabled');
    expect(getCurrentOrderLifecycleCohort()).toBe('disabled');
  });
});
