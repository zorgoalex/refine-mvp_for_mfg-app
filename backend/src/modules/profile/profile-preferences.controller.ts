import { Body, Controller, Get, Inject, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { ProfilePreferencesService } from './profile-preferences.service';
import type { UserPreferencesDto, UserPreferencesResponseDto } from './profile-preferences.types';

const updatePreferencesSchema = z.object({
  themeMode: z.enum(['light', 'dark']).optional(),
});

export function parseUpdateUserPreferencesRequest(body: unknown): Partial<UserPreferencesDto> {
  const result = updatePreferencesSchema.safeParse(body);
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid user preferences payload', {
      issues: result.error.issues,
    });
  }

  return result.data;
}

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('me/preferences')
export class ProfilePreferencesController {
  constructor(
    @Inject(ProfilePreferencesService)
    private readonly preferences: ProfilePreferencesService,
  ) {}

  @ApiOperation({ operationId: 'getCurrentUserPreferences', summary: 'Get current user preferences' })
  @ApiResponse({ status: 200, description: 'Current user preferences' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @Get()
  async get(@Req() request: RequestWithCurrentUser): Promise<UserPreferencesResponseDto> {
    const currentUser = requireCurrentUser(request);
    return {
      preferences: await this.preferences.get({ currentUser }),
    };
  }

  @ApiOperation({ operationId: 'updateCurrentUserPreferences', summary: 'Update current user preferences' })
  @ApiResponse({ status: 200, description: 'Updated current user preferences' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 422, description: 'Invalid preferences payload' })
  @Patch()
  async update(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<UserPreferencesResponseDto> {
    const currentUser = requireCurrentUser(request);
    return {
      preferences: await this.preferences.update({
        currentUser,
        preferences: parseUpdateUserPreferencesRequest(body),
      }),
    };
  }
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}
