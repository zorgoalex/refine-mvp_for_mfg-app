import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  ClientMergeHistory,
  MergeCommandBody,
  MergePreview,
  MergeRequestBody,
  MergeResult,
  MergeView,
  UndoCommandBody,
  UndoPreview,
  UndoResult,
} from './clientMergesApiTypes';

export const clientMergesApi = {
  preview: (caseId: number, body: MergeRequestBody) =>
    httpClient.post<MergePreview>(apiRoutes.clientMerges.mergePreview(caseId), body),
  merge: (caseId: number, body: MergeCommandBody) =>
    httpClient.post<MergeResult>(apiRoutes.clientMerges.merge(caseId), body),
  history: (clientId: number) =>
    httpClient.get<ClientMergeHistory>(`${apiRoutes.clientMerges.list}?clientId=${encodeURIComponent(String(clientId))}`),
  detail: (mergeId: number) => httpClient.get<MergeView>(apiRoutes.clientMerges.byId(mergeId)),
  undoPreview: (mergeId: number) => httpClient.post<UndoPreview>(apiRoutes.clientMerges.undoPreview(mergeId), {}),
  undo: (mergeId: number, body: UndoCommandBody) =>
    httpClient.post<UndoResult>(apiRoutes.clientMerges.undo(mergeId), body),
};
