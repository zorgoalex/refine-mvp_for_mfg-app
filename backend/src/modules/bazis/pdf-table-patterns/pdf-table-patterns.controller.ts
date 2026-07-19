import { createHash } from 'node:crypto';
import {
  Body, CanActivate, Controller, ExecutionContext, Headers, Inject, Injectable, Module,
  Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseModule } from '../../../database/database.module';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsModule } from '../../../permissions/permissions.module';
import { PermissionsService } from '../../../permissions/permissions.service';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../../permissions/require-permissions.decorator';

const columnSchema = z.object({
  header: z.string().max(120),
  relativeStart: z.number().min(0).max(1),
  relativeEnd: z.number().min(0).max(1),
  children: z.array(z.string().max(120)).max(10).optional(),
}).strict();
const signatureSchema = z.object({
  fingerprintVersion: z.literal(1),
  parserMajor: z.literal(1),
  headerBandCount: z.number().int().min(1).max(10),
  columns: z.array(columnSchema).min(1).max(50),
}).strict();
const targetSchema = z.enum([
  'position', 'designation', 'basis_project', 'basis_product', 'name', 'quantity', 'length', 'width',
  'compound_size', 'material', 'film', 'milling', 'note', 'ignore',
]);
const mappingSchema = z.object({
  schemaVersion: z.literal(1),
  geometryCandidateRole: z.enum(['header', 'data']).optional(),
  columns: z.array(z.object({
    columnIndex: z.number().int().min(0).max(49),
    target: targetSchema,
  }).strict()).min(1).max(50),
}).strict();
const matchSchema = z.object({ signatures: z.array(signatureSchema).min(1).max(50) }).strict();
const learnSchema = z.object({ signature: signatureSchema, mapping: mappingSchema }).strict();
const updateSchema = z.object({
  version: z.number().int().min(1),
  mapping: mappingSchema.optional(),
  approvalStatus: z.enum(['approved', 'rejected']).optional(),
  isActive: z.boolean().optional(),
}).strict();
type Signature = z.infer<typeof signatureSchema>;
type Mapping = z.infer<typeof mappingSchema>;

interface PatternRow {
  bazis_pdf_table_pattern_id: string | number;
  fingerprint: string;
  fingerprint_version: number;
  parser_major: number;
  signature_json: Signature;
  mapping_json: Mapping;
  mapping_hash: string;
  approval_status: 'pending' | 'approved' | 'rejected';
  is_active: boolean;
  version: number;
}

export class PdfTablePatternsService {
  private readonly permissions = new PermissionsService();
  constructor(private readonly db: DatabaseService, private readonly config: ConfigService) {}

  async match(user: CurrentUser, requestId: string, input: unknown) {
    this.assertEnabled();
    assertBodySize(input);
    await this.require(user, requestId, 'orders.import', 'match');
    const body = parse(matchSchema, input);
    const signatures = body.signatures.map(canonicalSignature);
    const keys = signatures.map(fingerprint);
    const result = await this.db.query<PatternRow>(
      `SELECT * FROM bazis_pdf_table_patterns
       WHERE is_active AND fingerprint_version=1 AND parser_major=1
         AND fingerprint = ANY($1::varchar[])`,
      [keys],
    );
    return {
      results: signatures.map((signature, index) => {
        const key = keys[index];
        const row = result.rows.find(candidate =>
          candidate.fingerprint === key
          && stableSerialize(candidate.signature_json) === stableSerialize(signature));
        return {
          index,
          fingerprint: key,
          status: row ? 'exact' : 'none',
          requiresConfirmation: !row || row.approval_status !== 'approved',
          pattern: row ? dto(row) : null,
        };
      }),
    };
  }

