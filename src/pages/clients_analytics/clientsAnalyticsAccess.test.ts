import { describe, expect, it } from 'vitest';
import { CLIENTS_ANALYTICS_PERMISSIONS, clientsAnalyticsAccess } from './clientsAnalyticsAccess';

const backend = { useBackendAuth: true, useBackendPermissions: true };
const all = [...CLIENTS_ANALYTICS_PERMISSIONS];
const scopes = (orders: string, payments: string) => ({ orders: { view: orders }, payments: { view: payments } });

describe('clients analytics access', () => {
  it('allows a user with every right and an unlimited view of orders and payments', () => {
    expect(clientsAnalyticsAccess({ permissions: all, policyScopes: scopes('all', 'all') }, backend)).toBe('allowed');
  });

  it.each(all)('needs %s', (permission) => {
    const permissions = all.filter((candidate) => candidate !== permission);
    expect(clientsAnalyticsAccess({ permissions, policyScopes: scopes('all', 'all') }, backend)).toBe('no_permission');
  });

  it('a manager — own orders and payments — is told why, not shown a failing screen', () => {
    expect(clientsAnalyticsAccess({ permissions: all, policyScopes: scopes('own', 'own') }, backend)).toBe('limited_scope');
    expect(clientsAnalyticsAccess({ permissions: all, policyScopes: scopes('all', 'own') }, backend)).toBe('limited_scope');
    expect(clientsAnalyticsAccess({ permissions: all, policyScopes: null }, backend)).toBe('limited_scope');
  });

  it('asks the backend nothing under the legacy login', () => {
    const user = { permissions: all, policyScopes: scopes('all', 'all') };
    expect(clientsAnalyticsAccess(user, { useBackendAuth: false, useBackendPermissions: true })).toBe('legacy_login');
    expect(clientsAnalyticsAccess(user, { useBackendAuth: true, useBackendPermissions: false })).toBe('legacy_login');
    expect(clientsAnalyticsAccess(null, backend)).toBe('no_permission');
  });
});
