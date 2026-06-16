export const RESOURCE_LABELS: Record<string, string> = {
  orders_view: 'Заказы',
  calendar: 'Календарь',
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
};

// First path segment → resource key for list routes.
const PATH_TO_RESOURCE: Record<string, string> = {
  orders: 'orders_view',
  calendar: 'calendar',
  projects: 'projects',
  clients: 'clients',
  'clients-analytics': 'clients_analytics_view',
  payments: 'payments',
  'payments-analytics': 'payments_view',
  'doweling-orders': 'doweling_orders_view',
  configuration: 'configuration',
  audit: 'audit',
};

export const resourceFromPath = (pathname: string): string | undefined => {
  const seg = pathname.split('/').filter(Boolean)[0];
  return seg ? PATH_TO_RESOURCE[seg] ?? seg : undefined;
};

export const resolveTabLabel = (pathname: string): string => {
  const segs = pathname.split('/').filter(Boolean);
  const orderId = pathname.match(/^\/orders\/(?:edit|show)\/(\d+)/)?.[1];
  if (orderId) return `Заказ #${orderId}`;
  const resource = resourceFromPath(pathname);
  if (resource && RESOURCE_LABELS[resource]) return RESOURCE_LABELS[resource];
  return segs[segs.length - 1] ?? 'Заказы';
};
