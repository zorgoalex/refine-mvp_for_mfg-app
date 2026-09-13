export type MdfReturnKind = "packet" | "bath" | "bazisCutSet";
export type MdfReturnColumn =
  | "parsed"
  | "completed"
  | "baths"
  | "baths_ready"
  | "baths_laminated";
export interface MdfReturnStage {
  id: number;
  code: string;
  name: string;
  rank: number;
}

/** Same terminal priority as the MDF board; manual positions never fake physical reopening. */
export function resolveMdfProductionColumn<T extends string>(
  automatic: T,
  manual?: T | null
): T {
  return automatic === "completed_baths" || automatic === "completed_laminated"
    ? automatic
    : manual ?? automatic;
}

export function returnStageOptions(
  kind: MdfReturnKind,
  column: string,
  stages: MdfReturnStage[]
): MdfReturnStage[] {
  const cut = stages.find((s) => s.code === "cut")?.rank;
  const laminated = stages.find((s) => s.code === "laminated")?.rank;
  const packed = stages.find((s) => s.code === "packed")?.rank;
  if (cut === undefined || laminated === undefined || packed === undefined)
    return [];
  const range =
    kind === "bath"
      ? column === "baths"
        ? [-Infinity, laminated]
        : column === "baths_ready"
        ? [cut, laminated]
        : column === "baths_laminated"
        ? [laminated, packed]
        : null
      : column === "parsed"
      ? [-Infinity, cut]
      : column === "completed"
      ? [cut, packed]
      : null;
  return range
    ? stages.filter(
        (s) => s.code !== "hdf" && s.rank >= range[0] && s.rank < range[1]
      )
    : [];
}

export function correctionDetailIds(
  details: { id: number; rank: number | null }[],
  rank: number
): number[] {
  return details
    .filter((d) => d.rank !== null && d.rank > rank)
    .map((d) => d.id);
}
