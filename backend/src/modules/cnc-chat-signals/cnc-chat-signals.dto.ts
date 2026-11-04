import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { ApplyState, BlockedReason, MessageRole } from './cnc-chat-signals.domain';

const digits = z.string().regex(/^[0-9]{1,20}$/);
const iso = z.string().datetime({ offset: true });
const messageId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const reactorSchema = z.object({
  peerType: z.enum(['user', 'channel', 'chat']),
  peerId: digits,
  displayName: z.string().max(200).nullable(),
  username: z.string().max(64).nullable(),
  reactedAt: iso.nullable(),
}).strict();

const reportMessageSchema = z.object({
  messageId,
  present: z.boolean(),
  thumbsCount: z.number().int().min(0).max(1_000_000),
  canSeeList: z.boolean().nullable(),
  authors: z.object({
    state: z.enum(['complete', 'partial', 'unavailable']),
    reactors: z.array(reactorSchema).max(500),
  }).strict().nullable(),
  readError: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable(),
}).strict();

const reportSchema = z.object({
  claimId: z.string().uuid(),
  claimToken: z.string().min(16).max(128),
  observedAt: iso,
  messages: z.array(reportMessageSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<number>();
  for (const message of value.messages) {
    if (ids.has(message.messageId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate messageId' });
    ids.add(message.messageId);
  }
});

export type SawnSignalReportDto = z.infer<typeof reportSchema>;

export interface SawnSignalClaimResponse {
  capability: string;
  claim: null | {
    claimId: string;
    claimToken: string;
    expiresAt: string;
    messages: Array<{ messageId: number; lastThumbsCount: number; authorsDue: boolean }>;
  };
}

const listQuerySchema = z.object({
  from: iso.optional(),
  to: iso.optional(),
  cuttingSequenceNo: z.coerce.number().int().positive().optional(),
  applyState: z.enum(['pending', 'held_disabled', 'held_baseline', 'held_history', 'held_return_barrier', 'held_engine',
    'retry_wait', 'failed_final', 'applied', 'already_completed', 'closed']).optional(),
  openOnly: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export type SawnSignalListQuery = z.infer<typeof listQuerySchema>;

export interface SawnSignalSettingsDto {
  applyToPacket: boolean;
  activatedAt: string | null;
}

export interface SawnSignalListItem {
  signalId: number;
  chatId: string;
  messageId: number;
  messageRole: MessageRole;
  packetId: string | null;
  cuttingSequenceNo: number | null;
  cutJobDisplayNumber: string | null;
  reactor: { peerType: 'user' | 'channel' | 'chat'; peerId: string; displayName: string | null; username: string | null } | null;
  reactedAt: string | null;
  firstObservedAt: string;
  clearedObservedAt: string | null;
  messageMissingObservedAt: string | null;
  origin: 'live' | 'baseline';
  packetSignal: { packetSignalId: number; applyState: ApplyState; freshness: 'fresh' | 'late'; appliedAt: string | null;
    closedObservedAt: string | null } | null;
}

export interface SawnSignalListResponse {
  items: SawnSignalListItem[];
  total: number;
  page: number;
  pageSize: number;
  settings: SawnSignalSettingsDto;
}

const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

const settingsSchema = z.object({ applyToPacket: z.boolean(), idempotencyKey }).strict();
const previewSchema = z.object({ packetSignalIds: z.array(z.number().int().positive()).min(1).max(200).optional() }).strict();
const confirmSchema = z.object({
  items: z.array(z.object({ packetSignalId: z.number().int().positive(), effectDigest: z.string().regex(/^[0-9a-f]{64}$/) })
    .strict()).min(1).max(200),
  idempotencyKey,
}).strict().superRefine((value, ctx) => {
  const ids = new Set<number>();
  for (const item of value.items) {
    if (ids.has(item.packetSignalId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate packetSignalId' });
    ids.add(item.packetSignalId);
  }
});

export type SawnSignalSettingsUpdateDto = z.infer<typeof settingsSchema>;
export type SawnSignalPreviewRequestDto = z.infer<typeof previewSchema>;
export type SawnSignalApplyConfirmDto = z.infer<typeof confirmSchema>;

export interface SawnSignalEffect {
  details: Array<{ detailId: number; orderId: number; orderName: string; detailNumber: number | null;
    statusBefore: string | null; statusAfter: string | null }>;
  orders: Array<{ orderId: number; orderName: string; orderStatusBefore: string | null; orderStatusAfter: string | null;
    productionStatusBefore: string | null; productionStatusAfter: string | null }>;
  events: string[];
}

export interface SawnSignalPreviewItem {
  packetSignalId: number;
  packetId: string;
  cuttingSequenceNo: number | null;
  applyState: ApplyState;
  eligible: boolean;
  blockedReason: BlockedReason | null;
  effect: SawnSignalEffect;
  effectDigest: string;
}

export interface SawnSignalConfirmResult {
  packetSignalId: number;
  result: 'applied' | 'stale_conflict' | 'blocked' | 'retry_later';
  reason?: BlockedReason;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Некорректный запрос', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

export const parseSawnSignalReport = (value: unknown) => parse(reportSchema, value);
export const parseSawnSignalListQuery = (value: unknown) => parse(listQuerySchema, value);
export const parseSawnSignalSettingsUpdate = (value: unknown) => parse(settingsSchema, value);
export const parseSawnSignalPreview = (value: unknown) => parse(previewSchema, value);
export const parseSawnSignalConfirm = (value: unknown) => parse(confirmSchema, value);
