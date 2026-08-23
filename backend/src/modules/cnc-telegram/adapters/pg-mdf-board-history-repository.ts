import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type {
  GetMdfBoardHistoryCommand,
  MdfBoardHistoryRepositoryPort,
  SearchMdfBoardHistoryOrdersCommand,
} from '../application/mdf-board-history.types';
import type {
  MdfBoardHistoryBlockerDto,
  MdfBoardHistoryColumn,
  MdfBoardHistoryCurrentCardDto,
  MdfBoardHistoryDiagnosisDto,
  MdfBoardHistoryEpisodeDto,
  MdfBoardHistoryEventDto,
  MdfBoardHistoryOrderOptionDto,
  MdfBoardHistoryOrderOptionsResponseDto,
  MdfBoardHistoryResponseDto,
  MdfBoardHistorySubjectKind,
} from '../dto/mdf-board-history.dto';
import type {
  CncTelegramBathCardDto,
  CncTelegramBazisCutSetCardDto,
  CncTelegramPacketDto,
  CncTelegramTodayColumnDto,
} from '../dto/cnc-telegram.dto';
import { PgCncTelegramRepository } from './pg-cnc-telegram-repository';

interface OrderRow extends QueryResultRow {
  order_id: string | number;
  order_name: string;
  full_number: string;
  delete_flag: boolean;
  created_at: string | Date;
  order_status_name?: string | null;
}

interface RangeRow extends QueryResultRow {
  date_from: string;
  date_to: string;
}

interface ManualMoveRow extends QueryResultRow {
  card_kind: string;
  card_id: string;
  target_column: string;
  updated_at: string | Date;
  username: string | null;
}

interface AuditHistoryRow extends QueryResultRow {
  audit_id: string;
  event: string;
  entity_type: string | null;
  entity_id: string | null;
  username: string | null;
  source: string | null;
  request_id: string;
  status_name: string | null;
  status_code: string | null;
  before_json: unknown;
  after_json: unknown;
  diff_json: unknown;
  metadata_json: unknown;
  created_at: string | Date;
  provenance: 'recorded' | 'reconstructed' | null;
}

export interface CurrentSource {
  kind: Exclude<MdfBoardHistorySubjectKind, 'order'>;
  id: string;
  label: string;
  automaticColumn: MdfBoardHistoryColumn;
  currentColumn: MdfBoardHistoryColumn;
  quantity: number;
}

const HISTORY_COLUMNS = new Set<MdfBoardHistoryColumn>([
  'parsed', 'completed', 'completed_laminated', 'baths', 'baths_ready',
  'baths_laminated', 'completed_baths', 'orders', 'orders_ready', 'orders_issued',
]);

const HISTORY_EVENT_PREFIXES = [
  'orders.',
  'order.',
  'production.',
  'cnc.telegram_packet.',
  'cnc.manual_svg_upload.',
  'cut_job.',
  'bazis_cut_set.',
  'mdf_board.',
  'status_automation.',
];

export class PgMdfBoardHistoryRepository implements MdfBoardHistoryRepositoryPort {
  private readonly boardRepository: PgCncTelegramRepository;

  constructor(private readonly database: DatabaseService) {
    this.boardRepository = new PgCncTelegramRepository(database);
  }

  async searchOrders(
    command: SearchMdfBoardHistoryOrdersCommand,
  ): Promise<MdfBoardHistoryOrderOptionsResponseDto> {
    const search = command.query.trim();
    const result = await this.database.query<OrderRow>(
      `
      SELECT
        o.order_id,
        COALESCE(NULLIF(BTRIM(o.order_name), ''), o.order_id::text) AS order_name,
        COALESCE(NULLIF(BTRIM(p.code || '-' || o.order_name), ''), NULLIF(BTRIM(o.order_name), ''), o.order_id::text) AS full_number,
        COALESCE(o.delete_flag, false) AS delete_flag,
        o.created_at
      FROM orders o
      LEFT JOIN projects p ON p.project_id = o.project_id
      WHERE (
        $1 = ''
        OR o.order_id::text = $1
        OR o.order_name ILIKE '%' || $1 || '%'
        OR p.code ILIKE '%' || $1 || '%'
        OR (p.code || '-' || o.order_name) ILIKE '%' || $1 || '%'
      )
      ORDER BY
        CASE WHEN o.order_id::text = $1 THEN 0 ELSE 1 END,
        COALESCE(o.updated_at, o.created_at) DESC,
        o.order_id DESC
      LIMIT $2
      `,
      [search, command.limit],
    );
    return {
      data: result.rows.map(mapOrderOption),
      generatedAt: new Date().toISOString(),
    };
  }

