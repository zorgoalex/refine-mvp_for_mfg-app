/** §5.6 requirement 7 / R2#2: one board-wide request generation. Every query change (focus,
 * searchOrderIds, workday, mode) and every refresh bumps the generation; a response, an error or a
 * 304 is applied only if its generation equals the current generation AT COMPLETION time — an older
 * one is dropped silently, without touching state. Pure and side-effect-free: the caller owns the
 * mutable holder (typically a ref) and calls these two functions around it. */
export interface MdfBoardGenerationState {
  readonly generation: number;
}

export function createMdfBoardGenerationState(): MdfBoardGenerationState {
  return { generation: 0 };
}

/** Call once per query change AND once per refresh (including polling/visibility refresh). Returns
 * the next state AND the generation to stamp on the request this bump is starting. */
export function bumpMdfBoardGeneration(
  state: MdfBoardGenerationState,
): { state: MdfBoardGenerationState; requestGeneration: number } {
  const requestGeneration = state.generation + 1;
  return { state: { generation: requestGeneration }, requestGeneration };
}

/** True when `requestGeneration` (captured at the start of a request) is still the current one —
 * apply the response/error/304. False — an older/superseded request completed last; drop it. */
export function isMdfBoardGenerationCurrent(
  state: MdfBoardGenerationState,
  requestGeneration: number,
): boolean {
  return state.generation === requestGeneration;
}
