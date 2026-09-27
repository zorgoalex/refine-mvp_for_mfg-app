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

/** §5.6 presentation: read in the same read-only snapshot as the accounting. Never decides a card's
 * existence, column, counters or readiness. */
export interface MdfPublishedPresentationItem {
  orderId: number;
  detailId: number | null;
  detailNumber: number | string | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
}

export interface MdfPublishedCardComposition {
  items: MdfPublishedPresentationItem[];
  programName?: string | null;
  externalKey?: string | null;
  materialName?: string | null;
  hasSheetImage?: boolean;
  svgCutJobId?: number | null;
  svgCutResultId?: number | null;
  cuttingSequenceNo?: number | null;
  cutJobId?: number | null;
  cutJobName?: string | null;
  resultNo?: number | null;
  revisionNo?: number | null;
}

export interface MdfPublishedCardLive {
  comments?: unknown;
  rework?: boolean;
  thumbsUp?: boolean;
  completionStatus?: string | null;
  dowelingLinks?: unknown;
  name?: string | null;
}

export interface MdfPublishedCardPresentation {
  kind: MdfSourceKind;
  id: string;
  /** Binding missing or raw composition changed since the accepted revision: render a minimal card. */
  stale: boolean;
  /** Composition-sensitive content; present only when not stale. */
  composition: MdfPublishedCardComposition | null;
  /** Live annotations (current values; not bound to the accepted revision). Present only for fully visible cards. */
  live: MdfPublishedCardLive | null;
}

export interface MdfPublishedCardProgress {
  kind: string;
  id: string;
  orderId: number;
  detailId: number;
  member: number;
  cut: number;
  laminated: number;
}

export interface MdfPublishedOrderName {
  orderId: number;
  orderName: string;
}

export interface MdfPublishedUnregisteredSource {
  kind: 'packet' | 'bazisCutSet';
  id: string;
  displayName: string;
  sourceCreatedAt: string;
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
  presentation: MdfPublishedCardPresentation[];
  progress: MdfPublishedCardProgress[];
  orders: MdfPublishedOrderName[];
  unregistered: MdfPublishedUnregisteredSource[];
  issues: string[];
}

export interface MdfPublishedQuery {
  dateTo?: string;
  focus?: { kind: MdfSourceKind; id: string };
  orderIds?: readonly number[];
  jobIds?: readonly string[];
  /** §5.6 search: ALSO select the cards (old/completed included) of these orders. */
  searchOrderIds?: readonly number[];
}

/** Generation at READ start, not the generation when a user later clicks. */
export interface MdfSessionSnapshot {
  sessionGeneration: number;
  snapshot: MdfPublishedSnapshot;
}
