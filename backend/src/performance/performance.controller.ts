import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../common/errors/api-error';
import type { RequestWithCurrentUser } from '../permissions/current-user';
import { PerformanceRumService } from './performance-rum.service';
import { PerformanceQueryTelemetryService } from './performance-query-telemetry.service';

@ApiTags('Performance')
@ApiBearerAuth()
@Controller('performance')
export class PerformanceController {
  constructor(
    private readonly rum: PerformanceRumService,
    private readonly queries: PerformanceQueryTelemetryService,
  ) {}

  @ApiOperation({ operationId: 'ingestPerformanceRum', summary: 'Ingest bounded order lifecycle RUM' })
  @ApiResponse({ status: 202, description: 'Batch accepted or already deduplicated' })
  @ApiResponse({ status: 413, description: 'RUM body exceeds the dedicated 16 KiB parser limit' })
  @ApiResponse({ status: 422, description: 'RUM body does not match the strict schema' })
  @ApiResponse({ status: 429, description: 'Per-user RUM ingest budget exceeded' })
  @Post('rum')
  @HttpCode(202)
  async ingest(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<{ accepted: boolean; duplicate: boolean }> {
    const currentUser = requireUser(request);
    try {
      return await this.rum.accept({
        currentUser,
        requestId: request.requestId,
        batch: body,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ApiError(422, 'PERFORMANCE_RUM_INVALID', 'Invalid performance RUM payload');
      }
      throw error;
    }
  }

  @ApiOperation({ operationId: 'getPerformanceQueryHistograms', summary: 'Read bounded app query histograms' })
  @ApiResponse({ status: 200, description: 'Query histogram snapshot' })
  @Get('query-histograms')
  histograms(@Req() request: RequestWithCurrentUser) {
    requirePerformanceReviewer(request);
    return this.queries.snapshot();
  }

  @ApiOperation({ operationId: 'getPerformanceRumSummary', summary: 'Read bounded RUM cohort summary' })
  @ApiResponse({ status: 200, description: 'RUM cohort summary without subject identifiers' })
  @Get('rum-summary')
  rumSummary(@Req() request: RequestWithCurrentUser) {
    requirePerformanceReviewer(request);
    return this.rum.snapshot();
  }
}

function requirePerformanceReviewer(request: RequestWithCurrentUser): void {
  const currentUser = requireUser(request);
  if (!currentUser.permissions.includes('system.health.view')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Insufficient permissions', {
      requiredPermissions: ['system.health.view'],
    });
  }
}

function requireUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  }
  return request.user;
}
