import type { UiVariant } from '../ui-variant/uiVariant';

export const LEGACY_CATEGORY_ORDER = [
  'Контрагенты',
  'Финансы',
  'Производство',
  'Материалы',
  'Данные',
  'Справочники',
  'Журналы',
  'Настройки',
] as const;

export const LEGACY_CATEGORY_MAP: Record<string, string> = {
  clients: 'Контрагенты',
  clients_analytics_view: 'Контрагенты',
  suppliers: 'Контрагенты',
  vendors: 'Контрагенты',
  film_vendors: 'Контрагенты',
  payments: 'Финансы',
  payments_view: 'Финансы',
  'orders-trash': 'Данные',
  'mdf-work-board': 'Производство',
  groups: 'Производство',
  projects: 'Производство',
  order_workshops: 'Производство',
  workshops: 'Производство',
  work_centers: 'Производство',
  doweling_orders_view: 'Производство',
  bazis: 'Производство',
  'cut-jobs': 'Производство',
  'bazis-cut-sets': 'Производство',
  scan: 'Производство',
  films: 'Материалы',
  materials: 'Материалы',
  sheet_material_types: 'Материалы',
  extra_resources: 'Материалы',
  employees: 'Настройки',
  users: 'Настройки',
  configuration: 'Настройки',
  audit: 'Журналы',
};

export const EVOLUTION_CATEGORY_ORDER = ['CRM', 'Производство', 'Данные', 'Журналы', 'Настройки'] as const;

export const EVOLUTION_CATEGORY_LABELS: Record<(typeof EVOLUTION_CATEGORY_ORDER)[number], string> = {
  CRM: 'CRM',
  Производство: 'Производство',
  Данные: 'Данные',
  Журналы: 'Журналы',
  Настройки: 'Система',
};

export const EVOLUTION_CATEGORY_MAP: Record<string, (typeof EVOLUTION_CATEGORY_ORDER)[number]> = {
  clients: 'CRM',
  clients_analytics_view: 'CRM',
  suppliers: 'CRM',
  vendors: 'CRM',
  film_vendors: 'CRM',
  payments: 'CRM',
  payments_view: 'CRM',
  'orders-trash': 'Данные',
  'mdf-work-board': 'Производство',
  groups: 'Производство',
  projects: 'Производство',
  order_workshops: 'Производство',
  workshops: 'Производство',
  work_centers: 'Производство',
  order_resource_requirements: 'Производство',
  doweling_orders_view: 'Производство',
  bazis: 'Производство',
  'cut-jobs': 'Производство',
  'bazis-cut-sets': 'Производство',
  scan: 'Производство',
  films: 'Данные',
  materials: 'Данные',
  sheet_material_types: 'Данные',
  milling_types: 'Данные',
  extra_resources: 'Данные',
  edge_types: 'Данные',
  film_types: 'Данные',
  material_types: 'Данные',
  units: 'Данные',
  order_statuses: 'Данные',
  payment_statuses: 'Данные',
  payment_types: 'Данные',
  requisition_statuses: 'Данные',
  movements_statuses: 'Данные',
  material_transaction_types: 'Данные',
  transaction_direction: 'Данные',
  production_statuses: 'Данные',
  resource_requirements_statuses: 'Данные',
  employees: 'Настройки',
  users: 'Настройки',
  configuration: 'Настройки',
  audit: 'Журналы',
};

export function getSidebarMenuConfig(variant: UiVariant): {
  categoryOrder: readonly string[];
  categoryMap: Record<string, string>;
} {
  if (variant === 'evolution' || variant === 'line' || variant === 'air') {
    return {
      categoryOrder: EVOLUTION_CATEGORY_ORDER,
      categoryMap: EVOLUTION_CATEGORY_MAP,
    };
  }

  return {
    categoryOrder: LEGACY_CATEGORY_ORDER,
    categoryMap: LEGACY_CATEGORY_MAP,
  };
}
