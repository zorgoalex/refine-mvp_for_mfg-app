import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../permissions/current-user';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { EMPLOYEE_CONTACT_KINDS, EMPLOYEE_CONTACTS_MAX, type EmployeeContactInput } from '../employees/employee-contacts';
import type { PartyKind } from './party-contacts';
import { ClientCounterpartyRepository } from './client-counterparty.repository';
import { PartyContactsRepository } from './party-contacts.repository';
import { SupplierCounterpartyRepository, parseRefKey1c } from './supplier-counterparty.repository';

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

const linkSchema = z.object({ refKey1c: z.string().nullable(), expectedRefKey1c: z.string().nullable() }).strict();
const fromCounterpartySchema = z.object({ refKey1c: z.string() }).strict();

/**
 * Contacts of suppliers, vendors and clients, and the supplier / client ↔ 1C counterparty links. One explicit route per
 * owner, so each carries its own permissions (view: <owner>.view; change: suppliers.manage / vendors.manage /
 * clients.update).
 */
@ApiTags('Party contacts')
@ApiBearerAuth('bearerAuth')
@Controller()
@UseGuards(PermissionsGuard)
export class PartyContactsController {
  constructor(
    @Inject(PartyContactsRepository) private readonly contacts: PartyContactsRepository,
    @Inject(SupplierCounterpartyRepository) private readonly counterparties: SupplierCounterpartyRepository,
    @Inject(ClientCounterpartyRepository) private readonly clientCounterparties: ClientCounterpartyRepository,
  ) {}

  @ApiOperation({ summary: 'Contacts of a supplier with the set version' })
  @Get('suppliers/:id/contacts') @RequirePermissions(['suppliers.view'])
  supplier(@Param('id') id: string) { return this.contacts.get('supplier', parseId(id)); }

  @ApiOperation({ summary: 'Replace the contacts of a supplier (version compare-and-swap; one primary per kind)' })
  @Put('suppliers/:id/contacts') @RequirePermissions(['suppliers.manage'])
  replaceSupplier(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) { return this.replace('supplier', id, body, request); }

  @ApiOperation({ summary: 'Contacts of several suppliers (the list column)' })
  @Get('supplier-contacts') @RequirePermissions(['suppliers.view'])
  suppliers(@Query('ids') ids: unknown) { return this.list('supplier', ids); }

  @ApiOperation({ summary: 'Contacts of a vendor with the set version' })
  @Get('vendors/:id/contacts') @RequirePermissions(['vendors.view'])
  vendor(@Param('id') id: string) { return this.contacts.get('vendor', parseId(id)); }

  @ApiOperation({ summary: 'Replace the contacts of a vendor (version compare-and-swap; one primary per kind)' })
  @Put('vendors/:id/contacts') @RequirePermissions(['vendors.manage'])
  replaceVendor(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) { return this.replace('vendor', id, body, request); }

  @ApiOperation({ summary: 'Contacts of several vendors (the list column)' })
  @Get('vendor-contacts') @RequirePermissions(['vendors.view'])
  vendors(@Query('ids') ids: unknown) { return this.list('vendor', ids); }

  @ApiOperation({ summary: 'Emails and Telegram accounts of a client with the set version (phones stay in client phones)' })
  @Get('clients/:id/contacts') @RequirePermissions(['clients.view'])
  client(@Param('id') id: string) { return this.contacts.get('client', parseId(id)); }

  @ApiOperation({ summary: 'Replace the emails and Telegram accounts of a client (version compare-and-swap)' })
  @Put('clients/:id/contacts') @RequirePermissions(['clients.update'])
  replaceClient(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) { return this.replace('client', id, body, request); }

  @ApiOperation({ summary: '1C counterparties a supplier can be linked to (the 1C mirror, else procurement documents)' })
  @Get('supplier-counterparties') @RequirePermissions(['suppliers.view'])
  async supplierCounterparties(@Query('search') search: unknown) {
    const text = typeof search === 'string' && search.trim() ? search.trim().slice(0, 100) : null;
    return { items: await this.counterparties.counterparties(text) };
  }

