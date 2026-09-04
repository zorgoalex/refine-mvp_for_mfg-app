import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24PaymentWidgetInstallService } from './bitrix24-payment-widget-install.service';

@ApiExcludeController()
@Controller('integrations/bitrix24')
export class Bitrix24PaymentWidgetInstallController {
  constructor(
    private readonly install: Bitrix24PaymentWidgetInstallService,
    private readonly config: CrmSyncRuntimeConfigService,
  ) {}

  @Post('install-ui')
  async installUi(
    @Req() request: Request & { requestId?: string },
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const result = await this.install.begin(body);
      installHeaders(response, result.domain);
      const apiPrefix = this.config.getReverseSync().apiPrefix;
      response.status(200).send(installHtml(result.state, `${apiPrefix}/integrations/bitrix24/app`));
    } catch (error) {
      const apiError = asApiError(error);
      installHeaders(response, this.config.getReverseSync().portalDomain);
      response.status(apiError.statusCode).send(statusHtml(
        'Установка не завершена',
        apiError.message,
        request.requestId,
      ));
    }
  }

  @Get('app')
  appGet(@Req() request: Request & { requestId?: string }, @Res() response: Response): void {
    installHeaders(response, this.config.getReverseSync().portalDomain);
    response.status(200).send(statusHtml(
      'ERP — синхронизация Bitrix24',
      'Откройте приложение из портала Bitrix24, чтобы проверить статус.',
      request.requestId,
    ));
  }

  @Post('app')
  async appPost(
    @Req() request: Request & { requestId?: string },
    @Query('state') state: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const result = await this.install.finish({
        state,
        body,
        requestId: request.requestId ?? 'bitrix24-app',
      });
      installHeaders(response, result.domain);
      response.status(200).send(statusHtml(
        'Приложение активно',
        `Виджет «Оплата ERP» установлен. Администратор Bitrix24: #${result.executorBitrixUserId}.`,
        request.requestId,
      ));
    } catch (error) {
      const apiError = asApiError(error);
      installHeaders(response, this.config.getReverseSync().portalDomain);
      response.status(apiError.statusCode).send(statusHtml(
        'Приложение не активировано',
        apiError.message,
        request.requestId,
      ));
    }
  }
}

function installHeaders(response: Response, domain: string): void {
  response.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self' https://api.bitrix24.com",
      "style-src 'self'",
      `connect-src 'self' https://${domain}`,
      `frame-ancestors https://${domain}`,
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.removeHeader('X-Frame-Options');
}

function installHtml(state: string, appPath: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Установка ERP</title><link rel="stylesheet" href="widget-assets/widget.css"></head><body data-install-state="${escapeHtml(state)}" data-app-path="${escapeHtml(appPath)}"><main class="shell"><h1>Установка ERP</h1><div id="notice" class="notice">Завершаю регистрацию приложения…</div></main><script src="https://api.bitrix24.com/api/v1/"></script><script src="widget-assets/install.js" defer></script></body></html>`;
}

function statusHtml(title: string, message: string, requestId?: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="widget-assets/widget.css"></head><body><main class="shell error"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="muted">Запрос: ${escapeHtml(requestId ?? 'unknown')}</p></main></body></html>`;
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(500, 'INTERNAL_ERROR', 'Internal server error');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character);
}
