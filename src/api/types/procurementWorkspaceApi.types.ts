import type { OrderResourceKind } from './orderApi.types';

export type WorklistPreset = 'action' | 'urgent' | 'all';
export type WorklistGroupBy = 'none' | 'supplier' | 'material';
export type WorklistCoverage = 'covered' | 'partial' | 'ordered' | 'none' | 'no_data';
export type WorklistUrgency = 'overdue' | 'critical' | 'soon' | 'normal' | 'no_date';
export type WorklistSort = 'due' | 'deficit' | 'order' | 'material';

export interface ProcurementWorklistParams {
  preset?: WorklistPreset;
  search?: string;
  dueFrom?: string;
  dueTo?: string;
  kind?: OrderResourceKind;
  supplierKey?: string;
  /** Через запятую. */
  coverage?: string;
  onecDocumentId?: number;
  groupBy?: WorklistGroupBy;
  sort?: WorklistSort;
}

export interface WorklistSupplier {
  key: string;
  name: string;
  source: 'material' | 'first_receipt' | 'none';
  others: Array<{ key: string; name: string }>;
}

/** Строка «заказ × материал»; количества — в единице потребности `unit`. */
export interface ProcurementWorklistLine {
  lineKey: string;
  orderId: number;
  orderName: string;
  fullNumber: string;
  clientName: string | null;
  orderStatus: string | null;
  resourceKey: string;
  kind: OrderResourceKind;
  refId: number;
  name: string;
  unit: 'm2' | 'lm';
  need: number | null;
  received: number;
  receivedIncompatibleCount: number;
  covered: number;
  orderedOpen: number;
  deficit: number | null;
  coverage: WorklistCoverage;
  needsAction: boolean;
  purchased: boolean;
  purchaseOrigin: 'manual' | 'onec' | null;
  demandChangedSinceMark: boolean;
  plannedCompletionDate: string | null;
  dueDate: string | null;
  daysLeft: number | null;
  urgency: WorklistUrgency;
  supplier: WorklistSupplier;
  procurementVersion: number;
  demandFingerprint: string;
  onecReceiptCount: number;
  lockedByOnec: boolean;
}

export interface WorklistGroup {
  key: string;
  label: string;
  linesCount: number;
  deficitM2: number;
  deficitLm: number;
  lineKeys: string[];
}

export interface ProcurementWorklistResponse {
  lines: ProcurementWorklistLine[];
  groups: WorklistGroup[];
  counts: { action: number; urgent: number; all: number };
  totals: { uncovered: number; urgent: number; deficitM2: number; deficitLm: number };
  settings: { leadDays: number; criticalDays: number; soonDays: number; wastePercent: number };
  /** Окно заказов: плановая дата в [plannedFrom, plannedTo] (null — без границы) или без даты. */
  window: { plannedFrom: string | null; plannedTo: string | null; ordersCount: number };
  today: string;
  capabilities: { supplyWorkspace: boolean; procurement: boolean };
  refreshedAt: string;
}

export interface ProcurementSavedView {
  id: string;
  name: string;
  query: string;
}

export interface ProcurementSettings {
  leadDays: number;
  criticalDays: number;
  soonDays: number;
  wastePercent: number;
  digestTime: string;
  unallocatedAlertDays: number;
  overdueWindowDays: number;
  version: number;
  updatedAt: string;
  updatedBy: { userId: number; name: string } | null;
}

export type ProcurementSettingsUpdate = Omit<ProcurementSettings, 'version' | 'updatedAt' | 'updatedBy'> & {
  expectedVersion: number;
};
