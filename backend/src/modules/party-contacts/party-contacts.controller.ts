import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../permissions/current-user';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { PARTY_ADDRESS_MAX, PARTY_CONFIG, PARTY_CONTACT_KINDS, PARTY_ONEC_CONTACTS_MAX, PARTY_OWN_CONTACTS_MAX, type PartyContactInput, type PartyKind } from './party-contacts';
import { CONFIRM_MAX, ClientCounterpartyRepository } from './client-counterparty.repository';
import { CLIENT_ONEC_DATA_VIEW } from './client-onec-visibility';
import { PartyContactsRepository } from './party-contacts.repository';
import { SupplierCounterpartyRepository, parseRefKey1c } from './supplier-counterparty.repository';
import { SupplierOnecContactsService } from './supplier-onec-contacts.service';
import { readOnecProfile } from './supplier-onec-contacts.repository';
import { DatabaseService } from '../../database/database.service';

const replaceSchema = z.object({
  version: z.number().int().min(0),
  contacts: z.array(z.object({
    contactId: z.number().int().positive().nullable(),
    kind: z.enum(PARTY_CONTACT_KINDS),
    value: z.string().trim().min(1).max(PARTY_ADDRESS_MAX),
    isPrimary: z.boolean(),
    note: z.string().max(200).nullable().optional(),
  }).strict()).max(PARTY_OWN_CONTACTS_MAX + PARTY_ONEC_CONTACTS_MAX),
}).strict();

