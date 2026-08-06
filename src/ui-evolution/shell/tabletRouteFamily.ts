export type OperationalPageKind = 'list' | 'show' | 'form' | 'workspace';

const isAction = (pathname: string, action: 'show' | 'create' | 'edit'): boolean => (
  pathname.includes(`/${action}/`) || pathname.endsWith(`/${action}`)
);

export function resolveModernRouteFamily(pathname: string): string {
  if (pathname.startsWith('/calendar')) return 'calendar';
  if (pathname.startsWith('/orders/show')) return 'order-detail';
  if (pathname.startsWith('/orders/edit') || pathname.startsWith('/orders/create')) return 'order-edit';
  if (pathname.startsWith('/orders')) return 'orders';
  if (pathname.startsWith('/clients-analytics') || pathname.startsWith('/clients')) {
    if (isAction(pathname, 'show')) return 'client-detail';
    if (isAction(pathname, 'create') || isAction(pathname, 'edit')) return 'client-form';
    return 'clients-list';
  }
  if (pathname.startsWith('/payments-analytics') || pathname.startsWith('/payments')) {
    if (isAction(pathname, 'show')) return 'payment-detail';
    if (isAction(pathname, 'create') || isAction(pathname, 'edit')) return 'payment-form';
    return 'payments-list';
  }
  if (pathname.startsWith('/materials')) {
    if (isAction(pathname, 'show')) return 'material-detail';
    if (isAction(pathname, 'create') || isAction(pathname, 'edit')) return 'material-form';
    return 'materials-list';
  }
  if (pathname.startsWith('/cut-jobs') || pathname.startsWith('/cut')) return 'cut';
  if (pathname.startsWith('/bazis-cut')) return 'bazis-cut';
  if (pathname.startsWith('/bazis')) return 'bazis';
  if (pathname.startsWith('/order-status-board') || pathname.startsWith('/mdf-work-board')) return 'status-board';
  if (pathname.startsWith('/configuration')) return 'configuration';
  if (pathname.startsWith('/profile')) return 'profile';
  if (pathname.startsWith('/scan')) return 'scan';
  return 'crud';
}

export function resolveOperationalPageKind(pathname: string): OperationalPageKind {
  if (
    pathname.startsWith('/orders/create') ||
    pathname.startsWith('/orders/edit') ||
    pathname.startsWith('/configuration') ||
    pathname.startsWith('/profile') ||
    pathname.startsWith('/scan') ||
    pathname.startsWith('/groups')
  ) return 'workspace';
  if (/\/(?:show\/|projects\/|bazis-cut\/\d+)/.test(pathname)) return 'show';
  if (/\/(?:create|edit\/)/.test(pathname)) return 'form';
  if (
    pathname.startsWith('/calendar') ||
    pathname.startsWith('/cut') ||
    pathname.startsWith('/order-status-board') ||
    pathname.startsWith('/mdf-work-board')
  ) return 'workspace';
  return 'list';
}