  async learn(user: CurrentUser, requestId: string, key: string, input: unknown) {
    this.assertEnabled();
    assertBodySize(input);
    await this.require(user, requestId, 'orders.import', 'learn');
    assertUuid(key);
    const body = parse(learnSchema, input);
    const signature = canonicalSignature(body.signature);
    validateMapping(body.mapping, signature);
    const fp = fingerprint(signature);
    const mapHash = hash(stableSerialize(body.mapping));
    return this.db.transaction(async tx => {
      const replay = await claimIdempotency<ReturnType<typeof dto>>(
        tx, key, 'bazis.pdf_table_pattern.create', user.id, fp,
        hash(stableSerialize({ signature, mapping: body.mapping })),
      );
      if (replay) return replay;
      const existing = await tx.query<PatternRow>(
        'SELECT * FROM bazis_pdf_table_patterns WHERE fingerprint_version=1 AND parser_major=1 AND fingerprint=$1 FOR UPDATE',
        [fp],
      );
      const row = existing.rows[0];
      if (row) {
        if (stableSerialize(row.signature_json) !== stableSerialize(signature) || row.mapping_hash !== mapHash) {
          throw new ApiError(409, 'LAYOUT_PATTERN_CONFLICT', 'Для структуры уже сохранено другое сопоставление');
        }
        const response = dto(row);
        await completeIdempotency(tx, key, response);
        return response;
      }
      const approval = user.permissions.includes('bazis.manage') ? 'approved' : 'pending';
      const inserted = await tx.query<PatternRow>(
        `INSERT INTO bazis_pdf_table_patterns
          (fingerprint,fingerprint_version,parser_major,signature_json,mapping_json,mapping_hash,
           approval_status,learned_by,edited_by)
         VALUES ($1,1,1,$2::jsonb,$3::jsonb,$4,$5,$6,$6)
         ON CONFLICT (fingerprint_version,parser_major,fingerprint) DO NOTHING
         RETURNING *`,
        [fp, JSON.stringify(signature), JSON.stringify(body.mapping), mapHash, approval, user.id],
      );
      let created = inserted.rows[0];
      if (!created) {
        const concurrent = await tx.query<PatternRow>(
          `SELECT * FROM bazis_pdf_table_patterns
           WHERE fingerprint_version=1 AND parser_major=1 AND fingerprint=$1`,
          [fp],
        );
        created = concurrent.rows[0];
        if (!created
          || stableSerialize(created.signature_json) !== stableSerialize(signature)
          || created.mapping_hash !== mapHash) {
          throw new ApiError(409, 'LAYOUT_PATTERN_CONFLICT', 'Для структуры уже сохранено другое сопоставление');
        }
        const response = dto(created);
        await completeIdempotency(tx, key, response);
        return response;
      }
      await mutationEffects(tx, 'created', null, created, user, requestId, key);
      const response = dto(created);
      await completeIdempotency(tx, key, response);
      return response;
    });
  }

  async update(user: CurrentUser, requestId: string, fp: string, key: string, input: unknown) {
    this.assertEnabled();
    assertBodySize(input);
    await this.require(user, requestId, 'bazis.manage', 'manage');
    assertUuid(key);
    if (!/^[0-9a-f]{64}$/.test(fp)) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid fingerprint');
    const body = parse(updateSchema, input);
    return this.db.transaction(async tx => {
      const replay = await claimIdempotency<ReturnType<typeof dto>>(
        tx, key, 'bazis.pdf_table_pattern.update', user.id, fp,
        hash(stableSerialize({ fingerprint: fp, ...body })),
      );
      if (replay) return replay;
      const currentResult = await tx.query<PatternRow>(
        'SELECT * FROM bazis_pdf_table_patterns WHERE fingerprint=$1 FOR UPDATE',
        [fp],
      );
      const current = currentResult.rows[0];
      if (!current) throw new ApiError(404, 'LAYOUT_PATTERN_NOT_FOUND', 'Паттерн не найден');
      if (body.mapping) validateMapping(body.mapping, current.signature_json);
      const updated = await tx.query<PatternRow>(
        `UPDATE bazis_pdf_table_patterns SET
           mapping_json=COALESCE($3::jsonb,mapping_json),
           mapping_hash=CASE WHEN $3::jsonb IS NULL THEN mapping_hash ELSE $4 END,
           approval_status=COALESCE($5,approval_status), is_active=COALESCE($6,is_active),
           version=version+1,edited_by=$7,updated_at=now()
         WHERE fingerprint=$1 AND version=$2 RETURNING *`,
        [fp, body.version, body.mapping ? JSON.stringify(body.mapping) : null,
          body.mapping ? hash(stableSerialize(body.mapping)) : null,
          body.approvalStatus ?? null, body.isActive ?? null, user.id],
      );
      const row = updated.rows[0];
      if (!row) throw new ApiError(409, 'STALE_VERSION', 'Паттерн изменён другим пользователем');
      const action = body.approvalStatus
        ?? (body.isActive === false ? 'deactivated' : 'updated');
      await mutationEffects(tx, action, current, row, user, requestId, key);
      const response = dto(row);
      await completeIdempotency(tx, key, response);
      return response;
    });
  }

  private async require(user: CurrentUser, requestId: string, permission: 'orders.import' | 'bazis.manage', action: string) {
    if (this.permissions.canUser(user, permission)) return;
    await auditService.recordDenied(this.db, {
      event: 'bazis_pdf_table_pattern.permission_denied', entityType: 'bazis_pdf_table_pattern',
      entityId: 0, actorUserId: user.id, actorUsername: user.username, actorRole: user.role,
      requestId, source: 'backend.bazis.pdf-patterns', reason: 'PERMISSION_DENIED',
      requiredPermissions: [permission], metadata: { action },
    }).catch(() => undefined);
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав', { requiredPermissions: [permission] });
  }

