export type CncSawnMessageRole = 'file' | 'comment' | 'unknown';
export type CncSawnSignalOrigin = 'live' | 'baseline';
export type CncSawnApplyState =
  | 'pending'
  | 'held_disabled'
  | 'held_baseline'
  | 'held_history'
  | 'held_return_barrier'
  | 'held_engine'
  | 'retry_wait'
  | 'failed_final'
  | 'applied'
  | 'already_completed'
  | 'closed';
export type CncSawnFreshness = 'fresh' | 'late';
export type CncSawnBlockedReason =
  | 'stale_observation'
  | 'closed'
  | 'return_barrier'
  | 'engine_mode'
  | 'already_completed'
  | 'already_applied'
  | 'read_only';

export interface CncSawnSignalsQuery {
  from?: string;
  to?: string;
  cuttingSequenceNo?: number;
  applyState?: CncSawnApplyState;
  openOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CncSawnSignalReactor {
  peerType: 'user' | 'channel' | 'chat';
  peerId: string;
  displayName: string | null;
  username: string | null;
}

export interface CncSawnPacketSignal {
  packetSignalId: number;
  applyState: CncSawnApplyState;
  freshness: CncSawnFreshness;
  appliedAt: string | null;
  closedObservedAt: string | null;
}

export interface CncSawnSignalItem {
  signalId: number;
  chatId: string;
  messageId: number;
  messageRole: CncSawnMessageRole;
  packetId: string | null;
  cuttingSequenceNo: number | null;
  cutJobDisplayNumber: string | null;
  reactor: CncSawnSignalReactor | null;
  reactedAt: string | null;
  firstObservedAt: string;
  clearedObservedAt: string | null;
  messageMissingObservedAt: string | null;
  origin: CncSawnSignalOrigin;
  packetSignal: CncSawnPacketSignal | null;
}

export interface CncSawnSignalSettings {
  applyToPacket: boolean;
  activatedAt: string | null;
}

export interface CncSawnSignalsResponse {
  items: CncSawnSignalItem[];
  total: number;
  page: number;
  pageSize: number;
  settings: CncSawnSignalSettings;
}

export interface CncSawnSignalSettingsRequest {
  applyToPacket: boolean;
  idempotencyKey: string;
}

export interface CncSawnApplyPreviewRequest {
  packetSignalIds?: number[];
}

export interface CncSawnEffectDetail {
  detailId: number;
  orderId: number;
  orderName: string;
  detailNumber: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
}

export interface CncSawnEffectOrder {
  orderId: number;
  orderName: string;
  orderStatusBefore: string | null;
  orderStatusAfter: string | null;
  productionStatusBefore: string | null;
  productionStatusAfter: string | null;
}

export interface CncSawnApplyPreviewItem {
  packetSignalId: number;
  packetId: string;
  cuttingSequenceNo: number | null;
  applyState: CncSawnApplyState;
  eligible: boolean;
  blockedReason: CncSawnBlockedReason | null;
  effect: {
    details: CncSawnEffectDetail[];
    orders: CncSawnEffectOrder[];
    events: string[];
  };
  effectDigest: string;
}

export interface CncSawnApplyPreviewResponse {
  items: CncSawnApplyPreviewItem[];
}

export interface CncSawnApplyConfirmItem {
  packetSignalId: number;
  effectDigest: string;
}

export interface CncSawnApplyConfirmRequest {
  items: CncSawnApplyConfirmItem[];
  idempotencyKey: string;
}

export type CncSawnApplyResultKind = 'applied' | 'stale_conflict' | 'blocked' | 'retry_later';

export interface CncSawnApplyConfirmResult {
  packetSignalId: number;
  result: CncSawnApplyResultKind;
  reason?: CncSawnBlockedReason;
}

export interface CncSawnApplyConfirmResponse {
  results: CncSawnApplyConfirmResult[];
}
