import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { OnecAgentContext } from '../application/onec-audit';
import { OnecAgentProtocolService } from '../application/onec-agent-protocol.service';
import { ONEC_ALLOW_BLOCKED_METADATA_KEY, OnecAgentAuthGuard } from './onec-agent-auth.guard';

const AllowBlockedAgent = () => SetMetadata(ONEC_ALLOW_BLOCKED_METADATA_KEY, true);

function agentOf(request: { onecAgent?: OnecAgentContext }): OnecAgentContext {
  if (!request.onecAgent) throw new ApiError(403, 'FORBIDDEN', 'Forbidden');
  return request.onecAgent;
}

/**
 * Agent-facing API (spec erp-agent-api-spec.md). Served only on the
 * dedicated agent listener behind the Traefik mTLS router; excluded from the
 * global /api/v1 prefix in main.ts.
 */
@ApiTags('1C agent protocol')
@Controller('api/integration/1c-agents/v1')
@UseGuards(OnecAgentAuthGuard)
export class OnecAgentController {
  constructor(@Inject(OnecAgentProtocolService) private readonly protocol: OnecAgentProtocolService) {}

  @ApiOperation({ summary: 'Start an agent session and check version compatibility (mTLS)' })
  @Post('session/start')
  @HttpCode(200)
  startSession(@Req() request: { onecAgent?: OnecAgentContext }, @Body() body: unknown) {
    return this.protocol.startSession(agentOf(request), body);
  }

  @ApiOperation({ summary: 'Accept an agent heartbeat (allowed for blocked agents)' })
  @Post('heartbeat')
  @HttpCode(204)
  @AllowBlockedAgent()
  async heartbeat(@Req() request: { onecAgent?: OnecAgentContext }, @Body() body: unknown): Promise<void> {
    await this.protocol.heartbeat(agentOf(request), body);
  }

  @ApiOperation({ summary: 'Return the published agent configuration or 304 when unchanged' })
  @Get('configuration')
  async configuration(
    @Req() request: { onecAgent?: OnecAgentContext },
    @Query('currentVersion') currentVersion: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.protocol.configuration(agentOf(request), currentVersion);
    response.setHeader('Cache-Control', 'no-store');
    if (result.notModified) {
      response.status(304).end();
      return;
    }
    response.status(200).type('application/json; charset=utf-8').send(result.body);
  }
}
