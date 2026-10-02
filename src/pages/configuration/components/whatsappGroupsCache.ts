import { whatsappApi } from '../../../api/whatsappApi';
import type { WhatsAppGroupDto } from '../../../api/types/whatsappApi.types';

/** Matches the backend cache of the group list (GROUPS_CACHE_TTL_MS). */
const GROUPS_TTL_MS = 60_000;

let loaded: { groups: WhatsAppGroupDto[]; at: number } | null = null;
let inFlight: Promise<WhatsAppGroupDto[]> | null = null;

/**
 * One group list for every picker and label on the page: concurrent callers share
 * one request, and a success is reused for a minute. Failures are not remembered,
 * so the next caller retries (the backend keeps its own cooldown for WAHA).
 */
export function loadWhatsAppGroups(now = Date.now()): Promise<WhatsAppGroupDto[]> {
  if (loaded && now - loaded.at < GROUPS_TTL_MS) return Promise.resolve(loaded.groups);
  if (inFlight) return inFlight;
  const request = whatsappApi.groups().then((response) => {
    loaded = { groups: response.groups, at: Date.now() };
    return response.groups;
  });
  inFlight = request;
  const clear = () => { if (inFlight === request) inFlight = null; };
  request.then(clear, clear);
  return request;
}

export function resetWhatsAppGroupsCacheForTests(): void {
  loaded = null;
  inFlight = null;
}
