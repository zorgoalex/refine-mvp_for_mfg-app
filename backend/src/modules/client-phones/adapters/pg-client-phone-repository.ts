import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { computeDiff } from '../../../common/audit/audit-diff';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ClientPhoneMutationResult,
  ClientPhoneRepositoryPort,
  CreateClientPhoneCommand,
  DeleteClientPhoneCommand,
  ReplaceClientPhoneSetCommand,
  UpdateClientPhoneCommand,
} from '../application/client-phone.types';
import type {
  ClientPhoneDto,
  ClientPhoneResponseDto,
  DeleteClientPhoneResponseDto,
  ReplaceClientPhoneSetResponseDto,
  UpdateClientPhoneRequestDto,
} from '../dto/client-phone.dto';
import {
  ClientPhoneClientChangeUnsupportedError,
  ClientPhoneOwnerChangedError,
  ClientPhoneClientNotFoundError,
  ClientPhoneDuplicateError,
  ClientPhoneIdempotencyFailedError,
  ClientPhoneIdempotencyInProgressError,
  ClientPhoneIdempotencyKeyReusedError,
  ClientPhoneNotFoundError,
  ClientPhoneRefKeyDuplicateError,
  ClientPhoneSetInvalidError,
  ClientPhonesStaleError,
} from '../errors/client-phone.errors';

const SOURCE = 'backend-client-phones-command';

interface ClientPhoneRow extends QueryResultRow {
  phone_id: string | number;
  client_id: string | number;
  phone_number: string;
  phone_type: 'mobile' | 'work' | 'home' | 'fax';
  is_primary: boolean;
  ref_key_1c: string | null;
  created_by: string | number | null;
  edited_by: string | number | null;
  created_at: string | Date;
  updated_at: string | Date | null;
}

interface LockedClientRow extends QueryResultRow {
  client_id: string | number;
}

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  request_hash: string;
  response_json: StoredResponse | string | null;
  status: 'processing' | 'completed' | 'failed';
}

type ClientPhoneCommandName =
  | 'client_phones.create'
  | 'client_phones.update'
  | 'client_phones.delete'
  | 'client_phones.replace_set';

type StoredResponse = ClientPhoneResponseDto | DeleteClientPhoneResponseDto | ReplaceClientPhoneSetResponseDto;

/** Phones of one client at most (the set command of the contacts screen). */
export const CLIENT_PHONE_SET_MAX = 20;
const PHONE_FORMAT = /^\+?[0-9\s\-()]{7,20}$/;