  async getHistory(command: GetMdfBoardHistoryCommand): Promise<MdfBoardHistoryResponseDto> {
    const [orderResult, rangeResult] = await Promise.all([
      this.database.query<OrderRow>(
        `
        SELECT
          o.order_id,
          COALESCE(NULLIF(BTRIM(o.order_name), ''), o.order_id::text) AS order_name,
          COALESCE(NULLIF(BTRIM(p.code || '-' || o.order_name), ''), NULLIF(BTRIM(o.order_name), ''), o.order_id::text) AS full_number,
          COALESCE(o.delete_flag, false) AS delete_flag,
          o.created_at,
          os.order_status_name
        FROM orders o
        LEFT JOIN projects p ON p.project_id = o.project_id
        LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
        WHERE o.order_id = $1
        `,
        [command.orderId],
      ),
      this.database.query<RangeRow>(`
        SELECT
          (CURRENT_DATE - INTERVAL '2 months')::date::text AS date_from,
          CURRENT_DATE::date::text AS date_to
      `),
    ]);
    const orderRow = orderResult.rows[0];
    if (!orderRow) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
    }
    const range = rangeResult.rows[0];
    if (!range) throw new ApiError(500, 'MDF_HISTORY_RANGE_UNAVAILABLE', 'Период истории недоступен');

    const boardDate = command.boardDate ?? range.date_to;
    const [board, manualMoves, auditRows] = await Promise.all([
      this.boardRepository.listToday({
        currentUser: command.currentUser,
        workday: boardDate,
        workdayFrom: boardDate,
        workdayTo: boardDate,
      }),
      this.loadManualMoves(),
      this.loadAuditHistory(command.orderId, range.date_from, range.date_to),
    ]);
    const order = mapOrderOption(orderRow);
    const sources = collectCurrentSources(board.columns, command.orderId, manualMoves);
    const diagnosis = buildDiagnosis(order, orderRow.order_status_name ?? null, sources, manualMoves);
    const events = auditRows
      .filter((row) => HISTORY_EVENT_PREFIXES.some((prefix) => row.event.startsWith(prefix)))
      .map((row) => mapAuditEvent(row, order, diagnosis))
      .filter((event): event is MdfBoardHistoryEventDto => event !== null);
    const episodes = groupEpisodes(events, auditRows);
    const evidenceFrom = events[0]?.occurredAt ?? null;
    const hasOnlyRecordedEvents = events.length > 0
      && events.every((event) => event.provenance === 'recorded');

