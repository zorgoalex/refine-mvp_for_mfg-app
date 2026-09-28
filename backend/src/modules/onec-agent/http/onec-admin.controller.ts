import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { OnecAdminService } from '../application/onec-admin.service';
import { OnecCommandsService } from '../application/onec-commands.service';
import { OnecEtlAdminService } from '../application/onec-etl-admin.service';
import type { OnecRequestContext } from '../application/onec-audit';
import { OnecPermissionsGuard } from './onec-permissions.guard';

function user(request: RequestWithCurrentUser): CurrentUser {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function requestId(request: RequestWithCurrentUser & { headers?: Record<string, string | string[] | undefined> }): OnecRequestContext {
  const raw = request.headers?.['x-correlation-id'];
  const correlation = Array.isArray(raw) ? raw[0] : raw;
  return { requestId: request.requestId ?? `onec-admin-${Date.now()}`, correlationId: correlation ? correlation.slice(0, 100) : null };
}

function positiveId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'INVALID_ID', 'Invalid id');
  return id;
}

function commandUuid(value: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new ApiError(400, 'INVALID_ID', 'Invalid command id');
  }
  return value.toLowerCase();
}

function agentId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new ApiError(400, 'INVALID_ID', 'Invalid agent id');
  return value;
}

/** Admin API of the 1C integration (JWT; onec.* permissions). */
@ApiTags('1C integration')
@Controller('onec')
@UseGuards(OnecPermissionsGuard)
export class OnecAdminController {
  constructor(
    @Inject(OnecAdminService) private readonly service: OnecAdminService,
    @Inject(OnecCommandsService) private readonly commands: OnecCommandsService,
    @Inject(OnecEtlAdminService) private readonly etl: OnecEtlAdminService,
  ) {}

  @ApiOperation({ summary: 'Overview of 1C agents: connection, state, queues, certificates, configuration' })
  @Get('overview')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  overview() {
    return this.service.overview();
  }

  @ApiOperation({ summary: 'List 1C sources (databases)' })
  @Get('sources')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  listSources() {
    return this.service.listSources();
  }

