import type {
  CalculatedOrderDetailDto,
  NormalizedSaveOrderDetailDto,
  NormalizedSaveOrderHeaderDto,
  NormalizedSaveOrderPaymentDto,
  OrderTotalsDto,
} from '../dto/save-order.dto';
import { STANDARD_PAYMENT_STATUS_IDS } from '../dto/save-order.dto';
import { OrderFinalAmountNegativeError } from '../errors/order.errors';

const STANDARD_PAYMENT_STATUS_SET = new Set<number>([
  STANDARD_PAYMENT_STATUS_IDS.NOT_PAID,
  STANDARD_PAYMENT_STATUS_IDS.PARTIALLY_PAID,
  STANDARD_PAYMENT_STATUS_IDS.PAID,
]);

export interface CalculateOrderTotalsInput {
  header: Pick<NormalizedSaveOrderHeaderDto, 'discount' | 'surcharge' | 'paymentStatusId'>;
  details: CalculatedOrderDetailDto[];
  payments: Pick<NormalizedSaveOrderPaymentDto, 'amount' | 'paymentDate'>[];
}

export function calculateDetailArea(detail: Pick<NormalizedSaveOrderDetailDto, 'height' | 'width' | 'quantity'>): number {
  return Math.ceil((detail.height * detail.width * detail.quantity) / 10000) / 100;
}

export function calculateDetailCost(
  detail: Pick<NormalizedSaveOrderDetailDto, 'detailCost' | 'millingCostPerSqm'>,
  area: number,
): number {
  if (detail.detailCost !== null && detail.detailCost !== undefined) {
    return roundMoney(detail.detailCost);
  }

  if (detail.millingCostPerSqm !== null && detail.millingCostPerSqm !== undefined) {
    return roundMoney(area * detail.millingCostPerSqm);
  }

  return 0;
}

export function calculateOrderDetails(
  details: NormalizedSaveOrderDetailDto[],
): CalculatedOrderDetailDto[] {
  return details
    .map((detail, originalIndex) => ({ detail, originalIndex }))
    .sort((left, right) => compareDetailsForNumbering(left, right))
    .map(({ detail }, index) => {
      const area = calculateDetailArea(detail);
      const detailCost = calculateDetailCost(detail, area);

      return {
        ...detail,
        detailNumber: index + 1,
        area,
        detailCost,
      };
    });
}

export function calculateOrderTotals(input: CalculateOrderTotalsInput): OrderTotalsDto {
  const totalArea = roundMoney(input.details.reduce((sum, detail) => sum + detail.area, 0));
  const totalAmount = sumMoney(input.details.map((detail) => detail.detailCost));
  const paidAmount = sumMoney(input.payments.map((payment) => payment.amount));
  const discount = roundMoney(input.header.discount ?? 0);
  const surcharge = roundMoney(input.header.surcharge ?? 0);
  const finalAmount = roundMoney(totalAmount - discount + surcharge);

  if (finalAmount < 0) {
    throw new OrderFinalAmountNegativeError(finalAmount);
  }

  return {
    positionsCount: input.details.length,
    partsCount: input.details.reduce((sum, detail) => sum + detail.quantity, 0),
    totalArea,
    totalAmount,
    discount,
    surcharge,
    finalAmount,
    paidAmount,
    debtAmount: roundMoney(finalAmount - paidAmount),
    paymentDate: calculateLatestPaymentDate(input.payments),
    paymentStatusId: calculatePaymentStatusId(
      input.header.paymentStatusId ?? null,
      finalAmount,
      paidAmount,
    ),
  };
}

export function calculatePaymentStatusId(
  providedStatusId: number | null,
  finalAmount: number,
  paidAmount: number,
): number {
  if (providedStatusId !== null && !STANDARD_PAYMENT_STATUS_SET.has(providedStatusId)) {
    return providedStatusId;
  }

  if (paidAmount === 0) {
    return STANDARD_PAYMENT_STATUS_IDS.NOT_PAID;
  }

  if (paidAmount < finalAmount) {
    return STANDARD_PAYMENT_STATUS_IDS.PARTIALLY_PAID;
  }

  return STANDARD_PAYMENT_STATUS_IDS.PAID;
}

export function calculateLatestPaymentDate(
  payments: Pick<NormalizedSaveOrderPaymentDto, 'paymentDate'>[],
): string | null {
  if (payments.length === 0) {
    return null;
  }

  return payments
    .map((payment) => payment.paymentDate)
    .filter((paymentDate) => paymentDate.length > 0)
    .sort()
    .at(-1) ?? null;
}

export function roundMoney(value: number): number {
  return centsToMoney(moneyToCents(value));
}

export function sumMoney(values: number[]): number {
  return centsToMoney(values.reduce((sum, value) => sum + moneyToCents(value), 0));
}

function moneyToCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('Money value must be finite');
  }

  return Math.round((value + Number.EPSILON) * 100);
}

function centsToMoney(cents: number): number {
  return cents / 100;
}

function compareDetailsForNumbering(
  left: { detail: NormalizedSaveOrderDetailDto; originalIndex: number },
  right: { detail: NormalizedSaveOrderDetailDto; originalIndex: number },
): number {
  const leftNumber = left.detail.detailNumber ?? Number.MAX_SAFE_INTEGER;
  const rightNumber = right.detail.detailNumber ?? Number.MAX_SAFE_INTEGER;

  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  const leftId = left.detail.id ?? Number.MAX_SAFE_INTEGER;
  const rightId = right.detail.id ?? Number.MAX_SAFE_INTEGER;

  if (leftId !== rightId) {
    return leftId - rightId;
  }

  return left.originalIndex - right.originalIndex;
}
