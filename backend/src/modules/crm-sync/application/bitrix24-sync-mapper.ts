import { createHash } from 'node:crypto';
import type { ClientRow, OrderRow, PaymentRow } from './crm-sync.types';

export const BITRIX24_ENTITY_TYPE = {
  deal: 2,
  contact: 3,
  company: 4,
} as const;

export const BITRIX24_ORIGINATOR_ID = 'MEBELKZ_ERP';

export type Bitrix24CounterpartyObject = 'contact' | 'company';

export interface Bitrix24CounterpartyPayload {
  object: Bitrix24CounterpartyObject;
  entityTypeId: number;
  originId: string;
  fields: Record<string, unknown>;
}

export interface Bitrix24DealPayload {
  originId: string;
  fields: Record<string, unknown>;
  productRows: Array<Record<string, unknown>>;
}

export interface Bitrix24PaymentPayload {
  xmlId: string;
  fields: Record<string, unknown>;
}

export interface Bitrix24MapperOptions {
  erpBaseUrl: string;
  currencyId: string;
  assignedById: number | null;
  paySystemId: number;
}

export function clientOriginId(clientId: string): string {
  return `CLIENT_${clientId}`;
}

export function orderOriginId(orderId: string): string {
  return `ORDER_${orderId}`;
}

export function paymentXmlId(paymentId: string): string {
  return `MEBELKZ_ERP_PAYMENT_${paymentId}`;
}

export function mapClient(
  client: ClientRow,
  assignedById: number | null,
): Bitrix24CounterpartyPayload {
  const isCompany = client.personType === 'legal';
  const comments = [
    client.notes?.trim() || null,
    client.isActive ? null : 'Статус ERP: неактивен',
    `ERP ID клиента: ${client.clientId}`,
  ].filter(Boolean).join('\n');
  const fields: Record<string, unknown> = {
    ...(isCompany ? { title: client.clientName } : { name: client.clientName }),
    comments,
    opened: 'Y',
    originatorId: BITRIX24_ORIGINATOR_ID,
    originId: clientOriginId(client.clientId),
    fm: client.phones.map((phone) => ({
      typeId: 'PHONE',
      valueType: phoneTypeForBitrix(phone.phoneType),
      value: phone.phoneNumber,
    })),
  };
  if (assignedById !== null) fields.assignedById = assignedById;

  return {
    object: isCompany ? 'company' : 'contact',
    entityTypeId: isCompany ? BITRIX24_ENTITY_TYPE.company : BITRIX24_ENTITY_TYPE.contact,
    originId: clientOriginId(client.clientId),
    fields,
  };
}

export function mapOrder(
  order: OrderRow,
  counterparty: { object: Bitrix24CounterpartyObject; id: string },
  options: Bitrix24MapperOptions,
): Bitrix24DealPayload {
  const erpUrl = `${options.erpBaseUrl.replace(/\/+$/, '')}/orders/show/${order.orderId}`;
  const finalAmount = order.finalAmount ?? order.totalAmount ?? 0;
  const comments = [
    `ERP: ${erpUrl}`,
    `ERP ID заказа: ${order.orderId}`,
    order.orderStatusName ? `Статус заказа: ${order.orderStatusName}` : null,
    order.paymentStatusName ? `Статус оплаты: ${order.paymentStatusName}` : null,
    `Оплачено: ${order.paidAmount ?? 0} ${options.currencyId}`,
  ].filter(Boolean).join('\n');
  const fields: Record<string, unknown> = {
    title: `Заказ ${order.orderName}`,
    opportunity: finalAmount,
    isManualOpportunity: 'Y',
    currencyId: options.currencyId,
    comments,
    additionalInfo: erpUrl,
    originatorId: BITRIX24_ORIGINATOR_ID,
    originId: orderOriginId(order.orderId),
    ...(order.orderDate ? { begindate: order.orderDate } : {}),
    ...(order.completionDate ? { closedate: order.completionDate } : {}),
    ...(counterparty.object === 'company'
      ? { companyId: Number(counterparty.id), contactId: null }
      : { contactId: Number(counterparty.id), companyId: null }),
  };
  if (options.assignedById !== null) fields.assignedById = options.assignedById;

  return {
    originId: orderOriginId(order.orderId),
    fields,
    productRows: [
      {
        productName: `Заказ ERP №${order.orderNumber}: ${order.orderName}`,
        price: finalAmount,
        quantity: 1,
        taxIncluded: 'N',
        sort: 10,
      },
    ],
  };
}

export function mapPayment(
  payment: PaymentRow,
  options: Bitrix24MapperOptions,
): Bitrix24PaymentPayload {
  const datePaid = `${payment.paymentDate}T12:00:00`;
  const comments = [
    `Платёж ERP #${payment.paymentId}`,
    payment.typePaidName ? `Способ: ${payment.typePaidName}` : null,
    payment.notes?.trim() || null,
  ].filter(Boolean).join('\n');

  return {
    xmlId: paymentXmlId(payment.paymentId),
    fields: {
      paySystemId: options.paySystemId,
      paid: 'Y',
      datePaid,
      psStatus: 'Y',
      psSum: payment.amount,
      psCurrency: options.currencyId,
      xmlId: paymentXmlId(payment.paymentId),
      sum: payment.amount,
      comments,
      updated1c: 'N',
      externalPayment: 'N',
    },
  };
}

function phoneTypeForBitrix(type: ClientRow['phones'][number]['phoneType']): string {
  if (type === 'work') return 'WORK';
  if (type === 'home') return 'HOME';
  if (type === 'fax') return 'FAX';
  return 'MOBILE';
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortedKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function hash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortedKeys(payload))).digest('hex');
}