export class PgClientPhoneRepository implements ClientPhoneRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  createClientPhone(command: CreateClientPhoneCommand): Promise<ClientPhoneMutationResult> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'client_phones.create',
        currentUser: command.currentUser,
        entityType: 'client',
        entityId: String(command.dto.clientId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'client_phones.create',
          clientId: command.dto.clientId,
          phoneNumber: command.dto.phoneNumber,
          phoneType: command.dto.phoneType,
          isPrimary: command.dto.isPrimary,
          refKey1c: command.dto.refKey1c,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse as ClientPhoneResponseDto;
      }

      await loadClientForUpdate(tx, command.dto.clientId);
      await assertNoDuplicatePhone(tx, command.dto.clientId, command.dto.phoneNumber);

      const demotedPhones = command.dto.isPrimary
        ? await demotePrimaryPhones(tx, command.dto.clientId)
        : [];
      const inserted = await insertClientPhone(tx, {
        clientId: command.dto.clientId,
        phoneNumber: command.dto.phoneNumber,
        phoneType: command.dto.phoneType,
        isPrimary: command.dto.isPrimary,
        refKey1c: command.dto.refKey1c,
      });
      const phone = mapClientPhoneRow(inserted);
      const auditId = await writeAudit(tx, {
        event: 'client_phones.create',
        currentUser: command.currentUser,
        requestId,
        phoneId: phone.phoneId,
        clientId: phone.clientId,
        beforeJson: null,
        afterJson: mutablePhoneJson(phone),
        diffJson: createdDiff(phone),
        metadataJson: metadataJson('create', phone, requestId, demotedPhones),
      });

      await writeDemotionAuditsAndOutbox(tx, {
        currentUser: command.currentUser,
        requestId,
        parentIdempotencyKey: command.dto.idempotencyKey,
        demotedPhones,
      });
      await enqueueOutbox(tx, {
        eventType: 'client_phone.created',
        aggregateType: 'client_phone',
        aggregateId: String(phone.phoneId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: outboxPayload('client_phone.created', 'create', command.currentUser, requestId, phone, {
          demotedPhoneIds: demotedPhones.map((item) => item.phoneId),
          source: 'clients-form|client-quick-create',
          idempotencyKey: command.dto.idempotencyKey,
        }),
      });

      const response = responseForPhone(phone, demotedPhones, auditId, requestId);
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  updateClientPhone(command: UpdateClientPhoneCommand): Promise<ClientPhoneMutationResult> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'client_phones.update',
        currentUser: command.currentUser,
        entityType: 'client_phone',
        entityId: String(command.phoneId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'client_phones.update',
          phoneId: command.phoneId,
          ...mutableUpdateShape(command.dto),
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse as ClientPhoneResponseDto;
      }

      const existing = await loadClientPhoneLockingClientFirst(tx, command.phoneId);
      const previous = mapClientPhoneRow(existing);
      if (
        command.dto.clientId !== undefined &&
        command.dto.clientId !== previous.clientId
      ) {
        throw new ClientPhoneClientChangeUnsupportedError(
          command.phoneId,
          previous.clientId,
          command.dto.clientId,
        );
      }

      if (command.dto.phoneNumber !== undefined) {
        await assertNoDuplicatePhone(
          tx,
          previous.clientId,
          command.dto.phoneNumber,
          command.phoneId,
        );
      }

      const demotedPhones = command.dto.isPrimary === true
        ? await demotePrimaryPhones(tx, previous.clientId, command.phoneId)
        : [];
      const updated = await updateClientPhoneRow(tx, command.phoneId, command.dto);
      const phone = mapClientPhoneRow(updated);
      const auditId = await writeAudit(tx, {
        event: 'client_phones.update',
        currentUser: command.currentUser,
        requestId,
        phoneId: phone.phoneId,
        clientId: phone.clientId,
        beforeJson: mutablePhoneJson(previous),
        afterJson: mutablePhoneJson(phone),
        diffJson: diffJson(previous, phone),
        metadataJson: metadataJson('update', phone, requestId, demotedPhones),
      });

      await writeDemotionAuditsAndOutbox(tx, {
        currentUser: command.currentUser,
        requestId,
        parentIdempotencyKey: command.dto.idempotencyKey,
        demotedPhones,
      });
      await enqueueOutbox(tx, {
        eventType: 'client_phone.updated',
        aggregateType: 'client_phone',
        aggregateId: String(phone.phoneId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: outboxPayload('client_phone.updated', 'update', command.currentUser, requestId, phone, {
          demotedPhoneIds: demotedPhones.map((item) => item.phoneId),
          source: 'clients-form|client-quick-create',
          idempotencyKey: command.dto.idempotencyKey,
        }),
      });

      const response = responseForPhone(phone, demotedPhones, auditId, requestId);
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  deleteClientPhone(command: DeleteClientPhoneCommand): Promise<DeleteClientPhoneResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: command.dto.idempotencyKey,
        commandName: 'client_phones.delete',
        currentUser: command.currentUser,
        entityType: 'client_phone',
        entityId: String(command.phoneId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'client_phones.delete',
          phoneId: command.phoneId,
          // Only when given: the hash of a request without it stays as before.
          ...(command.dto.clientId !== undefined ? { clientId: command.dto.clientId } : {}),
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse as DeleteClientPhoneResponseDto;
      }

      const existing = await loadClientPhoneLockingClientFirst(tx, command.phoneId);
      const phone = mapClientPhoneRow(existing);
      // A form opened before a merge (or its undo) moved the phone to another client must not remove it there.
      if (command.dto.clientId !== undefined && command.dto.clientId !== phone.clientId) {
        throw new ClientPhoneOwnerChangedError(command.phoneId, phone.clientId, command.dto.clientId);
      }
      await tx.query('DELETE FROM client_phones WHERE phone_id = $1', [command.phoneId]);
      const auditId = await writeAudit(tx, {
        event: 'client_phones.delete',
        currentUser: command.currentUser,
        requestId,
        phoneId: phone.phoneId,
        clientId: phone.clientId,
        beforeJson: mutablePhoneJson(phone),
        afterJson: null,
        diffJson: { deleted: { from: false, to: true } },
        metadataJson: metadataJson('delete', phone, requestId, []),
      });
      await enqueueOutbox(tx, {
        eventType: 'client_phone.deleted',
        aggregateType: 'client_phone',
        aggregateId: String(phone.phoneId),
        idempotencyKey: command.dto.idempotencyKey,
        payload: outboxPayload('client_phone.deleted', 'delete', command.currentUser, requestId, phone, {
          source: 'clients-form|client-quick-create',
          idempotencyKey: command.dto.idempotencyKey,
        }),
      });

      const response = {
        phoneId: phone.phoneId,
        clientId: phone.clientId,
        deleted: true as const,
        auditId,
        requestId,
      };
      await completeIdempotency(tx, command.dto.idempotencyKey, response);
      return response;
    });
  }

  /**
   * The whole phone set of one client (the contacts screen). The idempotency key is looked up first: a completed command
   * with the same body answers as before (a lost answer never turns into a stale error), another body is refused. Then
   * the client and its phones are locked (client first, as every writer of the phones) and the stored set — ids,
   * numbers, types, the primary — must equal what the screen saw; any difference is 409 with the current set and
   * nothing is written (the failed transaction does not keep the key). Removed phones go first, then changes with the
   * primary flag taken off, then the new primary, then new phones — the unique indexes only see valid states. Every
   * changed phone gets the same audit and outbox events as the card, each event under its own key.
   */
  replaceClientPhoneSet(command: ReplaceClientPhoneSetCommand): Promise<ReplaceClientPhoneSetResponseDto> {
    return this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);

      const requestId = requestIdOrFallback(command.requestId);
      const key = command.dto.idempotencyKey;
      const idempotency = await reconcileIdempotency(tx, {
        idempotencyKey: key,
        commandName: 'client_phones.replace_set',
        currentUser: command.currentUser,
        entityType: 'client',
        entityId: String(command.clientId),
        requestShape: {
          actorUserId: command.currentUser.id,
          commandName: 'client_phones.replace_set',
          clientId: command.clientId,
          expected: command.dto.expected,
          phones: command.dto.phones,
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse as ReplaceClientPhoneSetResponseDto;
      }

      await loadClientForUpdate(tx, command.clientId);
      const stored = (await tx.query<ClientPhoneRow>(
        `
        SELECT
          phone_id, client_id, phone_number, phone_type, is_primary, ref_key_1c,
          created_by, edited_by, created_at, updated_at
        FROM client_phones
        WHERE client_id = $1
        ORDER BY phone_id
        FOR UPDATE
        `,
        [command.clientId],
      )).rows.map(mapClientPhoneRow);
      if (!samePhoneSet(stored, command.dto.expected)) {
        throw new ClientPhonesStaleError(command.clientId, stored.map(publicPhone));
      }
      const plan = planPhoneSet(stored, command.dto.phones);

      const context = { currentUser: command.currentUser, requestId, source: command.source };
      for (const phone of plan.deleted) {
        await tx.query('DELETE FROM client_phones WHERE phone_id = $1', [phone.phoneId]);
        await recordPhoneChange(tx, context, 'delete', `${key}:delete:${phone.phoneId}`, phone, null);
      }
      // A number moving to another phone of the set (two phones swap numbers): the phones giving a number away are
      // parked on a placeholder first — UNIQUE(phone_number, client_id) is checked per statement.
      // Placeholders never meet a number of the client now or after the command, nor each other.
      const used = new Set([...stored.map((phone) => phone.phoneNumber), ...command.dto.phones.map((line) => line.phoneNumber.trim())]);
      const parked = plan.updated.filter((change) => change.before.phoneNumber !== change.after.phoneNumber
        && plan.updated.some((other) => other !== change && other.after.phoneNumber === change.before.phoneNumber));
      for (const change of parked) {
        const placeholder = parkedNumber(change.before.phoneId, used);
        used.add(placeholder);
        await tx.query('UPDATE client_phones SET phone_number = $2 WHERE phone_id = $1', [change.before.phoneId, placeholder]);
      }
      // Changes that leave a phone without «основной» first: the partial unique index sees at most one primary.
      const ordered = [...plan.updated].sort((left, right) => Number(left.after.isPrimary) - Number(right.after.isPrimary));
      for (const change of ordered) {
        const updated = mapClientPhoneRow(await updateClientPhoneRow(tx, change.before.phoneId, {
          phoneNumber: change.after.phoneNumber,
          phoneType: change.after.phoneType,
          isPrimary: change.after.isPrimary,
          idempotencyKey: key,
        }));
        const onlyDemoted = change.before.isPrimary && !updated.isPrimary
          && change.before.phoneNumber === updated.phoneNumber && change.before.phoneType === updated.phoneType;
        await recordPhoneChange(tx, context, onlyDemoted ? 'primary_demote' : 'update',
          `${key}:${onlyDemoted ? 'primary-demote' : 'update'}:${updated.phoneId}`, change.before, updated);
      }
      for (const line of plan.created) {
        const phone = mapClientPhoneRow(await insertClientPhone(tx, {
          clientId: command.clientId,
          phoneNumber: line.phoneNumber,
          phoneType: line.phoneType,
          isPrimary: line.isPrimary,
          refKey1c: null,
        }));
        await recordPhoneChange(tx, context, 'create', `${key}:create:${phone.phoneId}`, null, phone);
      }

      const after = (await tx.query<ClientPhoneRow>(
        `
        SELECT
          phone_id, client_id, phone_number, phone_type, is_primary, ref_key_1c,
          created_by, edited_by, created_at, updated_at
        FROM client_phones
        WHERE client_id = $1
        ORDER BY is_primary DESC, phone_id
        `,
        [command.clientId],
      )).rows.map(mapClientPhoneRow);
      const response: ReplaceClientPhoneSetResponseDto = {
        clientId: command.clientId,
        phones: after,
        created: plan.created.length,
        updated: plan.updated.length,
        deleted: plan.deleted.length,
        requestId,
      };
      await completeIdempotency(tx, key, response);
      return response;
    }).catch((error: unknown) => {
      // The card's duplicate error carries the number; this screen answers without it.
      if (error instanceof ClientPhoneDuplicateError) throw new ClientPhoneSetInvalidError('Такой телефон у клиента уже есть');
      throw error;
    });
  }
}

