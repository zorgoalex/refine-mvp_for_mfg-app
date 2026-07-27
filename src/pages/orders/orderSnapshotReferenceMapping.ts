import { ApiError } from "../../api/apiError";
import type {
  ImportOrderSnapshotBatchResponse,
  ImportOrderSnapshotUnmappedReference,
  OrderSnapshotReferenceEntityType,
} from "../../api/types/orderApi.types";

export const ORDER_SNAPSHOT_REFERENCE_MAPPING_REQUIRED =
  "ORDER_SNAPSHOT_REFERENCE_MAPPING_REQUIRED";

export interface SnapshotUnmappedReferenceRow extends ImportOrderSnapshotUnmappedReference {
  fileNames: string[];
}

type BatchResult = ImportOrderSnapshotBatchResponse["results"][number];
type FailureResult = Extract<BatchResult, { success: false }>;

export function snapshotReferenceMappingKey(
  row: Pick<ImportOrderSnapshotUnmappedReference, "entityType" | "sourceId">,
): string {
  return `${row.entityType}:${row.sourceId}`;
}

export function extractUnmappedReferencesFromBatch(
  result: ImportOrderSnapshotBatchResponse,
): SnapshotUnmappedReferenceRow[] {
  const failures = result.results.filter((item): item is FailureResult => item.success === false);
  return mergeUnmappedReferences(
    failures.flatMap((failure) =>
      extractUnmappedReferencesFromDetails(failure.details).map((reference) => ({
        reference,
        fileName: failure.fileName,
      })),
    ),
  );
}

export function extractUnmappedReferencesFromApiError(
  error: unknown,
  fileName: string,
): SnapshotUnmappedReferenceRow[] {
  if (
    !(error instanceof ApiError)
    || error.code !== ORDER_SNAPSHOT_REFERENCE_MAPPING_REQUIRED
  ) {
    return [];
  }

  return mergeUnmappedReferences(
    extractUnmappedReferencesFromDetails(error.details).map((reference) => ({
      reference,
      fileName,
    })),
  );
}

function extractUnmappedReferencesFromDetails(
  details: unknown,
): ImportOrderSnapshotUnmappedReference[] {
  if (!isRecord(details) || !Array.isArray(details.unmappedReferences)) return [];
  return details.unmappedReferences.filter(isUnmappedReference);
}

function mergeUnmappedReferences(
  items: Array<{ reference: ImportOrderSnapshotUnmappedReference; fileName: string }>,
): SnapshotUnmappedReferenceRow[] {
  const byKey = new Map<string, SnapshotUnmappedReferenceRow>();

  for (const { reference, fileName } of items) {
    const key = snapshotReferenceMappingKey(reference);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...reference,
        usageCount: reference.usageCount,
        candidates: mergeCandidates([], reference.candidates),
        fileNames: [fileName],
      });
      continue;
    }

    existing.usageCount += reference.usageCount;
    if (!existing.fileNames.includes(fileName)) {
      existing.fileNames.push(fileName);
    }
    existing.candidates = mergeCandidates(existing.candidates, reference.candidates);
  }

  return [...byKey.values()].sort((left, right) => {
    const typeCompare = left.entityType.localeCompare(right.entityType);
    if (typeCompare !== 0) return typeCompare;
    return left.sourceName.localeCompare(right.sourceName);
  });
}

function mergeCandidates(
  left: ImportOrderSnapshotUnmappedReference["candidates"],
  right: ImportOrderSnapshotUnmappedReference["candidates"],
): ImportOrderSnapshotUnmappedReference["candidates"] {
  const byId = new Map<number, { id: number; name: string; code: string | null }>();
  for (const candidate of [...left, ...right]) {
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

function isUnmappedReference(value: unknown): value is ImportOrderSnapshotUnmappedReference {
  if (!isRecord(value)) return false;
  return (
    isReferenceEntityType(value.entityType)
    && typeof value.sourceId === "string"
    && typeof value.sourceName === "string"
    && Number.isFinite(value.usageCount)
    && Array.isArray(value.candidates)
    && value.candidates.every(isCandidate)
  );
}

function isCandidate(value: unknown): value is { id: number; name: string; code: string | null } {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.id)
    && typeof value.name === "string"
    && (value.code === null || typeof value.code === "string")
  );
}

function isReferenceEntityType(value: unknown): value is OrderSnapshotReferenceEntityType {
  return typeof value === "string" && REFERENCE_ENTITY_TYPES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const REFERENCE_ENTITY_TYPES = new Set<string>([
  "material",
  "sheetMaterialType",
  "millingType",
  "edgeType",
  "film",
  "filmType",
  "unit",
  "materialType",
  "supplier",
  "vendor",
  "orderStatus",
  "paymentStatus",
  "paymentType",
  "productionStatus",
  "workshop",
  "employee",
  "resourceRequirementStatus",
]);
