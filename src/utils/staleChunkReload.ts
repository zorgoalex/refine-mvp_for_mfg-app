const RELOAD_MARKER_PREFIX = 'erp.staleChunkReload';
const MEMORY_RELOAD_MARKER = '__erpStaleChunkReloaded';

const STALE_CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Loading chunk [\w-]+ failed/i,
  /ChunkLoadError/i,
  /Expected a JavaScript-or-Wasm module script/i,
  /MIME type of ["']?text\/html/i,
];

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type LocationLike = Pick<Location, 'reload'>;
type DocumentLike = Pick<Document, 'querySelectorAll'>;

export interface StaleChunkReloadEnvironment {
  sessionStorage?: StorageLike;
  location: LocationLike;
  document?: DocumentLike;
  globalThis?: Record<string, unknown>;
}

export interface VitePreloadErrorEvent extends Event {
  payload?: unknown;
}

export function isStaleChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : '';

  return STALE_CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function reloadPageOnceForStaleChunk(
  error: unknown,
  environment = getDefaultEnvironment(),
): boolean {
  if (!environment || !isStaleChunkLoadError(error)) {
    return false;
  }

  if (!markReloadAttempt(environment)) {
    return false;
  }

  environment.location.reload();
  return true;
}

export function handleVitePreloadError(
  event: VitePreloadErrorEvent,
  environment = getDefaultEnvironment(),
): boolean {
  if (!environment || !reloadPageOnceForStaleChunk(event.payload, environment)) return false;
  event.preventDefault();
  return true;
}

function getDefaultEnvironment(): StaleChunkReloadEnvironment | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return {
    sessionStorage: window.sessionStorage,
    location: window.location,
    document: window.document,
    globalThis: window as unknown as Record<string, unknown>,
  };
}

function markReloadAttempt(environment: StaleChunkReloadEnvironment): boolean {
  const key = `${RELOAD_MARKER_PREFIX}:${getEntryScriptSignature(environment.document)}`;

  if (!environment.sessionStorage) {
    return markReloadAttemptInMemory(environment.globalThis);
  }

  try {
    if (environment.sessionStorage.getItem(key) === '1') {
      return false;
    }
    environment.sessionStorage.setItem(key, '1');
    return true;
  } catch {
    return markReloadAttemptInMemory(environment.globalThis);
  }
}

function markReloadAttemptInMemory(globalLike: Record<string, unknown> | undefined): boolean {
  if (!globalLike) {
    return false;
  }

  if (globalLike[MEMORY_RELOAD_MARKER]) {
    return false;
  }

  globalLike[MEMORY_RELOAD_MARKER] = true;
  return true;
}

function getEntryScriptSignature(documentLike: DocumentLike | undefined): string {
  try {
    const moduleScripts = Array.from(
      documentLike?.querySelectorAll('script[type="module"][src]') ?? [],
    );
    const srcs = moduleScripts
      .map((script) => (script as HTMLScriptElement).src)
      .filter(Boolean);

    return srcs.join('|') || 'unknown-entry';
  } catch {
    return 'unknown-entry';
  }
}
