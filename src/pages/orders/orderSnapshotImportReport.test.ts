import { describe, expect, it } from "vitest";

import { buildSnapshotImportBatchReport, extractFailureDetailLines } from "./orderSnapshotImportReport";
import type { ImportOrderSnapshotBatchResponse } from "../../api/types/orderApi.types";

describe("orderSnapshotImportReport", () => {
  it("keeps per-file errors and field-level validation details", () => {
    const result: ImportOrderSnapshotBatchResponse = {
      success: true,
      total: 4,
      imported: 1,
      skipped: 1,
      failed: 2,
      results: [
        {
          fileName: "ok.erp-order.json",
          success: true,
          status: "created",
          orderId: 101,
          orderName: "11452",
          payloadHash: "sha256:ok",
          importRunId: "run-ok",
          summary: {
            details: 1,
            payments: 0,
            workshops: 0,
            requirements: 0,
            dowelingLinks: 0,
            productionStatusEvents: 0,
            clientPhones: 0,
            deadlineInstances: 0,
            deadlineEvents: 0,
          },
        },
        {
          fileName: "exists.erp-order.json",
          success: true,
          status: "skipped",
          orderId: 102,
          orderName: "11453",
          payloadHash: "sha256:exists",
          importRunId: "run-exists",
          summary: {
            details: 1,
            payments: 0,
            workshops: 0,
            requirements: 0,
            dowelingLinks: 0,
            productionStatusEvents: 0,
            clientPhones: 0,
            deadlineInstances: 0,
            deadlineEvents: 0,
          },
        },
        {
          fileName: "bad-sheet.erp-order.json",
          success: false,
          errorCode: "VALIDATION_ERROR",
          message: "Order payload validation failed",
          details: {
            errors: [
              {
                field: "details[0].sheetMaterialTypeId",
                message: "sheet_material_type 999 does not exist",
              },
            ],
          },
        },
        {
          fileName: "bad-json.erp-order.json",
          success: false,
          errorCode: "ORDER_SNAPSHOT_IMPORT_FAILED",
          message: "Unexpected token",
        },
      ],
    };

    expect(buildSnapshotImportBatchReport(result)).toEqual({
      title: "Импортировано: 1, уже есть: 1, ошибок: 2",
      successes: [
        { fileName: "ok.erp-order.json", orderName: "11452", status: "created", statusLabel: "создан" },
      ],
      skipped: [
        {
          fileName: "exists.erp-order.json",
          orderName: "11453",
          status: "skipped",
          statusLabel: "уже есть, импорт не выполнялся",
        },
      ],
      failures: [
        {
          fileName: "bad-sheet.erp-order.json",
          errorCode: "VALIDATION_ERROR",
          message: "Order payload validation failed",
          detailLines: [
            "details[0].sheetMaterialTypeId — sheet_material_type 999 does not exist",
          ],
        },
        {
          fileName: "bad-json.erp-order.json",
          errorCode: "ORDER_SNAPSHOT_IMPORT_FAILED",
          message: "Unexpected token",
          detailLines: [],
        },
      ],
    });
  });

  it("ignores malformed details safely", () => {
    expect(extractFailureDetailLines({ errors: [null, {}, "bad"] })).toEqual([]);
    expect(extractFailureDetailLines(undefined)).toEqual([]);
  });
});