  private assertEnabled() {
    if (!this.config.get<boolean>('BACKEND_ENABLE_PDF_IMPORT_LAYOUT_PATTERNS')) {
      throw new ApiError(503, 'FEATURE_DISABLED', 'PDF layout patterns are disabled');
    }
  }
}

@Injectable()
class PdfTablePatternsPermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<readonly PermissionName[]>(
      REQUIRED_PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    ) ?? [];
    if (required.length === 0) return true;
    const request = context.switchToHttp().getRequest<RequestWithCurrentUser & {
      method?: string;
      url?: string;
    }>();
    const user = request.user;
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const missing = required.filter(permission => !this.permissions.canUser(user, permission));
    if (missing.length === 0) return true;
    await auditService.recordDenied(this.db, {
      event: 'bazis_pdf_table_pattern.permission_denied',
      entityType: 'bazis_pdf_table_pattern',
      entityId: 0,
      actorUserId: user.id,
      actorUsername: user.username,
      actorRole: user.role,
      requestId: request.requestId ?? 'missing-request-id',
      source: 'backend.bazis.pdf-patterns.guard',
      reason: 'PERMISSION_DENIED',
      requiredPermissions: missing,
      metadata: { action: `${request.method ?? 'UNKNOWN'} ${request.url ?? ''}`.trim() },
    }).catch(() => undefined);
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав', {
      requiredPermissions: missing,
    });
  }
}

@ApiTags('Bazis PDF table patterns')
@ApiBearerAuth()
@Controller('bazis/pdf-table-patterns')
@UseGuards(PdfTablePatternsPermissionsGuard)
class PdfTablePatternsController {
  constructor(@Inject(PdfTablePatternsService) private readonly service: PdfTablePatternsService) {}

  @ApiOperation({ operationId: 'matchBazisPdfTablePatterns' })
  @Post('match')
  @RequirePermissions('orders.import')
  match(@Req() req: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.match(requireUser(req), requireRequestId(req), body);
  }

  @ApiOperation({ operationId: 'learnBazisPdfTablePattern' })
  @Post()
  @RequirePermissions('orders.import')
  learn(@Req() req: RequestWithCurrentUser, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    return this.service.learn(requireUser(req), requireRequestId(req), key, body);
  }

  @ApiOperation({ operationId: 'updateBazisPdfTablePattern' })
  @Patch(':fingerprint')
  @RequirePermissions('bazis.manage')
  update(@Req() req: RequestWithCurrentUser, @Param('fingerprint') fp: string,
    @Headers('idempotency-key') key: string, @Body() body: unknown) {
    return this.service.update(requireUser(req), requireRequestId(req), fp, key, body);
  }
}

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [PdfTablePatternsController],
  providers: [PdfTablePatternsPermissionsGuard, {
    provide: PdfTablePatternsService,
    useFactory: (db: DatabaseService, config: ConfigService) =>
      new PdfTablePatternsService(db, config),
    inject: [DatabaseService, ConfigService],
  }],
})
export class PdfTablePatternsModule {}

