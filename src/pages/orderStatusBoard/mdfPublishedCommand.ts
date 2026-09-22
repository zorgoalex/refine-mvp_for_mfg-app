import { authSession } from '../../api/authSession';
import { assertMdfSession } from '../../api/mdfPublishedApi';
import { orderStatusBoardApi } from '../../api/orderStatusBoardApi';
import type { MdfSessionSnapshot, MdfSourceColumn, MdfSourceKind } from '../../api/types/mdfPublishedApi.types';

/** Protocol for the coherent publication UI, NOT for legacy-derived cards.
 * Preparation freezes the displayed source version and actor. An explicit retry
 * is the same command; stale/conflict responses require refresh + new intent. */
export function prepareMdfPublishedCommand(view: MdfSessionSnapshot,
  source: { kind: MdfSourceKind; id: string },target: MdfSourceColumn | null) {
  assertMdfSession(view.sessionGeneration);
  const { snapshot }=view;
  const card=snapshot.cards.find(c => c.kind===source.kind && c.id===source.id);
  const columns=source.kind==='bath' ? ['baths','baths_ready','baths_laminated','completed_baths']
    : ['parsed','completed','completed_laminated'];
  if (snapshot.mode!=='active' || snapshot.issues.length || !card || card.issues.length
    || !card.commandToken || !/^[a-f0-9]{64}$/.test(card.commandToken)
    || card.acceptedRevision!==card.receivedRevision || !card.acceptedRevision
    || snapshot.pendingJobs.some(j => j.kind===source.kind && j.id===source.id)
    || (target!==null && !columns.includes(target))) throw new Error('MDF_COMMAND_NOT_READY');
  const command=Object.freeze({ kind: card.kind,id: card.id,target,
    sourceToken: card.commandToken,idempotencyKey: `mdf:${crypto.randomUUID()}`,
    sessionGeneration: view.sessionGeneration });
  let inFlight: Promise<{ jobId: string }> | null=null;
  const execute=(): Promise<{ jobId: string }> => {
    assertMdfSession(command.sessionGeneration);
    if (inFlight) return inFlight;
    const controller=new AbortController();
    const unsubscribe=authSession.subscribeBeforeClear(() => controller.abort());
    const headers={ sourceToken: command.sourceToken,idempotencyKey: command.idempotencyKey,signal: controller.signal };
    const request=Promise.resolve().then<{ jobId?: string }>(() => {
      assertMdfSession(command.sessionGeneration);
      return command.target===null
        ? orderStatusBoardApi.deleteMdfManualMove(command.kind,command.id,headers)
        : orderStatusBoardApi.upsertMdfManualMove(command.kind,command.id,command.target,headers);
    });
    inFlight=request.then(response => {
      assertMdfSession(command.sessionGeneration);
      if (!response.jobId || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(response.jobId)) {
        throw new Error('MDF_COMMAND_RECEIPT_MISSING');
      }
      return { jobId: response.jobId };
    }).catch(error => {
      assertMdfSession(command.sessionGeneration);
      throw error;
    }).finally(() => { unsubscribe();inFlight=null; });
    return inFlight;
  };
  return Object.freeze({ command,execute });
}

export function mdfPublishedJobProgress(view: MdfSessionSnapshot,jobId: string,
  source: { kind: MdfSourceKind; id: string }) {
  assertMdfSession(view.sessionGeneration);
  if (!['active','read_only'].includes(view.snapshot.mode)) return 'unavailable' as const;
  const job=view.snapshot.trackedJobs.find(j => j.jobId===jobId && j.kind===source.kind && j.id===source.id);
  return job?.status ?? 'missing';
}
