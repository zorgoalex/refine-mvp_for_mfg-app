export type OrderGroupRelationType = 'main' | 'secondary' | 'reporting' | 'billing' | 'derived';

export interface OrderGroupSummaryDto {
  id: string;
  code: string;
  name: string;
  relationType: OrderGroupRelationType;
  isPrimary: boolean;
  validFrom: string;
}

export interface OrderGroupsResponseDto {
  orderId: number;
  version: number;
  primaryGroup: OrderGroupSummaryDto | null;
  groups: OrderGroupSummaryDto[];
  requestId: string;
}

export interface ReplaceOrderGroupLinkDto {
  groupId: string;
  relationType: OrderGroupRelationType;
  isPrimary: boolean;
}

export interface ReplaceOrderGroupsRequestDto {
  idempotencyKey: string;
  version: number;
  primaryGroupId?: string | null;
  groups: ReplaceOrderGroupLinkDto[];
  reason?: string | null;
}

export interface ReplaceOrderGroupsResponseDto extends OrderGroupsResponseDto {
  changed: boolean;
  auditId?: string;
}
