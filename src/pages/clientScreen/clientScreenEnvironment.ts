import { CLIENT_SCREEN_CHANNEL, clientScreenRandomId, parseClientScreenMessage, type ClientScreenMessage } from './clientScreenProtocol';
import {
  CLIENT_SCREEN_WORKSTATION_KEY, CLIENT_SCREEN_WORKSTATION_LOCK, disableClientScreenWorkstation, enableClientScreenWorkstation,
  parseClientScreenWorkstation, serializeClientScreenWorkstation, type ClientScreenWorkstation,
} from './clientScreenWorkstation';

/**
 * Everything the customer screen needs from the browser, behind one small interface, so the two
 * runtimes (manager window, customer window) can be exercised in tests without a browser.
 */
export interface ClientScreenLocks {
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
}

export interface ClientScreenEnvironment {
  now(): number;
  randomId(): string;
  /** Subscribes to the channel; returns the sender and a close function. Invalid messages are dropped here. */
  openChannel(onMessage: (message: ClientScreenMessage) => void): { post(message: ClientScreenMessage): void; close(): void };
  locks: ClientScreenLocks;
  readWorkstation(): ClientScreenWorkstation;
  /** Calls back when another window replaced the workstation record. */
  onWorkstationChange(listener: () => void): () => void;
  /** Switch-off / re-enable: read and replace the record inside the workstation lock. */
  updateWorkstation(action: 'disable' | 'enable'): Promise<ClientScreenWorkstation>;
  setInterval(callback: () => void, ms: number): () => void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createClientScreenEnvironment(overrides: {
  storage: StorageLike;
  locks: ClientScreenLocks;
  onStorageEvent?: (listener: (key: string | null) => void) => () => void;
  channelName?: string;
  /** Clock, for tests. */
  now?: () => number;
  /** Wraps the channel sender, for tests of a failing channel. */
  wrapPost?: (post: (message: ClientScreenMessage) => void) => (message: ClientScreenMessage) => void;
}): ClientScreenEnvironment {
  const read = (): ClientScreenWorkstation => {
    try {
      return parseClientScreenWorkstation(overrides.storage.getItem(CLIENT_SCREEN_WORKSTATION_KEY));
    } catch {
      // Storage that cannot be read gives no proof that presenting is allowed.
      return { disabled: true, gen: 0 };
    }
  };
  return {
    now: overrides.now ?? (() => Date.now()),
    randomId: () => clientScreenRandomId(),
    openChannel(onMessage) {
      const channel = new BroadcastChannel(overrides.channelName ?? CLIENT_SCREEN_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const message = parseClientScreenMessage(event.data);
        if (message) onMessage(message);
      };
      const post = (message: ClientScreenMessage) => channel.postMessage(message);
      return { post: overrides.wrapPost ? overrides.wrapPost(post) : post, close: () => channel.close() };
    },
    locks: overrides.locks,
    readWorkstation: read,
    onWorkstationChange(listener) {
      return overrides.onStorageEvent ? overrides.onStorageEvent((key) => { if (key === null || key === CLIENT_SCREEN_WORKSTATION_KEY) listener(); }) : () => undefined;
    },
    async updateWorkstation(action) {
      let next: ClientScreenWorkstation = read();
      await overrides.locks.request(CLIENT_SCREEN_WORKSTATION_LOCK, {}, () => {
        const current = read();
        next = action === 'disable' ? disableClientScreenWorkstation(current) : enableClientScreenWorkstation(current);
        overrides.storage.setItem(CLIENT_SCREEN_WORKSTATION_KEY, serializeClientScreenWorkstation(next));
      });
      return next;
    },
    setInterval(callback, ms) {
      const handle = globalThis.setInterval(callback, ms);
      return () => globalThis.clearInterval(handle);
    },
  };
}

/** The environment of a real browser window. Throws when the browser lacks Web Locks or BroadcastChannel. */
export function browserClientScreenEnvironment(): ClientScreenEnvironment {
  if (typeof BroadcastChannel === 'undefined' || !navigator.locks) throw new Error('client screen: browser lacks BroadcastChannel or Web Locks');
  return createClientScreenEnvironment({
    storage: window.localStorage,
    locks: navigator.locks as unknown as ClientScreenLocks,
    onStorageEvent(listener) {
      const handler = (event: StorageEvent) => listener(event.key);
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
  });
}
