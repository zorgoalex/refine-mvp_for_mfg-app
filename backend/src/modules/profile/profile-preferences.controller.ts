import { Body, Controller, Get, Inject, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { ProfilePreferencesService } from './profile-preferences.service';
import {
  RECENT_REFERENCE_RESOURCES,
  UI_VARIANTS,
  type RecentReferenceResource,
  type UserPreferencesDto,
  type UserPreferencesResponseDto,
} from './profile-preferences.types';

const MAX_PAGE_SIZE_PREFERENCES_PER_REQUEST = 32;
const MAX_SIDEBAR_MENU_SECTIONS = 40;
const MAX_SIDEBAR_MENU_ITEMS_PER_SECTION = 160;

const sidebarMenuOrderSchema = z.object({
  top: z.array(z.string().min(1).max(80)).max(MAX_SIDEBAR_MENU_ITEMS_PER_SECTION),
  categories: z.array(z.string().min(1).max(80)).max(MAX_SIDEBAR_MENU_SECTIONS),
  resources: z.record(
    z.string().min(1).max(80),
    z.array(z.string().min(1).max(80)).max(MAX_SIDEBAR_MENU_ITEMS_PER_SECTION),
  ).refine(
    (sections) => Object.keys(sections).length <= MAX_SIDEBAR_MENU_SECTIONS,
    { message: `sidebarMenuOrder.resources must contain at most ${MAX_SIDEBAR_MENU_SECTIONS} sections` },
  ),
});

const updatePreferencesSchema = z.object({
  themeMode: z.enum(['light', 'dark']).optional(),
  uiSize: z.enum(['default', 'small']).optional(),
  uiVariant: z.enum(UI_VARIANTS).optional(),
  orderDetailColumns: z.record(
    z.string().min(1).max(80),
    z.object({
      order: z.array(z.string().min(1).max(80)).max(80),
      hidden: z.array(z.string().min(1).max(80)).max(80),
    }),
  ).optional(),
  pageSizePreferences: z.record(
    z.string().min(1).max(120),
    z.union([
      z.literal(10),
      z.literal(20),
      z.literal(25),
      z.literal(50),
      z.literal(100),
    ]),
  ).refine(
    (preferences) => Object.keys(preferences).length <= MAX_PAGE_SIZE_PREFERENCES_PER_REQUEST,
    { message: `pageSizePreferences must contain at most ${MAX_PAGE_SIZE_PREFERENCES_PER_REQUEST} entries` },
  ).optional(),
  sidebarMenuOrder: sidebarMenuOrderSchema.optional(),
});

const referenceUsageSchema = z.object({
  resource: z.enum(RECENT_REFERENCE_RESOURCES),
  entityId: z.number().int().positive(),
}).strict();

export interface ReferenceUsageRequest {
  resource: RecentReferenceResource;
  entityId: number;
}

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

  @ApiOperation({ operationId: 'promoteCurrentUserReferenceUsage', summary: 'Remember current user reference usage' })
  @ApiResponse({ status: 200, description: 'Updated current user preferences' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 422, description: 'Invalid reference usage payload' })
  @Post('reference-usage')
  async promoteReferenceUsage(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<UserPreferencesResponseDto> {
    const currentUser = requireCurrentUser(request);
    const usage = parseReferenceUsageRequest(body);
    return {
      preferences: await this.preferences.promoteReferenceUsage({
        currentUser,
        ...usage,
      }),
    };
  }
}

export function parseReferenceUsageRequest(body: unknown): ReferenceUsageRequest {
  const result = referenceUsageSchema.safeParse(body);
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid reference usage payload', {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function requireCurrentUser(request: RequestWithCurrentUser) {
  if (!request.user) {
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  return request.user;
}
