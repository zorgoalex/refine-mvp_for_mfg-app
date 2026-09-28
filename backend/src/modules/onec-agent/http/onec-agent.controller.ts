import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { OnecAgentContext } from '../application/onec-audit';
import { OnecAgentProtocolService } from '../application/onec-agent-protocol.service';
import type { CommandRow } from '../adapters/pg-onec-command-repository';
import { OnecCommandsService } from '../application/onec-commands.service';
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
  constructor(
    @Inject(OnecAgentProtocolService) private readonly protocol: OnecAgentProtocolService,
    @Inject(OnecCommandsService) private readonly commands: OnecCommandsService,
  ) {}

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

  @ApiOperation({ summary: 'Long poll for the next command (holds up to maxWaitSeconds)' })
  @Post('commands/lease')
  async lease(
    @Req() request: { onecAgent?: OnecAgentContext },
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    // Client gone before we answered: stop waiting (a command leased into a dead
    // connection is re-issued after the 60 s lease, spec §4.2).
    response.on('close', () => {
      if (!response.writableFinished) abort.abort();
    });
    const result = await this.commands.lease(agentOf(request), body, abort.signal);
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).type('application/json; charset=utf-8').send(leaseBody(result.hasCommand ? (result.command as CommandRow) : null, result));
  }

  @ApiOperation({ summary: 'Acknowledge a leased command as durably received (idempotent)' })
  @Post('commands/:commandId/received')
  @HttpCode(204)
  async received(@Req() request: { onecAgent?: OnecAgentContext }, @Param('commandId') commandId: string, @Body() body: unknown): Promise<void> {
    await this.commands.received(agentOf(request), uuid(commandId), body);
  }

  @ApiOperation({ summary: 'Store the command result byte for byte (idempotent; different body -> 409)' })
  @Put('commands/:commandId/result')
  @HttpCode(204)
  async result(@Req() request: { onecAgent?: OnecAgentContext; rawBody?: Buffer }, @Param('commandId') commandId: string): Promise<void> {
    await this.commands.result(agentOf(request), uuid(commandId), request.rawBody);
  }
}

function uuid(value: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new ApiError(404, 'COMMAND_NOT_FOUND', 'Command not found');
  }
  return value.toLowerCase();
}

/**
 * Lease envelope (spec §4.2/§4.3) built by hand so the stored canonical payload
 * bytes are sent verbatim (the agent re-canonicalizes and compares payloadHash).
 */
function leaseBody(command: CommandRow | null, meta: { leaseId?: string; leaseExpiresAtUtc?: string }): string {
  if (!command) return '{"hasCommand":false}';
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  const envelope = {
    commandId: command.commandId,
    commandType: command.commandType,
    payloadVersion: command.payloadVersion,
    priority: command.priority,
    orderingKey: command.orderingKey,
    correlationId: command.correlationId,
    createdAtUtc: iso(command.createdAt),
    notBeforeUtc: iso(command.notBeforeUtc),
    expiresAtUtc: iso(command.expiresAtUtc),
    requestedBy: command.requestedBy,
    payloadHash: command.payloadHash,
  };
  const head = JSON.stringify(envelope);
  return `{"hasCommand":true,"leaseId":${JSON.stringify(meta.leaseId)},"leaseExpiresAtUtc":${JSON.stringify(meta.leaseExpiresAtUtc)},"command":${head.slice(0, -1)},"payload":${command.payloadCanonical}}}`;
}
