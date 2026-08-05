import { ApiError } from '../../../common/errors/api-error';
import type { OrderRealtimeCursor } from './order-realtime.types';

const CURSOR_PATTERN = /^v1;s=(0|[1-9]\d*)(?:;c=(0|[1-9]\d*))?$/;

export function formatOrderRealtimeCursor(cursor: OrderRealtimeCursor): string {
  const status = assertRevision(cursor.detailStatusRevision);
  const cut = cursor.cutRefsRevision;
  return cut === undefined
    ? `v1;s=${status}`
    : `v1;s=${status};c=${assertRevision(cut)}`;
}

export function parseOrderRealtimeCursor(
  value: string | undefined,
  options: { cutRefsAllowed: boolean },
): OrderRealtimeCursor | null {
  if (value === undefined || value.trim() === '') return null;

  const match = CURSOR_PATTERN.exec(value.trim());
  if (!match) throw malformedCursor();

  const detailStatusRevision = parseRevision(match[1]);
  const cutComponent = match[2];
  if (options.cutRefsAllowed && cutComponent === undefined) throw malformedCursor();
  if (!options.cutRefsAllowed && cutComponent !== undefined) throw malformedCursor();

  return {
    schemaVersion: 1,
    detailStatusRevision,
    ...(cutComponent === undefined ? {} : { cutRefsRevision: parseRevision(cutComponent) }),
  };
}

function parseRevision(value: string): number {
  const revision = Number(value);
  return assertRevision(revision);
}

function assertRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw malformedCursor();
  return value;
}

function malformedCursor(): ApiError {
  return new ApiError(422, 'ORDER_REALTIME_CURSOR_MALFORMED', 'Realtime cursor is malformed');
}