export function canonicalSignature(value: Signature): Signature {
  return {
    fingerprintVersion: 1, parserMajor: 1, headerBandCount: value.headerBandCount,
    columns: value.columns.map(column => ({
      header: normalizeHeader(column.header),
      relativeStart: ratio(column.relativeStart), relativeEnd: ratio(column.relativeEnd),
      ...(column.children?.length ? { children: column.children.map(normalizeHeader) } : {}),
    })),
  };
}
function normalizeHeader(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function ratio(value: number) { return Math.round(value * 1000) / 1000; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function fingerprint(value: Signature) { return hash(stableSerialize(value)); }
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный паттерн PDF', { issues: result.error.issues });
  return result.data;
}
export function validateMapping(mapping: Mapping, signature?: Signature) {
  const targets = mapping.columns.map(item => item.target);
  const indexes = mapping.columns.map(item => item.columnIndex);
  const sortedIndexes = [...indexes].sort((a, b) => a - b);
  const duplicates = targets.filter((target, index) =>
    target !== 'ignore' && targets.indexOf(target) !== index);
  const hasExactCoverage = !signature || (
    indexes.length === signature.columns.length
    && new Set(indexes).size === indexes.length
    && sortedIndexes.every((value, index) => value === index)
  );
  const geometryRoleIsPresent = !signature
    || !signature.columns.every((column, index) => column.header === `column ${index + 1}`)
    || Boolean(mapping.geometryCandidateRole);
  if (!targets.includes('name') || !targets.includes('quantity')
    || !(targets.includes('compound_size') || (targets.includes('length') && targets.includes('width')))
    || duplicates.length > 0 || !hasExactCoverage || !geometryRoleIsPresent) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Не сопоставлены обязательные поля');
  }
}
function assertUuid(key: string) {
  if (!z.string().uuid().safeParse(key).success) throw new ApiError(422, 'VALIDATION_ERROR', 'Idempotency-Key must be UUID');
}
function assertBodySize(input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input ?? null), 'utf8') > 256 * 1024) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'PDF pattern payload exceeds 256 KiB');
  }
}
function dto(row: PatternRow) {
  return {
    id: Number(row.bazis_pdf_table_pattern_id), fingerprint: row.fingerprint,
    fingerprintVersion: row.fingerprint_version, parserMajor: row.parser_major,
    signature: row.signature_json, mapping: row.mapping_json,
    approvalStatus: row.approval_status, isActive: row.is_active, version: row.version,
  };
}
async function mutationEffects(tx: TransactionClient, action: string, before: PatternRow | null, row: PatternRow,
  user: CurrentUser, requestId: string, idempotencyKey: string) {
  const id = Number(row.bazis_pdf_table_pattern_id);
  const event = `bazis.pdf_table_pattern_${action}`;
  const auditId = await auditService.record(tx, {
    event, entityType: 'bazis_pdf_table_pattern', entityId: id,
    actorUserId: user.id, actorUsername: user.username, actorRole: user.role,
    requestId, source: 'backend.bazis.pdf-patterns',
    before: before ? patternAuditSnapshot(before) : null,
    after: patternAuditSnapshot(row),
    metadata: {
      idempotencyKeyHash: hash(idempotencyKey),
      mappingHash: row.mapping_hash,
      mappedRoles: mappedRoles(row.mapping_json),
      fingerprintVersion: row.fingerprint_version,
      parserMajor: row.parser_major,
    },
  });
  await tx.query(
    `INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key)
     VALUES ($1,'bazis_pdf_table_pattern',$2,$3::jsonb,$4) ON CONFLICT (idempotency_key) DO NOTHING`,
    [event, String(id), JSON.stringify({ eventType: event, patternId: id,
      fingerprint: row.fingerprint, fingerprintVersion: row.fingerprint_version,
      parserMajor: row.parser_major, version: row.version, mappingHash: row.mapping_hash,
      mappedRoles: mappedRoles(row.mapping_json), approvalStatus: row.approval_status,
      isActive: row.is_active, idempotencyKeyHash: hash(idempotencyKey),
      actorUserId: user.id, requestId, auditId }),
      `${hash(idempotencyKey)}:${event}`],
  );
}

function patternAuditSnapshot(row: PatternRow) {
  return {
    fingerprint: row.fingerprint,
    fingerprintVersion: row.fingerprint_version,
    parserMajor: row.parser_major,
    mappingHash: row.mapping_hash,
    mappedRoles: mappedRoles(row.mapping_json),
    approvalStatus: row.approval_status,
    isActive: row.is_active,
    version: row.version,
  };
}

function mappedRoles(mapping: Mapping) {
  return [...new Set(mapping.columns.map(column => column.target).filter(target => target !== 'ignore'))];
}
function requireUser(req: RequestWithCurrentUser) {
  if (!req.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return req.user;
}
function requireRequestId(req: RequestWithCurrentUser) {
  if (!req.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return req.requestId;
}

async function claimIdempotency<T>(
  tx: TransactionClient,
  key: string,
  commandName: string,
  actorUserId: string | number,
  entityId: string,
  requestHash: string,
): Promise<T | null> {
  const inserted = await tx.query(
    `INSERT INTO command_idempotency_keys
       (idempotency_key,command_name,actor_user_id,entity_type,entity_id,request_hash,status)
     VALUES ($1,$2,$3,'bazis_pdf_table_pattern',$4,$5,'processing')
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
    [key, commandName, actorUserId, entityId, requestHash],
  );
  if (inserted.rowCount === 1) return null;
  const existing = await tx.query<{
    request_hash: string;
    actor_user_id: string | number;
    status: string;
    response_json: T | null;
  }>(
    `SELECT request_hash,actor_user_id,status,response_json
     FROM command_idempotency_keys WHERE idempotency_key=$1 FOR UPDATE`,
    [key],
  );
  const row = existing.rows[0];
  if (!row || row.request_hash !== requestHash || String(row.actor_user_id) !== String(actorUserId)) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused with different request');
  }
  if (row.status === 'completed' && row.response_json) return row.response_json;
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
}

async function completeIdempotency(tx: TransactionClient, key: string, response: unknown) {
  await tx.query(
    `UPDATE command_idempotency_keys
     SET status='completed',response_json=$2::jsonb,completed_at=now()
     WHERE idempotency_key=$1`,
    [key, JSON.stringify(response)],
  );
}
