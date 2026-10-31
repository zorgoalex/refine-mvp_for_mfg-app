import type {
  CncTelegramBathDuplicateDto,
  CncTelegramBathReworkMarkDto,
} from '../../cnc-telegram/dto/cnc-telegram.dto';

export type MdfBathDuplicateActionDto = 'keep_both' | 'rework_mark';

export interface ResolveMdfBathDuplicateRequestDto {
  /** The bath the dialog was opened on; for `rework_mark` — the marked bath. */
  bathCardId: string;
  otherBathCardId: string;
  action: MdfBathDuplicateActionDto;
  /** `duplicates[].digest` of the board read, passed back as is. */
  expectedDigest: string;
}

export interface MdfBathDuplicateResolutionDto {
  resolutionId: number;
  action: MdfBathDuplicateActionDto;
  /** Canonical pair: bathA has the smaller cut_result_id. */
  bathA: string;
  bathB: string;
  targetBath: string;
  otherBathCardId: string;
  digest: string;
  sharedCount: number;
  orderIds: number[];
  createdAt: string;
}

/** Pair facts of explicitly requested baths (hybrid board: engine bath cards outside the legacy read). */
export interface MdfBathDuplicatesResponseDto {
  generatedAt: string;
  /** Requested baths whose orders are all visible (others omitted); an inactive bath has empty lists. */
  baths: Array<{
    bathCardId: string;
    duplicates: CncTelegramBathDuplicateDto[];
    reworkMarks: CncTelegramBathReworkMarkDto[];
    reworkDetailCount: number;
  }>;
}

export interface ResolveMdfBathDuplicateResponseDto {
  generatedAt: string;
  resolution: MdfBathDuplicateResolutionDto;
  auditId: string | null;
  /** True when the same Idempotency-Key and body were already applied: nothing new was written. */
  replayed: boolean;
}
