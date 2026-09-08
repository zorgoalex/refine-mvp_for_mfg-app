import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { ApiError } from "../../common/errors/api-error";
import type { RequestWithCurrentUser } from "../../permissions/current-user";
import { RequirePermissions } from "../../permissions/require-permissions.decorator";
import {
  parseRestart,
  parseRuleInput,
  parseRuleUpdate,
  parseTemplateInput,
  parseTemplateUpdate,
} from "./whatsapp.dto";
import { WhatsAppPermissionsGuard } from "./whatsapp-permissions.guard";
import { WhatsAppService } from "./whatsapp.service";

@ApiTags("WhatsApp")
@Controller("whatsapp")
@UseGuards(WhatsAppPermissionsGuard)
export class WhatsAppController {
  constructor(
    @Inject(WhatsAppService) private readonly service: WhatsAppService
  ) {}
  @Get("status")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.view")
  status() {
    return this.service.status();
  }
  @Get("qr") @ApiBearerAuth() @RequirePermissions("whatsapp.manage") async qr(
    @Res() response: Response
  ) {
    const qr = await this.service.qr();
    response
      .type(qr.contentType)
      .setHeader("Cache-Control", "no-store")
      .send(Buffer.from(qr.bytes));
  }
  @Post("restart")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  restart(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    const value = parseRestart(body);
    return this.service.restart(
      user(request),
      requestId(request),
      value.restrictionConfirmed
    );
  }
  @Get("templates")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.view")
  templates() {
    return this.service.listTemplates();
  }
  @Post("templates")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  createTemplate(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown
  ) {
    return this.service.createTemplate(
      parseTemplateInput(body),
      user(request),
      requestId(request)
    );
  }
  @Patch("templates/:id")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  updateTemplate(
    @Param("id") id: string,
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown
  ) {
    return this.service.updateTemplate(
      positiveId(id),
      parseTemplateUpdate(body),
      user(request),
      requestId(request)
    );
  }
  @Get("rules") @ApiBearerAuth() @RequirePermissions("whatsapp.view") rules() {
    return this.service.listRules();
  }
  @Post("rules")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  createRule(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.createRule(
      parseRuleInput(body),
      user(request),
      requestId(request)
    );
  }
  @Patch("rules/:id")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  updateRule(
    @Param("id") id: string,
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown
  ) {
    return this.service.updateRule(
      positiveId(id),
      parseRuleUpdate(body),
      user(request),
      requestId(request)
    );
  }
  @Get("queue") @ApiBearerAuth() @RequirePermissions("whatsapp.view") queue() {
    return this.service.listJobs();
  }
  @Get("audit") @ApiBearerAuth() @RequirePermissions("whatsapp.view") audit() {
    return this.service.listAudit();
  }
  @Post("queue/:id/retry")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  retry(@Param("id") id: string, @Req() request: RequestWithCurrentUser) {
    return this.service.retryJob(
      positiveId(id),
      user(request),
      requestId(request)
    );
  }
  @Post("queue/process-now")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  process() {
    return this.service.processBatch();
  }
  @Post("cleanup")
  @ApiBearerAuth()
  @RequirePermissions("whatsapp.manage")
  cleanup() {
    return this.service.cleanup();
  }
  @Post("webhook") @HttpCode(202) webhook(
    @Req() request: RequestWithCurrentUser & Request,
    @Headers("x-webhook-hmac") signature: string | undefined,
    @Headers("x-webhook-hmac-algorithm") algorithm: string | undefined,
    @Headers("x-webhook-timestamp") timestamp: string | undefined
  ) {
    if (!Buffer.isBuffer(request.body))
      throw new ApiError(
        415,
        "WHATSAPP_WEBHOOK_BODY_INVALID",
        "Webhook body must be application/json"
      );
    return this.service.webhook(
      request.body,
      signature,
      algorithm,
      timestamp,
      requestId(request)
    );
  }
}
function user(request: RequestWithCurrentUser) {
  if (!request.user)
    throw new ApiError(401, "AUTH_REQUIRED", "Authentication required");
  return request.user;
}
function requestId(request: RequestWithCurrentUser) {
  if (!request.requestId)
    throw new ApiError(500, "INTERNAL_ERROR", "Missing request id");
  return request.requestId;
}
function positiveId(value: string) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new ApiError(422, "VALIDATION_ERROR", "id must be positive");
  return id;
}
