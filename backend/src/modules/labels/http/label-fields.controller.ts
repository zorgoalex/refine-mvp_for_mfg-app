import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import type { LabelFieldCatalogItem } from '../application/bazis-field-catalog';
import { LabelsService } from '../application/labels.service';
import { LabelsRuntimeConfigService } from './labels-runtime-config.service';

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('label-fields')
export class LabelFieldsController {
  constructor(
    private readonly service: LabelsService,
    private readonly runtimeConfig: LabelsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'listLabelFields', summary: 'List label field catalog' })
  @Get()
  async list(@Req() request: RequestWithCurrentUser): Promise<LabelFieldCatalogItem[]> {
    assertLabelsEnabled(this.runtimeConfig);
    return this.service.listFields({ currentUser: requireUser(request), requestId: request.requestId ?? '' });
  }
}

export function assertLabelsEnabled(runtimeConfig: LabelsRuntimeConfigService): void {
  if (!runtimeConfig.getFeatureFlags().labelsEnabled) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Labels API is disabled', { feature: 'labels' });
  }
}

export function requireUser(request: RequestWithCurrentUser): CurrentUser {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}
