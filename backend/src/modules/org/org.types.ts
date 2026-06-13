export interface DirectionSummaryDto {
  directionId: number;
  directionName: string;
  description: string | null;
  isActive: boolean;
  workshopCount: number;
  workCenterCount: number;
  headCount: number;
}

export interface HeadDto {
  userId: number;
  displayName: string | null;
  isActive: boolean;
}

export interface DirectionDetailDto {
  directionId: number;
  directionName: string;
  description: string | null;
  isActive: boolean;
  workshops: Array<{ workshopId: number; name: string }>;
  workCenters: Array<{ workcenterId: number; workshopId: number; name: string }>;
  heads: HeadDto[];
}

export interface CreateDirectionRequestDto {
  name: string;
  description?: string | null;
  isActive?: boolean;
}

export interface UpdateDirectionRequestDto {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

export interface ReplaceIdSetRequestDto {
  idempotencyKey: string;
  ids: number[];
  reason?: string | null;
}
