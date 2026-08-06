import { describe, expect, it } from 'vitest';
import { resolveModernRouteFamily, resolveOperationalPageKind } from './tabletRouteFamily';

describe('tablet route metadata', () => {
  it.each([
    ['/clients', 'clients-list'],
    ['/clients-analytics', 'clients-list'],
    ['/clients/show/1', 'client-detail'],
    ['/clients-analytics/show/1', 'client-detail'],
    ['/clients/create', 'client-form'],
    ['/clients/edit/1', 'client-form'],
    ['/payments', 'payments-list'],
    ['/payments-analytics', 'payments-list'],
    ['/payments/show/1', 'payment-detail'],
    ['/payments/edit/1', 'payment-form'],
    ['/materials', 'materials-list'],
    ['/materials/show/1', 'material-detail'],
    ['/materials/create', 'material-form'],
    ['/orders', 'orders'],
    ['/orders/show/1', 'order-detail'],
    ['/orders/create', 'order-edit'],
    ['/order-status-board', 'status-board'],
    ['/mdf-work-board', 'status-board'],
    ['/calendar', 'calendar'],
    ['/cut', 'cut'],
    ['/configuration', 'configuration'],
  ])('maps %s to %s', (path, family) => {
    expect(resolveModernRouteFamily(path)).toBe(family);
  });

  it.each([
    ['/clients', 'list'],
    ['/clients/show/1', 'show'],
    ['/clients/create', 'form'],
    ['/payments/edit/1', 'form'],
    ['/materials/show/1', 'show'],
    ['/calendar', 'workspace'],
    ['/configuration', 'workspace'],
  ] as const)('maps %s to page kind %s', (path, kind) => {
    expect(resolveOperationalPageKind(path)).toBe(kind);
  });
});
