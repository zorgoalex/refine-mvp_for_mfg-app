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
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
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
  @ApiOperation({ summary: 'Get WhatsApp session status' })
  @Get("status")
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions("whatsapp.view")
  status() {
    return this.service.status();
  }
  @ApiOperation({ summary: 'Get the WhatsApp pairing QR image' })
  @Get("qr") @ApiBearerAuth('bearerAuth') @RequirePermissions("whatsapp.manage") async qr(
    @Res() response: Response
  ) {
    const qr = await this.service.qr();
    response
      .type(qr.contentType)
      .setHeader("Cache-Control", "no-store")
      .send(Buffer.from(qr.bytes));
  }
  @ApiOperation({ summary: 'Restart the WhatsApp session after confirmation' })
  @Post("restart")
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions("whatsapp.manage")
  restart(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    const value = parseRestart(body);
    return this.service.restart(
      user(request),
      requestId(request),
      value.restrictionConfirmed
    );
  }
  @ApiOperation({ summary: 'List WhatsApp reply templates' })
  @Get("templates")
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions("whatsapp.view")
  templates() {
    return this.service.listTemplates();
  }
  @ApiOperation({ summary: 'Create a WhatsApp reply template' })
  @Post("templates")
  @ApiBearerAuth('bearerAuth')
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
  @ApiOperation({ summary: 'Update a WhatsApp reply template' })
  @Patch("templates/:id")
  @ApiBearerAuth('bearerAuth')
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
  @ApiOperation({ summary: 'List WhatsApp reply rules' })
  @Get("rules") @ApiBearerAuth('bearerAuth') @RequirePermissions("whatsapp.view") rules() {
    return this.service.listRules();
  }
  @ApiOperation({ summary: 'Create a WhatsApp reply rule' })
  @Post("rules")
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions("whatsapp.manage")
  createRule(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.createRule(
      parseRuleInput(body),
      user(request),
      requestId(request)
    );
  }
  @ApiOperation({ summary: 'Update a WhatsApp reply rule' })
  @Patch("rules/:id")
  @ApiBearerAuth('bearerAuth')
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
  @ApiOperation({ summary: 'List WhatsApp delivery jobs' })
  @Get("queue") @ApiBearerAuth('bearerAuth') @RequirePermissions("whatsapp.view") queue() {
    return this.service.listJobs();
  }
  @ApiOperation({ summary: 'List WhatsApp audit events' })
  @Get("audit") @ApiBearerAuth('bearerAuth') @RequirePermissions("whatsapp.view") audit() {
    return this.service.listAudit();
  }
  @ApiOperation({ summary: 'Retry a WhatsApp delivery job' })
  @Post("queue/:id/retry")
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions("whatsapp.manage")
  retry(@Param("id") id: string, @Req() request: RequestWithCurrentUser) {
    return this.service.retryJob(
      positiveId(id),
      user(request),
      requestId(request)
    );
  }
  @ApiOperation({ summary: 'Process the WhatsApp delivery queue' })
  @Post("queue/process-now")
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions("whatsapp.manage")
  process() {
    return this.service.processBatch();
  }
  @ApiOperation({ summary: 'Clean up retained WhatsApp data' })
  @Post("cleanup")
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions("whatsapp.manage")
  cleanup() {
    return this.service.cleanup();
  }
  @ApiOperation({ summary: 'Accept a WAHA webhook authenticated with HMAC' })
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
