/** Journal of duplicates found while integrating directories and records of ERP, Bitrix24 and 1C (D0). */

export const DUPLICATE_SYSTEMS = ['erp', 'bitrix', 'onec'] as const;
export type DuplicateSystem = (typeof DUPLICATE_SYSTEMS)[number];

export const DUPLICATE_ENTITY_KINDS = ['client', 'supplier', 'vendor', 'film', 'sheet_material', 'material', 'onec_counterparty', 'onec_item'] as const;
export type DuplicateEntityKind = (typeof DUPLICATE_ENTITY_KINDS)[number];

export const DUPLICATE_STATUSES = ['open', 'dismissed', 'external', 'merged', 'resolved'] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

/** Why a user marked a case: fixed reasons, never a free text (it could carry personal data past the masks). */
export const DUPLICATE_REASONS = ['different_records', 'related_records', 'test_data', 'other'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

export const DUPLICATE_VIAS = ['erp_manual', 'bitrix_inbound', 'onec_publication', 'catalog_import', 'order_import', 'scan'] as const;
export type DuplicateVia = (typeof DUPLICATE_VIAS)[number];

export type DuplicateAction =
  | 'detected' | 'member_joined' | 'member_left' | 'dismissed' | 'marked_external' | 'reopened' | 'resolved' | 'source_refreshed';

/** The sets of 1C with revocation and the personal data term a key may be read from. */
export type RevocableEntity = 'counterparty_phones' | 'counterparty_contacts';

/** One record of one system: an ERP id, `<sourceId>:<Ref_Key>` of 1C. */
export interface RecordRef {
  system: DuplicateSystem;
  entityKind: DuplicateEntityKind;
  recordKey: string;
}

export const recordId = (ref: RecordRef) => `${ref.system}:${ref.entityKind}:${ref.recordKey}`;

/** What reads a record of each kind (its name, its card); values of 1C need clients.onec_data.view on top. */
export const KIND_VIEW_PERMISSION: Record<DuplicateEntityKind, string> = {
  client: 'clients.view',
  supplier: 'suppliers.view',
  vendor: 'vendors.view',
  film: 'references.view',
  sheet_material: 'sheet_materials.view',
  material: 'materials.view',
  onec_counterparty: 'onec.view',
  onec_item: 'onec.view',
};
export const ONEC_VALUES_PERMISSION = 'clients.onec_data.view';

export const DUPLICATES_VIEW = 'integrations.duplicates.view';
export const DUPLICATES_RESOLVE = 'integrations.duplicates.resolve';

export const ENTITY_KIND_LABELS: Record<DuplicateEntityKind, string> = {
  client: 'Клиент',
  supplier: 'Поставщик',
  vendor: 'Производитель',
  film: 'Плёнка',
  sheet_material: 'Листовой материал',
  material: 'Материал',
  onec_counterparty: 'Контрагент 1С',
  onec_item: 'Номенклатура 1С',
};

/** Payload of the background boundary: who asked and how the check relates to other work. */
export interface CheckContext {
  via: DuplicateVia;
  requestId: string;
  correlationId: string;
  /** User of the write that queued the check (an ERP author), null for the system. */
  authorUserId: number | null;
}

export const SOURCE = 'integration_duplicates';
