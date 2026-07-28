import type { ImportOrderSnapshotBatchResponse } from "../../api/types/orderApi.types";

type BatchResult = ImportOrderSnapshotBatchResponse["results"][number];
type FailureResult = Extract<BatchResult, { success: false }>;
type SuccessResult = Extract<BatchResult, { success: true }>;
type SnapshotImportStatus = SuccessResult["status"];
type ImportedResult = SuccessResult & { status: "created" | "updated" };
type SkippedResult = SuccessResult & { status: "noop" | "skipped" };

export interface SnapshotImportFailureReport {
  fileName: string;
  errorCode: string;
  message: string;
  detailLines: string[];
}

export interface SnapshotImportBatchReport {
  title: string;
  failures: SnapshotImportFailureReport[];
  successes: Array<{
    fileName: string;
    orderName: string;
    status: "created" | "updated";
    statusLabel: string;
  }>;
  skipped: Array<{
    fileName: string;
    orderName: string;
    status: "noop" | "skipped";
    statusLabel: string;
  }>;
}

export function buildSnapshotImportBatchReport(
  result: ImportOrderSnapshotBatchResponse,
): SnapshotImportBatchReport {
  const failures = result.results
    .filter((item): item is FailureResult => item.success === false)
    .map((failure) => ({
      fileName: failure.fileName,
      errorCode: failure.errorCode,
      message: failure.message,
      detailLines: extractFailureDetailLines(failure.details),
    }));

  const successes = result.results
    .filter((item): item is ImportedResult => (
      item.success === true && isImportedSnapshotStatus(item.status)
    ))
    .map((success) => ({
      fileName: success.fileName,
      orderName: success.orderName,
      status: success.status,
      statusLabel: snapshotImportStatusLabel(success.status),
    }));

  const skipped = result.results
    .filter((item): item is SkippedResult => (
      item.success === true && isSkippedSnapshotStatus(item.status)
    ))
    .map((skip) => ({
      fileName: skip.fileName,
      orderName: skip.orderName,
      status: skip.status,
      statusLabel: snapshotImportStatusLabel(skip.status),
    }));

  return {
    title: snapshotImportBatchTitle(result),
    failures,
    successes,
    skipped,
  };
}

export function extractFailureDetailLines(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const errors = details.errors;
  if (!Array.isArray(errors)) return [];

  return errors
    .map((error) => {
      if (!isRecord(error)) return null;
      const field = typeof error.field === "string" ? error.field : "";
      const message = typeof error.message === "string" ? error.message : "";
      const code = typeof error.code === "string" ? error.code : "";
      if (!field && !message && !code) return null;
      return [field, message, code].filter(Boolean).join(" — ");
    })
    .filter((line): line is string => Boolean(line));
}

function snapshotImportBatchTitle(result: ImportOrderSnapshotBatchResponse): string {
  const parts = [
    result.imported > 0 ? `Импортировано: ${result.imported}` : null,
    result.skipped > 0 ? `уже есть: ${result.skipped}` : null,
    result.failed > 0 ? `ошибок: ${result.failed}` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(", ") : "Нет заказов для импорта";
}

function snapshotImportStatusLabel(status: "created" | "updated" | "noop" | "skipped"): string {
  switch (status) {
    case "created":
      return "создан";
    case "updated":
      return "обновлен";
    case "noop":
    case "skipped":
      return "уже есть, импорт не выполнялся";
  }
}

function isImportedSnapshotStatus(status: SnapshotImportStatus): status is "created" | "updated" {
  return status === "created" || status === "updated";
}

function isSkippedSnapshotStatus(status: SnapshotImportStatus): status is "noop" | "skipped" {
  return status === "noop" || status === "skipped";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
