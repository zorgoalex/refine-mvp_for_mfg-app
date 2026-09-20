import type { MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';

/** Internal command intent, never accepted production evidence. */
export type MdfShadowCommand = { auditId: string } & (
  | { kind: 'manual_move'; targetColumn: string }
  | { kind: 'manual_clear'; targetColumn: null }
  | { kind: 'production_return'; targetColumn: string; targetStageId: number;
      targetStageCode: string; previewDigest: string }
);

export function normalizeMdfShadowCommand(source: MdfBoardSource, command: MdfShadowCommand) {
  const columns = source.kind === 'bath'
    ? ['baths', 'baths_ready', 'baths_laminated', 'completed_baths']
    : ['parsed', 'completed', 'completed_laminated'];
  const returned = command.kind === 'production_return';
  if (!['packet', 'bazisCutSet', 'bath'].includes(source.kind)
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(command.auditId)
    || !['manual_move', 'manual_clear', 'production_return'].includes(command.kind)
    || (command.kind === 'manual_clear' ? command.targetColumn !== null : !columns.includes(command.targetColumn))
    || (returned && (!Number.isSafeInteger(command.targetStageId) || command.targetStageId <= 0
      || typeof command.targetStageCode !== 'string' || !command.targetStageCode.trim()
      || command.targetStageCode.length > 240 || command.targetStageCode.includes('\0')
      || !/^[a-f0-9]{64}$/.test(command.previewDigest)
      || ['completed_baths', 'completed_laminated'].includes(command.targetColumn)))) {
    throw new Error('MDF_SHADOW_COMMAND_INVALID');
  }
  // Canonical envelope: stable property order, no untrusted extra properties.
  return { kind: command.kind, targetColumn: command.targetColumn, auditId: command.auditId.toLowerCase(),
    targetStageId: returned ? command.targetStageId : null,
    targetStageCode: returned ? command.targetStageCode : null,
    previewDigest: returned ? command.previewDigest : null };
}
