export interface MergeUserRef { userId: number; username: string | null }
export interface MergeClientRef { clientId: number; name: string }

export interface MergeClientView {
  clientId: number;
  name: string;
  personType: 'individual' | 'legal';
  isActive: boolean;
  notes: string | null;
  onecLinked: boolean;
  createdAt: string;
  createdBy: MergeUserRef | null;
}

export type MergeWarningCode =
  | 'PERSON_TYPE_DIFFERS' | 'MERGED_NOTES_STAY' | 'BITRIX_CONTACT_STAYS' | 'PHONE_ONEC_KEY_LOST';

export interface MergeObstacle { code: string; message: string }

export interface MergePreview {
  caseId: number;
  caseVersion: number;
  survivor: MergeClientView;
  merged: MergeClientView;
  moves: {
    projects: number;
    orders: number;
    ordersShown: Array<{ orderId: number; name: string; deleted: boolean }>;
    ordersHidden: boolean;
    onecLink: boolean;
  };
  phones: {
    moved: Array<{ phoneId: number; number: string }>;
    dropped: Array<{ phoneId: number; number: string; sameAsPhoneId: number; onecKeyLost: boolean }>;
    primaryPhoneId: number | null;
  };
  contacts: {
    moved: Array<{ contactId: number; kind: string; value: string }>;
    /** A copy from 1C (`origin: 'onec'`) has no value: it returns by the 1C link. */
    dropped: Array<{ contactId: number; kind: string; value: string | null; origin?: 'erp' | 'onec' }>;
    /** How many copies from 1C of the merged client are dropped. */
    onecCopiesDropped?: number;
    total: number;
  };
  warnings: MergeWarningCode[];
  obstacles: MergeObstacle[];
  previewToken: string;
}

export interface MergeRequestBody { survivorId: number; mergedId: number }

export interface MergeCommandBody extends MergeRequestBody {
  expectedCaseVersion: number;
  previewToken: string;
  idempotencyKey: string;
}

export interface MergeResult {
  mergeId: number;
  caseId: number;
  survivorId: number;
  mergedId: number;
  counts: Record<string, number>;
}

export interface MergeSkipped { kind: string; rowId: number | string; reason: string }
export interface MergeUndoReport { returned: Record<string, number>; skipped: MergeSkipped[] }

export interface MergeView {
  mergeId: number;
  caseId: number;
  status: 'done' | 'undone';
  survivor: MergeClientRef;
  merged: MergeClientRef;
  mergedAt: string;
  mergedBy: MergeUserRef;
  undoUntil: string;
  undoneAt: string | null;
  undoneBy: MergeUserRef | null;
  counts: Record<string, number>;
  undoReport: MergeUndoReport | null;
  canUndo: boolean;
}

export interface ClientMergeHistory {
  clientId: number;
  mergedInto: MergeClientRef | null;
  merges: MergeView[];
}

export interface UndoPreview {
  merge: MergeView;
  returns: {
    projects: number;
    orders: number;
    ordersShown: number[];
    phones: number;
    contacts: number;
    onecLink: boolean;
  };
  skipped: MergeSkipped[];
  obstacles: MergeObstacle[];
  previewToken: string | null;
}

export interface UndoCommandBody { previewToken: string; idempotencyKey: string }

export interface UndoResult { mergeId: number; status: 'undone'; report: MergeUndoReport }