    return {
      window: { dateFrom: range.date_from, dateTo: range.date_to, boardDate },
      generatedAt: new Date().toISOString(),
      order,
      diagnosis,
      coverage: events.length === 0
        ? {
            status: 'none',
            label: 'За этот период подтверждённых событий нет',
            evidenceFrom: null,
            gaps: ['Текущее состояние показано отдельно от исторических событий'],
          }
        : hasOnlyRecordedEvents
          ? {
              status: 'recorded_exact',
              label: 'Точная история записана в момент изменений',
              evidenceFrom,
              gaps: [],
            }
          : {
            status: 'partial',
            label: 'История восстановлена из журнала операций',
            evidenceFrom,
            gaps: ['События до начала точной записи могут отражать только первое известное состояние'],
          },
      episodes,
    };
  }

  private async loadManualMoves(): Promise<Map<string, ManualMoveRow>> {
    const result = await this.database.query<ManualMoveRow>(`
      SELECT move.card_kind, move.card_id, move.target_column, move.updated_at, actor.username
      FROM mdf_board_manual_moves move
      LEFT JOIN users actor ON actor.user_id = move.updated_by_user_id
    `);
    return new Map(result.rows.map((row) => [`${row.card_kind}:${row.card_id}`, row]));
  }

  private async loadAuditHistory(orderId: number, dateFrom: string, dateTo: string): Promise<AuditHistoryRow[]> {
    const result = await this.database.query<AuditHistoryRow>(
      `
      SELECT
        log.audit_id, log.event, log.entity_type, log.entity_id, log.username, log.source,
        log.request_id, log.status_name, log.status_code, log.before_json, log.after_json,
        log.diff_json, log.metadata_json, log.created_at,
        CASE WHEN recorded.history_event_id IS NULL THEN 'reconstructed' ELSE 'recorded' END AS provenance
      FROM audit_log log
      LEFT JOIN mdf_board_history_events recorded
        ON recorded.source_event_type = 'audit_log'
       AND recorded.source_event_id = log.audit_id::text
       AND recorded.order_id = $1
      WHERE log.created_at >= $2::date
        AND log.created_at < ($3::date + INTERVAL '1 day')
        AND (
          log.related_order_id = $1
          OR (log.entity_type = 'order' AND log.entity_id = $1::text)
          OR EXISTS (
            SELECT 1
            FROM audit_log_related_entity relation
            WHERE relation.audit_id = log.audit_id
              AND relation.entity_type = 'order'
              AND relation.entity_id = $1
          )
        )
      ORDER BY log.created_at, log.audit_id
      `,
      [orderId, dateFrom, dateTo],
    );
    return result.rows;
  }
}

function mapOrderOption(row: OrderRow): MdfBoardHistoryOrderOptionDto {
  return {
    orderId: Number(row.order_id),
    orderName: row.order_name,
    fullNumber: row.full_number,
    deleted: row.delete_flag === true,
    createdAt: toIso(row.created_at),
  };
}

function collectCurrentSources(
  columns: CncTelegramTodayColumnDto[],
  orderId: number,
  manualMoves: ReadonlyMap<string, ManualMoveRow>,
): CurrentSource[] {
  const result: CurrentSource[] = [];
  for (const column of columns) {
    for (const packet of column.packets) {
      const items = packet.items.filter((item) => (item.matchOrderId ?? item.orderId) === orderId);
      if (items.length === 0) continue;
      result.push(sourceFromPacket(packet, column.key, items.reduce((sum, item) => sum + item.quantity, 0), manualMoves));
    }
    for (const bath of column.baths) {
      const items = bath.items.filter((item) => item.orderId === orderId);
      if (items.length === 0) continue;
      result.push(sourceFromBath(bath, column.key, items.reduce((sum, item) => sum + item.quantity, 0), manualMoves));
    }
    for (const set of column.bazisCutSets ?? []) {
      const items = set.items.filter((item) => item.orderId === orderId);
      if (items.length === 0) continue;
      result.push(sourceFromBazis(set, column.key, items.reduce((sum, item) => sum + item.quantity, 0), manualMoves));
    }
  }
  return result;
}

function sourceFromPacket(
  packet: CncTelegramPacketDto,
  column: CncTelegramTodayColumnDto['key'],
  quantity: number,
  moves: ReadonlyMap<string, ManualMoveRow>,
): CurrentSource {
  const label = packet.cuttingSequenceNo
    ? `Файл станка №${packet.cuttingSequenceNo}`
    : `Файл станка ${packet.programName ?? packet.packetId}`;
  return currentSource('packet', packet.packetId, label, column, quantity, moves);
}

function sourceFromBath(
  bath: CncTelegramBathCardDto,
  column: CncTelegramTodayColumnDto['key'],
  quantity: number,
  moves: ReadonlyMap<string, ManualMoveRow>,
): CurrentSource {
  return currentSource('bath', bath.bathCardId, `Ванна ${bath.displayCutNumber ?? bath.cutNumber}`, column, quantity, moves);
}

