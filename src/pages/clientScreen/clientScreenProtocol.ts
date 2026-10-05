import { z } from 'zod';
import { clientScreenSnapshotSchema, clientScreenUiSchema } from './clientScreenSnapshotSchema';

/**
 * Messages between the manager windows and the customer window (BroadcastChannel, same origin and
 * browser profile). One schema builds and validates every message: a sender goes through
 * `clientScreenMessage`, a receiver through `parseClientScreenMessage`; what does not parse is dropped.
 * Customer data never goes to localStorage, so there is deliberately no storage fallback.
 */
export const CLIENT_SCREEN_CHANNEL = 'erp-client-screen';
export const CLIENT_SCREEN_PROTOCOL_VERSION = 1 as const;

const v = z.literal(CLIENT_SCREEN_PROTOCOL_VERSION);
const windowId = z.string().regex(/^[a-z0-9]{8,40}$/);
const epoch = z.number().int().positive();
const gen = z.number().int().min(0);
const policyVersion = z.number().int().positive();
const validUntil = z.number().int().positive();

export const clientScreenMessageSchema = z.discriminatedUnion('t', [
  /** Customer window started (or restarted): owners of an earlier run may answer with `resume`. */
  z.object({ v, t: z.literal('hello'), viewerId: windowId }).strict(),
  /** «Показать клиенту» pressed in a manager window. */
  z.object({ v, t: z.literal('claim'), candidateId: windowId, claimId: windowId, gen }).strict(),
  /** The previous owner asks to continue after the customer window restarted. */
  z.object({ v, t: z.literal('resume'), candidateId: windowId, claimId: windowId, gen, viewerId: windowId, resumeEpoch: epoch }).strict(),
  /** The customer window, the only arbiter, names the owner; `claimId` says which claim it answers. */
  z.object({ v, t: z.literal('grant'), epoch, ownerId: windowId, claimId: windowId, viewerId: windowId }).strict(),
  /** Sent by the owner from inside its held Web Lock; only then the customer window watches that lock. */
  z.object({ v, t: z.literal('owner-ready'), epoch, gen }).strict(),
  z.object({
    v, t: z.literal('state'), epoch, gen, seq: z.number().int().positive(), policyVersion, validUntil,
    mode: z.enum(['blank', 'order']), snapshot: clientScreenSnapshotSchema.nullable(),
  }).strict().refine((message) => (message.mode === 'order') === (message.snapshot !== null), { message: 'snapshot must match the mode' }),
  z.object({ v, t: z.literal('ui'), epoch, gen, stateSeq: z.number().int().positive(), ui: clientScreenUiSchema }).strict(),
  /** The owner re-read the settings: extends the validity of the snapshot of the same policy version. */
  z.object({ v, t: z.literal('confirm'), epoch, gen, policyVersion, validUntil }).strict(),
  z.object({ v, t: z.literal('release'), epoch, gen }).strict(),
  /** Emergency switch-off of the whole workstation. */
  z.object({ v, t: z.literal('shutdown') }).strict(),
]);

export type ClientScreenMessage = z.infer<typeof clientScreenMessageSchema>;
export type ClientScreenMessageOf<T extends ClientScreenMessage['t']> = Extract<ClientScreenMessage, { t: T }>;

type Body<T extends ClientScreenMessage['t']> = Omit<ClientScreenMessageOf<T>, 'v' | 't'>;

/** Builds a message and proves it against the schema, so a sender cannot emit what receivers drop. */
export function clientScreenMessage<T extends ClientScreenMessage['t']>(t: T, body: Body<T>): ClientScreenMessageOf<T> {
  return clientScreenMessageSchema.parse({ v: CLIENT_SCREEN_PROTOCOL_VERSION, t, ...body }) as ClientScreenMessageOf<T>;
}

export function parseClientScreenMessage(value: unknown): ClientScreenMessage | null {
  const result = clientScreenMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Random id of a window (manager or customer), also used for opaque row ids. */
export function clientScreenRandomId(length = 16): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

export const CLIENT_SCREEN_VIEWER_LOCK = 'erp-client-screen-viewer';
export const CLIENT_SCREEN_OWNER_LOCK_PREFIX = 'erp-client-screen-owner-';
export const clientScreenOwnerLock = (ownerEpoch: number) => `erp-client-screen-owner-${ownerEpoch}`;