  @ApiOperation({ summary: 'Create a 1C source' })
  @Post('sources')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  createSource(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.createSource(body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Rename a 1C source' })
  @Patch('sources/:sourceId')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  updateSource(@Param('sourceId') sourceId: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.updateSource(positiveId(sourceId), body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Register a 1C agent for a source' })
  @Post('agents')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  createAgent(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.createAgent(body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Get a 1C agent with certificates and state history' })
  @Get('agents/:agentId')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  getAgent(@Param('agentId') id: string) {
    return this.service.getAgent(agentId(id));
  }

  @ApiOperation({ summary: 'Update a 1C agent (optimistic version)' })
  @Patch('agents/:agentId')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  updateAgent(@Param('agentId') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.updateAgent(agentId(id), body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Block a 1C agent (403 on everything except heartbeat)' })
  @Post('agents/:agentId/block')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  block(@Param('agentId') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.setAgentStatus(agentId(id), 'blocked', body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Unblock a 1C agent' })
  @Post('agents/:agentId/unblock')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  unblock(@Param('agentId') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.setAgentStatus(agentId(id), 'active', body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Register a client certificate (PEM or SHA-256 fingerprint) for a 1C agent' })
  @Post('agents/:agentId/certificates')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  addCertificate(@Param('agentId') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.addCertificate(agentId(id), body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Revoke a 1C agent client certificate' })
  @Post('agents/:agentId/certificates/:certId/revoke')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  revokeCertificate(@Param('agentId') id: string, @Param('certId') certId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.revokeCertificate(agentId(id), positiveId(certId), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Get draft, published configuration and agent-reported versions' })
  @Get('agents/:agentId/config')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  getConfiguration(@Param('agentId') id: string) {
    return this.service.getConfiguration(agentId(id));
  }

  @ApiOperation({ summary: 'Validate a configuration without saving' })
  @Post('config/validate')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  validateConfiguration(@Body() body: unknown) {
    return this.service.validateConfiguration(body);
  }

  @ApiOperation({ summary: 'Save the configuration draft (If-Match: draft revision)' })
  @Put('agents/:agentId/config/draft')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  saveDraft(
    @Param('agentId') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ) {
    return this.service.saveDraft(agentId(id), ifMatch, body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Publish the confirmed draft revision as a new configuration version' })
  @Post('agents/:agentId/config/publish')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  publish(@Param('agentId') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.publish(agentId(id), body, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'List published configuration versions of a 1C agent' })
  @Get('agents/:agentId/config/versions')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  listConfigVersions(@Param('agentId') id: string) {
    return this.service.listConfigVersions(agentId(id));
  }

  @ApiOperation({ summary: 'List 1C agent commands (journal; no payload/result bodies)' })
  @Get('commands')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  listCommands(@Query() query: { agentId?: string; status?: string; commandType?: string; limit?: string }) {
    return this.commands.list(query);
  }

  @ApiOperation({ summary: 'Get a 1C agent command; payload/result bodies only with onec.manage or onec.commands.send' })
  @Get('commands/:commandId')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  getCommand(@Param('commandId') commandId: string, @Req() request: RequestWithCurrentUser) {
    const permissions = request.user?.permissions ?? [];
    const includeBodies = permissions.includes('onec.manage') || permissions.includes('onec.commands.send');
    return this.commands.get(commandUuid(commandId), includeBodies);
  }

  @ApiOperation({ summary: 'Queue an admin command or the integration probe for a 1C agent (Idempotency-Key required)' })
  @Post('agents/:agentId/commands')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.commands.send')
  sendCommand(
    @Param('agentId') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ) {
    return this.commands.operatorEnqueue(agentId(id), body, idempotencyKey, user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Cancel a 1C agent command that the agent has not received yet' })
  @Post('commands/:commandId/cancel')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.commands.send')
  cancelCommand(@Param('commandId') commandId: string, @Req() request: RequestWithCurrentUser) {
    return this.commands.cancel(commandUuid(commandId), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'List 1C integration incidents' })
  @Get('incidents')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  listIncidents(@Query() query: { agentId?: string; open?: string; limit?: string }) {
    return this.service.listIncidents(query);
  }

  @ApiOperation({ summary: 'Resolve a 1C integration incident' })
  @Post('incidents/:incidentId/resolve')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  resolveIncident(@Param('incidentId') incidentId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.resolveIncident(positiveId(incidentId), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'List 1C integration alerts' })
  @Get('alerts')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  listAlerts(@Query() query: { agentId?: string; state?: string; limit?: string }) {
    return this.service.listAlerts(query);
  }

  @ApiOperation({ summary: 'Acknowledge a 1C integration alert' })
  @Post('alerts/:alertId/acknowledge')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  acknowledgeAlert(@Param('alertId') alertId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.acknowledgeAlert(positiveId(alertId), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Resolve a handled one-shot 1C command alert' })
  @Post('alerts/:alertId/resolve')
  @HttpCode(200)
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.manage')
  resolveAlert(@Param('alertId') alertId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.resolveAlert(positiveId(alertId), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'List 1C ETL runs (journal; no row data)' })
  @Get('etl/runs')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  listEtlRuns(@Query() query: { agentId?: string; limit?: string }) {
    return this.etl.listRuns(query);
  }

  @ApiOperation({ summary: 'One 1C ETL run with its batches' })
  @Get('etl/runs/:runId')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  getEtlRun(@Param('runId') runId: string) {
    return this.etl.getRun(commandUuid(runId));
  }

  @ApiOperation({ summary: 'State of every 1C ETL entity (rows, missing, last run, errors)' })
  @Get('etl/entities')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  listEtlEntities(@Query('agentId') id: string | undefined) {
    return this.etl.listEntities(id ? agentId(id) : undefined);
  }
}
