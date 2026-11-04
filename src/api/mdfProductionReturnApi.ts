import { httpClient } from "./httpClient";
import { backendApiPath } from "./apiRoutes";
export type {
  MdfReturnPreview,
  MdfReturnRequest,
  MdfReturnResult,
} from "../../backend/src/modules/orders/dto/mdf-production-return.dto";
import type {
  MdfReturnPreview,
  MdfReturnRequest,
  MdfReturnConfirmRequest,
  MdfReturnResult,
} from "../../backend/src/modules/orders/dto/mdf-production-return.dto";
export type MdfReturnSource = {
  kind: "packet" | "bath" | "bazisCutSet";
  id: string;
};
const route = (source: MdfReturnSource) =>
  backendApiPath(
    `/orders/status-board/mdf-return/${source.kind}/${encodeURIComponent(
      source.id
    )}`
  );
export function toMdfReturnBoardWindow(
  range: { dateFrom: string; dateTo: string } | undefined
): MdfReturnRequest["boardWindow"] {
  if (!range) return undefined;
  return { dateFrom: range.dateFrom, dateTo: range.dateTo };
}
export const mdfProductionReturnApi = {
  preview: (source: MdfReturnSource, request: MdfReturnRequest) =>
    httpClient.post<MdfReturnPreview>(`${route(source)}/preview`, {
      ...request,
      boardWindow: toMdfReturnBoardWindow(request.boardWindow),
    }),
  confirm: (source: MdfReturnSource, request: MdfReturnConfirmRequest) =>
    httpClient.post<MdfReturnResult>(`${route(source)}/confirm`, {
      ...request,
      boardWindow: toMdfReturnBoardWindow(request.boardWindow),
    }),
};
