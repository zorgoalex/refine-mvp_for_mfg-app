export interface DeadlineDefaultScheduleStageDto {
  productionStatusId: number;
  productionStatusName: string;
  productionStatusCode: string | null;
  sortOrder: number;
  durationDays: number | null;
  parallelWithPrevious: boolean;
  cumulativeDeadlineDays: number | null;
}

export interface DeadlineDefaultScheduleDto {
  configured: boolean;
  hasStoredConfiguration: boolean;
  version: number;
  reserveDays: number;
  /**
   * Saved order-status graph from production.workflow.default.
   * Stage layout/order is intentionally not used for deadline calculations.
   */
  transitionsOrder: Record<string, string[]>;
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
    parallelWithPrevious: boolean;
  }>;
}

export interface DeadlineDefaultScheduleResponseDto {
  schedule: DeadlineDefaultScheduleDto;
}