type SetAction = 'create' | 'update' | 'delete' | 'primary_demote';

const SET_EVENTS: Record<SetAction, { audit: 'client_phones.create' | 'client_phones.update' | 'client_phones.delete' | 'client_phones.primary_demote'; outbox: string }> = {
  create: { audit: 'client_phones.create', outbox: 'client_phone.created' },
  update: { audit: 'client_phones.update', outbox: 'client_phone.updated' },
  delete: { audit: 'client_phones.delete', outbox: 'client_phone.deleted' },
  primary_demote: { audit: 'client_phones.primary_demote', outbox: 'client_phone.primary_demoted' },
};

/** One phone of the set command: the card's audit and outbox event, the source of the caller, its own event key. */
async function recordPhoneChange(
  tx: TransactionClient,
  context: { currentUser: CurrentUser; requestId: string; source: string },
  action: SetAction,
  eventKey: string,
  before: ClientPhoneDto | null,
  after: ClientPhoneDto | null,
): Promise<void> {
  const phone = (after ?? before) as ClientPhoneDto;
  await writeAudit(tx, {
    event: SET_EVENTS[action].audit,
    currentUser: context.currentUser,
    requestId: context.requestId,
    phoneId: phone.phoneId,
    clientId: phone.clientId,
    beforeJson: before ? mutablePhoneJson(before) : null,
    afterJson: after ? mutablePhoneJson(after) : null,
    diffJson: after === null
      ? { deleted: { from: false, to: true } }
      : computeDiff(before ? mutablePhoneJson(before) : null, mutablePhoneJson(after)),
    metadataJson: { ...metadataJson(action, phone, context.requestId, []), source: context.source, setCommand: true },
  });
  await enqueueOutbox(tx, {
    eventType: SET_EVENTS[action].outbox,
    aggregateType: 'client_phone',
    aggregateId: String(phone.phoneId),
    idempotencyKey: eventKey,
    payload: outboxPayload(SET_EVENTS[action].outbox, action, context.currentUser, context.requestId, phone, {
      source: context.source,
      idempotencyKey: eventKey,
    }),
  });
}

