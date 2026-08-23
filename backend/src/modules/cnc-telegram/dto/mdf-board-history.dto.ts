export type MdfBoardHistorySubjectKind = 'order' | 'packet' | 'bazisCutSet' | 'bath';

export type MdfBoardHistoryColumn =
  | 'parsed'
  | 'completed'
  | 'completed_laminated'
  | 'baths'
  | 'baths_ready'
  | 'baths_laminated'
  | 'completed_baths'
  | 'orders'
  | 'orders_ready'
  | 'orders_issued';

export interface MdfBoardHistoryOrderOptionDto {
  orderId: number;
  orderName: string;
  fullNumber: string;
  deleted: boolean;
  createdAt: string;
}

export interface MdfBoardHistoryOrderOptionsResponseDto {
  data: MdfBoardHistoryOrderOptionDto[];
  generatedAt: string;
}

export interface MdfBoardHistoryCurrentCardDto {
  subjectKind: MdfBoardHistorySubjectKind;
  subjectId: string;
  existsNow: boolean;
  cardKind: 'order' | 'packet' | 'bazisCutSet' | 'bath' | null;
  cardId: string | null;
  label: string;
  currentColumn: MdfBoardHistoryColumn | null;
  automaticColumn: MdfBoardHistoryColumn | null;
  reasonUnavailable: string | null;
}

export interface MdfBoardHistoryBlockerDto {
  code: 'NO_MDF_SOURCES' | 'MACHINE_FILES_NOT_CUT' | 'BATHS_NOT_ROLLED' | 'ORDER_DELETED';
  text: string;
  count: number | null;
  relatedSubjectIds: string[];
}

export interface MdfBoardHistoryDiagnosisDto {
  presence: 'on_board' | 'not_on_board' | 'deleted';
  currentColumn: MdfBoardHistoryColumn | null;
  automaticColumn: MdfBoardHistoryColumn | null;
  manualOverride: {
    targetColumn: MdfBoardHistoryColumn;
    updatedAt: string;
    actorName: string | null;
  } | null;
  title: string;
  explanation: string;
  blockers: MdfBoardHistoryBlockerDto[];
  relatedCurrentCards: MdfBoardHistoryCurrentCardDto[];
}

export interface MdfBoardHistoryEventDto {
  eventId: string;
  occurredAt: string;
  subjectKind: MdfBoardHistorySubjectKind;
  subjectId: string;
  subjectLabel: string;
  eventKind: 'appeared' | 'moved' | 'progress' | 'disappeared' | 'not_on_board' | 'first_known';
  fromColumn: MdfBoardHistoryColumn | null;
  toColumn: MdfBoardHistoryColumn | null;
  reasonCode: string;
  reason: string;
  consequence: string;
  actor: {
    kind: 'user' | 'system';
    displayName: string;
  };
  provenance: 'recorded' | 'reconstructed' | 'net_reconstructed';
  relatedCurrentCards: MdfBoardHistoryCurrentCardDto[];
}

export interface MdfBoardHistoryEpisodeDto {
  episodeId: string;
  occurredAt: string;
  title: string;
  primaryEvent: MdfBoardHistoryEventDto;
  relatedEvents: MdfBoardHistoryEventDto[];
}

export interface MdfBoardHistoryCoverageDto {
  status: 'recorded_exact' | 'reconstructed_complete' | 'partial' | 'none';
  label: string;
  evidenceFrom: string | null;
  gaps: string[];
}

export interface MdfBoardHistoryResponseDto {
  window: {
    dateFrom: string;
    dateTo: string;
    boardDate: string;
  };
  generatedAt: string;
  order: MdfBoardHistoryOrderOptionDto;
  diagnosis: MdfBoardHistoryDiagnosisDto;
  coverage: MdfBoardHistoryCoverageDto;
  episodes: MdfBoardHistoryEpisodeDto[];
}