  @ApiOperation({ summary: 'The 1C counterparty a supplier is linked to' })
  @Get('suppliers/:id/counterparty') @RequirePermissions(['suppliers.view'])
  supplierCounterparty(@Param('id') id: string) { return this.counterparties.link(parseId(id)); }

  @ApiOperation({ summary: 'Link, relink or unlink a supplier and a 1C counterparty (compare-and-swap on the previous key)' })
  @Put('suppliers/:id/counterparty') @RequirePermissions(['suppliers.manage'])
  linkSupplier(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный запрос привязки');
    const { user, requestId } = actor(request);
    return this.counterparties.setLink(parseId(id), parsed.data.refKey1c === null ? null : parseRefKey1c(parsed.data.refKey1c),
      parsed.data.expectedRefKey1c === null ? null : parseRefKey1c(parsed.data.expectedRefKey1c), user, requestId);
  }

  @ApiOperation({ summary: 'Add a 1C counterparty to the suppliers directory (idempotent by the key)' })
  @Post('suppliers/from-counterparty') @HttpCode(200) @RequirePermissions(['suppliers.manage'])
  supplierFromCounterparty(@Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = fromCounterpartySchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный запрос');
    const { user, requestId } = actor(request);
    return this.counterparties.createFromCounterparty(parseRefKey1c(parsed.data.refKey1c), user, requestId);
  }

  @ApiOperation({ summary: 'The 1C counterparty a client is linked to' })
  @Get('clients/:id/counterparty') @RequirePermissions(['clients.view'])
  clientCounterparty(@Param('id') id: string) { return this.clientCounterparties.link(parseId(id)); }

  // The search opens the whole 1C counterparty directory (names, BIN/IIN, phones): only for those who may link.
  @ApiOperation({ summary: '1C counterparties for a client: by a search text, or the ones that look like the client (name, phone)' })
  @Get('clients/:id/counterparty-candidates') @RequirePermissions(['clients.update'])
  async clientCounterpartyCandidates(@Param('id') id: string, @Query('search') search: unknown) {
    const text = typeof search === 'string' && search.trim() ? search.trim().slice(0, 100) : null;
    return { items: await this.clientCounterparties.candidates(parseId(id), text) };
  }

  @ApiOperation({ summary: 'Link, relink or unlink a client and a 1C counterparty (compare-and-swap on the previous key)' })
  @Put('clients/:id/counterparty') @RequirePermissions(['clients.update'])
  linkClient(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный запрос сопоставления');
    const { user, requestId } = actor(request);
    return this.clientCounterparties.setLink(parseId(id), parsed.data.refKey1c === null ? null : parseRefKey1c(parsed.data.refKey1c),
      parsed.data.expectedRefKey1c === null ? null : parseRefKey1c(parsed.data.expectedRefKey1c), user, requestId);
  }

  private replace(party: PartyKind, id: string, body: unknown, request: RequestWithCurrentUser) {
    const parsed = replaceSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный набор контактов');
    const { user, requestId } = actor(request);
    const contacts: EmployeeContactInput[] = parsed.data.contacts.map((contact) => ({ ...contact, note: contact.note ?? null }));
    return this.contacts.replace(party, parseId(id), parsed.data.version, contacts, user, requestId);
  }

  private async list(party: PartyKind, value: unknown) {
    const ids = parseIds(value);
    const contacts = await this.contacts.listFor(party, ids);
    return { items: ids.map((id) => ({ id, contacts: contacts.get(id) ?? [] })) };
  }
}

function actor(request: RequestWithCurrentUser): { user: CurrentUser; requestId: string } {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return { user: request.user, requestId: request.requestId };
}

export function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный идентификатор');
  return id;
}

/** `ids=1,2,3` — at most 500 ids. */
export function parseIds(value: unknown): number[] {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список');
  const ids = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean).map(Number))];
  if (ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список');
  return ids;
}