/**
 * A placeholder number for a parked phone: «+», a lead digit and the phone id (19 digits, valid for the format check),
 * the first lead digit whose number is not in `used` (the client's numbers now and after the command, earlier placeholders).
 */
export function parkedNumber(phoneId: number, used: ReadonlySet<string>): string {
  for (let lead = 0; lead <= 9; lead += 1) {
    const number = `+${lead}${String(phoneId).padStart(18, '0')}`;
    if (!used.has(number)) return number;
  }
  throw new ClientPhoneSetInvalidError('Не удалось поменять номера местами; сохраните изменения в два шага');
}

/** The stored set equals what the screen saw: the same ids with the same number, type and primary flag. */
export function samePhoneSet(
  stored: readonly ClientPhoneDto[],
  expected: readonly { phoneId: number; phoneNumber: string; phoneType: string; isPrimary: boolean }[],
): boolean {
  if (stored.length !== expected.length) return false;
  const byId = new Map(expected.map((phone) => [phone.phoneId, phone]));
  if (byId.size !== expected.length) return false;
  return stored.every((phone) => {
    const seen = byId.get(phone.phoneId);
    return seen !== undefined && seen.phoneNumber === phone.phoneNumber && seen.phoneType === phone.phoneType
      && seen.isPrimary === phone.isPrimary;
  });
}

