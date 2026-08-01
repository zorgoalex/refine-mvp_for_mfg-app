export const ORDER_KINDS = ['draft', 'crm_request', 'production_order'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const ORDER_SOURCE_SYSTEMS = ['erp', 'bitrix24', 'customer_portal'] as const;
export type OrderSourceSystem = (typeof ORDER_SOURCE_SYSTEMS)[number];
