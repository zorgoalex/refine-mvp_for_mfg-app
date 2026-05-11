import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ClientPhoneMutationResult,
  ClientPhoneRepositoryPort,
  CreateClientPhoneCommand,
  DeleteClientPhoneCommand,
  UpdateClientPhoneCommand,
} from '../application/client-phone.types';
import type {
  ClientPhoneDto,
  ClientPhoneResponseDto,
  DeleteClientPhoneResponseDto,
  UpdateClientPhoneRequestDto,
} from '../dto/client-phone.dto';
import {
  ClientPhoneClientChangeUnsupportedError,
  ClientPhoneClientNotFoundError,
  ClientPhoneDuplicateError,
  ClientPhoneIdempotencyFailedError,
  ClientPhoneIdempotencyInProgressError,
  ClientPhoneIdempotencyKeyReusedError,
  ClientPhoneNotFoundError,
  ClientPhoneRefKeyDuplicateError,
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

interface AuditRow extends QueryResultRow {
  audit_id: string;
}

interface IdempotencyRow extends QueryResultRow {
  idempotency_key: string;
  request_hash: string;
  response_json: ClientPhoneResponseDto | DeleteClientPhoneResponseDto | string | null;
  status: 'processing' | 'completed' | 'failed';
}

type ClientPhoneCommandName =
  | 'client_phones.create'
  | 'client_phones.update'
  | 'client_phones.delete';

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

      const existing = await loadClientPhoneForUpdate(tx, command.phoneId);
      if (!existing) {
        throw new ClientPhoneNotFoundError(command.phoneId);
      }
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
      await loadClientForUpdate(tx, previous.clientId);

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
        },
      });
      if (idempotency.completedResponse) {
        return idempotency.completedResponse as DeleteClientPhoneResponseDto;
      }

      const existing = await loadClientPhoneForUpdate(tx, command.phoneId);
      if (!existing) {
        throw new ClientPhoneNotFoundError(command.phoneId);
      }
      const phone = mapClientPhoneRow(existing);
      await loadClientForUpdate(tx, phone.clientId);
      await tx.query('DELETE FROM client_phones WHERE phone_id = $1', [command.phoneId]);
      const auditId = await writeAudit(tx, {
        event: 'client_phones.delete',
        currentUser: command.currentUser,
        requestId,
        phoneId: phone.phoneId,
        clientId: phone.clientId,
        beforeJson: mutablePhoneJson(phone),
        afterJson: null,
        diffJson: { deleted: { before: false, after: true } },
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
): Promise<{ completedResponse?: ClientPhoneResponseDto | DeleteClientPhoneResponseDto }> {
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
  response: ClientPhoneResponseDto | DeleteClientPhoneResponseDto,
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
      diffJson: { isPrimary: { before: true, after: false } },
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
  const result = await tx.query<AuditRow>(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, request_id, source,
      related_client_id, before_json, after_json, diff_json, metadata_json
    )
    VALUES (
      $1, 'client_phone', $2, $3, $4, $5,
      $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb
    )
    RETURNING audit_id
    `,
    [
      input.event,
      String(input.phoneId),
      input.currentUser.id,
      input.requestId,
      SOURCE,
      input.clientId,
      input.beforeJson === null ? null : JSON.stringify(input.beforeJson),
      input.afterJson === null ? null : JSON.stringify(input.afterJson),
      JSON.stringify(input.diffJson),
      JSON.stringify(input.metadataJson),
    ],
  );

  return result.rows[0].audit_id;
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

function mutablePhoneJson(phone: ClientPhoneDto): Record<string, unknown> {
  return {
    clientId: phone.clientId,
    phoneNumber: phone.phoneNumber,
    phoneType: phone.phoneType,
    isPrimary: phone.isPrimary,
    refKey1c: phone.refKey1c,
  };
}

function createdDiff(phone: ClientPhoneDto): Record<string, unknown> {
  const mutable = mutablePhoneJson(phone);
  return Object.fromEntries(
    Object.entries(mutable).map(([key, value]) => [key, { before: null, after: value }]),
  );
}

function diffJson(before: ClientPhoneDto, after: ClientPhoneDto): Record<string, unknown> {
  const beforeJson = mutablePhoneJson(before);
  const afterJson = mutablePhoneJson(after);
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(afterJson)) {
    if (beforeJson[key] !== afterJson[key]) {
      diff[key] = { before: beforeJson[key], after: afterJson[key] };
    }
  }
  return diff;
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
  responseJson: ClientPhoneResponseDto | DeleteClientPhoneResponseDto | string,
): ClientPhoneResponseDto | DeleteClientPhoneResponseDto {
  return typeof responseJson === 'string'
    ? (JSON.parse(responseJson) as ClientPhoneResponseDto | DeleteClientPhoneResponseDto)
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
