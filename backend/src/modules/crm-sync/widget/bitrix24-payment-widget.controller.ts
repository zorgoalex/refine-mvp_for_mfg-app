import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import {
  parseCreateWidgetPaymentInput,
  parseIdempotencyKey,
  parseWidgetAuthorization,
} from './bitrix24-payment-widget.dto';
import { Bitrix24PaymentWidgetAuthService } from './bitrix24-payment-widget-auth.service';
import { Bitrix24ManualPaymentCommandService } from './bitrix24-manual-payment-command.service';

const ASSET_DIR = join(process.cwd(), 'assets', 'bitrix24-payment-widget');

@ApiExcludeController()
@Controller('integrations/bitrix24')
export class Bitrix24PaymentWidgetController {
  constructor(
    private readonly auth: Bitrix24PaymentWidgetAuthService,
    private readonly commands: Bitrix24ManualPaymentCommandService,
  ) {}

  @Post('widget/deal-payment')
  async bootstrap(
    @Req() request: Request & { requestId?: string },
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const session = await this.auth.bootstrap(request.query, body);
      secureHtml(response);
      response.status(200).send(widgetHtml(session));
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, 'INTERNAL_ERROR', 'Internal server error');
      secureHtml(response);
      response.status(apiError.statusCode).send(errorHtml(apiError, request.requestId));
    }
  }

  @Get('widget-assets/widget.css')
  widgetCss(@Res() response: Response): void {
    response
      .set({
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(readFileSync(join(ASSET_DIR, 'widget.css'), 'utf8'));
  }

  @Get('widget-assets/widget.js')
  widgetJs(@Res() response: Response): void {
    response
      .set({
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(readFileSync(join(ASSET_DIR, 'widget.js'), 'utf8'));
  }

  @Get('widget-api/context')
  async context(@Headers('authorization') authorization: unknown) {
    const authenticated = await this.auth.authenticate(
      parseWidgetAuthorization(authorization),
    );
    return this.commands.getContext(authenticated);
  }

  @Post('widget-api/payments')
  async createPayment(
    @Req() request: Request & { requestId?: string },
    @Res({ passthrough: true }) response: Response,
    @Headers('authorization') authorization: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
  ) {
    const authenticated = await this.auth.authenticate(
      parseWidgetAuthorization(authorization),
    );
    const result = await this.commands.create({
      authenticated,
      idempotencyKey: parseIdempotencyKey(idempotencyKey),
      body: parseCreateWidgetPaymentInput(body),
      requestId: request.requestId ?? 'bitrix24-widget-payment',
    });
    response.status(result.created ? 201 : 200);
    return result.response;
  }

  @Get('widget-api/commands/:commandId')
  async getCommand(
    @Headers('authorization') authorization: unknown,
    @Param('commandId') commandId: string,
  ) {
    const authenticated = await this.auth.authenticate(
      parseWidgetAuthorization(authorization),
    );
    return this.commands.getCommand(authenticated, commandId);
  }

  @Post('widget-api/commands/:commandId/retry')
  async retryCommand(
    @Headers('authorization') authorization: unknown,
    @Param('commandId') commandId: string,
  ) {
    const authenticated = await this.auth.authenticate(
      parseWidgetAuthorization(authorization),
    );
    return this.commands.retry(authenticated, commandId);
  }

  @Post('widget-api/commands/:commandId/reauthorize')
  async reauthorizeCommand(
    @Headers('authorization') authorization: unknown,
    @Param('commandId') commandId: string,
  ) {
    const authenticated = await this.auth.authenticate(
      parseWidgetAuthorization(authorization),
    );
    return this.commands.reauthorize(authenticated, commandId);
  }

  @Post('widget-api/commands/:commandId/confirm-overpayment')
  async confirmOverpayment(
    @Headers('authorization') authorization: unknown,
    @Param('commandId') commandId: string,
  ) {
    const authenticated = await this.auth.authenticate(
      parseWidgetAuthorization(authorization),
    );
    return this.commands.confirmOverpayment(authenticated, commandId);
  }
}

function secureHtml(response: Response): void {
  response.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      'frame-ancestors https://mebelkz.bitrix24.kz',
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.removeHeader('X-Frame-Options');
}

function widgetHtml(input: {
  token: string;
  dealId: string;
  actorDisplayName: string;
}): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Оплата ERP</title><link rel="stylesheet" href="../widget-assets/widget.css"></head>
<body data-widget-token="${escapeHtml(input.token)}">
<main class="shell">
  <header><div><h1>Оплата ERP</h1><p id="subtitle">Сделка #${escapeHtml(input.dealId)} · ${escapeHtml(input.actorDisplayName)}</p></div><button id="refresh" class="secondary" type="button">Обновить</button></header>
  <div id="notice" class="notice" role="status" aria-live="polite">Загрузка…</div>
  <section id="summary" class="summary" hidden></section>
  <form id="payment-form" hidden>
    <label>Сумма, ₸<input id="amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="50000.00" required></label>
    <label>Дата оплаты<input id="paymentDate" name="paymentDate" type="date" required></label>
    <label>Платёжная система<select id="paySystemId" name="paySystemId" required></select></label>
    <label>Комментарий<textarea id="comment" name="comment" maxlength="1000" rows="3" placeholder="Необязательно"></textarea></label>
    <label id="overpayment-row" class="check" hidden><input id="confirmOverpayment" type="checkbox"> Подтверждаю переплату заказа ERP</label>
    <button id="submit" type="submit">Добавить оплату</button>
  </form>
  <section class="recent"><h2>Последние оплаты</h2><div id="recent-list" class="empty">Нет данных</div></section>
</main>
<script src="../widget-assets/widget.js" defer></script></body></html>`;
}

function errorHtml(error: ApiError, requestId?: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата ERP</title><link rel="stylesheet" href="../widget-assets/widget.css"></head><body><main class="shell error"><h1>Оплата ERP недоступна</h1><p>${escapeHtml(error.message)}</p><p class="muted">Код: ${escapeHtml(error.code)} · запрос ${escapeHtml(requestId ?? 'unknown')}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character);
}
