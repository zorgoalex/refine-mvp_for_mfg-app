export type DuplicateStatus = 'open' | 'dismissed' | 'external' | 'merged' | 'resolved';
export type DuplicateStatusFilter = DuplicateStatus | 'all';
export type DuplicateSystem = 'erp' | 'bitrix' | 'onec';
export type DuplicateEntityKind =
  | 'client' | 'supplier' | 'vendor' | 'film' | 'sheet_material' | 'material' | 'onec_counterparty' | 'onec_item';
export type DuplicateStrength = 'exact' | 'likely';
export type DuplicateSourcesState = 'none' | 'current' | 'refreshing' | 'unavailable';
export type DuplicateDetectedVia =
  | 'erp_manual' | 'bitrix_inbound' | 'onec_publication' | 'catalog_import' | 'order_import' | 'scan';

export interface DuplicateUserRef { userId: number; username: string | null }

export interface DuplicateMember {
  system: DuplicateSystem;
  entityKind: DuplicateEntityKind;
  recordKey: string;
  erpEntityId: number | null;
  name: string | null;
  joinedAt: string;
  leftAt: string | null;
  recordCreatedAt: string | null;
  author: DuplicateUserRef | null;
  authorExternal: string | null;
  via: string;
}

export interface DuplicateCaseView {
  caseId: number;
  ruleCode: string;
  ruleLabel: string;
  entityKind: DuplicateEntityKind;
  entityKindLabel: string;
  strength: DuplicateStrength;
  status: DuplicateStatus;
  keyMask: string | null;
  sourcesState: DuplicateSourcesState;
  firstDetectedAt: string;
  lastSeenAt: string;
  detectedVia: DuplicateDetectedVia;
  resolvedAt: string | null;
  resolvedBy: DuplicateUserRef | null;
  resolutionCode: string | null;
  resolutionReason: string | null;
  version: number;
  external: 'onec' | null;
  members: DuplicateMember[];
}

export interface DuplicateListResult {
  items: DuplicateCaseView[];
  total: number;
  counts: Partial<Record<DuplicateStatus, number>>;
}

export interface DuplicateRule {
  code: string;
  label: string;
  entityKind: DuplicateEntityKind;
  strength: DuplicateStrength;
  external: 'onec' | null;
}

export interface DuplicateFact { label: string; value: string | number | null; hidden?: true }

export interface DuplicateMemberDetail extends DuplicateMember {
  facts: DuplicateFact[];
  /** null — no right to see the matched values. */
  matchedValues: string[] | null;
}

export interface DuplicateHistoryEvent {
  eventId: number;
  action: string;
  at: string;
  actor: DuplicateUserRef | null;
  reason: string | null;
  members: Array<{ system: DuplicateSystem; entityKind: DuplicateEntityKind; recordKey: string }>;
}

export interface DuplicateRelatedCase { caseId: number; ruleCode: string; ruleLabel: string; status: DuplicateStatus }

export interface DuplicateCaseDetail extends Omit<DuplicateCaseView, 'members'> {
  members: DuplicateMemberDetail[];
  history: DuplicateHistoryEvent[];
  related: DuplicateRelatedCase[];
}

export interface DuplicateListQuery {
  status?: DuplicateStatusFilter;
  entityKind?: string;
  ruleCode?: string;
  system?: DuplicateSystem;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface DuplicateCommandBody { expectedVersion: number; reason?: 'different_records' | 'related_records' | 'test_data' | 'other' | null }
