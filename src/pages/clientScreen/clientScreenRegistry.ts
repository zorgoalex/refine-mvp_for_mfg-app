/**
 * Frontend mirror of backend/src/modules/client-screen/client-screen.registry.ts
 * (parity is guarded by clientScreenRegistry.test.ts against the OpenAPI enum).
 */
export const CLIENT_SCREEN_CODES = [
  'summary.number', 'summary.order_name', 'summary.client', 'summary.client_phone', 'summary.client_phones', 'summary.deadline',
  'summary.positions', 'summary.parts', 'summary.area', 'summary.material', 'summary.milling_type', 'summary.edge_type', 'summary.film',
  'summary.final', 'summary.discount', 'summary.surcharge', 'summary.paid', 'summary.debt',
  'tab.basic',
  'basic.client', 'basic.order_name', 'basic.order_date', 'basic.order_status', 'basic.payment_status',
  'basic.production_status', 'basic.manager', 'basic.priority', 'basic.doweling', 'basic.notes',
  'tab.details',
  'details.n', 'details.name', 'details.height', 'details.width', 'details.quantity', 'details.area',
  'details.material', 'details.milling_type', 'details.edge_type', 'details.film', 'details.price_per_sqm',
  'details.cost', 'details.note', 'details.production_status',
  'tab.dates',
  'dates.planned', 'dates.completion', 'dates.issue',
  'tab.finance',
  'finance.total', 'finance.discount', 'finance.surcharge', 'finance.final', 'finance.paid', 'finance.debt',
  'finance.payments', 'finance.payments_note',
  'tab.services',
  'services.name', 'services.quantity', 'services.price', 'services.sum',
] as const;

export type ClientScreenCode = typeof CLIENT_SCREEN_CODES[number];

export const CLIENT_SCREEN_DEFAULT_VISIBLE_CODES: readonly ClientScreenCode[] = [
  'summary.number', 'summary.client', 'summary.parts', 'summary.area', 'summary.final',
  'tab.basic',
  'basic.client', 'basic.order_name', 'basic.order_date', 'basic.order_status', 'basic.manager', 'basic.doweling',
  'tab.details',
  'details.n', 'details.name', 'details.height', 'details.width', 'details.quantity', 'details.area',
  'details.material', 'details.milling_type', 'details.edge_type', 'details.film',
  'tab.dates',
  'dates.planned',
  'tab.finance',
  'finance.discount', 'finance.final', 'finance.paid', 'finance.debt', 'finance.payments',
  'tab.services',
  'services.name', 'services.quantity', 'services.price', 'services.sum',
];

/**
 * Shown whenever their tab is shown, ticked or not: the row number of the detail list is the
 * common way for the manager and the customer to name a row.
 */
export const CLIENT_SCREEN_ALWAYS_WITH_TAB: ReadonlySet<string> = new Set(['details.n']);

export interface ClientScreenField {
  code: ClientScreenCode;
  label: string;
}

export interface ClientScreenGroup {
  key: string;
  label: string;
  /** null for the summary: it is always on screen and has no tab checkbox. */
  tabCode: ClientScreenCode | null;
  fields: ClientScreenField[];
}

