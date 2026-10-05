import { z } from 'zod';
import { clientScreenSnapshotSchema, clientScreenUiSchema } from './clientScreenSnapshotSchema';

/**
 * Messages between the manager windows and the customer window (BroadcastChannel, same origin and
 * browser profile). One schema builds and validates every message: a sender goes through
 * `clientScreenMessage`, a receiver through `parseClientScreenMessage`; what does not parse is dropped.
 * Customer data never goes to localStorage, so there is deliberately no storage fallback.
 */
/**
 * Version of everything on the wire: the messages and the data inside them (the registry of codes,
 * the snapshot and interface-state schemas). Windows of different versions must never talk — a
 * customer window of an older build would drop what it does not know and keep showing stale data.
 * So the version is part of the channel name and of the lock names: a manager window sees only a
 * customer window of its own version and opens one when there is none. Any change of the wire data
 * needs a new version here, and the previous one added to CLIENT_SCREEN_RETIRED_VIEWERS (a test pins
 * the registry to the version).
 */
export const CLIENT_SCREEN_PROTOCOL_VERSION = 2 as const;
export const CLIENT_SCREEN_CHANNEL = `erp-client-screen-v${CLIENT_SCREEN_PROTOCOL_VERSION}`;
/**
 * Customer windows of earlier builds: the channel each listens on and the message that makes it
 * close itself. Sent when an order is presented, so an outdated window does not stay on the
 * customer's monitor next to the current one.
 */
export const CLIENT_SCREEN_RETIRED_VIEWERS: ReadonlyArray<{ channel: string; shutdown: unknown }> = [
  { channel: 'erp-client-screen', shutdown: { v: 1, t: 'shutdown' } },
];

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

export const CLIENT_SCREEN_VIEWER_LOCK = `erp-client-screen-viewer-v${CLIENT_SCREEN_PROTOCOL_VERSION}`;
export const CLIENT_SCREEN_OWNER_LOCK_PREFIX = `erp-client-screen-owner-v${CLIENT_SCREEN_PROTOCOL_VERSION}-`;
export const clientScreenOwnerLock = (ownerEpoch: number) => `${CLIENT_SCREEN_OWNER_LOCK_PREFIX}${ownerEpoch}`;
