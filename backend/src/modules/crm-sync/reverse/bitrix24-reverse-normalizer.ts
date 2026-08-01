import { hash } from '../application/bitrix24-sync-mapper';
import type {
  ReverseClientSnapshot,
  ReverseDealSnapshot,
  ReversePaymentSnapshot,
} from './pg-bitrix24-reverse-repository';

export function normalizeBitrixClient(
  objectType: 'contact' | 'company',
  bitrixId: string,
  item: Record<string, unknown>,
): ReverseClientSnapshot {
  const name = objectType === 'company'
    ? cleanText(item.title) ?? `Компания Bitrix #${bitrixId}`
    : contactName(item) ?? `Контакт Bitrix #${bitrixId}`;
  const phones = normalizePhones(item.fm);
  const originErpId = parseOriginId(item, 'CLIENT');
  const rawSnapshot = selectClientSnapshot(item, objectType, name, phones);
  return {
    objectType,
    bitrixId,
    name,
    notes: cleanText(item.comments),
    phones,
    originErpId,
    normalizedHash: hash(rawSnapshot),
    bitrixCreatedAt: dateTime(item.createdTime),
    bitrixUpdatedAt: dateTime(item.updatedTime),
    rawSnapshot,
  };
}

export function normalizeBitrixDeal(
  bitrixId: string,
  item: Record<string, unknown>,
  input: {
    clientId: number | null;
    portalDomain: string;
    portalTimezone: string;
    counterparty: { objectType: 'contact' | 'company'; bitrixId: string } | null;
  },
): ReverseDealSnapshot {
  const fullTitle = cleanText(item.title) ?? `Заявка Bitrix #${bitrixId}`;
  const updatedAt = dateTime(item.updatedTime);
  const createdAt = dateTime(item.createdTime);
  const rawSnapshot = {
    title: cleanText(item.title),
    opportunity: finiteNumber(item.opportunity),
    currencyId: cleanText(item.currencyId),
    stageId: cleanText(item.stageId),
    assignedById: positiveId(item.assignedById),
    begindate: dateOnly(item.begindate),
    closedate: dateOnly(item.closedate),
    comments: cleanText(item.comments),
    companyId: positiveId(item.companyId),
    contactId: positiveId(item.contactId),
    originatorId: cleanText(item.originatorId),
    originId: cleanText(item.originId),
    createdTime: isoDateTime(item.createdTime),
    updatedTime: isoDateTime(item.updatedTime),
  };
  return {
    bitrixId,
    title: normalizeOrderTitle(fullTitle, bitrixId),
    fullTitle,
    clientId: input.clientId,
    counterpartyObjectType: input.counterparty?.objectType ?? null,
    counterpartyBitrixId: input.counterparty?.bitrixId ?? null,
    originErpOrderId: parseOriginId(item, 'ORDER'),
    crmAmount: finiteNumber(item.opportunity),
    currencyId: cleanText(item.currencyId),
    stageId: cleanText(item.stageId),
    assignedById: positiveId(item.assignedById),
    beginDate: dateOnly(item.begindate) ?? dateInTimezone(createdAt, input.portalTimezone),
    closeDate: dateOnly(item.closedate),
    comments: cleanText(item.comments),
    bitrixUrl: `https://${input.portalDomain}/crm/deal/details/${bitrixId}/`,
    normalizedHash: hash(rawSnapshot),
    remoteRevision: `${(updatedAt ?? createdAt)?.toISOString() ?? 'unknown'}:${hash(rawSnapshot)}`,
    bitrixCreatedAt: createdAt,
    bitrixUpdatedAt: updatedAt,
    rawSnapshot,
  };
}

function normalizeOrderTitle(value: string, bitrixId: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return (normalized || `Заявка Bitrix #${bitrixId}`).slice(0, 200);
}

