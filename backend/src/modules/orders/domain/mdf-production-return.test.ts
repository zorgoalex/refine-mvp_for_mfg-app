import { describe, expect, it } from "vitest";
import {
  correctionDetailIds,
  returnStageOptions,
  resolveMdfProductionColumn,
} from "./mdf-production-return";

const stages = [
  { id: 1, code: "drawn", name: "Отрисован", rank: 10 },
  { id: 2, code: "cut", name: "Распилен", rank: 20 },
  { id: 4, code: "sanded", name: "Отшлифован", rank: 40 },
  { id: 6, code: "laminated", name: "Закатан", rank: 70 },
  { id: 7, code: "packed", name: "Упакован", rank: 80 },
  { id: 8, code: "issued", name: "Выдан", rank: 90 },
];
describe("MDF production return contracts", () => {
  it("uses catalog ranks, never hard-coded IDs", () => {
    expect(
      returnStageOptions("packet", "parsed", stages).map((s) => s.code)
    ).toEqual(["drawn"]);
    expect(
      returnStageOptions("bath", "baths_laminated", stages).map((s) => s.code)
    ).toEqual(["laminated"]);
    expect(
      returnStageOptions("bath", "baths_ready", stages).map((s) => s.code)
    ).toEqual(["cut", "sanded"]);
  });
  it("rolls back source positions only, keeps earlier and unassigned details", () => {
    expect(
      correctionDetailIds(
        [
          { id: 11, rank: 90 },
          { id: 12, rank: 10 },
          { id: 13, rank: null },
          { id: 14, rank: 20 },
        ],
        20
      )
    ).toEqual([11]);
  });
  it("terminal automatic completion wins identically for board/history", () => {
    expect(resolveMdfProductionColumn("completed_baths", "baths")).toBe(
      "completed_baths"
    );
    expect(resolveMdfProductionColumn("completed_laminated", "parsed")).toBe(
      "completed_laminated"
    );
    expect(resolveMdfProductionColumn("baths_laminated", "baths")).toBe(
      "baths"
    );
  });
  it("rejects incompatible destination or missing mandatory threshold", () => {
    expect(returnStageOptions("packet", "baths", stages)).toEqual([]);
    expect(
      returnStageOptions(
        "packet",
        "parsed",
        stages.filter((s) => s.code !== "cut")
      )
    ).toEqual([]);
  });
});