export const CLIENT_SCREEN_GROUPS: readonly ClientScreenGroup[] = [
  {
    key: 'summary',
    label: 'Сводка заказа',
    tabCode: null,
    fields: [
      { code: 'summary.number', label: 'Номер заказа' },
      { code: 'summary.order_name', label: 'Название заказа' },
      { code: 'summary.client', label: 'Клиент' },
      { code: 'summary.client_phone', label: 'Телефон клиента' },
      { code: 'summary.client_phones', label: 'Доп. телефоны клиента' },
      { code: 'summary.deadline', label: 'Срок выполнения' },
      { code: 'summary.positions', label: 'Позиций' },
      { code: 'summary.parts', label: 'Деталей' },
      { code: 'summary.area', label: 'Площадь' },
      { code: 'summary.material', label: 'Материал' },
      { code: 'summary.milling_type', label: 'Фрезеровка' },
      { code: 'summary.edge_type', label: 'Обкат' },
      { code: 'summary.film', label: 'Плёнка' },
      { code: 'summary.final', label: 'Итоговая сумма' },
      { code: 'summary.discount', label: 'Скидка' },
      { code: 'summary.surcharge', label: 'Наценка' },
      { code: 'summary.paid', label: 'Оплачено' },
      { code: 'summary.debt', label: 'Остаток к оплате' },
    ],
  },
  {
    key: 'basic',
    label: 'Основное',
    tabCode: 'tab.basic',
    fields: [
      { code: 'basic.client', label: 'Клиент' },
      { code: 'basic.order_name', label: 'Название заказа' },
      { code: 'basic.order_date', label: 'Дата заказа' },
      { code: 'basic.order_status', label: 'Статус заказа' },
      { code: 'basic.payment_status', label: 'Статус оплаты' },
      { code: 'basic.production_status', label: 'Статус производства' },
      { code: 'basic.manager', label: 'Менеджер' },
      { code: 'basic.priority', label: 'Приоритет' },
      { code: 'basic.doweling', label: 'Присадки' },
      { code: 'basic.notes', label: 'Примечание' },
    ],
  },
  {
    key: 'details',
    label: 'Детали',
    tabCode: 'tab.details',
    fields: [
      { code: 'details.n', label: '№' },
      { code: 'details.name', label: 'Название детали' },
      { code: 'details.height', label: 'Высота' },
      { code: 'details.width', label: 'Ширина' },
      { code: 'details.quantity', label: 'Кол-во' },
      { code: 'details.area', label: 'Площадь' },
      { code: 'details.material', label: 'Материал' },
      { code: 'details.milling_type', label: 'Фрезеровка' },
      { code: 'details.edge_type', label: 'Обкат' },
      { code: 'details.film', label: 'Пленка' },
      { code: 'details.price_per_sqm', label: 'Цена за кв.м.' },
      { code: 'details.cost', label: 'Сумма' },
      { code: 'details.note', label: 'Примечание' },
      { code: 'details.production_status', label: 'Статус' },
    ],
  },
  {
    key: 'dates',
    label: 'Даты',
    tabCode: 'tab.dates',
    fields: [
      { code: 'dates.planned', label: 'Плановая дата завершения' },
      { code: 'dates.completion', label: 'Дата завершения' },
      { code: 'dates.issue', label: 'Дата выдачи' },
    ],
  },
  {
    key: 'finance',
    label: 'Финансы',
    tabCode: 'tab.finance',
    fields: [
      { code: 'finance.total', label: 'Сумма заказа' },
      { code: 'finance.discount', label: 'Скидка' },
      { code: 'finance.surcharge', label: 'Наценка' },
      { code: 'finance.final', label: 'Финальная сумма' },
      { code: 'finance.paid', label: 'Оплачено' },
      { code: 'finance.debt', label: 'Осталось' },
      { code: 'finance.payments', label: 'Список оплат' },
      { code: 'finance.payments_note', label: 'Примечания к оплатам' },
    ],
  },
  {
    key: 'services',
    label: 'Услуги/товары',
    tabCode: 'tab.services',
    fields: [
      { code: 'services.name', label: 'Наименование' },
      { code: 'services.quantity', label: 'Количество' },
      { code: 'services.price', label: 'Цена' },
      { code: 'services.sum', label: 'Сумма' },
    ],
  },
];

const ORDER = new Map<string, number>(CLIENT_SCREEN_CODES.map((code, index) => [code, index]));

/** Known codes only, without repeats, in registry order. */
export function normalizeClientScreenCodes(codes: readonly string[]): ClientScreenCode[] {
  return [...new Set(codes)]
    .filter((code): code is ClientScreenCode => ORDER.has(code))
    .sort((left, right) => ORDER.get(left)! - ORDER.get(right)!);
}

/**
 * tab.* and summary.* codes are visible iff ticked; any other field is visible
 * iff it and its tab.<group> code are both ticked.
 */
export function isClientScreenCodeVisible(code: string, visible: ReadonlySet<string>): boolean {
  if (CLIENT_SCREEN_ALWAYS_WITH_TAB.has(code)) return visible.has(`tab.${code.split('.')[0]}`);
  if (!visible.has(code)) return false;
  if (code.startsWith('tab.') || code.startsWith('summary.')) return true;
  const group = code.split('.')[0];
  return visible.has(`tab.${group}`);
}
