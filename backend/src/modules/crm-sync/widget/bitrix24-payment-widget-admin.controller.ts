import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import { Bitrix24OAuthTokenService } from '../reverse/bitrix24-oauth-token.service';
import { Bitrix24ManualPaymentCommandService } from './bitrix24-manual-payment-command.service';
import { parseResolvePaymentAmbiguityInput } from './bitrix24-payment-widget.dto';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';
import { Bitrix24PaymentSystemCatalogService } from './bitrix24-payment-system-catalog.service';

@ApiTags('Bitrix24')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('bitrix24')
export class Bitrix24PaymentWidgetAdminController {
  constructor(
    private readonly catalog: Bitrix24PaymentSystemCatalogService,
    private readonly repository: Bitrix24PaymentWidgetRepository,
    private readonly bitrix: Bitrix24LocalAppClient,
    private readonly tokens: Bitrix24OAuthTokenService,
    private readonly commands: Bitrix24ManualPaymentCommandService,
  ) {}

  @ApiOperation({ summary: 'Refresh Bitrix24 payment system catalog' })
  @Post('payment-systems/refresh')
  @HttpCode(200)
  @RequirePermissions('bitrix24.integration.manage')
  async refreshPaymentSystems(@Req() request: RequestWithCurrentUser) {
    if (!request.user || !request.requestId) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    return {
      refreshed: await this.catalog.refresh({
        actorUserId: Number(request.user.id),
        requestId: request.requestId,
      }),
    };
  }

  @ApiOperation({ summary: 'List ambiguous Bitrix24 payment commands' })
  @Get('payment-commands/ambiguous')
  @RequirePermissions('bitrix24.integration.manage')
  listAmbiguousCommands() {
    return this.repository.listAmbiguousCommands();
  }

  @ApiOperation({ summary: 'Resolve an ambiguous Bitrix24 payment create' })
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['resolution', 'bitrixPaymentId', 'reason', 'expectedVersion'],
          properties: {
            resolution: { type: 'string', enum: ['attach_existing'] },
            bitrixPaymentId: { type: 'string', pattern: '^[1-9][0-9]*$' },
            reason: { type: 'string', minLength: 10, maxLength: 2000 },
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
        {
          type: 'object',
          required: ['resolution', 'reason', 'expectedVersion'],
          properties: {
            resolution: { type: 'string', enum: ['confirm_absent'] },
            reason: { type: 'string', minLength: 10, maxLength: 2000 },
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
      ],
    },
  })
  @Post('payment-commands/:commandId/resolve-ambiguity')
  @HttpCode(200)
  @RequirePermissions('bitrix24.integration.manage')
  async resolveAmbiguity(
    @Req() request: RequestWithCurrentUser,
    @Param('commandId') commandId: string,
    @Body() body: unknown,
  ) {
    if (!request.user || !request.requestId) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }
    const input = parseResolvePaymentAmbiguityInput(body);
    const command = await this.repository.getCommand(commandId);
    if (!command || command.status !== 'remote_create_ambiguous') {
      throw new ApiError(
        409,
        'BITRIX24_PAYMENT_COMMAND_STATE_CHANGED',
        'Payment command is not awaiting ambiguity resolution',
      );
    }
    if (input.resolution === 'attach_existing') {
      const accessToken = await this.tokens.getAccessToken(command.domain);
      const ids = await this.bitrix.listDealPaymentIds({
        domain: command.domain,
        accessToken,
        dealId: command.bitrixDealId,
      });
      if (!ids.includes(input.bitrixPaymentId)) {
        throw new ApiError(
          409,
          'BITRIX24_PAYMENT_MEMBERSHIP_MISMATCH',
          'Selected payment does not belong to the command Deal',
        );
      }
      await this.bitrix.getPayment({
        domain: command.domain,
        accessToken,
        paymentId: input.bitrixPaymentId,
      });
    }
    const resolved = await this.repository.resolveAmbiguity({
      commandId,
      resolution: input.resolution,
      bitrixPaymentId: input.resolution === 'attach_existing'
        ? input.bitrixPaymentId
        : undefined,
      expectedVersion: input.expectedVersion,
      resolvedBy: Number(request.user.id),
      reason: input.reason,
      requestId: request.requestId,
    });
    if (resolved.status === 'confirmed_not_created') {
      return {
        commandId: resolved.commandId,
        status: resolved.status,
        bitrixPaymentId: null,
        message: 'Подтверждено: платёж Bitrix24 не был создан',
      };
    }
    return this.commands.continueAfterAdministrativeResolution(resolved);
  }
}
