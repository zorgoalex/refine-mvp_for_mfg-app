import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import type { LiveHealthResponse, ReadyHealthResponse } from './health.contract';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live(): LiveHealthResponse {
    return this.healthService.live();
  }

  @Get('ready')
  ready(): Promise<ReadyHealthResponse> {
    return this.healthService.ready();
  }
}
