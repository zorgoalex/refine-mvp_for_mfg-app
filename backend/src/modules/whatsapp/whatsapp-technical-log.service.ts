import { Inject, Injectable, Logger } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../../database/database.service";
import type { WhatsAppTechnicalLogQuery } from "./whatsapp-technical-log.dto";

export interface WhatsAppTechnicalLogEntry {
  component: "backend" | "waha" | "webhook" | "relay" | "cleanup";
  level: "info" | "warn" | "error";
  eventCode: string;
  outcome: "started" | "succeeded" | "failed" | "observed";
  operation?: string;
  httpStatus?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  requestId?: string;
  details?: Record<string, string | number | boolean | null>;
}

@Injectable()
export class WhatsAppTechnicalLogService {
  private readonly logger = new Logger(WhatsAppTechnicalLogService.name);
  private readonly queue: WhatsAppTechnicalLogEntry[] = [];
  private draining = false;
  private dropped = 0;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  record(entry: WhatsAppTechnicalLogEntry): Promise<void> {
    if (this.queue.length >= 1000) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 100 === 0) {
        this.logger.warn({
          event: "whatsapp_technical_log_queue_full",
          code: "TECHNICAL_LOG_DROPPED",
          dropped: this.dropped,
        });
      }
      return Promise.resolve();
    }
    this.queue.push(entry);
    void this.drain();
    return Promise.resolve();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) continue;
        try {
          await this.database.query(
            `INSERT INTO whatsapp_technical_logs
              (component,level,event_code,outcome,operation,http_status,duration_ms,error_code,error_message,request_id,details)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
            [entry.component, entry.level, entry.eventCode, entry.outcome, entry.operation ?? null,
              entry.httpStatus ?? null, entry.durationMs ?? null, entry.errorCode ?? null,
              bounded(entry.errorMessage, 500), bounded(entry.requestId, 200), JSON.stringify(entry.details ?? {})],
          );
        } catch {
          this.logger.warn({ event: "whatsapp_technical_log_write_failed", code: "TECHNICAL_LOG_UNAVAILABLE" });
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) void this.drain();
    }
  }

  async list(query: WhatsAppTechnicalLogQuery) {
    const params: unknown[] = [];
    const where = ["occurred_at >= now() - interval '14 days'"];
    addFilter(where, params, "level", query.level);
    addFilter(where, params, "component", query.component);
    addFilter(where, params, "outcome", query.outcome);
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(`(event_code ILIKE $${params.length} OR operation ILIKE $${params.length} OR error_code ILIKE $${params.length} OR error_message ILIKE $${params.length} OR request_id ILIKE $${params.length})`);
    }
    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text total FROM whatsapp_technical_logs WHERE ${where.join(" AND ")}`, [...params],
    );
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.database.query<QueryResultRow>(
      `SELECT technical_log_id::text AS "id", occurred_at AS "occurredAt", component, level,
        event_code AS "eventCode", outcome, operation, http_status AS "httpStatus",
        duration_ms AS "durationMs", error_code AS "errorCode", error_message AS "errorMessage",
        request_id AS "requestId", details
       FROM whatsapp_technical_logs WHERE ${where.join(" AND ")}
       ORDER BY occurred_at DESC, technical_log_id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data: rows.rows, pagination: { page: query.page, pageSize: query.pageSize, total: Number(count.rows[0]?.total ?? 0) } };
  }

  async export(query: WhatsAppTechnicalLogQuery): Promise<string> {
    const result = await this.list({ ...query, page: 1, pageSize: 5000 });
    return `${result.data.map((row) => JSON.stringify(row)).join("\n")}\n`;
  }

  async cleanup(): Promise<number> {
    try {
      const result = await this.database.query(`DELETE FROM whatsapp_technical_logs WHERE occurred_at < now() - interval '14 days'`);
      return result.rowCount ?? 0;
    } catch {
      this.logger.warn({ event: "whatsapp_technical_log_cleanup_failed", code: "TECHNICAL_LOG_UNAVAILABLE" });
      return 0;
    }
  }
}

function addFilter(where: string[], params: unknown[], column: string, value?: string): void {
  if (!value) return;
  params.push(value);
  where.push(`${column}=$${params.length}`);
}

function bounded(value: string | undefined, max: number): string | null {
  return value ? value.replace(/[\r\n\t]+/g, " ").slice(0, max) : null;
}
