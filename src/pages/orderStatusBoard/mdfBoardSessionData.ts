/** What the MDF board does with the data it shows when it is shown again or the auth session changes. */

/** The key of the shown data: its dataset and the auth session it was read under. */
export const mdfShownDataKey = (datasetKey: string, sessionGeneration: number) => `${datasetKey}|${sessionGeneration}`;

/** Coming back to the board: keep what it shows (and refresh in the background) only for the same dataset of the
 * same auth session, and only if it shows something; otherwise clear and load again. */
export function keepsShownMdfBoard(shownKey: string | null, currentKey: string, hasData: boolean): boolean {
  return shownKey !== null && shownKey === currentKey && hasData;
}

/** Everything the board shows from its reads — each part must be dropped on a session change. */
export interface MdfBoardSessionData {
  dropAuxiliaryReads(): void;
  clearBoard(): void;
  clearToday(): void;
  clearOrderSearchToday(): void;
  clearOriginalBoard(): void;
  clearOrderBoard(): void;
  setShownKey(key: string | null): void;
  reload(): void;
}

/** A re-login or a permission/scope change: drop every part at once; a shown board reads its dataset again under the
 * new session (and that becomes its shown key), a hidden one loads in full when shown again. */
export function resetMdfBoardForNewSession(data: MdfBoardSessionData, input: {
  shown: boolean; datasetKey: string; sessionGeneration: number;
}): void {
  data.dropAuxiliaryReads();
  data.clearBoard();
  data.clearToday();
  data.clearOrderSearchToday();
  data.clearOriginalBoard();
  data.clearOrderBoard();
  data.setShownKey(input.shown ? mdfShownDataKey(input.datasetKey, input.sessionGeneration) : null);
  if (input.shown) data.reload();
}
