import { Inject, Injectable } from '@nestjs/common';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  assertSuppliersSelectable,
  loadMaterialSuppliers,
  loadOnecSuppliers,
  replaceMaterialSuppliers,
} from '../adapters/pg-material-suppliers';
import { sameIds, supplierRelatedEntities, type MaterialSupplierRef } from './material-suppliers';

export const FILM_SUPPLIERS_AUDIT_EVENT = 'film.suppliers_changed';
export const FILM_SUPPLIERS_AUDIT_SOURCE = 'backend-material-suppliers';

export interface FilmSuppliersDto {
  filmId: number;
  /** Выбранные человеком, по порядку (первый — основной). */
  suppliers: MaterialSupplierRef[];
  /** Поставщики по приходам 1С (журнал, только чтение). */
  onecSuppliers: Array<{ key: string; name: string }>;
}

export interface ReplaceFilmSuppliersCommand {
  currentUser: CurrentUser;
  requestId: string;
  filmId: number;
  supplierIds: number[];
  /** Список, который видел пользователь: другой — 409 (кто-то успел поменять). */
  expectedSupplierIds: number[];
}

/**
 * Поставщики плёнки (migr 280). Сама плёнка пишется через Hasura; список поставщиков — только здесь: под блокировкой
 * плёнки, со сверкой ожидаемого списка и аудитом в той же транзакции. Права проверяет контроллер (references.view /
 * references.manage — те же, что у чтения и правки плёнок в Hasura).
 */
@Injectable()
export class FilmSuppliersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(filmIds: number[]): Promise<FilmSuppliersDto[]> {
    if (filmIds.length === 0) return [];
    const [manual, onec] = await Promise.all([
      loadMaterialSuppliers(this.database, 'film', filmIds),
      loadOnecSuppliers(this.database, 'film', filmIds),
    ]);
    return filmIds.map((filmId) => ({ filmId, suppliers: manual.get(filmId) ?? [], onecSuppliers: onec.get(filmId) ?? [] }));
  }

  async replace(command: ReplaceFilmSuppliersCommand): Promise<FilmSuppliersDto> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT set_session_user($1)', [String(command.currentUser.id)]);
      const film = await tx.query('SELECT film_id FROM films WHERE film_id = $1 FOR UPDATE', [command.filmId]);
      if (film.rowCount === 0) throw new ApiError(404, 'FILM_NOT_FOUND', 'Плёнка не найдена');
      const before = ((await loadMaterialSuppliers(tx, 'film', [command.filmId])).get(command.filmId) ?? []).map((s) => s.id);
      if (!sameIds(before, command.expectedSupplierIds)) {
        throw new ApiError(409, 'FILM_SUPPLIERS_STALE', 'Список поставщиков плёнки уже изменили — обновите карточку', {
          currentSupplierIds: before,
        });
      }
      if (!sameIds(before, command.supplierIds)) {
        await assertSuppliersSelectable(tx, command.supplierIds, before);
        const actorId = Number(command.currentUser.id);
        await replaceMaterialSuppliers(tx, 'film', command.filmId, command.supplierIds, Number.isSafeInteger(actorId) ? actorId : null);
        await auditService.record(tx, {
          event: FILM_SUPPLIERS_AUDIT_EVENT,
          entityType: 'film',
          entityId: command.filmId,
          actorUserId: command.currentUser.id,
          actorUsername: command.currentUser.username ?? null,
          actorRole: command.currentUser.role ?? null,
          requestId: command.requestId,
          source: FILM_SUPPLIERS_AUDIT_SOURCE,
          before: { supplierIds: before },
          after: { supplierIds: command.supplierIds },
          diff: { supplierIds: { before, after: command.supplierIds } },
          relatedEntities: [{ entityType: 'film', entityId: command.filmId }, ...supplierRelatedEntities(before, command.supplierIds)],
        });
      }
      const [manual, onec] = await Promise.all([
        loadMaterialSuppliers(tx, 'film', [command.filmId]),
        loadOnecSuppliers(tx, 'film', [command.filmId]),
      ]);
      return { filmId: command.filmId, suppliers: manual.get(command.filmId) ?? [], onecSuppliers: onec.get(command.filmId) ?? [] };
    });
  }
}
