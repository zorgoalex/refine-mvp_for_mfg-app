import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/errors/api-error';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import {
  maskContact, prepareContacts,
  type EmployeeContact, type EmployeeContactInput, type EmployeeContactKind, type EmployeeContacts,
} from './employee-contacts';

const SOURCE = 'erp_employees';

interface ContactRow extends QueryResultRow {
  contact_id: string; employee_id: string; kind: EmployeeContactKind; value: string; value_normalized: string; is_primary: boolean;
  note: string | null; position: number; created_by: string | null; created_at: Date;
}

/**
 * Work contacts of employees. The whole set of one employee is replaced by one command under a
 * version kept on the employee row (also for an empty set). Lock order: employees (NO KEY UPDATE) → contacts; the
 * command never touches the order-send tables, so it cannot close a cycle with a delivery.
 */
@Injectable()
export class EmployeeContactsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async get(employeeId: number, client: DatabaseClient = this.database): Promise<EmployeeContacts> {
    const employee = (await client.query<{ work_contacts_version: number }>(
      'SELECT work_contacts_version FROM employees WHERE employee_id = $1', [employeeId])).rows[0];
    if (!employee) throw new ApiError(404, 'EMPLOYEE_NOT_FOUND', 'Сотрудник не найден');
    const rows = (await client.query<ContactRow>(`SELECT * FROM employee_work_contacts WHERE employee_id = $1
      ORDER BY kind, is_primary DESC, position, contact_id`, [employeeId])).rows;
    return { employeeId, version: employee.work_contacts_version, contacts: rows.map(toContact) };
  }

  /** Contacts of many employees at once (the employees list column). */
  async listFor(employeeIds: readonly number[]): Promise<Map<number, EmployeeContact[]>> {
    const result = new Map<number, EmployeeContact[]>();
    if (!employeeIds.length) return result;
    const rows = (await this.database.query<ContactRow>(`SELECT * FROM employee_work_contacts WHERE employee_id = ANY($1::bigint[])
      ORDER BY employee_id, kind, is_primary DESC, position, contact_id`, [employeeIds])).rows;
    for (const row of rows) {
      const id = Number(row.employee_id);
      result.set(id, [...(result.get(id) ?? []), toContact(row)]);
    }
    return result;
  }

  /**
   * Replaces the set: version compare-and-swap on the locked employee row; contacts with an id are
   * updated in place (their id survives — a waiting send that used it stays valid), the missing ones
   * deleted, the new ones inserted; the version goes up by one. Audited with masks only.
   */
  async replace(employeeId: number, version: number, input: readonly EmployeeContactInput[], actor: CurrentUser,
    requestId: string): Promise<EmployeeContacts> {
    const prepared = prepareContacts(input);
    return this.database.transaction(async (tx) => {
      const employee = (await tx.query<{ work_contacts_version: number }>(
        // NO KEY UPDATE: serializes contact commands of the employee, yet never blocks the FK key-share lock of a
        // user being linked to him (FOR UPDATE would, and with the audit's key-share on the actor close a cycle).
        'SELECT work_contacts_version FROM employees WHERE employee_id = $1 FOR NO KEY UPDATE', [employeeId])).rows[0];
      if (!employee) throw new ApiError(404, 'EMPLOYEE_NOT_FOUND', 'Сотрудник не найден');
      if (employee.work_contacts_version !== version) {
        throw new ApiError(409, 'EMPLOYEE_CONTACTS_VERSION_CONFLICT', 'Контакты сотрудника уже изменены; обновите страницу');
      }
      const before = (await tx.query<ContactRow>('SELECT * FROM employee_work_contacts WHERE employee_id = $1 FOR UPDATE',
        [employeeId])).rows;
      const byId = new Map(before.map((row) => [Number(row.contact_id), row]));
      for (const contact of prepared) {
        if (contact.contactId !== null && !byId.has(contact.contactId)) {
          throw new ApiError(409, 'EMPLOYEE_CONTACTS_VERSION_CONFLICT', 'Контакт уже удалён; обновите страницу');
        }
      }
      const kept = new Set(prepared.filter((contact) => contact.contactId !== null).map((contact) => contact.contactId as number));
      const actorId = Number(actor.id);
      const removed = before.filter((row) => !kept.has(Number(row.contact_id))).map((row) => Number(row.contact_id));
      // The whole old set goes first and kept contacts come back under their own ids: the unique indexes
      // (value, primary) only ever see the final set, so swapping values or primaries between contacts works.
      await tx.query('DELETE FROM employee_work_contacts WHERE employee_id = $1', [employeeId]);
      for (const contact of prepared) {
        const previous = contact.contactId !== null ? byId.get(contact.contactId) : undefined;
        if (previous) {
          await tx.query(`INSERT INTO employee_work_contacts (contact_id, employee_id, kind, value, value_normalized, is_primary, note, position,
              created_by, created_at, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
          [contact.contactId, employeeId, contact.kind, contact.value, contact.valueNormalized, contact.isPrimary, contact.note, contact.position,
            previous.created_by, previous.created_at, actorId]);
        } else {
          await tx.query(`INSERT INTO employee_work_contacts (employee_id, kind, value, value_normalized, is_primary, note, position,
              created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [employeeId, contact.kind, contact.value, contact.valueNormalized, contact.isPrimary, contact.note, contact.position, actorId]);
        }
      }
      await tx.query('UPDATE employees SET work_contacts_version = work_contacts_version + 1 WHERE employee_id = $1', [employeeId]);
      const after = await this.get(employeeId, tx);
      await auditService.record(tx, {
        event: 'employee.work_contacts.updated', entityType: 'employee', entityId: employeeId,
        actorUserId: actorId, actorUsername: actor.username, actorRole: actor.role, requestId, source: SOURCE,
        relatedEntities: [{ entityType: 'employee', entityId: employeeId }],
        before: { version, contacts: before.map((row) => auditView(toContact(row))) },
        after: { version: after.version, contacts: after.contacts.map(auditView) },
        metadata: { added: prepared.filter((contact) => contact.contactId === null).length, removed: removed.length },
      });
      return after;
    }).catch((error: unknown) => {
      const record = error as { code?: string; constraint?: string } | null;
      // The set is validated before writing and the employee row is locked: a unique violation here is a duplicate value.
      if (record?.code === '23505') throw new ApiError(422, 'EMPLOYEE_CONTACT_DUPLICATE', 'Такой контакт уже есть у сотрудника');
      throw error;
    });
  }
}

function toContact(row: ContactRow): EmployeeContact {
  return {
    contactId: Number(row.contact_id), kind: row.kind, value: row.value, valueNormalized: row.value_normalized,
    isPrimary: row.is_primary, note: row.note,
  };
}

/** Audit: kind, primary and a mask — never the value itself; the note only by its length. */
function auditView(contact: EmployeeContact) {
  return {
    contactId: contact.contactId, kind: contact.kind, isPrimary: contact.isPrimary,
    masked: maskContact(contact.kind, contact.valueNormalized), noteLength: contact.note?.length ?? 0,
  };
}
