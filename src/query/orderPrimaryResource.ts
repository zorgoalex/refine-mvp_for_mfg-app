const BASE_ORDER_SHOW_FIELDS = [
  'order_id',
  'order_name',
  'client_id',
  'client_name',
  'order_date',
  'planned_completion_date',
  'completion_date',
  'issue_date',
  'payment_date',
  'total_amount',
  'final_amount',
  'discount',
  'paid_amount',
  'priority',
  'order_status_name',
  'payment_status_name',
  'production_status_id',
  'production_status_name',
  'manager_id',
  'material_name',
  'milling_type_name',
  'edge_type_name',
  'film_name',
  'notes',
  'parts_count',
  'total_area',
  'link_cutting_file',
  'link_cutting_image_file',
  'link_cad_file',
  'link_pdf_file',
  'doweling_order_id',
  'doweling_order_name',
  'ref_key_1c',
  'version',
  'delete_flag',
  'created_at',
  'updated_at',
  'created_by',
  'edited_by',
] as const;

export const ORDER_SHOW_PRIMARY_RESOURCE = 'orders_view' as const;

export function createOrderShowPrimaryMeta(input: {
  projectsEnabled: boolean;
  authCacheNamespace: string;
}): Record<string, unknown> {
  return {
    idColumnName: 'order_id',
    label: 'Заказы',
    fields: [
      ...BASE_ORDER_SHOW_FIELDS,
      ...(input.projectsEnabled ? ['project_id', 'project_code', 'order_full_number'] : []),
    ],
    authCacheNamespace: input.authCacheNamespace,
  };
}

export function getOrderShowBackendMode(backendOrdersRead: boolean): string {
  return getOrdersReadBackendMode(backendOrdersRead);
}

export function getOrdersReadBackendMode(backendOrdersRead: boolean): string {
  return backendOrdersRead ? 'backend-orders-read' : 'hasura-orders-read';
}

export function createOrderShowPrimaryIdentity(input: {
  orderId: string | number;
  projectsEnabled: boolean;
  authCacheNamespace: string;
  additionalParams?: Record<string, unknown>;
}) {
  return {
    resource: ORDER_SHOW_PRIMARY_RESOURCE,
    orderId: input.orderId,
    meta: {
      ...(input.additionalParams ?? {}),
      ...createOrderShowPrimaryMeta(input),
    },
  } as const;
}
