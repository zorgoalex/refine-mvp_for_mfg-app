export const RESOURCE_LABELS: Record<string, string> = {
  orders_view: 'Заказы',
  'orders-trash': 'Корзина',
  calendar: 'Календарь',
  'order-status-board': 'Доски статусов',
  'mdf-work-board': 'МДФ-работы',
  groups: 'Группы',
  projects: 'Проекты',
  clients: 'Клиенты',
  client_contacts: 'Контакты клиентов',
  bitrix24_incoming_requests: 'Входящие заявки Bitrix',
  clients_analytics_view: '+Клиенты',
  suppliers: 'Поставщики',
  vendors: 'Производители',
  film_vendors: 'Производители плёнки',
  payments: 'Платежи',
  payments_view: '+Платежи',
  films: 'Пленки',
  materials: 'Материалы',
  order_resource_requirements: 'Потребности заказов',
  onec_purchase_documents: 'Документы 1С',
  'film-inventory': 'Остатки на складах',
  'inventory-warehouses': 'Справочник складов',
  film_types: 'Типы плёнки',
  units: 'Ед. измерения',
  material_types: 'Типы материалов',
  edge_types: 'Типы кромок',
  milling_types: 'Типы фрезеровки',
  extra_resources: 'Доп. ресурсы',
  catalog_items: 'Товары и услуги',
  order_statuses: 'Статусы заказов',
  payment_statuses: 'Статусы оплат',
  production_statuses: 'Статусы производства',
  requisition_statuses: 'Статусы заявок',
  resource_requirements_statuses: 'Статусы потребностей',
  workshops: 'Цеха',
  work_centers: 'Участки цехов',
  payment_types: 'Типы оплат',
  transaction_direction: 'Направления движения',
  material_transaction_types: 'Типы движений материалов',
  employees: 'Сотрудники',
  users: 'Пользователи',
  movements_statuses: 'Статусы движений',
  order_workshops: 'Цеха заказа',
  doweling_orders_view: 'Базис-проекты',
  configuration: 'Конфигурация',
  audit: 'Журналы',
  onec: 'Интеграция 1С',
  integrations: 'Интеграции',
  'inbound-signals': 'Входящие сигналы',
  sheet_material_types: 'Листовые материалы',
  cut: 'Раскрой',
  cad: 'CAD',
  bazis: 'XML Базиса',
  'bazis-cut-sets': 'Базис-раскрой',
  scan: 'Сканер бирок',
  profile: 'Профиль',
};

// First path segment → resource key for list routes.
const PATH_TO_RESOURCE: Record<string, string> = {
  orders: 'orders_view',
  calendar: 'calendar',
  'order-status-board': 'order-status-board',
  'mdf-work-board': 'mdf-work-board',
  groups: 'groups',
  clients: 'clients',
  'client-contacts': 'client_contacts',
  bitrix24: 'bitrix24_incoming_requests',
  'clients-analytics': 'clients_analytics_view',
  payments: 'payments',
  'payments-analytics': 'payments_view',
  'doweling-orders': 'doweling_orders_view',
  configuration: 'configuration',
  audit: 'audit',
  'inbound-signals': 'inbound-signals',
  integrations: 'integrations',
  'sheet-material-types': 'sheet_material_types',
  'extra-resources': 'extra_resources',
  'catalog-items': 'catalog_items',
  'bazis-cut': 'bazis-cut-sets',
  inventory: 'film-inventory',
};

const ACTION_LABELS: Record<string, string> = {
  create: 'Создание',
  show: 'Просмотр',
  edit: 'Редактирование',
};

const resourceKeyFromSegment = (seg: string): string => PATH_TO_RESOURCE[seg] ?? seg.replace(/-/g, '_');

// «Документы 1С» живёт под /procurement/onec-documents — resource-имя не совпадает
// с первым сегментом пути, поэтому первый сегмент один сюда не отображается.
const ONEC_DOCUMENTS_PATH_PREFIX = '/procurement/onec-documents';

export const resourceFromPath = (pathname: string): string | undefined => {
  if (pathname === ONEC_DOCUMENTS_PATH_PREFIX || pathname.startsWith(`${ONEC_DOCUMENTS_PATH_PREFIX}/`)) {
    return 'onec_purchase_documents';
  }
  if (pathname === '/inventory/warehouses' || pathname.startsWith('/inventory/warehouses/')) return 'inventory-warehouses';
  const seg = pathname.split('/').filter(Boolean)[0];
  return seg ? resourceKeyFromSegment(seg) : undefined;
};