function sourceFromBazis(
  set: CncTelegramBazisCutSetCardDto,
  column: CncTelegramTodayColumnDto['key'],
  quantity: number,
  moves: ReadonlyMap<string, ManualMoveRow>,
): CurrentSource {
  return currentSource('bazisCutSet', String(set.bazisCutSetId), `Набор Bazis ${set.name}`, column, quantity, moves);
}

function currentSource(
  kind: CurrentSource['kind'],
  id: string,
  label: string,
  automaticColumn: MdfBoardHistoryColumn,
  quantity: number,
  moves: ReadonlyMap<string, ManualMoveRow>,
): CurrentSource {
  const target = parseColumn(moves.get(`${kind}:${id}`)?.target_column) ?? automaticColumn;
  return { kind, id, label, automaticColumn, currentColumn: target, quantity };
}

export function buildDiagnosis(
  order: MdfBoardHistoryOrderOptionDto,
  orderStatusName: string | null,
  sources: CurrentSource[],
  manualMoves: ReadonlyMap<string, ManualMoveRow>,
): MdfBoardHistoryDiagnosisDto {
  const currentCards = sources.map<MdfBoardHistoryCurrentCardDto>((source) => ({
    subjectKind: source.kind,
    subjectId: source.id,
    existsNow: true,
    cardKind: source.kind,
    cardId: source.id,
    label: source.label,
    currentColumn: source.currentColumn,
    automaticColumn: source.automaticColumn,
    reasonUnavailable: null,
  }));
  const blockers: MdfBoardHistoryBlockerDto[] = [];
  const uncut = sources.filter((source) =>
    (source.kind === 'packet' || source.kind === 'bazisCutSet') && source.automaticColumn === 'parsed');
  const unrolled = sources.filter((source) =>
    source.kind === 'bath' && !['baths_laminated', 'completed_baths'].includes(source.automaticColumn));
  if (order.deleted) {
    blockers.push({ code: 'ORDER_DELETED', text: 'Заказ удалён в ERP', count: null, relatedSubjectIds: [] });
  } else if (sources.length === 0) {
    blockers.push({
      code: 'NO_MDF_SOURCES',
      text: 'Для заказа нет карточек файла станка, Bazis или ванны на выбранную дату',
      count: 0,
      relatedSubjectIds: [],
    });
  }
  if (uncut.length > 0) {
    blockers.push({
      code: 'MACHINE_FILES_NOT_CUT',
      text: `Не распилено позиций: ${uncut.reduce((sum, source) => sum + source.quantity, 0)}`,
      count: uncut.reduce((sum, source) => sum + source.quantity, 0),
      relatedSubjectIds: uncut.map((source) => source.id),
    });
  }
  if (unrolled.length > 0) {
    blockers.push({
      code: 'BATHS_NOT_ROLLED',
      text: `Не закатано позиций в ваннах: ${unrolled.reduce((sum, source) => sum + source.quantity, 0)}`,
      count: unrolled.reduce((sum, source) => sum + source.quantity, 0),
      relatedSubjectIds: unrolled.map((source) => source.id),
    });
  }

  const normalizedStatus = normalizeText(orderStatusName);
  const automaticColumn: MdfBoardHistoryColumn | null = sources.length === 0
    ? null
    : normalizedStatus === 'выдан'
      ? 'orders_issued'
      : normalizedStatus === 'готов к выдаче'
        ? 'orders_ready'
        : uncut.length === 0 && unrolled.length === 0
          ? 'orders_ready'
          : 'orders';
  const orderMove = manualMoves.get(`order:${order.orderId}`);
  const manualColumn = parseColumn(orderMove?.target_column);
  const statusOverridesManual = automaticColumn === 'orders_ready' || automaticColumn === 'orders_issued';
  const currentColumn = statusOverridesManual ? automaticColumn : manualColumn ?? automaticColumn;
  if (sources.length > 0) {
    currentCards.unshift({
      subjectKind: 'order',
      subjectId: String(order.orderId),
      existsNow: true,
      cardKind: 'order',
      cardId: String(order.orderId),
      label: `Заказ ${order.fullNumber}`,
      currentColumn,
      automaticColumn,
      reasonUnavailable: null,
    });
  }
  const presence = order.deleted ? 'deleted' : sources.length > 0 ? 'on_board' : 'not_on_board';
  const explanation = presence === 'deleted'
    ? 'Заказ удалён, поэтому его текущая карточка не показывается на МДФ-доске.'
    : presence === 'not_on_board'
      ? 'Заказ создан, но ещё не получил ни одного МДФ-источника. Создание заказа само по себе не создаёт карточку на этой доске.'
      : blockers.length > 0
        ? blockers.map((blocker) => blocker.text).join('. ')
        : currentColumn === 'orders_issued'
          ? 'Заказ находится здесь, потому что его статус — «Выдан».'
          : 'Все найденные МДФ-позиции распилены и ванны закатаны.';
  return {
    presence,
    currentColumn,
    automaticColumn,
    manualOverride: orderMove && manualColumn
      ? {
          targetColumn: manualColumn,
          updatedAt: toIso(orderMove.updated_at),
          actorName: orderMove.username,
        }
      : null,
    title: presence === 'on_board'
      ? `Заказ сейчас в колонке «${columnTitle(currentColumn)}»`
      : presence === 'deleted'
        ? 'Заказ удалён и отсутствует на доске'
        : 'Заказ ещё не появился на МДФ-доске',
    explanation,
    blockers,
    relatedCurrentCards: currentCards,
  };
}

