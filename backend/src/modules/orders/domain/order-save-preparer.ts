import type { PreparedOrderSave, SaveOrderDto } from '../dto/save-order.dto';
import { calculateOrderDetails, calculateOrderTotals } from './order-calculations';
import { normalizeSaveOrderDto } from './order-normalizer';
import { validateSaveOrderDto, type ValidateSaveOrderOptions } from './order-validation';

export function prepareOrderSave(
  input: SaveOrderDto,
  options: ValidateSaveOrderOptions,
): PreparedOrderSave {
  const order = normalizeSaveOrderDto(input);
  validateSaveOrderDto(order, options);

  const details = calculateOrderDetails(order.details);
  const totals = calculateOrderTotals({
    header: order.header,
    details,
    payments: order.payments,
  });

  return {
    order,
    details,
    totals,
  };
}
