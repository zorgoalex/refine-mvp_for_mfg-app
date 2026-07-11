import { describe, expect, it } from 'vitest';
import { SIDER_RESOURCE_ICONS } from './siderResourceIcons';

const NAVIGATION_RESOURCES = [
  'orders_view',
  'calendar',
  'scan',
  'groups',
  'projects',
  'cut-jobs',
  'bazis',
  'clients',
  'clients_analytics_view',
  'suppliers',
  'vendors',
  'payments',
  'payments_view',
  'films',
  'materials',
  'order_resource_requirements',
  'film_types',
  'units',
  'material_types',
  'edge_types',
  'milling_types',
  'order_statuses',
  'payment_statuses',
  'production_statuses',
  'requisition_statuses',
  'resource_requirements_statuses',
  'workshops',
  'work_centers',
  'payment_types',
  'transaction_direction',
  'material_transaction_types',
  'employees',
  'users',
  'movements_statuses',
  'order_workshops',
  'doweling_orders_view',
  'configuration',
  'audit',
  'sheet_material_types',
] as const;

describe('SIDER_RESOURCE_ICONS', () => {
  it.each(NAVIGATION_RESOURCES)('provides a semantic icon for %s', (resource) => {
    expect(SIDER_RESOURCE_ICONS[resource]).toBeTruthy();
  });
});
