import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../permissions/current-user';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { ClientPhoneService } from '../client-phones/application/client-phone.service';
import { ClientPhonesRuntimeConfigService } from '../client-phones/http/client-phones-runtime-config.service';
import { PartyContactsRepository } from '../party-contacts/party-contacts.repository';
import { PARTY_CONFIG, PARTY_NOTE_MAX, PARTY_OWN_CONTACTS_MAX, PARTY_VALUE_MAX } from '../party-contacts/party-contacts';
import {
  CLIENT_CONTACT_COLUMNS, CLIENT_CONTACT_SORTS, ClientContactsListRepository,
  type ClientContactColumn, type ClientContactsQuery, type ColumnFilter,
} from './client-contacts-list.repository';

/** Audit / outbox source of the writes of this screen (the card writes as before). */
export const CLIENT_CONTACTS_SCREEN_SOURCE = 'client_contacts_screen';
export const CLIENT_CONTACTS_PAGE_MAX = 100;

const clientKinds = PARTY_CONFIG.client.kinds as readonly [string, ...string[]];
const contactsSchema = z.object({
  version: z.number().int().min(0),
  contacts: z.array(z.object({
    contactId: z.number().int().positive().nullable(),
    kind: z.enum(clientKinds),
    value: z.string().trim().min(1).max(PARTY_VALUE_MAX),
    isPrimary: z.boolean(),
    note: z.string().max(PARTY_NOTE_MAX).nullable().optional(),
  }).strict()).max(PARTY_OWN_CONTACTS_MAX),
}).strict();

const phoneType = z.enum(['mobile', 'work', 'home', 'fax']);
const phoneNumber = z.string().trim().min(7).max(20);
const phonesSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  expected: z.array(z.object({
    phoneId: z.number().int().positive(), phoneNumber: z.string().max(20), phoneType, isPrimary: z.boolean(),
  }).strict()).max(100),
  phones: z.array(z.object({
    phoneId: z.number().int().positive().nullable(), phoneNumber, phoneType, isPrimary: z.boolean(),
  }).strict()).max(100),
}).strict();

/**
 * «Контакты клиентов»: one list of the phones, emails and messengers of all clients, edited in place. Its own rights
 * (clients.contacts.view / clients.contacts.manage, top manager and above by default); the client card keeps its routes.
 * Emails and messengers go through the set command of the card (version compare-and-swap); phones through the whole-set
 * command of the client phones (the stored set must equal what the screen saw).
 */
@ApiTags('Client contacts')
@ApiBearerAuth('bearerAuth')
@Controller()
@UseGuards(PermissionsGuard)
export class ClientContactsController {
  constructor(
    @Inject(ClientContactsListRepository) private readonly list: ClientContactsListRepository,
    @Inject(PartyContactsRepository) private readonly contacts: PartyContactsRepository,
    @Inject(ClientPhoneService) private readonly phones: ClientPhoneService,
    @Inject(ClientPhonesRuntimeConfigService) private readonly phonesConfig: ClientPhonesRuntimeConfigService,
  ) {}

  @ApiOperation({ summary: 'Clients with their phones, emails and messengers: search, column filters, sorting, pages' })
  @Get('client-contacts') @RequirePermissions(['clients.contacts.view'])
  async index(@Query() query: Record<string, unknown>, @Req() request: RequestWithCurrentUser) {
    const parsed = parseListQuery(query);
    const { items, total } = await this.list.list(parsed);
    const user = actor(request).user;
    return {
      items, total, page: parsed.page, pageSize: parsed.pageSize,
      kinds: this.contacts.kindsNow('client'),
      canManage: user.permissions.includes('clients.contacts.manage'),
      phonesEditable: this.phonesConfig.getFeatureFlags().clientPhonesEnabled,
    };
  }

  @ApiOperation({ summary: 'One client of the list (after a save or a conflict)' })
  @Get('client-contacts/:clientId') @RequirePermissions(['clients.contacts.view'])
  async one(@Param('clientId') clientId: string) {
    return this.rowOf(parseId(clientId));
  }

  @ApiOperation({ summary: 'Replace the emails and messengers of a client from the list (version compare-and-swap)' })
  @Put('client-contacts/:clientId/contacts') @RequirePermissions(['clients.contacts.manage'])
  async replaceContacts(@Param('clientId') clientId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    const parsed = contactsSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный набор контактов');
    const id = parseId(clientId);
    const { user, requestId } = actor(request);
    await this.contacts.replace('client', id,
      parsed.data.version, parsed.data.contacts.map((contact) => ({ ...contact, kind: contact.kind as never, note: contact.note ?? null })),
      user, requestId, CLIENT_CONTACTS_SCREEN_SOURCE);
    return this.rowOf(id);
  }

  // `result` is the stored answer of the command (a repeat after a lost answer gets the same one); `row` is the client now.
  @ApiOperation({ summary: 'Replace the phones of a client from the list (the stored set must equal `expected`; idempotent by key)' })
  @Put('client-contacts/:clientId/phones') @RequirePermissions(['clients.contacts.manage'])
  async replacePhones(@Param('clientId') clientId: string, @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    if (!this.phonesConfig.getFeatureFlags().clientPhonesEnabled) {
      throw new ApiError(503, 'CLIENT_PHONES_DISABLED', 'Правка телефонов клиентов сейчас выключена');
    }
    const parsed = phonesSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный набор телефонов');
    const id = parseId(clientId);
    const { user, requestId } = actor(request);
    const result = await this.phones.replaceSet({ currentUser: user, clientId: id, dto: parsed.data, requestId, source: CLIENT_CONTACTS_SCREEN_SOURCE });
    return { result, row: await this.rowOf(id) };
  }

  private async rowOf(clientId: number) {
    const row = await this.list.row(clientId);
    if (!row) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    return row;
  }
}

function actor(request: RequestWithCurrentUser): { user: CurrentUser; requestId: string } {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return { user: request.user, requestId: request.requestId };
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный идентификатор');
  return id;
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * `q`, `page`, `pageSize` (≤ 100), `sort` (client|updated|phone|email|telegram|whatsapp|viber|instagram|other), `order`
 * (asc|desc), `active` (active|archived|all; active by default), and per column `f.<column>` = `has` | `none` | `~<text>`.
 */
export function parseListQuery(query: Record<string, unknown>): ClientContactsQuery {
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 50);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > CLIENT_CONTACTS_PAGE_MAX) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Страница — с 1, размер — от 1 до ${CLIENT_CONTACTS_PAGE_MAX}`);
  }
  const sort = query.sort ?? 'client';
  if (!CLIENT_CONTACT_SORTS.includes(sort as never)) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректная сортировка');
  const order = query.order ?? 'asc';
  if (order !== 'asc' && order !== 'desc') throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный порядок');
  const active = query.active ?? 'active';
  if (active !== 'active' && active !== 'archived' && active !== 'all') throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный фильтр активности');
  const filters: Partial<Record<ClientContactColumn, ColumnFilter>> = {};
  for (const column of CLIENT_CONTACT_COLUMNS) {
    const raw = query[`f.${column}`];
    if (raw === undefined || raw === '') continue;
    if (raw === 'has' || raw === 'none') filters[column] = { mode: raw };
    else if (typeof raw === 'string' && raw.startsWith('~') && text(raw.slice(1), 100)) filters[column] = { mode: 'contains', text: text(raw.slice(1), 100) as string };
    else throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный фильтр колонки', { column });
  }
  return { q: text(query.q, 100), filters, active, sort: sort as ClientContactsQuery['sort'], order, page, pageSize };
}
