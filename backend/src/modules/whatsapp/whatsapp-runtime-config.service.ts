import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BackendEnv } from "../../config/env.validation";
import type { WhatsAppConfig } from "./whatsapp.types";

@Injectable()
export class WhatsAppRuntimeConfigService {
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<BackendEnv, true>
  ) {}

  getConfig(): WhatsAppConfig {
    return {
      enabled: this.config.get("BACKEND_ENABLE_WHATSAPP", { infer: true }),
      baseUrl: this.config.get("WAHA_BASE_URL", { infer: true }),
      apiKey: this.config.get("WAHA_API_KEY", { infer: true }),
      sessionName: this.config.get("WAHA_SESSION_NAME", { infer: true }),
      webhookSecret: this.config.get("WAHA_WEBHOOK_HMAC_SECRET", {
        infer: true,
      }),
      requestTimeoutMs: this.config.get("WAHA_REQUEST_TIMEOUT_MS", {
        infer: true,
      }),
      relayOwner: this.config.get("BACKEND_WHATSAPP_RELAY_OWNER", {
        infer: true,
      }),
      relayPollIntervalMs: this.config.get(
        "BACKEND_WHATSAPP_RELAY_POLL_INTERVAL_MS",
        { infer: true }
      ),
      relayBatchSize: this.config.get("BACKEND_WHATSAPP_RELAY_BATCH_SIZE", {
        infer: true,
      }),
      relayWorkerId: this.config.get("BACKEND_WHATSAPP_RELAY_WORKER_ID", {
        infer: true,
      }),
      relayMaxAttempts: this.config.get("BACKEND_WHATSAPP_RELAY_MAX_ATTEMPTS", {
        infer: true,
      }),
      relayStaleLockMs: this.config.get(
        "BACKEND_WHATSAPP_RELAY_STALE_LOCK_MS",
        { infer: true }
      ),
      cleanupOwner: this.config.get("BACKEND_WHATSAPP_CLEANUP_OWNER", {
        infer: true,
      }),
    };
  }
}
