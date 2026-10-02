import { ApiError } from '../../../common/errors/api-error';

/**
 * Kazakhstan numbers as they are stored in client_phones: `87014952060`, `8 701 495 20 60`,
 * `+7 (701) 495-20-60`, an extension or a second number after a separator (`87014952060-897`,
 * `… доб. 12`, `87014952060, 87771234567`). The main number is matched before any formatting is
 * removed, so a separator is never confused with digits of the number. Everything else is refused.
 */
const MAIN_NUMBER = /^\s*(?:\+?([78]))[\s()-]*(\d{3})[\s()-]*(\d{3})[\s-]*(\d{2})[\s-]*(\d{2})(?:\s*(?:[-,;/]|доб\.?|вн\.?)\s*.*)?\s*$/iu;

export function normalizeClientPhone(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) throw new ApiError(409, 'CLIENT_PHONE_MISSING', 'У клиента заказа нет телефона');
  const match = MAIN_NUMBER.exec(value);
  if (!match) throw new ApiError(422, 'CLIENT_PHONE_INVALID', 'Телефон клиента не удалось распознать');
  return `7${match[2]}${match[3]}${match[4]}${match[5]}`;
}

/** `77014952060` → `7701***2060`: the only form a phone ever takes in audit, logs and API views. */
export function maskPhone(normalized: string): string {
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

/** `120363338054016575@g.us` → `1203…@g.us`. */
export function maskGroup(groupChatId: string): string {
  return `${groupChatId.slice(0, 4)}…@g.us`;
}