function dateInTimezone(value: Date | null, timezone: string): string | null {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function normalizeBitrixPayment(
  bitrixPaymentId: string,
  payment: Record<string, unknown>,
): ReversePaymentSnapshot {
  const rawSnapshot = {
    id: bitrixPaymentId,
    paySystemId: positiveNumber(payment.paySystemId),
    paySystemName: cleanText(payment.paySystemName),
    sum: finiteNumber(payment.sum) ?? 0,
    currency: cleanText(payment.currency),
    paid: String(payment.paid ?? '').toUpperCase() === 'Y',
    datePaid: isoDateTime(payment.datePaid),
    dateBill: isoDateTime(payment.dateBill),
    xmlId: cleanText(payment.xmlId),
  };
  return {
    bitrixPaymentId,
    paySystemId: positiveNumber(payment.paySystemId),
    paySystemName: cleanText(payment.paySystemName),
    amount: finiteNumber(payment.sum) ?? 0,
    currencyId: cleanText(payment.currency),
    paid: String(payment.paid ?? '').toUpperCase() === 'Y',
    paymentDate: dateTime(payment.datePaid) ?? dateTime(payment.dateBill),
    normalizedHash: hash(rawSnapshot),
    bitrixCreatedAt: dateTime(payment.dateBill),
    bitrixUpdatedAt: dateTime(payment.datePaid) ?? dateTime(payment.dateBill),
  };
}

export function bitrixCounterparty(
  item: Record<string, unknown>,
): { objectType: 'contact' | 'company'; bitrixId: string } | null {
  const companyId = positiveId(item.companyId);
  if (companyId) return { objectType: 'company', bitrixId: companyId };
  const contactId = positiveId(item.contactId);
  if (contactId) return { objectType: 'contact', bitrixId: contactId };
  if (Array.isArray(item.contactIds)) {
    for (const value of item.contactIds) {
      const id = positiveId(value);
      if (id) return { objectType: 'contact', bitrixId: id };
    }
  }
  return null;
}

export function paymentIsErpOrigin(payment: Record<string, unknown>): boolean {
  return /^MEBELKZ_ERP_PAYMENT_[1-9][0-9]*$/.test(cleanText(payment.xmlId) ?? '');
}

function selectClientSnapshot(
  item: Record<string, unknown>,
  objectType: 'contact' | 'company',
  name: string,
  phones: ReverseClientSnapshot['phones'],
): Record<string, unknown> {
  return {
    objectType,
    name,
    comments: cleanText(item.comments),
    phones,
    originatorId: cleanText(item.originatorId),
    originId: cleanText(item.originId),
    createdTime: isoDateTime(item.createdTime),
    updatedTime: isoDateTime(item.updatedTime),
  };
}

function normalizePhones(value: unknown): ReverseClientSnapshot['phones'] {
  const rows = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? Object.values(value as Record<string, unknown>)
      : [];
  const seen = new Set<string>();
  const phones: ReverseClientSnapshot['phones'] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const phone = row as Record<string, unknown>;
    if (String(phone.typeId ?? '').toUpperCase() !== 'PHONE') continue;
    const phoneNumber = cleanText(phone.value);
    if (!phoneNumber || seen.has(phoneNumber)) continue;
    seen.add(phoneNumber);
    phones.push({
      phoneNumber,
      phoneType: phoneType(phone.valueType),
      isPrimary: phones.length === 0,
    });
  }
  return phones;
}

function contactName(item: Record<string, unknown>): string | null {
  const parts = [item.name, item.secondName, item.lastName]
    .map(cleanText)
    .filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(' ') : null;
}

function parseOriginId(
  item: Record<string, unknown>,
  prefix: 'CLIENT' | 'ORDER',
): string | null {
  if (cleanText(item.originatorId) !== 'MEBELKZ_ERP') return null;
  const value = cleanText(item.originId);
  const match = value?.match(new RegExp(`^${prefix}_([1-9][0-9]*)$`));
  return match?.[1] ?? null;
}

function phoneType(value: unknown): 'mobile' | 'work' | 'home' | 'fax' {
  const type = String(value ?? '').toUpperCase();
  if (type === 'WORK') return 'work';
  if (type === 'HOME') return 'home';
  if (type === 'FAX') return 'fax';
  return 'mobile';
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, 10000) : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 && Number.isInteger(parsed) ? parsed : null;
}

function positiveId(value: unknown): string | null {
  const text = String(value ?? '');
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function isoDateTime(value: unknown): string | null {
  return dateTime(value)?.toISOString() ?? null;
}

function dateTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
