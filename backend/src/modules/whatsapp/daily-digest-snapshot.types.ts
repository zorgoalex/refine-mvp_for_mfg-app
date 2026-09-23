export const DAILY_DIGEST_RENDERER_VERSION = 'daily-order-cards-v1';
export const DAILY_DIGEST_MAX_ORDERS = 500;
export const DAILY_DIGEST_MAX_PAGE_BYTES = 1024 * 1024;
export const DAILY_DIGEST_MAX_RUN_BYTES = 16 * 1024 * 1024;

export interface DailyDigestMaterial {
  fullName: string;
  label: string;
}

export interface DailyDigestOrderCard {
  orderId: number;
  orderName: string;
  orderDate: string | null;
  plannedCompletionDate: string;
  clientName: string | null;
  orderStatusName: string;
  paymentStatusName: string;
  totalArea: number;
  basisProjectDisplay: string | null;
  materials: DailyDigestMaterial[];
  millingDisplay: string;
  passedProductionCodes: string[];
}

export interface DailyDigestWorkflowDisplay {
  displayOrderCodes: string[];
  codeToLetter: Record<string, string>;
  codeToName: Record<string, string>;
}

/** Frozen calendar-shaped content captured from one repeatable-read snapshot. */
export interface DailyDigestSnapshot {
  businessDate: string;
  rendererVersion: string;
  cardsPerMessage: 1 | 2;
  totalArea: number;
  orders: DailyDigestOrderCard[];
  workflowDisplay: DailyDigestWorkflowDisplay;
}

export interface DailyDigestRenderedPage {
  /** One-based image sequence; page one carries the date and whole-day total. */
  pageIndex: number;
  orderIds: number[];
  png: Buffer;
}