export interface PhoneSetPlan {
  deleted: ClientPhoneDto[];
  updated: Array<{ before: ClientPhoneDto; after: { phoneNumber: string; phoneType: ClientPhoneDto['phoneType']; isPrimary: boolean } }>;
  created: Array<{ phoneNumber: string; phoneType: ClientPhoneDto['phoneType']; isPrimary: boolean }>;
}

/**
 * The wanted set against the stored one (already equal to what the screen saw): at most CLIENT_PHONE_SET_MAX phones,
 * a known id at most once, a number at most once (by its digits), at most one primary.
 */
export function planPhoneSet(
  stored: readonly ClientPhoneDto[],
  wanted: readonly { phoneId: number | null; phoneNumber: string; phoneType: ClientPhoneDto['phoneType']; isPrimary: boolean }[],
): PhoneSetPlan {
  if (wanted.length > CLIENT_PHONE_SET_MAX) {
    throw new ClientPhoneSetInvalidError(`Не больше ${CLIENT_PHONE_SET_MAX} телефонов у клиента`);
  }
  const byId = new Map(stored.map((phone) => [phone.phoneId, phone]));
  const named = new Set<number>();
  const numbers = new Set<string>();
  const lines = wanted.map((line) => ({ ...line, phoneNumber: line.phoneNumber.trim() }));
  for (const [index, line] of lines.entries()) {
    // Messages name the line, never the number (error payloads are not masked).
    if (!PHONE_FORMAT.test(line.phoneNumber)) {
      throw new ClientPhoneSetInvalidError(`Телефон в строке ${index + 1} указан неверно`, { line: index + 1, phoneId: line.phoneId });
    }
    if (line.phoneId !== null) {
      if (!byId.has(line.phoneId) || named.has(line.phoneId)) {
        throw new ClientPhoneSetInvalidError('Телефон указан дважды или не принадлежит клиенту', { phoneId: line.phoneId });
      }
      named.add(line.phoneId);
    }
    const digits = line.phoneNumber.replace(/\D/g, '');
    if (numbers.has(digits)) throw new ClientPhoneSetInvalidError(`Телефон в строке ${index + 1} указан дважды`, { line: index + 1 });
    numbers.add(digits);
  }
  if (lines.filter((line) => line.isPrimary).length > 1) {
    throw new ClientPhoneSetInvalidError('Основным может быть только один телефон');
  }
  const plan: PhoneSetPlan = { deleted: stored.filter((phone) => !named.has(phone.phoneId)), updated: [], created: [] };
  for (const line of lines) {
    const after = { phoneNumber: line.phoneNumber, phoneType: line.phoneType, isPrimary: line.isPrimary };
    if (line.phoneId === null) {
      plan.created.push(after);
      continue;
    }
    const before = byId.get(line.phoneId) as ClientPhoneDto;
    if (before.phoneNumber !== after.phoneNumber || before.phoneType !== after.phoneType || before.isPrimary !== after.isPrimary) {
      plan.updated.push({ before, after });
    }
  }
  return plan;
}

/** A phone in the stale answer: what the screen needs to show the current set. */
function publicPhone(phone: ClientPhoneDto) {
  return { phoneId: phone.phoneId, phoneNumber: phone.phoneNumber, phoneType: phone.phoneType, isPrimary: phone.isPrimary };
}

async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

async function reconcileIdempotency(
  tx: TransactionClient,
  input: {
    idempotencyKey: string;
    commandName: ClientPhoneCommandName;
    currentUser: CurrentUser;
    entityType: string;
    entityId: string;
    requestShape: Record<string, unknown>;
  },
): Promise<{ completedResponse?: StoredResponse }> {
  const requestHash = hashRequest(input.requestShape);
  const inserted = await tx.query<IdempotencyRow>(
    `
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'processing')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key, request_hash, response_json, status
    `,
    [
      input.idempotencyKey,
      input.commandName,
      numericUserId(input.currentUser),
      input.entityType,
      input.entityId,
      requestHash,
    ],
  );

  if (inserted.rows[0]) {
    return {};
  }

  const existing = await tx.query<IdempotencyRow>(
    `
    SELECT idempotency_key, request_hash, response_json, status
    FROM command_idempotency_keys
    WHERE idempotency_key = $1
    FOR UPDATE
    `,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new ClientPhoneIdempotencyInProgressError(input.idempotencyKey);
  }
  if (row.request_hash !== requestHash) {
    throw new ClientPhoneIdempotencyKeyReusedError(input.idempotencyKey);
  }
  if (row.status === 'completed' && row.response_json) {
    return { completedResponse: parseStoredResponse(row.response_json) };
  }
  if (row.status === 'failed') {
    throw new ClientPhoneIdempotencyFailedError(input.idempotencyKey);
  }

  throw new ClientPhoneIdempotencyInProgressError(input.idempotencyKey);
}

