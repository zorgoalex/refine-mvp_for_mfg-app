export type SchemaPreflightSeverity = 'blocker' | 'error' | 'warning';

export interface SchemaPreflightIssue {
  code: string;
  severity: SchemaPreflightSeverity;
  title: string;
  details: string;
  recommendation: string;
  message?: string;
  remediation?: string;
}

function hasCreateTable(sql: string, tableName: string): boolean {
  return new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\b`,
    'i',
  ).test(sql);
}

function hasTable(sql: string, tableName: string): boolean {
  return hasCreateTable(sql, tableName);
}

function hasTableReference(sql: string, tableName: string): boolean {
  return new RegExp(`\\b${tableName}\\b`, 'i').test(sql);
}

function extractCreateTableBlock(sql: string, tableName: string): string {
  const match = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\b`,
    'i',
  ).exec(sql);

  if (!match) {
    return '';
  }

  const rest = sql.slice(match.index);
  const nextTable = /\nCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_]+\b/i.exec(
    rest.slice(match[0].length),
  );

  if (!nextTable) {
    return rest;
  }

  return rest.slice(0, match[0].length + nextTable.index);
}

function getColumnType(sql: string, tableName: string, columnName: string): string | null {
  const block = extractCreateTableBlock(sql, tableName);
  const match = new RegExp(`^\\s*${columnName}\\s+([A-Z]+(?:\\([^)]*\\))?)\\b`, 'im').exec(
    block,
  );

  return match?.[1]?.toUpperCase() ?? null;
}

function hasColumn(sql: string, tableName: string, columnName: string): boolean {
  const block = extractCreateTableBlock(sql, tableName);
  const createTableColumn = new RegExp(`^\\s*${columnName}\\s+`, 'im').test(block);
  const additiveColumn = new RegExp(
    `ALTER\\s+TABLE\\s+${tableName}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${columnName}\\b`,
    'i',
  ).test(sql);

  return createTableColumn || additiveColumn;
}

function hasUniqueOnColumn(sql: string, tableName: string, columnName: string): boolean {
  const block = extractCreateTableBlock(sql, tableName);
  const uniqueConstraint = new RegExp(
    `UNIQUE\\s*\\([^)]*\\b${columnName}\\b[^)]*\\)`,
    'i',
  ).test(block);
  const uniqueIndex = new RegExp(
    `CREATE\\s+UNIQUE\\s+INDEX[\\s\\S]+ON\\s+${tableName}\\s*\\([^)]*\\b${columnName}\\b[^)]*\\)`,
    'i',
  ).test(sql);

  return uniqueConstraint || uniqueIndex;
}

function hasNotificationIdempotencyIndex(sql: string): boolean {
  const match = new RegExp(
    [
      'CREATE\\s+UNIQUE\\s+INDEX',
      '(?:\\s+IF\\s+NOT\\s+EXISTS)?',
      '\\s+uq_notifications_idempotency_key\\b',
      '[^;]*?ON\\s+notifications\\s*\\(\\s*idempotency_key\\s*\\)',
      '[^;]*?WHERE\\s+([^;]+?)\\s*(?:;|$)',
    ].join(''),
    'i',
  ).exec(sql);

  return match?.[1]?.replace(/\s+/g, ' ').trim().toUpperCase() === 'IDEMPOTENCY_KEY IS NOT NULL';
}

function getInsertLeadingNumbers(sql: string, tableName: string): number[] {
  const insertMatch = new RegExp(
    `INSERT\\s+INTO\\s+${tableName}\\s*\\([^)]*\\)\\s*VALUES([\\s\\S]*?)ON\\s+CONFLICT`,
    'i',
  ).exec(sql);

  if (!insertMatch) {
    return [];
  }

  const values = insertMatch[1];
  const numbers: number[] = [];
  const rowRegex = /\(\s*(\d+)\s*,/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(values)) !== null) {
    numbers.push(Number(rowMatch[1]));
  }

  return numbers;
}

function hasDuplicateNumbers(numbers: number[]): boolean {
  return new Set(numbers).size !== numbers.length;
}

function addIssue(issues: SchemaPreflightIssue[], issue: SchemaPreflightIssue): void {
  issues.push(issue);
}

