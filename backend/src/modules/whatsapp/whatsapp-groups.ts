import { ApiError } from "../../common/errors/api-error";

/**
 * Groups of the linked WhatsApp account, reduced to an explicit allowlist.
 *
 * WAHA returns engine-specific group objects. The GOWS shape (production) also
 * carries owner/creator phone numbers (OwnerJID, OwnerPN, NameSetByPN, ...) and
 * the group topic; none of that may leave the backend, so every field is copied
 * explicitly instead of spreading the provider object.
 */
export interface WhatsAppGroup {
  id: string;
  name: string;
  participantCount: number | null;
  /** Only admins may post; sending succeeds only if the linked account is an admin. */
  announceOnly: boolean;
  /** Community parent group: it does not accept regular messages. */
  communityParent: boolean;
  suspended: boolean;
}

export interface WhatsAppGroupList {
  groups: WhatsAppGroup[];
  truncated: boolean;
}

export interface WhatsAppGroupsResponse extends WhatsAppGroupList {
  fetchedAt: string;
  /** True when served from the short in-process cache instead of a new WAHA call. */
  cached: boolean;
}

/** Same group JID rule as the daily digest settings DTO. */
export const WHATSAPP_GROUP_ID_PATTERN = /^\d{5,24}(?:-\d{5,24})?@g\.us$/;
export const WHATSAPP_GROUPS_MAX = 1000;
const NAME_MAX_LENGTH = 200;

/**
 * Throws WAHA_GROUPS_RESPONSE_INVALID for anything that is not a recognizable group
 * list, so a broken or unsupported provider answer never looks like "no groups".
 */
export function normalizeWahaGroups(value: unknown): WhatsAppGroupList {
  const entries = groupEntries(value);
  const seen = new Set<string>();
  const groups: WhatsAppGroup[] = [];
  for (const [key, item] of entries) {
    const group = normalizeGroup(item, key);
    if (!group || seen.has(group.id)) continue;
    seen.add(group.id);
    groups.push(group);
  }
  if (entries.length > 0 && groups.length === 0) throw invalidGroupsResponse();
  groups.sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" }) || a.id.localeCompare(b.id));
  return {
    groups: groups.slice(0, WHATSAPP_GROUPS_MAX),
    truncated: groups.length > WHATSAPP_GROUPS_MAX,
  };
}

function groupEntries(value: unknown): Array<[string | undefined, unknown]> {
  if (Array.isArray(value)) return value.map((item) => [undefined, item]);
  // NOWEB returns a map keyed by group JID; an object with other keys (including the
  // `{}` fallback for an unparsable body) is an error, not an empty list.
  const record = asRecord(value);
  const keys = record ? Object.keys(record) : [];
  if (!record || keys.length === 0 || !keys.every((key) => WHATSAPP_GROUP_ID_PATTERN.test(key)))
    throw invalidGroupsResponse();
  return Object.entries(record);
}

function invalidGroupsResponse(): ApiError {
  return new ApiError(502, "WAHA_GROUPS_RESPONSE_INVALID", "WAHA returned an invalid group list");
}

function normalizeGroup(item: unknown, key: string | undefined): WhatsAppGroup | null {
  const record = asRecord(item);
  if (!record) return null;
  const id = firstString(
    record.JID,
    asRecord(record.id)?._serialized,
    record.id,
    key,
  );
  if (!id || !WHATSAPP_GROUP_ID_PATTERN.test(id)) return null;
  return {
    id,
    name: cleanName(firstString(record.Name, asRecord(record.GroupName)?.Name, record.subject, record.name) ?? ""),
    participantCount: participantCount(record),
    announceOnly: record.IsAnnounce === true || record.announce === true,
    communityParent: record.IsParent === true,
    suspended: record.Suspended === true,
  };
}

function participantCount(record: Record<string, unknown>): number | null {
  for (const value of [record.ParticipantCount, record.size]) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function cleanName(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, NAME_MAX_LENGTH);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseGroupsRefresh(value: unknown): boolean {
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new ApiError(422, "WHATSAPP_GROUPS_QUERY_INVALID", "refresh must be true or false");
}
