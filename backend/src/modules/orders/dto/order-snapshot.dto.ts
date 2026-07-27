import type { SaveOrderDto } from './save-order.dto';

export const ORDER_SNAPSHOT_SCHEMA = 'erp.order.snapshot.v1' as const;
export const ORDER_SNAPSHOT_FORMAT_VERSION = '1.0.0' as const;
export const ORDER_SNAPSHOT_SERVICE_NAME = 'erp-order-snapshot' as const;
export const ORDER_SNAPSHOT_SERVICE_VERSION = '1.0.0' as const;
export const ORDER_SNAPSHOT_SUPPORTED_IMPORT_VERSIONS = [
  ORDER_SNAPSHOT_FORMAT_VERSION,
] as const;

export interface OrderSnapshotDto {
  schema: typeof ORDER_SNAPSHOT_SCHEMA;
  formatVersion: typeof ORDER_SNAPSHOT_FORMAT_VERSION;
  exporterService: {
    name: typeof ORDER_SNAPSHOT_SERVICE_NAME;
    version: typeof ORDER_SNAPSHOT_SERVICE_VERSION | string;
    compatibleImportVersions: string[];
  };
  source: {
    sourceInstanceId: string;
    exportedAt: string;
    payloadHash: string;
  };
  identity: {
    order: SnapshotIdentity;
    client: SnapshotIdentity;
  };
  data: {
    client: ClientSnapshotDto;
    clientPhones: ClientPhoneSnapshotDto[];
    order: OrderSnapshotHeaderDto;
    details: OrderSnapshotDetailDto[];
    payments: OrderSnapshotPaymentDto[];
    workshops: OrderSnapshotWorkshopDto[];
    requirements: OrderSnapshotRequirementDto[];
    dowelingOrders: DowelingOrderSnapshotDto[];
    dowelingLinks: OrderSnapshotDowelingLinkDto[];
    productionStatusEvents: ProductionStatusEventSnapshotDto[];
    deadlineInstances: Record<string, unknown>[];
    deadlineEvents: Record<string, unknown>[];
  };
  references: Record<string, unknown[]>;
}

export interface SnapshotIdentity {
  sourceId: string;
  refKey1c: string | null;
}

export interface ClientSnapshotDto {
  sourceId: string;
  clientName: string;
  refKey1c: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface ClientPhoneSnapshotDto {
  sourceId: string;
  phoneNumber: string;
  phoneType: 'mobile' | 'work' | 'home' | 'fax';
  isPrimary: boolean;
  refKey1c: string | null;
}

export type OrderSnapshotHeaderDto = SaveOrderDto['header'] & {
  sourceId: string;
};

export type OrderSnapshotDetailDto = SaveOrderDto['details'][number] & {
  sourceId: string;
};

export type OrderSnapshotPaymentDto = SaveOrderDto['payments'][number] & {
  sourceId: string;
};

export type OrderSnapshotWorkshopDto = SaveOrderDto['workshops'][number] & {
  sourceId: string;
};

export type OrderSnapshotRequirementDto = SaveOrderDto['requirements'][number] & {
  sourceId: string;
};

export interface DowelingOrderSnapshotDto {
  sourceId: string;
  dowelingOrderName: string;
  dowelingOrderDate: string;
  orderSourceId: string | null;
  paymentStatusId: number;
  productionStatusId: number | null;
  issueDate: string | null;
  totalAmount: number | null;
  finalAmount: number | null;
  discount: number;
  surcharge: number;
  paidAmount: number;
  paymentDate: string | null;
  partsCount: number;
  linkCadFile: string | null;
  linkPdfFile: string | null;
  refKey1c: string | null;
  designEngineerId: number | null;
  operatorId: number | null;
}

export type OrderSnapshotDowelingLinkDto = SaveOrderDto['dowelingLinks'][number] & {
  sourceId: string;
  dowelingOrderSourceId: string;
};

export interface ProductionStatusEventSnapshotDto {
  sourceId: string;
  targetType: 'order' | 'detail';
  targetSourceId: string;
  productionStatusId: number;
  eventAt: string;
  eventBy: number | null;
  note: string | null;
  payload: Record<string, unknown>;
}

export interface ImportOrderSnapshotRequestDto {
  snapshot?: OrderSnapshotDto;
}

export interface ImportOrderSnapshotResponseDto {
  success: true;
  status: 'created' | 'updated' | 'noop';
  orderId: number;
  orderName: string;
  payloadHash: string;
  importRunId: string | null;
  summary: {
    details: number;
    payments: number;
    workshops: number;
    requirements: number;
    dowelingLinks: number;
    productionStatusEvents: number;
    clientPhones: number;
    deadlineInstances: number;
    deadlineEvents: number;
  };
}

export interface ImportOrderSnapshotBatchRequestDto {
  fileName?: string;
  zipBase64: string;
}

export interface ImportOrderSnapshotBatchResponseDto {
  success: true;
  total: number;
  imported: number;
  failed: number;
  results: Array<
    | ({ fileName: string } & ImportOrderSnapshotResponseDto)
    | { fileName: string; success: false; errorCode: string; message: string; details?: Record<string, unknown> }
  >;
}