function mapAuditEvent(
  row: AuditHistoryRow,
  order: MdfBoardHistoryOrderOptionDto,
  diagnosis: MdfBoardHistoryDiagnosisDto,
): MdfBoardHistoryEventDto | null {
  const before = recordValue(row.before_json);
  const after = recordValue(row.after_json);
  const metadata = recordValue(row.metadata_json);
  let subjectKind: MdfBoardHistorySubjectKind = 'order';
  let subjectId = String(order.orderId);
  let subjectLabel = `Заказ ${order.fullNumber}`;
  let eventKind: MdfBoardHistoryEventDto['eventKind'] = 'progress';
  let fromColumn: MdfBoardHistoryColumn | null = null;
  let toColumn: MdfBoardHistoryColumn | null = null;
  let reasonCode = row.event.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  let reason = 'Изменилось связанное производственное состояние';
  let consequence = 'Текущее положение заказа пересчитано по связанным данным.';

  if (row.event === 'orders.create') {
    eventKind = 'not_on_board';
    reasonCode = 'ORDER_CREATED';
    reason = 'Заказ создан в ERP';
    consequence = 'Само создание заказа не создаёт карточку на МДФ-доске — нужен файл станка, набор Bazis или ванна.';
  } else if (row.event.startsWith('cnc.telegram_packet.') || row.event.startsWith('cnc.manual_svg_upload.')) {
    subjectKind = 'packet';
    subjectId = row.entity_id ?? textValue(metadata.packetId) ?? row.audit_id;
    subjectLabel = textValue(metadata.cuttingSequenceNo)
      ? `Файл станка №${textValue(metadata.cuttingSequenceNo)}`
      : `Файл станка ${textValue(metadata.programName) ?? subjectId}`;
    const completed = textValue(after.completionStatus) === 'completed'
      || after.thumbsUp === true
      || textValue(metadata.completionStatus) === 'completed'
      || metadata.thumbsUp === true;
    eventKind = before && Object.keys(before).length > 0 ? completed ? 'moved' : 'progress' : 'appeared';
    fromColumn = eventKind === 'moved' ? 'parsed' : null;
    toColumn = completed ? 'completed' : 'parsed';
    reasonCode = completed ? 'MACHINE_FILE_COMPLETED' : 'MACHINE_FILE_RECEIVED';
    reason = completed ? 'Станок завершил обработку файла' : 'Файл станка принят и связан с заказом';
    consequence = completed
      ? 'Распил по этой карточке больше не блокирует готовность заказа.'
      : 'У заказа появился МДФ-источник; он может быть показан на доске.';
  } else if (row.event.startsWith('mdf_board.manual_move.')) {
    const cardKind = historySubjectKind(textValue(metadata.cardKind));
    if (!cardKind) return null;
    subjectKind = cardKind;
    subjectId = textValue(metadata.cardId) ?? row.entity_id?.split(':').slice(1).join(':') ?? row.audit_id;
    subjectLabel = subjectLabelFor(subjectKind, subjectId, order);
    fromColumn = parseColumn(textValue(before.targetColumn));
    toColumn = parseColumn(textValue(after.targetColumn));
    eventKind = row.event.endsWith('.deleted') ? 'moved' : fromColumn ? 'moved' : 'appeared';
    reasonCode = row.event.endsWith('.deleted') ? 'MANUAL_MOVE_CLEARED' : 'MANUAL_MOVE';
    reason = row.event.endsWith('.deleted')
      ? 'Ручное перемещение отменено'
      : `Карточка перемещена вручную в «${columnTitle(toColumn)}»`;
    consequence = row.event.endsWith('.deleted')
      ? 'Карточка снова следует автоматическим правилам доски.'
      : 'Ручное положение действует, пока его не отменит оператор или приоритетный статус заказа.';
  } else if (row.event.startsWith('bazis_cut_set.')) {
    subjectKind = 'bazisCutSet';
    subjectId = row.entity_id ?? row.audit_id;
    subjectLabel = `Набор Bazis ${subjectId}`;
    eventKind = row.event.endsWith('.created') ? 'appeared' : row.event.endsWith('.deleted') ? 'disappeared' : 'progress';
    fromColumn = eventKind === 'disappeared' ? 'parsed' : null;
    toColumn = eventKind === 'appeared' ? 'parsed' : null;
    reason = row.event.endsWith('.created')
      ? 'Набор Bazis создан и связан с заказом'
      : row.event.endsWith('.deleted')
        ? 'Набор Bazis удалён'
        : 'Изменился состав набора Bazis';
    consequence = 'Готовность заказа пересчитана по позициям набора.';
  } else if (row.event === 'cut_job.calculated') {
    subjectKind = 'bath';
    const cutResultId = textValue(metadata.cutResultId);
    subjectId = cutResultId ? `cut-result:${cutResultId}` : `cut-job:${row.entity_id ?? row.audit_id}`;
    subjectLabel = `Ванна ${textValue(metadata.cutNumber) ?? row.entity_id ?? ''}`.trim();
    eventKind = 'appeared';
    toColumn = 'baths';
    reasonCode = 'BATH_CREATED';
    reason = 'Рассчитана карта ванны';
    consequence = 'Для готовности заказа теперь учитывается распил и закатка этой ванны.';
  } else if (row.event.startsWith('cut_job.')) {
    subjectKind = 'bath';
    subjectId = `cut-job:${row.entity_id ?? row.audit_id}`;
    subjectLabel = `Раскрой ${row.entity_id ?? ''}`.trim();
    eventKind = row.event.includes('archiv') || row.event.endsWith('.deleted') ? 'disappeared' : 'progress';
    reason = humanizeCutEvent(row.event);
    consequence = 'Связанные ванны и положение заказа пересчитаны.';
  } else if (row.event === 'orders.status_change') {
    const status = normalizeText(row.status_name ?? textValue(after.orderStatusName));
    toColumn = status === 'выдан' ? 'orders_issued' : status === 'готов к выдаче' ? 'orders_ready' : 'orders';
    eventKind = 'moved';
    reasonCode = 'ORDER_STATUS_CHANGED';
    reason = `Статус заказа изменён${row.status_name ? ` на «${row.status_name}»` : ''}`;
    consequence = toColumn === 'orders_issued'
      ? 'Статус «Выдан» имеет приоритет над автоматической и ручной колонкой.'
      : toColumn === 'orders_ready'
        ? 'Статус «Готов к выдаче» переводит заказ в готовые.'
        : 'Колонка снова определяется производственной готовностью и ручным перемещением.';
  } else if (row.event.startsWith('orders.production_status') || row.event.includes('detail_production_status')) {
    reason = row.status_name
      ? `Производственный статус изменён на «${row.status_name}»`
      : 'Изменились производственные статусы деталей';
    consequence = 'Готовность файлов и ванн пересчитана по новым статусам деталей.';
  } else if (row.event.startsWith('status_automation.')) {
    reason = 'Сработало правило автоматизации статусов';
    consequence = 'Автоматическое действие повлияло на связанное производственное состояние.';
  } else if (row.event === 'orders.delete') {
    eventKind = 'disappeared';
    reason = 'Заказ удалён';
    consequence = 'Карточка заказа больше не показывается на доске.';
  } else if (row.event === 'orders.restore') {
    eventKind = 'first_known';
    reason = 'Заказ восстановлен';
    consequence = 'Карточка появится только при наличии MDF-источников.';
  } else {
    return null;
  }

  const relatedCurrentCards = diagnosis.relatedCurrentCards.filter((card) =>
    card.subjectKind === subjectKind && card.subjectId === subjectId);
  return {
    eventId: row.audit_id,
    occurredAt: toIso(row.created_at),
    subjectKind,
    subjectId,
    subjectLabel,
    eventKind,
    fromColumn,
    toColumn,
    reasonCode,
    reason,
    consequence,
    actor: row.username
      ? { kind: 'user', displayName: row.username }
      : { kind: 'system', displayName: 'Система' },
    provenance: row.provenance ?? 'reconstructed',
    relatedCurrentCards,
  };
}