const linkSchema = z.object({ refKey1c: z.string().nullable(), expectedRefKey1c: z.string().nullable() }).strict();
const confirmSchema = z.object({
  pairs: z.array(z.object({ clientId: z.number().int().positive(), refKey1c: z.string() }).strict()).min(1).max(CONFIRM_MAX),
}).strict();
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
    @Inject(SupplierOnecContactsService) private readonly onecContacts: SupplierOnecContactsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @ApiOperation({ summary: 'Contacts of a supplier with the set version' })
  @Get('suppliers/:id/contacts') @RequirePermissions(['suppliers.view'])
  supplier(@Param('id') id: string) { return this.contacts.get('supplier', parseOwnerId('supplier', id)); }

  @ApiOperation({ summary: 'Replace the contacts of a supplier (version compare-and-swap; one primary per kind)' })
  @Put('suppliers/:id/contacts') @RequirePermissions(['suppliers.manage'])
  replaceSupplier(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) { return this.replace('supplier', id, body, request); }

  @ApiOperation({ summary: 'Contacts of several suppliers (the list column)' })
  @Get('supplier-contacts') @RequirePermissions(['suppliers.view'])
  suppliers(@Query('ids') ids: unknown) { return this.list('supplier', ids); }

  @ApiOperation({ summary: 'Contacts of a vendor with the set version' })
  @Get('vendors/:id/contacts') @RequirePermissions(['vendors.view'])
  vendor(@Param('id') id: string) { return this.contacts.get('vendor', parseOwnerId('vendor', id)); }

  @ApiOperation({ summary: 'Replace the contacts of a vendor (version compare-and-swap; one primary per kind)' })
  @Put('vendors/:id/contacts') @RequirePermissions(['vendors.manage'])
  replaceVendor(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) { return this.replace('vendor', id, body, request); }

  @ApiOperation({ summary: 'Contacts of several vendors (the list column)' })
  @Get('vendor-contacts') @RequirePermissions(['vendors.view'])
  vendors(@Query('ids') ids: unknown) { return this.list('vendor', ids); }

  @ApiOperation({ summary: 'Emails and messengers of a client with the set version; copies of 1C (phones, emails, addresses) only with clients.onec_data.view' })
  @Get('clients/:id/contacts') @RequirePermissions(['clients.view'])
  client(@Param('id') id: string, @Req() request: RequestWithCurrentUser) {
    return this.contacts.get('client', parseId(id), undefined, actor(request).user.permissions.includes(CLIENT_ONEC_DATA_VIEW));
  }

  @ApiOperation({ summary: 'Sync the contacts of a client with its 1C counterparty now (the loaded 1C data)' })
  @Post('clients/:id/contacts/onec-sync') @HttpCode(200) @RequirePermissions(['clients.update', 'clients.onec_data.view'])
  async syncClientOnec(@Param('id') id: string, @Req() request: RequestWithCurrentUser) {
    const { user, requestId } = actor(request);
    const clientId = parseId(id);
    const outcome = await this.onecContacts.syncClient(clientId, user, requestId);
    if (outcome.status === 'skipped' && outcome.reason === 'not_found') throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    return { outcome, contacts: await this.contacts.get('client', clientId, undefined, true), onec: await readOnecProfile(this.database, 'client', clientId) };
  }

  @ApiOperation({ summary: 'Replace the emails and Telegram accounts of a client (version compare-and-swap)' })
  @Put('clients/:id/contacts') @RequirePermissions(['clients.update'])
  replaceClient(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) { return this.replace('client', id, body, request); }

  @ApiOperation({ summary: '1C counterparties a supplier can be linked to (the 1C mirror, else procurement documents)' })
  @Get('supplier-counterparties') @RequirePermissions(['suppliers.view'])
  async supplierCounterparties(@Query('search') search: unknown) {
    const text = typeof search === 'string' && search.trim() ? search.trim().slice(0, 100) : null;
    return { items: await this.counterparties.counterparties(text) };
  }

  @ApiOperation({ summary: 'The 1C counterparty a supplier is linked to, with what the last 1C contacts sync saw' })
  @Get('suppliers/:id/counterparty') @RequirePermissions(['suppliers.view'])
  async supplierCounterparty(@Param('id') id: string) {
    return { ...(await this.counterparties.link(parseOwnerId('supplier', id))), onecSyncEnabled: this.onecContacts.enabled() };
  }

  @ApiOperation({ summary: 'Sync the contacts of a supplier with its 1C counterparty now (the loaded 1C data)' })
  @Post('suppliers/:id/contacts/onec-sync') @HttpCode(200) @RequirePermissions(['suppliers.manage'])
  async syncSupplierOnec(@Param('id') id: string, @Req() request: RequestWithCurrentUser) {
    const { user, requestId } = actor(request);
    const supplierId = parseOwnerId('supplier', id);
    const outcome = await this.onecContacts.syncSupplier(supplierId, user, requestId, 'manual');
    if (outcome.status === 'skipped' && outcome.reason === 'not_found') throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'Поставщик не найден');
    return { outcome, link: { ...(await this.counterparties.link(supplierId)), onecSyncEnabled: true } };
  }

  @ApiOperation({ summary: 'Link, relink or unlink a supplier and a 1C counterparty (compare-and-swap on the previous key)' })
  @Put('suppliers/:id/counterparty') @RequirePermissions(['suppliers.manage'])
  async linkSupplier(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный запрос привязки');
    const { user, requestId } = actor(request);
    const supplierId = parseOwnerId('supplier', id);
    const link = await this.counterparties.setLink(supplierId, parsed.data.refKey1c === null ? null : parseRefKey1c(parsed.data.refKey1c),
      parsed.data.expectedRefKey1c === null ? null : parseRefKey1c(parsed.data.expectedRefKey1c), user, requestId);
    return this.afterLink(supplierId, link, user, requestId);
  }

  @ApiOperation({ summary: 'Add a 1C counterparty to the suppliers directory (idempotent by the key)' })
  @Post('suppliers/from-counterparty') @HttpCode(200) @RequirePermissions(['suppliers.manage'])
  async supplierFromCounterparty(@Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = fromCounterpartySchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный запрос');
    const { user, requestId } = actor(request);
    const created = await this.counterparties.createFromCounterparty(parseRefKey1c(parsed.data.refKey1c), user, requestId);
    return { ...(await this.afterLink(created.supplierId, created, user, requestId)), created: created.created };
  }

  @ApiOperation({ summary: 'The 1C counterparty a client is linked to' })
  @Get('clients/:id/counterparty') @RequirePermissions(['clients.view'])
  async clientCounterparty(@Param('id') id: string, @Req() request: RequestWithCurrentUser) {
    // Phones and BIN/IIN of the counterparty — only with `clients.onec_data.view`; the name and the code — with `clients.view`.
    const withData = actor(request).user.permissions.includes(CLIENT_ONEC_DATA_VIEW);
    const clientId = parseId(id);
    const link = await this.clientCounterparties.link(clientId, undefined, withData);
    // The state of the copy of 1C contacts (K4b): the time of the last sync and whether the 1C data may be shown now.
    return { ...link, onecSyncEnabled: this.onecContacts.clientsEnabled(), onec: withData ? await readOnecProfile(this.database, 'client', clientId) : null };
  }

  // The search opens the whole 1C counterparty directory (names, BIN/IIN, phones): only for those who may link
  // and may see the data of 1C counterparties.
  @ApiOperation({ summary: '1C counterparties for a client: by a search text, or the ones that look like the client (name, phone)' })
  @Get('clients/:id/counterparty-candidates') @RequirePermissions(['clients.update', 'clients.onec_data.view'])
  async clientCounterpartyCandidates(@Param('id') id: string, @Query('search') search: unknown) {
    const text = typeof search === 'string' && search.trim() ? search.trim().slice(0, 100) : null;
    return { items: await this.clientCounterparties.candidates(parseId(id), text) };
  }

  @ApiOperation({ summary: 'Link, relink or unlink a client and a 1C counterparty (compare-and-swap on the previous key)' })
  @Put('clients/:id/counterparty') @RequirePermissions(['clients.update'])
  async linkClient(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный запрос сопоставления');
    const { user, requestId } = actor(request);
    const clientId = parseId(id);
    const link = await this.clientCounterparties.setLink(clientId, parsed.data.refKey1c === null ? null : parseRefKey1c(parsed.data.refKey1c),
      parsed.data.expectedRefKey1c === null ? null : parseRefKey1c(parsed.data.expectedRefKey1c), user, requestId);
    // Committed: the contacts of the new counterparty follow in the background (the previous copy went with the link).
    if (link.refKey1c !== null) this.onecContacts.syncClientsSoon([clientId], user, requestId);
    return link;
  }

  @ApiOperation({ summary: 'Bulk view: clients without a 1C counterparty and their exact candidates (unambiguous pairs and ambiguous clients)' })
  @Get('client-counterparty-matches') @RequirePermissions(['clients.update', 'clients.onec_data.view'])
  clientCounterpartyMatches() { return this.clientCounterparties.matches(); }

  @ApiOperation({ summary: 'Confirm pairs of the bulk view: link each client that has no counterparty yet; impossible pairs are reported and skipped' })
  @Post('client-counterparty-matches/confirm') @HttpCode(200) @RequirePermissions(['clients.update', 'clients.onec_data.view'])
  async confirmClientCounterparties(@Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', `Некорректный запрос подтверждения (не более ${CONFIRM_MAX} пар)`);
    const pairs = parsed.data.pairs.map((pair) => ({ clientId: pair.clientId, refKey1c: parseRefKey1c(pair.refKey1c) }));
    if (new Set(pairs.map((pair) => pair.clientId)).size !== pairs.length || new Set(pairs.map((pair) => pair.refKey1c)).size !== pairs.length) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Клиент и контрагент в запросе не должны повторяться');
    }
    const { user, requestId } = actor(request);
    const results = await this.clientCounterparties.confirm(pairs, user, requestId);
    this.onecContacts.syncClientsSoon(results.filter((result) => result.status === 'linked').map((result) => result.clientId), user, requestId);
    return { results };
  }

  /**
   * After the link is committed: the contacts of the new counterparty come in at once when the sync is on. Its failure
   * does not undo the link (the hourly pass repeats it); the answer then shows the link without them.
   */
  private async afterLink<T extends { refKey1c: string | null }>(supplierId: number, link: T, user: CurrentUser, requestId: string) {
    if (!this.onecContacts.enabled() || link.refKey1c === null) return { ...link, onecSyncEnabled: this.onecContacts.enabled() };
    try {
      await this.onecContacts.syncSupplier(supplierId, user, requestId, 'link');
      return { ...(await this.counterparties.link(supplierId)), onecSyncEnabled: true };
    } catch {
      return { ...link, onecSyncEnabled: true };
    }
  }

  private replace(party: PartyKind, id: string, body: unknown, request: RequestWithCurrentUser) {
    const parsed = replaceSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный набор контактов');
    const { user, requestId } = actor(request);
    const contacts: PartyContactInput[] = parsed.data.contacts.map((contact) => ({ ...contact, note: contact.note ?? null }));
    return this.contacts.replace(party, parseOwnerId(party, id), parsed.data.version, contacts, user, requestId);
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

/**
 * Suppliers and vendors are keyed by smallint: an id beyond it names nobody (404, not a database error). Clients — bigint.
 */
export function parseOwnerId(party: PartyKind, value: string): number {
  const id = parseId(value);
  if (party !== 'client' && id > 32_767) throw new ApiError(404, PARTY_CONFIG[party].notFoundCode, PARTY_CONFIG[party].notFoundText);
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
