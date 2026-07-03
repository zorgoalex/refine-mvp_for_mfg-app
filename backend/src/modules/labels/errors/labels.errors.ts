import { ApiError } from '../../../common/errors/api-error';

export class LabelTemplateNotFoundError extends ApiError {
  constructor(id: number) {
    super(404, 'LABEL_TEMPLATE_NOT_FOUND', 'Label template not found', { id });
  }
}

export class LabelTemplateStaleVersionError extends ApiError {
  constructor(expectedVersion: number, currentVersion: number) {
    super(409, 'LABEL_TEMPLATE_VERSION_STALE', 'Label template version is stale', {
      expectedVersion,
      currentVersion,
    });
  }
}

export class LabelFieldBindingError extends ApiError {
  constructor(fieldBinding: string) {
    super(422, 'LABEL_FIELD_BINDING_INVALID', 'Label field binding is not supported', { fieldBinding });
  }
}

export class OrderLabelDataNotFoundError extends ApiError {
  constructor(orderId: number) {
    super(404, 'ORDER_LABEL_DATA_NOT_FOUND', 'Order label data not found', { orderId });
  }
}

export class OrderLabelDetailNotFoundError extends ApiError {
  constructor(orderId: number, detailIds: number[]) {
    super(422, 'ORDER_LABEL_DETAIL_INVALID', 'One or more details do not belong to the order', {
      orderId,
      detailIds,
    });
  }
}

export class OrderLabelDataStaleVersionError extends ApiError {
  constructor(detailId: number, expectedVersion: number | null, currentVersion: number | null) {
    super(409, 'ORDER_LABEL_DATA_VERSION_STALE', 'Order label data version is stale', {
      detailId,
      expectedVersion,
      currentVersion,
    });
  }
}

export class LabelCustomFieldSchemaStaleError extends ApiError {
  constructor(detailId: number, fieldIds: string[]) {
    super(409, 'LABEL_CUSTOM_FIELD_SCHEMA_STALE', 'Label custom field schema is stale', {
      detailId,
      fieldIds,
    });
  }
}

export class LabelQrTemplateNotFoundError extends ApiError {
  constructor(id: number) {
    super(404, 'LABEL_QR_TEMPLATE_NOT_FOUND', 'QR template not found', { id });
  }
}

export class LabelQrTemplateStaleVersionError extends ApiError {
  constructor(expectedVersion: number, currentVersion: number) {
    super(409, 'LABEL_QR_TEMPLATE_VERSION_STALE', 'QR template version is stale', {
      expectedVersion,
      currentVersion,
    });
  }
}
