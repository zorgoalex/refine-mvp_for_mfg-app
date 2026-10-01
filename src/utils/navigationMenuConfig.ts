import { isModernUiVariant, type UiVariant } from '../ui-variant/uiVariant';

export const LEGACY_CATEGORY_ORDER = [
  'Контрагенты',
  'Финансы',
  'Производство',
  'Закупки',
  'Склады',
  'Материалы',
  'Данные',
  'Справочники',
  'Журналы',
  'Настройки',
] as const;

export const LEGACY_CATEGORY_MAP: Record<string, string> = {
  clients: 'Контрагенты',
  bitrix24_incoming_requests: 'Контрагенты',
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
  order_resource_requirements: 'Производство',
  doweling_orders_view: 'Производство',
  bazis: 'Производство',
  'cut-jobs': 'Производство',
  cad: 'Производство',
  'bazis-cut-sets': 'Производство',
  scan: 'Производство',
  onec_purchase_documents: 'Закупки',
  'film-inventory': 'Склады',
  'inventory-warehouses': 'Склады',
  films: 'Материалы',
  materials: 'Материалы',
  sheet_material_types: 'Материалы',
  extra_resources: 'Материалы',
  catalog_items: 'Справочники',
  employees: 'Настройки',
  users: 'Настройки',
  configuration: 'Настройки',
  audit: 'Журналы',
  'inbound-signals': 'Журналы',
  onec: 'Настройки',
};

export const EVOLUTION_CATEGORY_ORDER = ['CRM', 'Производство', 'Закупки', 'Данные', 'Журналы', 'Настройки'] as const;

export const EVOLUTION_CATEGORY_LABELS: Record<(typeof EVOLUTION_CATEGORY_ORDER)[number], string> = {
  CRM: 'CRM',
  Производство: 'Производство',
  Закупки: 'Закупки',
  Данные: 'Данные',
  Журналы: 'Журналы',
  Настройки: 'Система',
};

type EvolutionCategoryLabels = Record<(typeof EVOLUTION_CATEGORY_ORDER)[number], string>;

/**
 * «NewLine» only renames the groups. Category keys, the resource→category map and
 * the order stay shared with Evolution, so the user's stored menu order, the
 * 'Настройки' permission gate and role visibility keep working unchanged.
 */
const WORKBENCH_CATEGORY_LABELS: EvolutionCategoryLabels = {
  CRM: 'Продажи и финансы',
  Производство: 'Производство',
  Закупки: 'Снабжение и склад',
  Данные: 'Справочники',
  Журналы: 'Журналы',
  Настройки: 'Настройка',
};

export function getEvolutionCategoryLabels(variant: UiVariant): EvolutionCategoryLabels {
  return variant === 'workbench' ? WORKBENCH_CATEGORY_LABELS : EVOLUTION_CATEGORY_LABELS;
}

export const EVOLUTION_CATEGORY_MAP: Record<string, (typeof EVOLUTION_CATEGORY_ORDER)[number]> = {
  clients: 'CRM',
  bitrix24_incoming_requests: 'CRM',
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
  cad: 'Производство',
  doweling_orders_view: 'Производство',
  bazis: 'Производство',
  'cut-jobs': 'Производство',
  'bazis-cut-sets': 'Производство',
  scan: 'Производство',
  onec_purchase_documents: 'Закупки',
  'film-inventory': 'Закупки',
  'inventory-warehouses': 'Закупки',
  films: 'Данные',
  materials: 'Данные',
  sheet_material_types: 'Данные',
  milling_types: 'Данные',
  extra_resources: 'Данные',
  catalog_items: 'Данные',
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
  'inbound-signals': 'Журналы',
  onec: 'Настройки',
};

export function getSidebarMenuConfig(variant: UiVariant): {
  categoryOrder: readonly string[];
  categoryMap: Record<string, string>;
} {
  if (isModernUiVariant(variant)) {
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
