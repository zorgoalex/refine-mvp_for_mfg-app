import type { DeadlineEntityType } from '../domain/deadline-validation';

export interface DeadlinePolicyDto {
  policyId: string;
  policyCode: string;
  policyName: string;
  scopeType: DeadlineEntityType;
  targetType?: string | null;
  targetCode?: string | null;
  durationValue?: number | null;
  durationUnit?: 'minute' | 'hour' | 'day' | 'working_hour' | 'working_day' | null;
  startPoint?: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeadlinePolicyListResponseDto {
  data: DeadlinePolicyDto[];
}

export interface DeadlinePolicyResponseDto {
  policy: DeadlinePolicyDto;
}

export interface CreateDeadlinePolicyRequestDto {
  policyCode: string;
  policyName: string;
  scopeType: DeadlineEntityType;
  targetType?: string | null;
  targetCode?: string | null;
  durationValue?: number | null;
  durationUnit?: 'minute' | 'hour' | 'day' | 'working_hour' | 'working_day' | null;
  startPoint?: string | null;
  isEnabled?: boolean;
  config?: Record<string, unknown>;
}

export interface UpdateDeadlinePolicyRequestDto {
  policyName?: string;
  targetType?: string | null;
  targetCode?: string | null;
  durationValue?: number | null;
  durationUnit?: 'minute' | 'hour' | 'day' | 'working_hour' | 'working_day' | null;
  startPoint?: string | null;
  isEnabled?: boolean;
  config?: Record<string, unknown>;
}