function groupEpisodes(events: MdfBoardHistoryEventDto[], rows: AuditHistoryRow[]): MdfBoardHistoryEpisodeDto[] {
  const requestByAuditId = new Map(rows.map((row) => [row.audit_id, row.request_id || row.audit_id]));
  const groups = new Map<string, MdfBoardHistoryEventDto[]>();
  for (const event of events) {
    const key = requestByAuditId.get(event.eventId) ?? event.eventId;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return Array.from(groups.entries())
    .map<MdfBoardHistoryEpisodeDto>(([episodeId, group]) => {
      const [primaryEvent, ...relatedEvents] = group.sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId));
      if (!primaryEvent) {
        throw new Error(`MDF history episode ${episodeId} has no events`);
      }
      return {
        episodeId,
        occurredAt: primaryEvent.occurredAt,
        title: primaryEvent.reason,
        primaryEvent,
        relatedEvents,
      };
    })
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}

function parseColumn(value: string | null | undefined): MdfBoardHistoryColumn | null {
  return value && HISTORY_COLUMNS.has(value as MdfBoardHistoryColumn)
    ? value as MdfBoardHistoryColumn
    : null;
}

function historySubjectKind(value: string | null): MdfBoardHistorySubjectKind | null {
  if (value === 'order' || value === 'packet' || value === 'bazisCutSet' || value === 'bath') return value;
  return null;
}