export function checkSchemaPreflight(sql: string): SchemaPreflightIssue[] {
  const issues: SchemaPreflightIssue[] = [];

  if (hasTableReference(sql, 'film_vendors') && !hasCreateTable(sql, 'film_vendors')) {
    addIssue(issues, {
      code: 'FILM_VENDORS_TABLE_MISSING',
      severity: 'blocker',
      title: 'film_vendors referenced without table definition',
      details: 'The schema references film_vendors, but no CREATE TABLE film_vendors was found.',
      recommendation:
        'Add CREATE TABLE film_vendors or remove stale film_vendors indexes/references before applying migrations.',
    });
  }

  const ordersBlock = extractCreateTableBlock(sql, 'orders');
  if (/\bADD\s+CONSTRAINT\s+chk_orders_final_amount_consistent\b/i.test(ordersBlock)) {
    addIssue(issues, {
      code: 'ORDERS_ADD_CONSTRAINT_IN_CREATE_TABLE',
      severity: 'blocker',
      title: 'orders contains ALTER-style ADD CONSTRAINT inside CREATE TABLE',
      details:
        'The orders table block contains ADD CONSTRAINT chk_orders_final_amount_consistent, which is ALTER TABLE syntax.',
      recommendation:
        'Move this constraint into a separate ALTER TABLE statement or rewrite it as a normal CREATE TABLE constraint.',
    });
  }

  const productionStatusesBlock = extractCreateTableBlock(sql, 'production_statuses');
  const hasSortOrderUnique = /\bUNIQUE\s*\(\s*sort_order\s*\)/i.test(productionStatusesBlock);
  const productionSortOrders = getInsertLeadingNumbers(sql, 'production_statuses');
  if (hasSortOrderUnique && hasDuplicateNumbers(productionSortOrders)) {
    addIssue(issues, {
      code: 'PRODUCTION_STATUS_SORT_ORDER_SEED_CONFLICT',
      severity: 'blocker',
      title: 'production_statuses seed conflicts with UNIQUE(sort_order)',
      details:
        'production_statuses has UNIQUE(sort_order), but the seed contains duplicate sort_order values.',
      recommendation:
        'Use unique sort_order values, remove the uniqueness constraint, or split display ordering from workflow grouping.',
    });
  }

  const materialIdType = getColumnType(sql, 'materials', 'material_id');
  const mucMaterialIdType = getColumnType(sql, 'material_unit_conversions', 'material_id');
  if (materialIdType && mucMaterialIdType && materialIdType !== mucMaterialIdType) {
    addIssue(issues, {
      code: 'MUC_MATERIAL_ID_TYPE_MISMATCH',
      severity: 'blocker',
      title: 'material_unit_conversions.material_id type differs from materials.material_id',
      details: `materials.material_id is ${materialIdType}, material_unit_conversions.material_id is ${mucMaterialIdType}.`,
      recommendation: 'Align material_unit_conversions.material_id with materials.material_id.',
    });
  }

  const edgeTypeIdType = getColumnType(sql, 'edge_types', 'edge_type_id');
  const orrEdgeTypeIdType = getColumnType(sql, 'order_resource_requirements', 'edge_type_id');
  if (edgeTypeIdType && orrEdgeTypeIdType && edgeTypeIdType !== orrEdgeTypeIdType) {
    addIssue(issues, {
      code: 'ORR_EDGE_TYPE_ID_TYPE_MISMATCH',
      severity: 'blocker',
      title: 'order_resource_requirements.edge_type_id type differs from edge_types.edge_type_id',
      details: `edge_types.edge_type_id is ${edgeTypeIdType}, order_resource_requirements.edge_type_id is ${orrEdgeTypeIdType}.`,
      recommendation: 'Align order_resource_requirements.edge_type_id with edge_types.edge_type_id.',
    });
  }

  const supplierIdType = getColumnType(sql, 'suppliers', 'supplier_id');
  const orrSupplierIdType = getColumnType(sql, 'order_resource_requirements', 'supplier_id');
  if (supplierIdType && orrSupplierIdType && supplierIdType !== orrSupplierIdType) {
    addIssue(issues, {
      code: 'ORR_SUPPLIER_ID_TYPE_MISMATCH',
      severity: 'blocker',
      title: 'order_resource_requirements.supplier_id type differs from suppliers.supplier_id',
      details: `suppliers.supplier_id is ${supplierIdType}, order_resource_requirements.supplier_id is ${orrSupplierIdType}.`,
      recommendation: 'Align order_resource_requirements.supplier_id with suppliers.supplier_id.',
    });
  }

  const orrBlock = extractCreateTableBlock(sql, 'order_resource_requirements');
  if (
    /CONSTRAINT\s+uq_orr_order_resource\s+UNIQUE\s*\(\s*order_id,\s*resource_type,\s*material_id,\s*film_id,\s*edge_type_id\s*\)/i.test(
      orrBlock,
    )
  ) {
    addIssue(issues, {
      code: 'ORR_UNIQUE_NULL_DUPLICATE_RISK',
      severity: 'warning',
      title: 'order_resource_requirements unique constraint does not prevent NULL duplicates',
      details:
        'The unique constraint includes nullable material_id, film_id, and edge_type_id. PostgreSQL allows duplicate rows when compared columns are NULL.',
      recommendation:
        'Use partial unique indexes per resource type or a generated resource key that treats NULLs deterministically.',
    });
  }

  if (!hasCreateTable(sql, 'audit_log')) {
    addIssue(issues, {
      code: 'AUDIT_LOG_TABLE_MISSING',
      severity: 'blocker',
      title: 'audit_log table is missing',
      details: 'The backend PRD requires audit_log for auth, orders, users, export, and VLM events.',
      recommendation: 'Add an additive migration for audit_log before enabling backend critical flows.',
    });
  }

  if (
    hasCreateTable(sql, 'deadline_events') &&
    !hasColumn(sql, 'deadline_events', 'idempotency_key')
  ) {
    addIssue(issues, {
      code: 'DEADLINE_EVENTS_IDEMPOTENCY_KEY_MISSING',
      severity: 'blocker',
      title: 'deadline_events.idempotency_key is missing',
      details:
        'The Deadline Engine backend reads and writes deadline_events.idempotency_key for idempotent event handling.',
      recommendation:
        'Apply the additive deadline migration that adds deadline_events.idempotency_key and uq_deadline_events_idempotency_key before deploying deadline-enabled backend code.',
    });
  }

  if (hasTable(sql, 'notifications') && !hasColumn(sql, 'notifications', 'idempotency_key')) {
    addIssue(issues, {
      code: 'notifications.idempotency_key_missing',
      severity: 'error',
      title: 'notifications.idempotency_key is missing',
      details:
        'Deadline Engine notification delivery writes notifications.idempotency_key to prevent duplicate user-visible notifications.',
      recommendation:
        'Apply backend/db/migrations/006_deadline_notifications_idempotency.sql before enabling BACKEND_DEADLINE_NOTIFICATIONS_ENABLED.',
      message:
        'Deadline Engine notification delivery writes notifications.idempotency_key to prevent duplicate user-visible notifications.',
      remediation:
        'Apply backend/db/migrations/006_deadline_notifications_idempotency.sql before enabling BACKEND_DEADLINE_NOTIFICATIONS_ENABLED.',
    });
  }

  if (
    hasTable(sql, 'notifications') &&
    hasColumn(sql, 'notifications', 'idempotency_key') &&
    !hasNotificationIdempotencyIndex(sql)
  ) {
    addIssue(issues, {
      code: 'notifications.idempotency_index_missing',
      severity: 'error',
      title: 'uq_notifications_idempotency_key is missing',
      details:
        'Deadline Engine notification delivery requires a unique notification idempotency index.',
      recommendation:
        'Apply backend/db/migrations/006_deadline_notifications_idempotency.sql before enabling BACKEND_DEADLINE_NOTIFICATIONS_ENABLED.',
      message:
        'Deadline Engine notification delivery requires a unique notification idempotency index.',
      remediation:
        'Apply backend/db/migrations/006_deadline_notifications_idempotency.sql before enabling BACKEND_DEADLINE_NOTIFICATIONS_ENABLED.',
    });
  }

  if (!hasCreateTable(sql, 'file_uploads')) {
    addIssue(issues, {
      code: 'FILE_UPLOADS_TABLE_MISSING',
      severity: 'warning',
      title: 'file_uploads table is missing',
      details: 'The VLM upload flow needs a durable upload record if upload/analyze are split.',
      recommendation: 'Add file_uploads before migrating VLM upload/analyze to the backend.',
    });
  }

  if (!hasCreateTable(sql, 'integration_jobs')) {
    addIssue(issues, {
      code: 'INTEGRATION_JOBS_TABLE_MISSING',
      severity: 'warning',
      title: 'integration_jobs table is missing',
      details: 'The PRD recommends integration_jobs for future async export/VLM operations.',
      recommendation: 'Add integration_jobs as an additive migration when export/VLM need async tracking.',
    });
  }

  for (const column of ['session_id', 'replaced_by_token_id', 'reuse_detected_at', 'revoked_reason']) {
    if (!new RegExp(`\\b${column}\\b`, 'i').test(extractCreateTableBlock(sql, 'refresh_tokens'))) {
      addIssue(issues, {
        code: `REFRESH_TOKENS_${column.toUpperCase()}_MISSING`,
        severity: 'warning',
        title: `refresh_tokens.${column} is missing`,
        details: `The refresh_tokens table does not include ${column}, which is recommended for rotation hardening.`,
        recommendation: `Add refresh_tokens.${column} before implementing full refresh token family/reuse detection.`,
      });
    }
  }

  if (!/\bpayment_status_code\b/i.test(extractCreateTableBlock(sql, 'payment_statuses'))) {
    addIssue(issues, {
      code: 'PAYMENT_STATUS_CODE_MISSING',
      severity: 'warning',
      title: 'payment_statuses.payment_status_code is missing',
      details: 'Payment status rules currently rely on magic ids 1/2/3.',
      recommendation:
        'Add payment_status_code and use stable codes for unpaid/partial/paid/custom statuses.',
    });
  }

  if (!hasUniqueOnColumn(sql, 'roles', 'role_code')) {
    addIssue(issues, {
      code: 'ROLES_CODE_UNIQUENESS_MISSING',
      severity: 'warning',
      title: 'roles.role_code is not unique',
      details: 'The backend permissions model depends on canonical role_code values.',
      recommendation: 'Add a unique constraint or unique index on roles.role_code.',
    });
  }

  return issues;
}

export function getSchemaPreflightIssueCodes(sql: string): string[] {
  return checkSchemaPreflight(sql).map((issue) => issue.code);
}
