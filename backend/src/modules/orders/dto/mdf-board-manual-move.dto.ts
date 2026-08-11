export type MdfBoardManualCardKind = 'packet' | 'bazisCutSet' | 'bath' | 'order';

export type MdfBoardManualTargetColumn =
  | 'parsed'
  | 'completed'
  | 'completed_laminated'
  | 'baths'
  | 'baths_ready'
  | 'baths_laminated'
  | 'orders'
  | 'orders_ready'
  | 'orders_issued';

export interface MdfBoardManualMoveDto {
  cardKind: MdfBoardManualCardKind;
  cardId: string;
  targetColumn: MdfBoardManualTargetColumn;
  version: number;
  createdAt: string;
  createdByUserId: number | null;
  updatedAt: string;
  updatedByUserId: number | null;
}

export interface MdfBoardManualMovesResponseDto {
  generatedAt: string;
  moves: MdfBoardManualMoveDto[];
}

export interface MdfBoardManualMoveUpsertResponseDto {
  generatedAt: string;
  changed: boolean;
  move: MdfBoardManualMoveDto;
  auditId?: string;
}

export interface MdfBoardManualMoveDeleteResponseDto {
  generatedAt: string;
  cardKind: MdfBoardManualCardKind;
  cardId: string;
  deleted: boolean;
  auditId?: string;
}
