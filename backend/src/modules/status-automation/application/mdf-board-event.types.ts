import type { CurrentUser } from '../../../permissions/current-user';
import type { StatusAutomationEventType } from './status-automation.types';

export type MdfBoardSource = { kind: 'packet' | 'bazisCutSet' | 'bath'; id: string };
export type MdfBoardEventType = Extract<StatusAutomationEventType, `mdf.${string}`>;
export interface MdfBoardEventInput {
  source: MdfBoardSource;
  actor: CurrentUser;
  requestId: string;
  sourceIdempotencyKey: string;
}
export interface MdfBoardDetailEvidence {
  detailId: number;
  requiredQuantity: number;
  eligibleQuantity: number;
}
export interface MdfBoardDetailScope {
  source: MdfBoardSource;
  details: MdfBoardDetailEvidence[];
}
export interface MdfBoardResolvedEvent {
  eventType: MdfBoardEventType;
  orderId: number;
  scope: MdfBoardDetailScope;
}

export function isMdfBoardEvent(eventType: string): eventType is MdfBoardEventType {
  return ['mdf.order_machine_files_present', 'mdf.board.completed', 'mdf.board.baths',
    'mdf.board.baths_ready', 'mdf.board.baths_laminated'].includes(eventType);
}
