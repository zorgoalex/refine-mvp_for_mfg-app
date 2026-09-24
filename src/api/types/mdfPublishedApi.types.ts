export type MdfSourceKind = 'packet' | 'bazisCutSet' | 'bath';
export type MdfSourceColumn = 'parsed' | 'completed' | 'completed_laminated'
  | 'baths' | 'baths_ready' | 'baths_laminated' | 'completed_baths';

export interface MdfPublishedCard {
  kind: MdfSourceKind;
  id: string;
  displayName: string;
  column: MdfSourceColumn | null;
  sourceCreatedAt: string;
  acceptedRevision: string | null;
  receivedRevision: string;
  commandToken?: string | null;
  issues: string[];
}

export interface MdfPublishedJob {
  jobId: string;
  kind: MdfSourceKind | 'order' | 'orderDetail';
  id: string;
  status: 'pending' | 'done' | 'superseded' | 'needs_attention';
  code: string | null;
  attempts: number;
  orderIds: number[];
}

export interface MdfPublishedSnapshot {
  schemaVersion: 1;
  mode: 'legacy' | 'shadow' | 'active' | 'read_only';
  revision: string;
  generatedAt: string;
  dateFrom: string;
  dateTo: string;
  cards: MdfPublishedCard[];
  members: { kind: MdfSourceKind; id: string; orderId: number; detailId: number; quantity: number }[];
  positions: { orderId: number; detailId: number; required: number; cut: number; rolled: number;
    creditedCut: number; creditedRolled: number; remaining: number; issues: string[] }[];
  pendingJobs: MdfPublishedJob[];
  trackedJobs: MdfPublishedJob[];
  issues: string[];
}

export interface MdfPublishedQuery {
  dateTo?: string;
  focus?: { kind: MdfSourceKind; id: string };
  orderIds?: readonly number[];
  jobIds?: readonly string[];
}

/** Generation at READ start, not the generation when a user later clicks. */
export interface MdfSessionSnapshot {
  sessionGeneration: number;
  snapshot: MdfPublishedSnapshot;
}
