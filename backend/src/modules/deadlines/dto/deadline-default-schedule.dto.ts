export interface DeadlineDefaultScheduleStageDto {
  productionStatusId: number;
  productionStatusName: string;
  productionStatusCode: string | null;
  sortOrder: number;
  durationDays: number | null;
  cumulativeDeadlineDays: number | null;
}

export interface DeadlineDefaultScheduleDto {
  configured: boolean;
  hasStoredConfiguration: boolean;
  version: number;
  reserveDays: number;
  totalProductionDays: number | null;
  plannedOrderDays: number | null;
  updatedAt: string | null;
  stages: DeadlineDefaultScheduleStageDto[];
}

export interface ReplaceDeadlineDefaultScheduleRequestDto {
  expectedVersion: number;
  reserveDays: number;
  reason: string;
  stages: Array<{
    productionStatusId: number;
    durationDays: number;
  }>;
}

export interface DeadlineDefaultScheduleResponseDto {
  schedule: DeadlineDefaultScheduleDto;
}