function subjectLabelFor(kind: MdfBoardHistorySubjectKind, id: string, order: MdfBoardHistoryOrderOptionDto): string {
  if (kind === 'order') return `Заказ ${order.fullNumber}`;
  if (kind === 'packet') return `Файл станка ${id}`;
  if (kind === 'bath') return `Ванна ${id.replace('cut-result:', '')}`;
  return `Набор Bazis ${id}`;
}

function columnTitle(column: MdfBoardHistoryColumn | null): string {
  if (!column) return 'нет колонки';
  return {
    parsed: 'Файлы на станке',
    completed: 'Распилено',
    completed_laminated: 'Распиленные файлы',
    baths: 'Карты ванн',
    baths_ready: 'Готовы к закатке',
    baths_laminated: 'Закатаны',
    completed_baths: 'Завершённые ванны',
    orders: 'Заказы',
    orders_ready: 'Готов к выдаче',
    orders_issued: 'Выдан',
  }[column];
}

function humanizeCutEvent(event: string): string {
  if (event.endsWith('.current_result_changed')) return 'Изменён действующий раскрой';
  if (event.endsWith('.result_archived')) return 'Версия раскроя архивирована';
  if (event.endsWith('.result_unarchived')) return 'Версия раскроя восстановлена';
  if (event.endsWith('.deleted') || event.endsWith('.archived')) return 'Раскрой удалён с активной доски';
  return 'Изменился связанный раскрой';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