async function completeIdempotency(
  tx: TransactionClient,
  idempotencyKey: string,
  response: StoredResponse,
): Promise<void> {
  await tx.query(
    `
    UPDATE command_idempotency_keys
    SET status = 'completed',
        response_json = $2::jsonb,
        completed_at = now()
    WHERE idempotency_key = $1
    `,
    [idempotencyKey, JSON.stringify(response)],
  );
}

async function loadClientForUpdate(tx: TransactionClient, clientId: number): Promise<void> {
  const result = await tx.query<LockedClientRow>(
    `
    SELECT client_id
    FROM clients
    WHERE client_id = $1
    FOR UPDATE
    `,
    [clientId],
  );

  if (!result.rows[0]) {
    throw new ClientPhoneClientNotFoundError(clientId);
  }
}

/**
 * Lock order of every writer of a client's phones: the client row first, then its phones (the Bitrix24 reverse sync
 * updates the client and then replaces its phones; the order snapshot import and the set command of the contacts
 * screen lock the client too). The owner is read without a lock, the client locked, then the phone locked and its
 * owner checked again: a phone moved or replaced meanwhile is reported as not found.
 */
async function loadClientPhoneLockingClientFirst(tx: TransactionClient, phoneId: number): Promise<ClientPhoneRow> {
  const owner = await tx.query<LockedClientRow>('SELECT client_id FROM client_phones WHERE phone_id = $1', [phoneId]);
  if (!owner.rows[0]) {
    throw new ClientPhoneNotFoundError(phoneId);
  }
  const clientId = toNumber(owner.rows[0].client_id);
  await loadClientForUpdate(tx, clientId);
  const locked = await loadClientPhoneForUpdate(tx, phoneId);
  if (!locked || toNumber(locked.client_id) !== clientId) {
    throw new ClientPhoneNotFoundError(phoneId);
  }
  return locked;
}

async function loadClientPhoneForUpdate(
  tx: TransactionClient,
  phoneId: number,
): Promise<ClientPhoneRow | null> {
  const result = await tx.query<ClientPhoneRow>(
    `
    SELECT
      phone_id, client_id, phone_number, phone_type, is_primary, ref_key_1c,
      created_by, edited_by, created_at, updated_at
    FROM client_phones
    WHERE phone_id = $1
    FOR UPDATE
    `,
    [phoneId],
  );

  return result.rows[0] ?? null;
}

async function assertNoDuplicatePhone(
  tx: TransactionClient,
  clientId: number,
  phoneNumber: string,
  excludePhoneId?: number,
): Promise<void> {
  const result = await tx.query<QueryResultRow>(
    `
    SELECT phone_id
    FROM client_phones
    WHERE client_id = $1
      AND phone_number = $2
      AND ($3::bigint IS NULL OR phone_id <> $3::bigint)
    LIMIT 1
    `,
    [clientId, phoneNumber, excludePhoneId ?? null],
  );

  if (result.rows[0]) {
    throw new ClientPhoneDuplicateError(clientId, phoneNumber);
  }
}

async function demotePrimaryPhones(
  tx: TransactionClient,
  clientId: number,
  exceptPhoneId?: number,
): Promise<ClientPhoneDto[]> {
  const existing = await tx.query<ClientPhoneRow>(
    `
    SELECT
      phone_id, client_id, phone_number, phone_type, is_primary, ref_key_1c,
      created_by, edited_by, created_at, updated_at
    FROM client_phones
    WHERE client_id = $1
      AND is_primary = true
      AND ($2::bigint IS NULL OR phone_id <> $2::bigint)
    FOR UPDATE
    `,
    [clientId, exceptPhoneId ?? null],
  );
  const demoted = existing.rows.map(mapClientPhoneRow);
  if (demoted.length === 0) {
    return [];
  }

  await tx.query(
    `
    UPDATE client_phones
    SET is_primary = false
    WHERE phone_id = ANY($1::bigint[])
    `,
    [demoted.map((phone) => phone.phoneId)],
  );

  return demoted;
}

async function insertClientPhone(
  tx: TransactionClient,
  input: {
    clientId: number;
    phoneNumber: string;
    phoneType: ClientPhoneDto['phoneType'];
    isPrimary: boolean;
    refKey1c: string | null;
  },
): Promise<ClientPhoneRow> {
  try {
    const result = await tx.query<ClientPhoneRow>(
      `
      INSERT INTO client_phones (client_id, phone_number, phone_type, is_primary, ref_key_1c)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        phone_id, client_id, phone_number, phone_type, is_primary, ref_key_1c,
        created_by, edited_by, created_at, updated_at
      `,
      [input.clientId, input.phoneNumber, input.phoneType, input.isPrimary, input.refKey1c],
    );
    return result.rows[0];
  } catch (error) {
    throw mapClientPhoneWriteError(error, input.clientId, input.phoneNumber, input.refKey1c);
  }
}

