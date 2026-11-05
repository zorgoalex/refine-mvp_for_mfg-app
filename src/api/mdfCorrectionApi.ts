import { apiRoutes } from "./apiRoutes";
import { httpClient, type RequestOptions } from "./httpClient";
export type {
  MdfCorrectionConfirmBody,
  MdfCorrectionConfirmResponse,
  MdfCorrectionPreviewBody,
  MdfCorrectionPreviewResponse,
  MdfCorrectionSourceRef,
} from "../../backend/src/modules/mdf-board/application/mdf-correction.types";
import type {
  MdfCorrectionConfirmBody,
  MdfCorrectionConfirmResponse,
  MdfCorrectionPreviewBody,
  MdfCorrectionPreviewResponse,
  MdfCorrectionSourceRef,
} from "../../backend/src/modules/mdf-board/application/mdf-correction.types";
export type { MdfCorrectionBlocker } from "../../backend/src/modules/mdf-board/domain/mdf-correction-plan";

/** Mirrors MdfEngineModeDto (mdf-active-production-return.service.ts). Declared
 * locally instead of imported: that service file pulls in the full NestJS/DB
 * runtime import graph (PgMdfCorrectionCommand -> ... -> DatabaseService),
 * which the frontend program cannot typecheck (decorators disabled here). */
export interface MdfEngineModeDto {
  mode: "legacy" | "shadow" | "active" | "read_only";
  publishedReads: boolean;
}

const route = (source: MdfCorrectionSourceRef) =>
  apiRoutes.orders.statusBoardMdfCorrection(source.kind, source.id);

/** §5.5b active-engine correction preview/confirm and read-only engine mode.
 * Never used to gate the legacy dialog directly — see mdfReturnSelection.ts. */
export const mdfCorrectionApi = {
  getEngineMode: (options?: RequestOptions): Promise<MdfEngineModeDto> =>
    httpClient.get<MdfEngineModeDto>(
      apiRoutes.orders.statusBoardMdfEngineMode,
      options
    ),
  preview: (
    source: MdfCorrectionSourceRef,
    body: MdfCorrectionPreviewBody
  ): Promise<MdfCorrectionPreviewResponse> =>
    httpClient.post<MdfCorrectionPreviewResponse>(
      `${route(source)}/preview`,
      body
    ),
  confirm: (
    source: MdfCorrectionSourceRef,
    body: MdfCorrectionConfirmBody
  ): Promise<MdfCorrectionConfirmResponse> =>
    httpClient.post<MdfCorrectionConfirmResponse>(
      `${route(source)}/confirm`,
      body
    ),
};
