import type { ImportOrderSnapshotBatchResponse } from "../../api/types/orderApi.types";

type BatchResult = ImportOrderSnapshotBatchResponse["results"][number];
type FailureResult = Extract<BatchResult, { success: false }>;

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
    status: "created" | "updated" | "noop";
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
    .filter((item): item is Extract<BatchResult, { success: true }> => item.success === true)
    .map((success) => ({
      fileName: success.fileName,
      orderName: success.orderName,
      status: success.status,
      statusLabel: snapshotImportStatusLabel(success.status),
    }));

  return {
    title: result.failed > 0
      ? `Импортировано: ${result.imported}, ошибок: ${result.failed}`
      : `Импортировано заказов: ${result.imported}`,
    failures,
    successes,
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

function snapshotImportStatusLabel(status: "created" | "updated" | "noop"): string {
  switch (status) {
    case "created":
      return "создан";
    case "updated":
      return "обновлен";
    case "noop":
      return "без изменений";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