async function updateClientPhoneRow(
  tx: TransactionClient,
  phoneId: number,
  dto: UpdateClientPhoneRequestDto,
): Promise<ClientPhoneRow> {
  const update = buildUpdateAssignments(dto);
  try {
    const result = await tx.query<ClientPhoneRow>(
      `
      UPDATE client_phones
      SET ${update.assignments}
      WHERE phone_id = $1
      RETURNING
        phone_id, client_id, phone_number, phone_type, is_primary, ref_key_1c,
        created_by, edited_by, created_at, updated_at
      `,
      update.params(phoneId),
    );
    const row = result.rows[0];
    if (!row) {
      throw new ClientPhoneNotFoundError(phoneId);
    }
    return row;
  } catch (error) {
    throw mapClientPhoneWriteError(error, dto.clientId, dto.phoneNumber, dto.refKey1c);
  }
}

function buildUpdateAssignments(dto: UpdateClientPhoneRequestDto): {
  assignments: string;
  params: (phoneId: number) => unknown[];
} {
  const values: unknown[] = [];
  const assignments: string[] = [];

  addAssignment('phoneNumber', 'phone_number', dto.phoneNumber);
  addAssignment('phoneType', 'phone_type', dto.phoneType);
  addAssignment('isPrimary', 'is_primary', dto.isPrimary);
  addAssignment('refKey1c', 'ref_key_1c', dto.refKey1c);

  return {
    assignments: assignments.join(', '),
    params(phoneId: number) {
      return [phoneId, ...values];
    },
  };

  function addAssignment(
    dtoKey: keyof UpdateClientPhoneRequestDto,
    column: string,
    value: unknown,
  ): void {
    if (!Object.prototype.hasOwnProperty.call(dto, dtoKey)) {
      return;
    }
    const index = values.push(value);
    assignments.push(`${column} = $${index + 1}`);
  }
}

async function writeDemotionAuditsAndOutbox(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    parentIdempotencyKey: string;
    demotedPhones: readonly ClientPhoneDto[];
  },
): Promise<void> {
  for (const phone of input.demotedPhones) {
    await writeAudit(tx, {
      event: 'client_phones.primary_demote',
      currentUser: input.currentUser,
      requestId: input.requestId,
      phoneId: phone.phoneId,
      clientId: phone.clientId,
      beforeJson: { isPrimary: true, phoneId: phone.phoneId, clientId: phone.clientId },
      afterJson: { isPrimary: false, phoneId: phone.phoneId, clientId: phone.clientId },
      diffJson: { isPrimary: { from: true, to: false } },
      metadataJson: metadataJson('primary_demote', { ...phone, isPrimary: false }, input.requestId, []),
    });
    await enqueueOutbox(tx, {
      eventType: 'client_phone.primary_demoted',
      aggregateType: 'client_phone',
      aggregateId: String(phone.phoneId),
      idempotencyKey: `${input.parentIdempotencyKey}:primary-demote:${phone.phoneId}`,
      payload: outboxPayload(
        'client_phone.primary_demoted',
        'primary_demote',
        input.currentUser,
        input.requestId,
        { ...phone, isPrimary: false },
        {
          source: 'clients-form|client-quick-create',
          idempotencyKey: `${input.parentIdempotencyKey}:primary-demote:${phone.phoneId}`,
        },
      ),
    });
  }
}

async function writeAudit(
  tx: TransactionClient,
  input: {
    event: 'client_phones.create' | 'client_phones.update' | 'client_phones.delete' | 'client_phones.primary_demote';
    currentUser: CurrentUser;
    requestId: string;
    phoneId: number;
    clientId: number;
    beforeJson: Record<string, unknown> | null;
    afterJson: Record<string, unknown> | null;
    diffJson: Record<string, unknown>;
    metadataJson: Record<string, unknown>;
  },
): Promise<string> {
  return auditService.record(tx, {
    event: input.event,
    entityType: 'client_phone',
    entityId: String(input.phoneId),
    actorUserId: input.currentUser.id,
    requestId: input.requestId,
    source: SOURCE,
    relatedClientId: input.clientId,
    before: input.beforeJson,
    after: input.afterJson,
    diff: input.diffJson,
    metadata: input.metadataJson,
  });
}

async function enqueueOutbox(
  tx: TransactionClient,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO outbox_events (
      event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
    )
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload),
      input.idempotencyKey,
    ],
  );
}

