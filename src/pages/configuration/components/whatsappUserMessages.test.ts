import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/apiError";
import {
  qrErrorPresentation,
  restartErrorPresentation,
  whatsappAuditPresentation,
  whatsappErrorPresentation,
  whatsappPartialIssueNames,
  whatsappSessionPresentation,
  whatsappTechnicalLogPresentation,
} from "./WhatsAppConfigTabs";

describe("WhatsApp user-facing diagnostics", () => {
  it("refreshes the technical journal while its tab is visible", () => {
    const source = readFileSync(resolve(__dirname, "WhatsAppConfigTabs.tsx"), "utf8");
    expect(source).toContain("window.setInterval");
    expect(source).toContain('document.visibilityState === "visible"');
    expect(source).toContain("15_000");
    expect(source).toContain("Обновлено:");
    expect(source).toContain("if (silent && activeRequest.current) return");
    expect(source).toContain("activeRequest.current?.abort()");
    expect(source).toContain("signal: controller.signal");
  });

  it("offers readable and technical modes in both WhatsApp journals", () => {
    const source = readFileSync(resolve(__dirname, "WhatsAppConfigTabs.tsx"), "utf8");
    expect(source.match(/LOG_DISPLAY_OPTIONS\.map/g)).toHaveLength(2);
    expect(source).toContain('label: "Понятный"');
    expect(source).toContain('label: "Технический"');
  });

  it("translates audit events and entities for operators", () => {
    expect(whatsappAuditPresentation({
      auditId: "1",
      event: "whatsapp.rule.created",
      entityType: "whatsapp_rule",
      entityId: "7",
      username: "admin",
      requestId: "req-1",
      source: "operator",
      createdAt: "2026-09-21T10:00:00.000Z",
    })).toEqual({
      action: "Создано правило ответа",
      object: "Правило №7",
    });
  });

  it("explains unmatched webhook and provider failures without raw codes", () => {
    const unmatched = whatsappTechnicalLogPresentation({
      id: "1",
      occurredAt: "2026-09-21T10:00:00.000Z",
      component: "webhook",
      level: "info",
      eventCode: "whatsapp.webhook.processed",
      outcome: "succeeded",
      operation: "webhook.receive",
      httpStatus: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      requestId: "req-1",
      details: { result: "unmatched", duplicate: false },
    });
    expect(unmatched).toMatchObject({
      event: "Входящее сообщение обработано",
      result: "Правило не найдено",
      color: "orange",
      description: "Подходящее правило не найдено. Ответ не отправлен.",
    });

    const failed = whatsappTechnicalLogPresentation({
      id: "2",
      occurredAt: "2026-09-21T10:01:00.000Z",
      component: "waha",
      level: "error",
      eventCode: "waha.api.request",
      outcome: "failed",
      operation: ["GET ", "/api/", "sessions/{session}/capping"].join(""),
      httpStatus: 404,
      durationMs: 12,
      errorCode: "WAHA_PROVIDER_ERROR",
      errorMessage: null,
      requestId: null,
      details: {},
    });
    expect(failed.description).toBe("WhatsApp отклонил запрос (код 404).");
    expect(failed.description).not.toContain("WAHA_PROVIDER_ERROR");
  });

  it.each([
    ["AUTH_REQUIRED", 401, "Сеанс ERP завершён"],
    ["PERMISSION_DENIED", 403, "Недостаточно прав"],
    ["WHATSAPP_NOT_CONFIGURED", 503, "WhatsApp не настроен"],
    ["WAHA_UNAVAILABLE", 503, "WAHA не отвечает"],
    ["WAHA_PROVIDER_ERROR", 502, "WAHA отклонил запрос"],
    ["WAHA_QR_RESPONSE_INVALID", 502, "WAHA вернул некорректный QR-код"],
    ["WHATSAPP_RESTRICTION_CONFIRMATION_REQUIRED", 409, "Нужно подтверждение ограничений"],
    ["WHATSAPP_VERSION_CONFLICT", 409, "Запись уже изменена"],
    ["WHATSAPP_RETRY_NOT_ALLOWED", 409, "Повтор запрещён"],
    ["WHATSAPP_TEMPLATE_NOT_FOUND", 422, "Шаблон не найден"],
    ["WHATSAPP_NOT_FOUND", 404, "Запись не найдена"],
    ["VALIDATION_ERROR", 422, "Проверьте введённые данные"],
    ["INVALID_WHATSAPP_TECHNICAL_LOG_QUERY", 422, "Некорректные фильтры журнала"],
    ["RATE_LIMIT_EXCEEDED", 429, "Слишком много запросов"],
    ["INTERNAL_ERROR", 500, "Внутренняя ошибка ERP"],
  ])("maps %s to an actionable Russian message", (code, status, title) => {
    const result = whatsappErrorPresentation(new ApiError({
      code,
      status,
      message: "opaque backend message",
      requestId: "req-safe",
    }), "Ошибка WhatsApp");
    expect(result.title).toBe(title);
    expect(result.description).toContain("req-safe");
    expect(result.description).not.toContain("opaque backend message");
  });

  it.each([
    ["WORKING", "Подключена", null],
    ["SCAN_QR_CODE", "Ожидает QR", "Ожидается сканирование QR-кода"],
    ["STARTING", "Запускается", "WAHA запускается"],
    ["FAILED", "Ошибка", "WhatsApp-сессия остановлена"],
    ["STOPPED", "Остановлена", "WhatsApp-сессия остановлена"],
  ])("explains session state %s", (status, label, notice) => {
    const result = whatsappSessionPresentation({ status });
    expect(result.label).toBe(label);
    expect(result.notice?.title ?? null).toBe(notice);
  });

  it("explains missing session state instead of exposing UNKNOWN", () => {
    const result = whatsappSessionPresentation(null);
    expect(result.label).toBe("Нет данных");
    expect(result.notice?.description).toContain("технический журнал");
  });

  it("distinguishes an unreachable WAHA service from an unknown session", () => {
    const result = whatsappSessionPresentation(null, { health: "WAHA_UNAVAILABLE", session: "WAHA_UNAVAILABLE" });
    expect(result.label).toBe("WAHA недоступен");
    expect(result.notice?.title).toBe("WAHA не отвечает");
  });

  it("explains provider 422 according to the requested operation", () => {
    const error = new ApiError({
      code: "WAHA_PROVIDER_ERROR",
      status: 502,
      message: "opaque provider error",
      requestId: "req-operation",
    });

    expect(qrErrorPresentation(error).title).toBe("QR-код сейчас недоступен");
    expect(restartErrorPresentation(error).title).toBe("WAHA не принял перезапуск сессии");
    expect(qrErrorPresentation(error).description).toContain("req-operation");
  });

  it("surfaces partial diagnostic failures instead of reporting a clean state", () => {
    expect(whatsappPartialIssueNames({
      health: null,
      session: null,
      capping: "WAHA_PROVIDER_ERROR",
      timelock: "WAHA_UNAVAILABLE",
      diagnostics: null,
    })).toEqual(["лимит отправки сообщений", "ограничение новых диалогов"]);
  });
});