/** Вкладка набора Базис-раскроя — по его имени («БР-12» как есть, иначе с приставкой «БР»). */
export const bazisCutSetTabLabel = (name: string): string => (/^БР/i.test(name.trim()) ? name.trim() : `БР ${name.trim()}`);

export const resolveOrderTabLabel = (orderName: unknown): string =>
  typeof orderName === 'string' && orderName.trim() ? orderName.trim() : 'Заказ';

export const shouldPreserveTabLabel = (pathname: string): boolean => {
  if (/^\/cad\/orders\/\d+$/.test(pathname)) return true;
  if (/^\/procurement\/onec-documents\/show\/\d+$/.test(pathname)) return true;
  const segs = pathname.split('/').filter(Boolean);
  if ((segs[1] === 'show' || segs[1] === 'edit') && Boolean(segs[2])) {
    return true;
  }
  if (segs[0] === 'bazis' && segs[1] === 'projects' && Boolean(segs[2])) {
    return true;
  }
  return segs[0] === 'bazis-cut' && Boolean(segs[1]);
};

/**
 * Название вкладки по адресу, пока страница не назвала её сама. Номер записи из адреса (её id в базе) сюда
 * не попадает никогда: вкладка записи называется ресурсом и действием, а имя записи подставляет страница
 * или `useWorkspaceTabNames`.
 */
export const resolveTabLabel = (pathname: string): string => {
  if (/^\/cad\/orders\/\d+/.test(pathname)) return 'CAD · заказ';
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const segs = pathname.split('/').filter(Boolean);
  if (normalizedPath === '/orders/trash') {
    return 'Корзина';
  }
  const orderMatch = pathname.match(/^\/orders\/(edit|show)\/\d+/);
  if (orderMatch) {
    return resolveOrderTabLabel(undefined);
  }
  if (segs[0] === 'procurement' && segs[1] === 'onec-documents') {
    const resourceLabel = RESOURCE_LABELS.onec_purchase_documents;
    const action = segs[2];
    const actionLabel = action ? ACTION_LABELS[action] : undefined;
    if (actionLabel) return `${resourceLabel} · ${actionLabel}`;
    return resourceLabel;
  }
  if (segs[0] === 'bazis' && segs[1] === 'projects' && segs[2]) return 'Базис-проект';
  if (segs[0] === 'bazis-cut' && segs[1]) return 'Базис-раскрой';
  const resource = resourceFromPath(pathname);
  const resourceLabel = resource ? RESOURCE_LABELS[resource] : undefined;
  if (resourceLabel) {
    const action = segs[1];
    const actionLabel = action ? ACTION_LABELS[action] : undefined;
    if (actionLabel) return `${resourceLabel} · ${actionLabel}`;
    return resourceLabel;
  }
  return segs[segs.length - 1] ?? 'Заказы';
};

/**
 * Название вкладки в формате, который выдавала прежняя версия с номером записи в базе, — только точные прежние
 * форматы с номером ИМЕННО этой записи из адреса: «Клиенты · Просмотр #2606» (название по адресу),
 * «Клиенты · Просмотр · #2606» (имя-заглушка), «БР #9» (`'exact'`); «CAD · заказ 11842», голый номер «6» у
 * Базис-проекта (`'ambiguous'` — так могло бы выглядеть и имя). Применяется только миграцией сохранённых
 * вкладок прежних версий (`migrateWorkspaceTabs`): то, что сохранено новой версией, не проверяется. Любой другой
 * текст с «#» или числами — имя записи («Магазин #12»); номер заказа («3087») у вкладок заказа — имя.
 */
export const legacyRecordIdLabel = (key: string, label: string): 'exact' | 'ambiguous' | null => {
  if (!shouldPreserveTabLabel(key)) return null;
  const id = key.match(/(\d+)$/)?.[1];
  if (!id) return null;
  const base = resolveTabLabel(key);
  const text = label.trim();
  if (text === `${base} #${id}` || text === `${base} · #${id}` || (/^\/bazis-cut\//.test(key) && text === `БР #${id}`)) {
    return 'exact';
  }
  if (/^\/cad\/orders\/\d+$/.test(key)) return text === `CAD · заказ ${id}` ? 'ambiguous' : null;
  if (/^\/orders\//.test(key)) return null;
  return text === id ? 'ambiguous' : null;
};

export const tabLabelHasRecordId = (key: string, label: string): boolean => legacyRecordIdLabel(key, label) !== null;

/** Вкладке записи ещё нужно имя: у неё название по адресу (старые названия с номером записи убирает миграция). */
export const tabLabelNeedsName = (key: string, label: string): boolean =>
  shouldPreserveTabLabel(key) && label === resolveTabLabel(key);