function responseForPhone(
  phone: ClientPhoneDto,
  demotedPhones: readonly ClientPhoneDto[],
  auditId: string,
  requestId: string,
): ClientPhoneResponseDto {
  const demotedPhoneIds = demotedPhones.map((item) => item.phoneId);
  return {
    phone,
    ...(demotedPhoneIds.length > 0 ? { demotedPhoneIds } : {}),
    auditId,
    requestId,
  };
}

function mutableUpdateShape(dto: UpdateClientPhoneRequestDto): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const key of ['clientId', 'phoneNumber', 'phoneType', 'isPrimary', 'refKey1c'] as const) {
    if (Object.prototype.hasOwnProperty.call(dto, key)) {
      shape[key] = dto[key];
    }
  }
  return shape;
}

/** Audit view of a phone: the number only masked (it is personal data), never as typed. */
function mutablePhoneJson(phone: ClientPhoneDto): Record<string, unknown> {
  return {
    clientId: phone.clientId,
    phoneNumber: maskedNumber(phone.phoneNumber),
    phoneType: phone.phoneType,
    isPrimary: phone.isPrimary,
    refKey1c: phone.refKey1c,
  };
}

function maskedNumber(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

function createdDiff(phone: ClientPhoneDto): Record<string, unknown> {
  return computeDiff(null, mutablePhoneJson(phone));
}

function diffJson(before: ClientPhoneDto, after: ClientPhoneDto): Record<string, unknown> {
  return computeDiff(mutablePhoneJson(before), mutablePhoneJson(after));
}

function metadataJson(
  action: 'create' | 'update' | 'delete' | 'primary_demote',
  phone: ClientPhoneDto,
  requestId: string,
  demotedPhones: readonly ClientPhoneDto[],
): Record<string, unknown> {
  const demotedPhoneIds = demotedPhones.map((item) => item.phoneId);
  return {
    source: SOURCE,
    clientId: phone.clientId,
    phoneId: phone.phoneId,
    phoneType: phone.phoneType,
    isPrimary: phone.isPrimary,
    demotedPhoneIds,
    primaryChanged: action === 'primary_demote' || demotedPhoneIds.length > 0,
    action,
    requestId,
  };
}

function outboxPayload(
  eventType: string,
  action: 'create' | 'update' | 'delete' | 'primary_demote',
  currentUser: CurrentUser,
  requestId: string,
  phone: ClientPhoneDto,
  options: {
    source?: string;
    demotedPhoneIds?: number[];
    idempotencyKey?: string;
  },
): Record<string, unknown> {
  return {
    eventType,
    actorUserId: currentUser.id,
    requestId,
    entityType: 'client_phone',
    entityId: String(phone.phoneId),
    clientId: phone.clientId,
    phoneId: phone.phoneId,
    phoneType: phone.phoneType,
    isPrimary: phone.isPrimary,
    demotedPhoneIds: options.demotedPhoneIds ?? [],
    action,
    scope: { source: options.source ?? 'clients-form|client-quick-create' },
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  };
}

function mapClientPhoneRow(row: ClientPhoneRow): ClientPhoneDto {
  return {
    phoneId: toNumber(row.phone_id),
    clientId: toNumber(row.client_id),
    phoneNumber: row.phone_number,
    phoneType: row.phone_type,
    isPrimary: row.is_primary,
    refKey1c: row.ref_key_1c,
    createdBy: toNullableNumber(row.created_by),
    editedBy: toNullableNumber(row.edited_by),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at),
  };
}

function mapClientPhoneWriteError(
  error: unknown,
  clientId?: number,
  phoneNumber?: string,
  refKey1c?: string | null,
): never {
  if (isPgUniqueViolation(error)) {
    const constraint = String(error.constraint ?? '');
    if (constraint === 'uq_client_phones_phone_client') {
      throw new ClientPhoneDuplicateError(clientId ?? 0, phoneNumber ?? '');
    }
    if (constraint === 'idx_client_phones__ref_key_1c') {
      throw new ClientPhoneRefKeyDuplicateError(refKey1c ?? '');
    }
  }

  throw error;
}

function isPgUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function requestIdOrFallback(requestId: string | undefined): string {
  return requestId || 'client-phone-command';
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function parseStoredResponse(
  responseJson: StoredResponse | string,
): StoredResponse {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as StoredResponse)
    : responseJson;
}

function numericUserId(currentUser: CurrentUser): number {
  const value = Number(currentUser.id);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(500, 'INVALID_CURRENT_USER', 'Current user id must be numeric');
  }
  return value;
}

function toNumber(value: string | number): number {
  return Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
