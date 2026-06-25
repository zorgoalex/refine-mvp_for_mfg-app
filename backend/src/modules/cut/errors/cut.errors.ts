import { ApiError } from '../../../common/errors/api-error';

export class CutJobNotFoundError extends ApiError {
  constructor(cutJobId: number) {
    super(404, 'CUT_JOB_NOT_FOUND', 'Cut job not found', { cutJobId });
  }
}

export class CutJobItemNotFoundError extends ApiError {
  constructor(cutJobItemId: number) {
    super(404, 'CUT_JOB_ITEM_NOT_FOUND', 'Cut job item not found', { cutJobItemId });
  }
}

export class CutConfigRowNotFoundError extends ApiError {
  constructor(table: string, id: string | number) {
    super(404, 'CUT_CONFIG_NOT_FOUND', 'Cut config row not found', { table, id });
  }
}

/** A detail cannot be reserved because it is not eligible (server-side check). */
export class CutDetailNotEligibleError extends ApiError {
  constructor(detailId: number, reason: string) {
    super(422, 'CUT_DETAIL_NOT_ELIGIBLE', 'Деталь не готова к раскрою', { detailId, reason });
  }
}

export class CutOrderDetailNotFoundError extends ApiError {
  constructor(orderDetailId: number) {
    super(404, 'ORDER_DETAIL_NOT_FOUND', 'Order detail not found', { orderDetailId });
  }
}

/** Optimistic-concurrency guard (plan §8 — stale version on a mutating op). */
export class CutStaleVersionError extends ApiError {
  constructor(cutJobId: number, expected: number, actual: number) {
    super(409, 'CUT_STALE_VERSION', 'Раскрой изменился в другой вкладке или сессии — обновите страницу и повторите.', {
      cutJobId,
      expectedVersion: expected,
      actualVersion: actual,
    });
  }
}

/** Reservation guard (plan §5 — partial unique index 23505 surfaced as 409). */
export class CutDetailAlreadyReservedError extends ApiError {
  constructor(orderDetailId: number) {
    super(409, 'CUT_DETAIL_ALREADY_RESERVED', 'Деталь уже зарезервирована в активном раскрое', {
      orderDetailId,
    });
  }
}

/** A cut job is only mutable while reservation is active (draft/calculating/ready). */
export class CutJobNotMutableError extends ApiError {
  constructor(cutJobId: number, status: string) {
    super(409, 'CUT_JOB_NOT_MUTABLE', 'Раскрой нельзя изменить в текущем статусе', {
      cutJobId,
      status,
    });
  }
}

export class CutNoItemsError extends ApiError {
  constructor(cutJobId: number) {
    super(422, 'CUT_NO_ITEMS', 'В раскрое нет активных деталей для расчёта', { cutJobId });
  }
}

/** A group cannot be cut because its material has no sheet spec (size). Distinct
 *  from CUT_NO_ITEMS so the persisted/durable reason names the real cause. */
export class CutNoSheetSpecError extends ApiError {
  constructor(cutJobId: number) {
    super(422, 'CUT_NO_SHEET_SPEC', 'У материала детали нет раскройной спецификации (размеров листа)', { cutJobId });
  }
}

export class CutGroupSheetNotFoundError extends ApiError {
  constructor(cutGroupId: number, sheetIndex: number) {
    super(404, 'CUT_GROUP_SHEET_NOT_FOUND', 'Cut group sheet not found', {
      cutGroupId,
      sheetIndex,
    });
  }
}

export class CutParamProfileNotFoundError extends ApiError {
  constructor(profileId: number) {
    super(422, 'CUT_PARAM_PROFILE_NOT_FOUND', 'Выбранный профиль раскроя не найден или неактивен', { profileId });
  }
}

export class CutSheetMaterialNotCuttableError extends ApiError {
  constructor(sheetMaterialTypeId: number) {
    super(422, 'CUT_SHEET_MATERIAL_NOT_CUTTABLE', 'Выбранный лист не найден, неактивен или не пригоден для раскроя', {
      sheetMaterialTypeId,
    });
  }
}
