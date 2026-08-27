import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { Bitrix24ReverseIngressService } from './bitrix24-reverse-ingress.service';

@ApiExcludeController()
@ApiTags('Bitrix24')
@Controller('integrations/bitrix24')
export class Bitrix24ReverseController {
  constructor(private readonly ingress: Bitrix24ReverseIngressService) {}

  @ApiOperation({ summary: 'Install Bitrix24 local application callback' })
  @Post('install')
  install(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<{ status: 'success' }> {
    return this.ingress.install(body, request.requestId ?? 'bitrix24-install');
  }

  @ApiOperation({ summary: 'Receive authenticated Bitrix24 event callback' })
  @Post('events')
  receiveEvent(@Body() body: unknown): Promise<{ accepted: true }> {
    return this.ingress.receiveEvent(body);
  }
}
