import { z } from "zod";
import { ApiError } from "../../common/errors/api-error";

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(100),
  level: z.enum(["info", "warn", "error"]).optional(),
  component: z.enum(["backend", "waha", "webhook", "relay", "cleanup"]).optional(),
  outcome: z.enum(["started", "succeeded", "failed", "observed"]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
}).strict();

export type WhatsAppTechnicalLogQuery = z.infer<typeof querySchema>;

export function parseWhatsAppTechnicalLogQuery(value: Record<string, unknown>): WhatsAppTechnicalLogQuery {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, "INVALID_WHATSAPP_TECHNICAL_LOG_QUERY", "Некорректные фильтры технического журнала WhatsApp");
  }
  return parsed.data;
}
