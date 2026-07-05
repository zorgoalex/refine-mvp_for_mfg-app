export type OrderProjectRelationType = 'main' | 'secondary' | 'reporting' | 'billing' | 'derived';

export interface OrderProjectSummaryDto {
  id: string;
  code: string;
  name: string;
  relationType: OrderProjectRelationType;
  isPrimary: boolean;
  validFrom: string;
}

export interface OrderProjectsResponseDto {
  orderId: number;
  version: number;
  primaryProject: OrderProjectSummaryDto | null;
  projects: OrderProjectSummaryDto[];
  requestId: string;
}

export interface ReplaceOrderGroupLinkDto {
  projectId: string;
  relationType: OrderProjectRelationType;
  isPrimary: boolean;
}

export interface ReplaceOrderProjectsRequestDto {
  idempotencyKey: string;
  version: number;
  primaryProjectId?: string | null;
  projects: ReplaceOrderGroupLinkDto[];
  reason?: string | null;
}

export interface ReplaceOrderProjectsResponseDto extends OrderProjectsResponseDto {
  changed: boolean;
  auditId?: string;
}
