/**
 * Everything the customer screen is able to show. A code is either a tab of the order (`tab.<key>`)
 * or one field (`<tab key>.<field>`); the order summary above the tabs has fields only.
 * What is not listed here can never be shown, and a listed code is shown only when the
 * organisation ticked it (client_screen_settings.visible_codes) together with its tab.
 */
export const CLIENT_SCREEN_CODES = [
  'summary.number', 'summary.order_name', 'summary.client', 'summary.client_phone', 'summary.client_phones', 'summary.deadline',
  'summary.positions', 'summary.parts', 'summary.area', 'summary.material', 'summary.milling_type', 'summary.edge_type', 'summary.film',
  'summary.final', 'summary.discount', 'summary.surcharge', 'summary.paid', 'summary.debt',
  'summary.designer', 'summary.basis_project', 'summary.project', 'summary.order_status', 'summary.payment_status',
  'summary.production_status', 'summary.priority', 'summary.created_by',
  'tab.basic',
  'basic.client', 'basic.order_name', 'basic.order_date', 'basic.order_status', 'basic.payment_status',
  'basic.production_status', 'basic.manager', 'basic.priority', 'basic.doweling', 'basic.notes',
  'tab.details',
  'details.n', 'details.name', 'details.height', 'details.width', 'details.quantity', 'details.area',
  'details.material', 'details.milling_type', 'details.edge_type', 'details.film', 'details.price_per_sqm',
  'details.cost', 'details.note', 'details.production_status',
  'details.hdf_parameter', 'details.doweling', 'details.cut_job', 'details.bath_cut_job', 'details.bazis_cut_sets', 'details.priority',
  'details.basis_project', 'details.basis_product', 'details.basis_data', 'details.basis_designation',
  'tab.dates',
  'dates.planned', 'dates.completion', 'dates.issue',
  'tab.finance',
  'finance.total', 'finance.discount', 'finance.surcharge', 'finance.final', 'finance.paid', 'finance.debt',
  'finance.payments', 'finance.payments_note',
  'tab.services',
  'services.name', 'services.quantity', 'services.price', 'services.sum',
] as const;

export type ClientScreenCode = typeof CLIENT_SCREEN_CODES[number];

/** Seeded by the migration that creates client_screen_settings; kept equal to it by a test. */
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

const ORDER = new Map<string, number>(CLIENT_SCREEN_CODES.map((code, index) => [code, index]));

/** Known codes only, without repeats, in registry order: the one stored and compared form. */
export function normalizeClientScreenCodes(codes: readonly string[]): ClientScreenCode[] {
  return [...new Set(codes)]
    .filter((code): code is ClientScreenCode => ORDER.has(code))
    .sort((left, right) => ORDER.get(left)! - ORDER.get(right)!);
}
