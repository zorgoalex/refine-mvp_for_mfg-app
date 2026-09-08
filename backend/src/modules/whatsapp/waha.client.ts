import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../../common/errors/api-error";
import { WhatsAppRuntimeConfigService } from "./whatsapp-runtime-config.service";

@Injectable()
export class WahaClient {
  constructor(
    @Inject(WhatsAppRuntimeConfigService)
    private readonly runtime: WhatsAppRuntimeConfigService
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
    return this.request(`/api/${this.sessionPath()}/message-capping`);
  }
  timelock() {
    return this.request(`/api/${this.sessionPath()}/presence/timelock`);
  }
  restart() {
    return this.request(`/api/sessions/${this.sessionPath()}/restart`, {
      method: "POST",
    });
  }

  async qr(): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.raw(
      `/api/${this.sessionPath()}/auth/qr?format=image`
    );
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "image/png",
    };
  }

  async sendText(
    chatId: string,
    text: string
  ): Promise<{ messageId?: string }> {
    const value = await this.request("/api/sendText", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: this.sessionName(), chatId, text }),
    });
    const record = asRecord(value);
    return {
      messageId: typeof record?.id === "string" ? record.id : undefined,
    };
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
        throw new ApiError(
          502,
          "WAHA_PROVIDER_ERROR",
          `WAHA request failed (${response.status})`
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "WAHA_UNAVAILABLE", "WAHA is unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
