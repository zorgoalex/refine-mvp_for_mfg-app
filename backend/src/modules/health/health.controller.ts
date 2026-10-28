import { Controller, Get, Inject } from '@nestjs/common';
import { HealthService } from './health.service';
import type { LiveHealthResponse, ReadyHealthResponse } from './health.contract';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get('live')
  live(): LiveHealthResponse {
    return this.healthService.live();
  }

  @Get('ready')
  ready(): Promise<ReadyHealthResponse> {
    return this.healthService.ready();
  }

  /**
   * What this backend can do, for an open tab of a newer frontend (GET /api/v1/health/capabilities, no auth, no
   * secrets): after a backend rollback the tab hides what the backend lacks instead of sending lost fields.
   */
  @Get('capabilities')
  capabilities(): { bazisProjectCards: true } {
    return { bazisProjectCards: true };
  }
}
