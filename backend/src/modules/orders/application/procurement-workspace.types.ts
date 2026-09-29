import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceKind, OrderResourceUnit } from './order-resource-demand.types';

/** Настройки экрана снабжения (singleton `procurement_settings`, экран «Конфигурация»). */
export interface ProcurementSettingsDto {
  /** «Нужно к» = плановая дата завершения − leadDays рабочих дней. */
  leadDays: number;
  criticalDays: number;
  soonDays: number;
  /** Запас на обрезки (%) для потребности по площади без готового раскроя. */
  wastePercent: number;
  /** Время утренней сводки, HH:MM (Asia/Almaty). */
  digestTime: string;
  unallocatedAlertDays: number;
  /** Рабочий список показывает просроченные заказы не старше стольких дней. */
  overdueWindowDays: number;
  version: number;
  updatedAt: string;
  updatedBy: { userId: number; name: string } | null;
}

export type ProcurementSettingsInput = Omit<ProcurementSettingsDto, 'version' | 'updatedAt' | 'updatedBy'>;

export interface UpdateProcurementSettingsCommand {
  currentUser: CurrentUser;
  requestId: string;
  settings: ProcurementSettingsInput;
  expectedVersion: number;
}

export type WorklistPreset = 'action' | 'urgent' | 'all';
export type WorklistGroupBy = 'none' | 'supplier' | 'material';
export type WorklistCoverage = 'covered' | 'partial' | 'ordered' | 'none' | 'no_data';
export type WorklistUrgency = 'overdue' | 'critical' | 'soon' | 'normal' | 'no_date';
export type WorklistSort = 'due' | 'deficit' | 'order' | 'material';

export interface ProcurementWorklistQuery {
  preset: WorklistPreset;
  search?: string;
  dueFrom?: string;
  dueTo?: string;
  kind?: OrderResourceKind;
  supplierKey?: string;
  coverage?: WorklistCoverage[];
  onecDocumentId?: number;
  groupBy: WorklistGroupBy;
  sort: WorklistSort;
}

export interface WorklistSupplierDto {
  /** s:<supplier_id> | c:<1C ref> | n:<name> | none */
  key: string;
  name: string;
  source: 'material' | 'first_receipt' | 'none';
  others: Array<{ key: string; name: string }>;
}

/** Строка «заказ × материал». Все количества — в единице потребности `unit`. */
export interface ProcurementWorklistLineDto {
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
  unit: OrderResourceUnit;
  need: number | null;
  received: number;
  /** Приходы в единицах, не пересчитываемых в единицу потребности (§4.4). */
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
  supplier: WorklistSupplierDto;
  procurementVersion: number;
  demandFingerprint: string;
  onecReceiptCount: number;
  lockedByOnec: boolean;
}

export interface WorklistGroupDto {
  key: string;
  label: string;
  linesCount: number;
  deficitM2: number;
  deficitLm: number;
  lineKeys: string[];
}

export interface ProcurementWorklistResponseDto {
  lines: ProcurementWorklistLineDto[];
  groups: WorklistGroupDto[];
  counts: { action: number; urgent: number; all: number };
  totals: { uncovered: number; urgent: number; deficitM2: number; deficitLm: number };
  settings: Pick<ProcurementSettingsDto, 'leadDays' | 'criticalDays' | 'soonDays' | 'wastePercent'>;
  /** Окно заказов: плановая дата в [plannedFrom, plannedTo] (null — без границы) или без даты. */
  window: { plannedFrom: string | null; plannedTo: string | null; ordersCount: number };
  today: string;
  capabilities: { supplyWorkspace: boolean; procurement: boolean };
  refreshedAt: string;
}

export interface ProcurementSavedViewDto {
  id: string;
  name: string;
  /** Query-строка рабочего списка без «?» (preset=…&groupBy=…). */
  query: string;
}

export const PROCUREMENT_SAVED_VIEWS_LIMIT = 20;
/** Сколько заказов рабочий список проецирует за один запрос (как by-material). */
export const PROCUREMENT_WORKLIST_ORDER_LIMIT = 500;
/** Сколько строк «заказ × материал» отдаётся целиком (фильтры — на сервере, листание — на клиенте). */
export const PROCUREMENT_WORKLIST_LINE_LIMIT = 3000;
/** Окно заказов сверху: плановая дата не дальше чем через N дней (без даты — всегда). */
export const PROCUREMENT_WORKLIST_PLANNED_AHEAD_DAYS = 60;
/** Статусы заказа, для которых материал уже не закупают: «Готов к выдаче», «Выдан», «Завершен» (order_statuses). */
export const PROCUREMENT_WORKLIST_DONE_STATUS_CODES: readonly string[] = ['legacy_6', 'legacy_7', 'legacy_8'];
