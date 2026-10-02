import { Inject, Injectable, Optional } from "@nestjs/common";
import { ApiError } from "../../common/errors/api-error";
import { WhatsAppRuntimeConfigService } from "./whatsapp-runtime-config.service";
import { WhatsAppTechnicalLogService } from "./whatsapp-technical-log.service";

@Injectable()
export class WahaClient {
  constructor(
    @Inject(WhatsAppRuntimeConfigService)
    private readonly runtime: WhatsAppRuntimeConfigService,
    @Optional() @Inject(WhatsAppTechnicalLogService)
    private readonly technicalLogs?: WhatsAppTechnicalLogService
  ) {}

  health() {
    return this.request("/health");
  }
  version() {
    return this.request("/api/server/version");
  }
  serverStatus() {
    return this.request("/api/server/status");
  }
  session() {
    return this.request(`/api/sessions/${this.sessionPath()}`);
  }
  me() {
    return this.request(`/api/sessions/${this.sessionPath()}/me`);
  }
  capping() {
    return this.request(`/api/sessions/${this.sessionPath()}/capping`);
  }
  timelock() {
    return this.request(`/api/sessions/${this.sessionPath()}/timelock`);
  }
  restart() {
    return this.request(`/api/sessions/${this.sessionPath()}/restart`, {
      method: "POST",
    });
  }
  /** Groups of the linked account without participants (member phone numbers stay in WAHA). */
  groups(limit: number) {
    return this.request(`/api/${this.sessionPath()}/groups?exclude=participants&limit=${limit}`);
  }

  async qr(): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.raw(
      `/api/${this.sessionPath()}/auth/qr?format=image`,
      { headers: { Accept: "image/png" } }
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/png") || !isPng(bytes)) {
      await this.technicalLogs?.record({
        component: "waha", level: "error", eventCode: "waha.qr.response",
        outcome: "failed", operation: "GET /api/{session}/auth/qr",
        errorCode: "WAHA_QR_RESPONSE_INVALID",
        details: { contentType: contentType.slice(0, 80), size: bytes.byteLength },
      });
      throw new ApiError(502, "WAHA_QR_RESPONSE_INVALID", "WAHA returned an invalid QR image");
    }
    return {
      bytes,
      contentType: "image/png",
    };
  }

  async sendText(
    chatId: string,
    text: string,
    replyTo?: string
  ): Promise<{ messageId?: string }> {
    const value = await this.request("/api/sendText", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: this.sessionName(), chatId, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    const record = asRecord(value);
    return {
      messageId: typeof record?.id === "string" ? record.id : undefined,
    };
  }

  async sendImage(chatId: string, png: Buffer, filename: string, caption: string): Promise<{ messageId?: string }> {
    const value = await this.request('/api/sendImage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: this.sessionName(), chatId,
        file: { mimetype: 'image/png', filename, data: png.toString('base64') },
        caption,
      }),
    });
    const record = asRecord(value);
    return { messageId: typeof record?.id === 'string' && record.id.length > 0 ? record.id : undefined };
  }

  /** Sends a document (PDF/XLSX). Only a non-empty message id means WhatsApp accepted it. */
  async sendFile(chatId: string, bytes: Buffer, filename: string, mimetype: string, caption: string): Promise<{ messageId?: string }> {
    const value = await this.request('/api/sendFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: this.sessionName(), chatId,
        file: { mimetype, filename, data: bytes.toString('base64') },
        caption,
      }),
    });
    const record = asRecord(value);
    const id = record?.id;
    const messageId = typeof id === 'string' ? id : typeof asRecord(id)?._serialized === 'string' ? String(asRecord(id)?._serialized) : undefined;
    return { messageId: messageId && messageId.length > 0 ? messageId : undefined };
  }

  /**
   * Whether a phone (7XXXXXXXXXX) is on WhatsApp, and its chat id (`…@c.us` or `…@lid`). The phone
   * travels only in the query, which is never written to the technical log (see safePath).
   */
  async checkPhone(phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const value = await this.request(`/api/contacts/check-exists?phone=${encodeURIComponent(phone)}&session=${encodeURIComponent(this.sessionName())}`);
    const record = asRecord(value);
    const chatId = typeof record?.chatId === 'string' && /^\d{5,24}@(c\.us|lid)$/.test(record.chatId) ? record.chatId : null;
    return { exists: record?.numberExists === true && chatId !== null, chatId };
  }

  private sessionPath(): string {
    return encodeURIComponent(this.sessionName());
  }

  private sessionName(): string {
    const value = this.runtime.getConfig().sessionName;
    if (!value)
      throw new ApiError(
        503,
        "WHATSAPP_NOT_CONFIGURED",
        "WhatsApp session is not configured"
      );
    return value;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.raw(path, init);
    if (response.status === 204) return null;
    return response.json().catch(() => ({}));
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const config = this.runtime.getConfig();
    if (!config.enabled || !config.baseUrl || !config.apiKey) {
      throw new ApiError(
        503,
        "WHATSAPP_NOT_CONFIGURED",
        "WhatsApp integration is not configured"
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const startedAt = Date.now();
    const operation = `${init.method ?? "GET"} ${this.safePath(path)}`;
    try {
      const response = await globalThis.fetch(`${config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-Api-Key": config.apiKey,
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        await this.technicalLogs?.record({ component: "waha", level: "error", eventCode: "waha.api.request",
          outcome: "failed", operation, httpStatus: response.status, durationMs: Date.now() - startedAt,
          errorCode: "WAHA_PROVIDER_ERROR" });
        throw new ApiError(
          502,
          "WAHA_PROVIDER_ERROR",
          `WAHA request failed (${response.status})`,
          { httpStatus: response.status }
        );
      }
      await this.technicalLogs?.record({ component: "waha", level: "info", eventCode: "waha.api.request",
        outcome: "succeeded", operation, httpStatus: response.status, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      await this.technicalLogs?.record({ component: "waha", level: "error", eventCode: "waha.api.request",
        outcome: "failed", operation, durationMs: Date.now() - startedAt, errorCode: "WAHA_UNAVAILABLE",
        errorMessage: error instanceof Error ? error.name : "UnknownError" });
      throw new ApiError(503, "WAHA_UNAVAILABLE", "WAHA is unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Route template only: the query (phones, session) never reaches the technical log. */
  private safePath(path: string): string {
    const route = path.split("?")[0];
    const session = this.runtime.getConfig().sessionName;
    return session ? route.replaceAll(encodeURIComponent(session), "{session}") : route;
  }
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
