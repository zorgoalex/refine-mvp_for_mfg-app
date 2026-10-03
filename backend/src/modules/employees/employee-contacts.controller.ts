import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { EMPLOYEE_CONTACT_KINDS, EMPLOYEE_CONTACTS_MAX, EMPLOYEES_MANAGE, EMPLOYEES_VIEW, type EmployeeContactInput } from './employee-contacts';
import { EmployeeContactsRepository } from './employee-contacts.repository';

const replaceSchema = z.object({
  version: z.number().int().min(0),
  contacts: z.array(z.object({
    contactId: z.number().int().positive().nullable(),
    kind: z.enum(EMPLOYEE_CONTACT_KINDS),
    value: z.string().trim().min(1).max(200),
    isPrimary: z.boolean(),
    note: z.string().max(200).nullable().optional(),
  }).strict()).max(EMPLOYEE_CONTACTS_MAX),
}).strict();

@ApiTags('Employees')
@ApiBearerAuth('bearerAuth')
@Controller()
@UseGuards(PermissionsGuard)
export class EmployeeContactsController {
  constructor(@Inject(EmployeeContactsRepository) private readonly repository: EmployeeContactsRepository) {}

  @ApiOperation({ summary: 'Work contacts of one employee (phones, emails, Telegram accounts) with the set version' })
  @Get('employees/:employeeId/contacts') @RequirePermissions([EMPLOYEES_VIEW])
  get(@Param('employeeId') employeeId: string) {
    return this.repository.get(parseEmployeeId(employeeId));
  }

  @ApiOperation({ summary: 'Replace the work contacts of an employee (version compare-and-swap; one primary per kind)' })
  @Put('employees/:employeeId/contacts') @RequirePermissions([EMPLOYEES_MANAGE])
  replace(@Param('employeeId') employeeId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = replaceSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный набор контактов');
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
    const contacts: EmployeeContactInput[] = parsed.data.contacts.map((contact) => ({ ...contact, note: contact.note ?? null }));
    return this.repository.replace(parseEmployeeId(employeeId), parsed.data.version, contacts, request.user, request.requestId);
  }

  @ApiOperation({ summary: 'Work contacts of several employees (the employees list)' })
  @Get('employee-contacts') @RequirePermissions([EMPLOYEES_VIEW])
  async list(@Query('employeeIds') employeeIds: unknown) {
    const ids = parseEmployeeIds(employeeIds);
    const contacts = await this.repository.listFor(ids);
    return { items: ids.map((employeeId) => ({ employeeId, contacts: contacts.get(employeeId) ?? [] })) };
  }
}

export function parseEmployeeId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный идентификатор сотрудника');
  return id;
}

/** `employeeIds=1,2,3` — at most 500 ids. */
export function parseEmployeeIds(value: unknown): number[] {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список сотрудников');
  const ids = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean).map(Number))];
  if (ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список сотрудников');
  }
  return ids;
}
