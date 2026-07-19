export const RESOURCE_LABELS: Record<string, string> = {
  orders_view: 'Заказы',
  'orders-trash': 'Корзина',
  calendar: 'Календарь',
  'order-status-board': 'Доски статусов',
  groups: 'Группы',
  projects: 'Проекты',
  clients: 'Клиенты',
  clients_analytics_view: '+Клиенты',
  suppliers: 'Поставщики',
  vendors: 'Производители',
  film_vendors: 'Производители плёнки',
  payments: 'Платежи',
  payments_view: '+Платежи',
  films: 'Пленки',
  materials: 'Материалы',
  order_resource_requirements: 'Потребности заказов',
  film_types: 'Типы плёнки',
  units: 'Ед. измерения',
  material_types: 'Типы материалов',
  edge_types: 'Типы кромок',
  milling_types: 'Типы фрезеровки',
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
  doweling_orders_view: 'Присадка',
  configuration: 'Конфигурация',
  audit: 'Аудит',
  sheet_material_types: 'Листовые материалы',
  cut: 'Раскрой',
  bazis: 'Базис-проекты',
  'bazis-cut-sets': 'Базис-раскрой',
  scan: 'Сканер бирок',
};

// First path segment → resource key for list routes.
const PATH_TO_RESOURCE: Record<string, string> = {
  orders: 'orders_view',
  calendar: 'calendar',
  'order-status-board': 'order-status-board',
  groups: 'groups',
  clients: 'clients',
  'clients-analytics': 'clients_analytics_view',
  payments: 'payments',
  'payments-analytics': 'payments_view',
  'doweling-orders': 'doweling_orders_view',
  configuration: 'configuration',
  audit: 'audit',
  'sheet-material-types': 'sheet_material_types',
  'bazis-cut': 'bazis-cut-sets',
};

const ACTION_LABELS: Record<string, string> = {
  create: 'Создание',
  show: 'Просмотр',
  edit: 'Редактирование',
};

const resourceKeyFromSegment = (seg: string): string => PATH_TO_RESOURCE[seg] ?? seg.replace(/-/g, '_');

export const resourceFromPath = (pathname: string): string | undefined => {
  const seg = pathname.split('/').filter(Boolean)[0];
  return seg ? resourceKeyFromSegment(seg) : undefined;
};

export const resolveOrderTabLabel = (orderName: unknown): string =>
  typeof orderName === 'string' && orderName.trim() ? orderName.trim() : 'Заказ';

export const shouldPreserveTabLabel = (pathname: string): boolean => {
  const segs = pathname.split('/').filter(Boolean);
  if ((segs[1] === 'show' || segs[1] === 'edit') && Boolean(segs[2])) {
    return true;
  }
  if (segs[0] === 'bazis' && segs[1] === 'projects' && Boolean(segs[2])) {
    return true;
  }
  return segs[0] === 'bazis-cut' && Boolean(segs[1]);
};

export const resolveTabLabel = (pathname: string): string => {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const segs = pathname.split('/').filter(Boolean);
  if (normalizedPath === '/orders/trash') {
    return 'Корзина';
  }
  const orderMatch = pathname.match(/^\/orders\/(edit|show)\/\d+/);
  if (orderMatch) {
    return resolveOrderTabLabel(undefined);
  }
  const resource = resourceFromPath(pathname);
  const resourceLabel = resource ? RESOURCE_LABELS[resource] : undefined;
  if (resourceLabel) {
    const action = segs[1];
    const actionLabel = action ? ACTION_LABELS[action] : undefined;
    if (actionLabel) {
      const id = segs[2];
      return id ? `${resourceLabel} · ${actionLabel} #${id}` : `${resourceLabel} · ${actionLabel}`;
    }
    return resourceLabel;
  }
  return segs[segs.length - 1] ?? 'Заказы';
};
