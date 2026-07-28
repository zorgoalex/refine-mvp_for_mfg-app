import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/apiError";
import type { ImportOrderSnapshotBatchResponse } from "../../api/types/orderApi.types";
import {
  ORDER_SNAPSHOT_REFERENCE_MAPPING_REQUIRED,
  extractUnmappedReferencesFromApiError,
  extractUnmappedReferencesFromBatch,
  snapshotReferenceMappingKey,
} from "./orderSnapshotReferenceMapping";

describe("orderSnapshotReferenceMapping", () => {
  it("groups unmapped references from batch failures by entity type and source id", () => {
    const result: ImportOrderSnapshotBatchResponse = {
      success: true,
      total: 3,
      imported: 1,
      skipped: 0,
      failed: 2,
      results: [
        {
          fileName: "ok.erp-order.json",
          success: true,
          status: "created",
          orderId: 1,
          orderName: "2701",
          payloadHash: "hash",
          importRunId: "run",
          summary: {
            details: 0,
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
          fileName: "a.erp-order.json",
          success: false,
          errorCode: ORDER_SNAPSHOT_REFERENCE_MAPPING_REQUIRED,
          message: "Order snapshot reference mapping required",
          details: {
            unmappedReferences: [
              {
                entityType: "sheetMaterialType",
                sourceId: "9",
                sourceName: "LDSP 18",
                usageCount: 2,
                candidates: [{ id: 101, name: "LDSP 18", code: null }],
              },
            ],
          },
        },
        {
          fileName: "b.erp-order.json",
          success: false,
          errorCode: ORDER_SNAPSHOT_REFERENCE_MAPPING_REQUIRED,
          message: "Order snapshot reference mapping required",
          details: {
            unmappedReferences: [
              {
                entityType: "sheetMaterialType",
                sourceId: "9",
                sourceName: "LDSP 18",
                usageCount: 1,
                candidates: [
                  { id: 101, name: "LDSP 18", code: null },
                  { id: 102, name: "LDSP 18 alt", code: null },
                ],
              },
            ],
          },
        },
      ],
    };

    expect(extractUnmappedReferencesFromBatch(result)).toEqual([
      {
        entityType: "sheetMaterialType",
        sourceId: "9",
        sourceName: "LDSP 18",
        usageCount: 3,
        candidates: [
          { id: 101, name: "LDSP 18", code: null },
          { id: 102, name: "LDSP 18 alt", code: null },
        ],
        fileNames: ["a.erp-order.json", "b.erp-order.json"],
      },
    ]);
  });

  it("extracts unmapped references from single import ApiError", () => {
    const error = new ApiError({
      status: 422,
      code: ORDER_SNAPSHOT_REFERENCE_MAPPING_REQUIRED,
      message: "Order snapshot reference mapping required",
      details: {
        unmappedReferences: [
          {
            entityType: "film",
            sourceId: "7",
            sourceName: "Matte white",
            usageCount: 4,
            candidates: [{ id: 55, name: "Matte white", code: null }],
          },
        ],
      },
    });

    expect(extractUnmappedReferencesFromApiError(error, "order.erp-order.json")).toEqual([
      {
        entityType: "film",
        sourceId: "7",
        sourceName: "Matte white",
        usageCount: 4,
        candidates: [{ id: 55, name: "Matte white", code: null }],
        fileNames: ["order.erp-order.json"],
      },
    ]);
  });

  it("uses stable mapping key", () => {
    expect(snapshotReferenceMappingKey({ entityType: "film", sourceId: "7" })).toBe("film:7");
  });
});
