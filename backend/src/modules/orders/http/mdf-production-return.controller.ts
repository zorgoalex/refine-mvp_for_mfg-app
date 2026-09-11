import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";
import { DatabaseService } from "../../../database/database.service";
import { ApiError } from "../../../common/errors/api-error";
import type { RequestWithCurrentUser } from "../../../permissions/current-user";
import { PgMdfProductionReturn } from "../adapters/pg-mdf-production-return";
import { OrdersRuntimeConfigService } from "./orders-runtime-config.service";

export const mdfReturnRequestSchema = z
  .object({
    targetColumn: z.enum([
      "parsed",
      "completed",
      "baths",
      "baths_ready",
      "baths_laminated",
    ]),
    productionStatusId: z.number().int().positive().optional(),
    boardWindow: z
      .object({ dateFrom: z.string().date(), dateTo: z.string().date() })
      .strict()
      .refine((w) => w.dateFrom <= w.dateTo)
      .optional(),
  })
  .strict();
export const mdfReturnConfirmSchema = mdfReturnRequestSchema
  .extend({
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();
const sourceSchema = z
  .object({
    kind: z.enum(["packet", "bath", "bazisCutSet"]),
    id: z.string().max(100),
  })
  .refine(
    (s) =>
      s.kind === "packet"
        ? /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s.id)
        : s.kind === "bath"
        ? /^cut-result:[1-9]\d*$/.test(s.id)
        : /^[1-9]\d*$/.test(s.id),
    "Invalid source identity"
  );
const properties = {
  targetColumn: {
    type: "string",
    enum: ["parsed", "completed", "baths", "baths_ready", "baths_laminated"],
  },
  productionStatusId: { type: "integer", minimum: 1 },
  boardWindow: {
    type: "object",
    required: ["dateFrom", "dateTo"],
    additionalProperties: false,
    properties: {
      dateFrom: { type: "string", format: "date" },
      dateTo: { type: "string", format: "date" },
    },
  },
};

@ApiTags("Orders")
@ApiBearerAuth()
@ApiParam({ name: "cardKind", enum: ["packet", "bath", "bazisCutSet"] })
@ApiParam({ name: "cardId", type: String })
@ApiResponse({ status: 401, description: "Authentication required" })
@ApiResponse({
  status: 403,
  description: "Insufficient production/order scope",
})
@ApiResponse({ status: 409, description: "Stale preview or concurrent change" })
@ApiResponse({
  status: 422,
  description: "Unresolved source or blocked return",
})
@Controller("orders/status-board/mdf-return/:cardKind/:cardId")
export class MdfProductionReturnController {
  private readonly returns: PgMdfProductionReturn;
  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtime: OrdersRuntimeConfigService
  ) {
    this.returns = new PgMdfProductionReturn(database);
  }
  @Post("preview")
  @HttpCode(200)
  @ApiOperation({
    operationId: "previewMdfProductionReturn",
    summary: "Preview source-scoped MDF production correction",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["targetColumn"],
      additionalProperties: false,
      properties,
    },
  })
  preview(
    @Req() req: RequestWithCurrentUser,
    @Param("cardKind") kind: string,
    @Param("cardId") id: string,
    @Body() body: unknown
  ) {
    return this.returns.preview(
      this.user(req),
      parse(sourceSchema, { kind, id }),
      parse(mdfReturnRequestSchema, body)
    );
  }
  @Post("confirm")
  @HttpCode(200)
  @ApiOperation({
    operationId: "confirmMdfProductionReturn",
    summary: "Confirm previewed MDF return without a reason field",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["targetColumn", "expectedDigest", "idempotencyKey"],
      additionalProperties: false,
      properties: {
        ...properties,
        expectedDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
      },
    },
  })
  confirm(
    @Req() req: RequestWithCurrentUser,
    @Param("cardKind") kind: string,
    @Param("cardId") id: string,
    @Body() body: unknown
  ) {
    return this.returns.confirm(
      this.user(req),
      parse(sourceSchema, { kind, id }),
      parse(mdfReturnConfirmSchema, body),
      req.requestId ?? "mdf-production-return"
    );
  }
  private user(req: RequestWithCurrentUser) {
    const flags = this.runtime.getFeatureFlags();
    if (!flags.ordersEnabled || flags.ordersReadOnly)
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "Изменения заказов недоступны"
      );
    if (!req.user)
      throw new ApiError(401, "AUTH_REQUIRED", "Authentication required");
    return req.user;
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Некорректные параметры возврата"
    );
  return parsed.data;
}
