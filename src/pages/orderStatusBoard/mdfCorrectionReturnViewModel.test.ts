import { describe, expect, it } from "vitest";
import {
  buildMdfCorrectionReturnViewModel,
  mdfCorrectionBlockerText,
} from "./mdfCorrectionReturnViewModel";
import type { MdfCorrectionPreviewResponse } from "../../api/mdfCorrectionApi";

const columnTitle = (key: string) =>
  ({ parsed: "Отрисован", completed: "Раскроен", baths: "В ваннах" } as Record<string, string>)[
    key
  ] ?? key;

function detail(overrides: Partial<MdfCorrectionPreviewResponse["details"][number]> = {}) {
  return {
    orderId: 1,
    detailId: 11,
    cutCoverage: 10,
    laminatedCoverage: 0,
    independentFloorRank: null,
    afterRank: 5,
    after: {
      orderId: 1,
      detailId: 11,
      quantity: 10,
      rawCut: 10,
      rawRolled: 0,
      cut: 10,
      rolled: 0,
      creditedCut: 10,
      creditedRolled: 0,
      remaining: 0,
    },
    orderName: "Заказ №1",
    detailNumber: 3,
    beforeStatus: "Упакован",
    afterStatus: "Отрисован",
    cardQuantity: 4,
    statusKept: false,
    ...overrides,
  };
}

function preview(
  overrides: Partial<MdfCorrectionPreviewResponse> = {}
): MdfCorrectionPreviewResponse {
  return {
    protocol: "mdf-correction-v1",
    status: "ready",
    source: { kind: "packet", id: "card-1", label: "Файл E2E" },
    targetColumn: "parsed",
    targetStage: { id: 1, code: "drawn", name: "Отрисован", rank: 10 },
    stages: [{ id: 1, code: "drawn", name: "Отрисован", rank: 10 }],
    sourceToken: "a".repeat(64),
    headFence: { version: "v1", correctionEpoch: "1" },
    digest: "b".repeat(64),
    affectedOrderIds: [1],
    details: [detail()],
    sourceAfter: { afterColumn: null, afterIssues: [] },
    affectedBaths: [],
    orders: [],
    allocationReleases: [],
    allocationReplacements: [],
    deferredPriorAutomation: [],
    cncFreshnessBaseline: null,
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

describe("buildMdfCorrectionReturnViewModel", () => {
  it("uses the whole-detail quantity from after.quantity, not the card membership quantity", () => {
    const vm = buildMdfCorrectionReturnViewModel(preview(), columnTitle);
    expect(vm.details[0].wholeQuantity).toBe(10);
    expect(vm.details[0].cardQuantity).toBe(4);
  });

  it("groups details by order", () => {
    const vm = buildMdfCorrectionReturnViewModel(
      preview({
        details: [
          detail({ orderId: 1, detailId: 11, orderName: "Заказ №1" }),
          detail({ orderId: 1, detailId: 12, orderName: "Заказ №1" }),
          detail({ orderId: 2, detailId: 21, orderName: "Заказ №2" }),
        ],
      }),
      columnTitle
    );
    expect(vm.detailsByOrder).toHaveLength(2);
    expect(vm.detailsByOrder.find((b) => b.orderId === 1)?.rows).toHaveLength(2);
  });

  it("only surfaces order consequences where before differs from after", () => {
    const vm = buildMdfCorrectionReturnViewModel(
      preview({
        orders: [
          { orderId: 1, orderName: "Заказ №1", before: "Выдан", after: "В производстве", beforeStatusId: 9, afterStatusId: 3 },
          { orderId: 2, orderName: "Заказ №2", before: "В производстве", after: "В производстве", beforeStatusId: 3, afterStatusId: 3 },
        ],
      }),
      columnTitle
    );
    expect(vm.orderConsequences).toHaveLength(1);
    expect(vm.orderConsequences[0].text).toContain("Заказ №1");
    expect(vm.orderConsequences[0].text).toContain("Выдан");
    expect(vm.orderConsequences[0].text).toContain("В производстве");
  });

  it("marks a bath pending recalculation when afterIssues is non-empty, instead of showing a column", () => {
    const vm = buildMdfCorrectionReturnViewModel(
      preview({
        affectedBaths: [
          {
            source: { kind: "bath", id: "cut-result:5" },
            previousRevision: "rev-1",
            cancelledLaminationQuantity: 3,
            beforeColumn: "baths",
            manualPlacementColumnBefore: null,
            manualPlacementColumnAfter: null,
            clearsManualPlacementOverride: true,
            afterColumn: null,
            afterIssues: ["SOME_UNRESOLVED_ISSUE"],
          },
        ],
      }),
      columnTitle
    );
    expect(vm.baths).toHaveLength(1);
    expect(vm.baths[0].pendingRecalculation).toBe(true);
    expect(vm.baths[0].afterColumnTitle).toBeNull();
    expect(vm.baths[0].beforeColumnTitle).toBe("В ваннах");
    expect(vm.baths[0].clearsManualPlacementOverride).toBe(true);
    expect(vm.baths[0].cancelledLaminationQuantity).toBe(3);
  });

  it("resolves a bath's afterColumn title when the recalculation outcome is already known", () => {
    const vm = buildMdfCorrectionReturnViewModel(
      preview({
        affectedBaths: [
          {
            source: { kind: "bath", id: "cut-result:5" },
            previousRevision: "rev-1",
            cancelledLaminationQuantity: 0,
            beforeColumn: "baths_laminated",
            manualPlacementColumnBefore: null,
            manualPlacementColumnAfter: null,
            clearsManualPlacementOverride: false,
            afterColumn: "baths",
            afterIssues: [],
          },
        ],
      }),
      columnTitle
    );
    expect(vm.baths[0].pendingRecalculation).toBe(false);
    expect(vm.baths[0].afterColumnTitle).toBe("В ваннах");
  });

  it("maps blocker codes to Russian text and keeps status/ready flags in sync", () => {
    const vm = buildMdfCorrectionReturnViewModel(
      preview({
        status: "blocked",
        digest: null,
        blockers: [{ code: "LAMINATION_PROOF_NOT_FOUND", sourceId: "cut-result:5" }],
      }),
      columnTitle
    );
    expect(vm.ready).toBe(false);
    expect(vm.blockerTexts).toHaveLength(1);
    expect(vm.blockerTexts[0]).toMatch(/[а-яё]/i);
    expect(vm.blockerTexts[0]).toContain("cut-result:5");
  });

  it("falls back to a generic Russian message for an unknown blocker code", () => {
    const text = mdfCorrectionBlockerText({ code: "SOME_FUTURE_CODE" });
    expect(text).toContain("SOME_FUTURE_CODE");
    expect(text).toMatch(/[а-яё]/i);
  });
});
