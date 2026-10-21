import { livePersonalSnapshotJoin, normalizedName, normalizedPhone } from '../onec-agent/domain/onec-matching-sql';
import type { MaskKind } from './duplicate-keys';
import type { DuplicateEntityKind } from './integration-duplicates';

/**
 * A rule finds records that share one key. Its SQL returns one row per (record, key):
 *   system, entity_kind, record_key, erp_entity_id, key, personal,
 *   dep_source, dep_entity, dep_snapshot  — the set of 1C the key was read from (only sets with revocation), else NULL;
 *   created_at, author, via               — when, by whom and how the record came (when the system knows it).
 * Records sharing a key form a group; a group of two or more records is a case. Values of 1C are read from the
 * current mirror only (never from the ERP copies of K4a/K4b): phones and contacts only from a live snapshot.
 */
export interface DuplicateRule {
  code: string;
  /** The kind the case is about (the journal filter). */
  entityKind: DuplicateEntityKind;
  /** The kinds whose change can change the result: a check of such a record runs this rule. */
  kinds: readonly DuplicateEntityKind[];
  strength: 'exact' | 'likely';
  maskKind: MaskKind;
  label: string;
  /** Fixed in the source system, not in ERP: the case offers «Исправить в 1С» instead of a merge. */
  external: 'onec' | null;
  /** Reads the 1C mirror: without the 1C tables the rule does not run. */
  readsOnec: boolean;
  /** The matched value itself comes from 1C (a name, an IIN of a counterparty): shown only with the right on 1C data. */
  valueFromOnec?: boolean;
  /** Needs pg_trgm. */
  needsTrigram?: boolean;
  sql(env: RuleEnv): string;
}

export interface RuleEnv {
  /** The 1C mirror tables exist. */
  onec: boolean;
}

/** Lowercase, everything but letters and digits to single spaces (names of materials, films, vendors). */
const plainName = (expr: string) => `btrim(regexp_replace(lower(coalesce(${expr}, '')), '[^0-9a-zа-яёәғқңөұүһі]+', ' ', 'g'))`;
const digits = (expr: string) => `regexp_replace(coalesce(${expr}, ''), '\\D', '', 'g')`;
const NO_DEP = 'NULL::bigint AS dep_source, NULL::text AS dep_entity, NULL::timestamptz AS dep_snapshot';

/** Counterparties of the 1C copy by source: not a folder, not marked for deletion, still in the source. */
export const onecCounterpartiesBySource = `
  SELECT m.source_id, lower(m.source_key) AS ref, m.data
    FROM onec_etl_mirror_rows m
   WHERE m.entity_code = 'counterparties' AND NOT m.deleted AND m.missing_in_source_at IS NULL
     AND COALESCE(m.data->>'IsFolder', 'false') <> 'true' AND COALESCE(m.data->>'DeletionMark', 'false') <> 'true'`;

/**
 * Phones of 1C counterparties from a live snapshot of either set — `counterparty_phones` (the presentation) and the
 * phone lines of `counterparty_contacts` (the number, else the presentation: the rule K4a copies by) — with the set and
 * the snapshot each was read from.
 */
const onecPhones = `
  SELECT m.source_id, lower(m.data->>'Ref_Key') AS ref, ${normalizedPhone("m.data->>'Представление'")} AS p, m.entity_code, st.snapshot_version
    FROM onec_etl_mirror_rows m
    ${livePersonalSnapshotJoin('m')}
   WHERE m.entity_code = 'counterparty_phones' AND NOT m.deleted AND m.missing_in_source_at IS NULL
  UNION ALL
  SELECT m.source_id, lower(m.data->>'Ref_Key'),
         ${normalizedPhone("COALESCE(NULLIF(btrim(m.data->>'НомерТелефона'), ''), m.data->>'Представление')")}, m.entity_code, st.snapshot_version
    FROM onec_etl_mirror_rows m
    ${livePersonalSnapshotJoin('m')}
   WHERE m.entity_code = 'counterparty_contacts' AND NOT m.deleted AND m.missing_in_source_at IS NULL AND m.data->>'Тип' = 'Телефон'`;

/**
 * The 1C source of the link of an ERP record (`ref_key_1c` has no source) — the choice of K4a: among the sources that
 * hold the contacts set (by id), the first that has the counterparty; else the only one. `refExpr` — the lower-case
 * key. Yields `ls.source_id`.
 */
export const linkSourceSql = (refExpr: string) => `COALESCE(
    (SELECT min(es.source_id) FROM onec_etl_entity_state es WHERE es.entity_code = 'counterparty_contacts'
        AND EXISTS (SELECT 1 FROM onec_etl_mirror_rows ms WHERE ms.source_id = es.source_id AND ms.entity_code = 'counterparties'
                                                             AND lower(ms.source_key) = ${refExpr})),
    (SELECT min(es.source_id) FROM onec_etl_entity_state es WHERE es.entity_code = 'counterparty_contacts' HAVING count(*) = 1))`;
const linkSource = (refExpr: string) => `JOIN LATERAL (SELECT ${linkSourceSql(refExpr)} AS source_id) ls ON ls.source_id IS NOT NULL`;

const onecPersonal = (data: string) => `COALESCE(${data}->>'ВидКонтрагента', '') IN ('ФизическоеЛицо', 'ИндивидуальныйПредприниматель')`;

const clientVia = `CASE WHEN EXISTS (SELECT 1 FROM crm_sync_mapping mp WHERE mp.entity_type = 'client' AND mp.erp_id = c.client_id::text
                                       AND mp.source_system = 'bitrix24') THEN 'bitrix_inbound' ELSE 'erp_manual' END`;
const clientMeta = `'erp'::text AS system, 'client'::text AS entity_kind, c.client_id::text AS record_key, c.client_id::bigint AS erp_entity_id`;
const clientTail = `c.created_at::timestamptz AS created_at, c.created_by::bigint AS author, ${clientVia} AS via`;
const erpMeta = (kind: string, alias: string, id: string) =>
  `'erp'::text AS system, '${kind}'::text AS entity_kind, ${alias}.${id}::text AS record_key, ${alias}.${id}::bigint AS erp_entity_id`;
const erpTail = (alias: string) => `${alias}.created_at::timestamptz AS created_at, ${alias}.created_by::bigint AS author, 'erp_manual'::text AS via`;
const onecMeta = (kind: string) =>
  `'onec'::text AS system, '${kind}'::text AS entity_kind, cp.source_id || ':' || cp.ref AS record_key, NULL::bigint AS erp_entity_id`;
const onecTail = `NULL::timestamptz AS created_at, NULL::bigint AS author, 'onec_publication'::text AS via`;

const refKeyRule = (kind: DuplicateEntityKind, table: string, id: string, extra = 'TRUE'): DuplicateRule => ({
  code: `${kind}.ref_key_1c`, entityKind: kind, kinds: [kind], strength: 'exact', maskKind: 'ref',
  label: 'Один ключ 1С у нескольких записей', external: null, readsOnec: false,
  sql: () => `SELECT ${erpMeta(kind, 't', id)}, lower(t.ref_key_1c::text) AS key, false AS personal, ${NO_DEP}, ${erpTail('t')}
                FROM ${table} t WHERE t.ref_key_1c IS NOT NULL AND t.is_active AND ${extra}`,
});

export const DUPLICATE_RULES: readonly DuplicateRule[] = [
  {
    code: 'client.phone', entityKind: 'client', kinds: ['client'], strength: 'exact', maskKind: 'phone',
    label: 'Одинаковый телефон', external: null, readsOnec: true,
    sql: ({ onec }) => `
      WITH x AS (
        SELECT p.client_id, ${normalizedPhone('p.phone_number')} AS k, ${NO_DEP} FROM client_phones p
        ${onec ? `UNION ALL
        SELECT c.client_id, ph.p, ph.source_id, ph.entity_code, ph.snapshot_version
          FROM clients c ${linkSource('lower(c.ref_key_1c::text)')}
          JOIN (${onecPhones}) ph ON ph.source_id = ls.source_id AND ph.ref = lower(c.ref_key_1c::text) WHERE c.ref_key_1c IS NOT NULL` : ''})
      SELECT ${clientMeta}, x.k AS key, c.person_type = 'individual' AS personal, x.dep_source, x.dep_entity, x.dep_snapshot, ${clientTail}
        FROM x JOIN clients c ON c.client_id = x.client_id WHERE c.is_active AND length(x.k) = 10`,
  },
  {
    code: 'client.name', entityKind: 'client', kinds: ['client'], strength: 'exact', maskKind: 'name',
    label: 'Одинаковое название (без формы собственности)', external: null, readsOnec: false,
    sql: () => `
      SELECT ${clientMeta}, n.k AS key, c.person_type = 'individual' AS personal, ${NO_DEP}, ${clientTail}
        FROM clients c CROSS JOIN LATERAL (SELECT ${normalizedName('c.client_name::text')} AS k) n
       WHERE c.is_active AND n.k <> ''`,
  },
  {
    code: 'client.name_similar', entityKind: 'client', kinds: ['client'], strength: 'likely', maskKind: 'pair',
    label: 'Похожие названия', external: null, readsOnec: false, needsTrigram: true,
    // A pair is its own case (similarity is not transitive): the key names both clients.
    sql: () => `
      WITH n AS (SELECT c.client_id, ${normalizedName('c.client_name::text')} AS k FROM clients c WHERE c.is_active),
      pairs AS (SELECT a.client_id AS a, b.client_id AS b FROM n a JOIN n b ON a.client_id < b.client_id
                 WHERE a.k <> '' AND b.k <> '' AND a.k <> b.k AND similarity(a.k, b.k) >= 0.85)
      SELECT ${clientMeta}, pairs.a || ':' || pairs.b AS key, c.person_type = 'individual' AS personal, ${NO_DEP}, ${clientTail}
        FROM pairs JOIN clients c ON c.client_id IN (pairs.a, pairs.b)`,
  },
  {
    code: 'client.counterparty_bin', entityKind: 'client', kinds: ['client'], strength: 'exact', maskKind: 'bin',
    label: 'Одинаковый ИИН/БИН связанных контрагентов 1С', external: null, readsOnec: true, valueFromOnec: true,
    sql: ({ onec }) => onec ? `
      SELECT ${clientMeta}, ${digits("cp.data->>'ИдентификационныйНомер'")} AS key, c.person_type = 'individual' AS personal, ${NO_DEP}, ${clientTail}
        FROM clients c ${linkSource('lower(c.ref_key_1c::text)')}
        JOIN (${onecCounterpartiesBySource}) cp ON cp.source_id = ls.source_id AND cp.ref = lower(c.ref_key_1c::text)
       WHERE c.is_active AND length(${digits("cp.data->>'ИдентификационныйНомер'")}) = 12` : EMPTY,
  },
  {
    code: 'client.counterparty_shared', entityKind: 'client', kinds: ['client', 'onec_counterparty'], strength: 'likely', maskKind: 'ref',
    label: 'Контрагент 1С подходит нескольким клиентам', external: null, readsOnec: true, valueFromOnec: true,
    // Unlinked active clients whose exact candidate (equal name or phone) is a free counterparty, when it is the candidate
    // of two or more of them; the counterparty takes part as a member. The key is the counterparty (source and key, not its
    // name: a rename in 1C keeps the case and its decision; the name is shown through the 1C member).
    sql: ({ onec }) => onec ? `
      WITH cp AS (${onecCounterpartiesBySource}),
      free AS (SELECT cp.* FROM cp WHERE NOT EXISTS (SELECT 1 FROM clients h WHERE lower(h.ref_key_1c::text) = cp.ref)),
      cl AS (SELECT c.client_id, ${normalizedName('c.client_name::text')} AS n FROM clients c WHERE c.is_active AND c.ref_key_1c IS NULL),
      hit AS (
        SELECT cl.client_id, free.source_id, free.ref, ${NO_DEP} FROM cl JOIN free ON ${normalizedName("free.data->>'Description'")} = cl.n WHERE cl.n <> ''
        UNION ALL
        SELECT p.client_id, free.source_id, free.ref, ph.source_id, ph.entity_code, ph.snapshot_version
          FROM client_phones p JOIN cl ON cl.client_id = p.client_id
          JOIN (${onecPhones}) ph ON ph.p = ${normalizedPhone('p.phone_number')} AND length(ph.p) = 10
          JOIN free ON free.source_id = ph.source_id AND free.ref = ph.ref),
      shared AS (SELECT source_id, ref FROM hit GROUP BY source_id, ref HAVING count(DISTINCT client_id) >= 2)
      SELECT ${clientMeta}, h.source_id || ':' || h.ref AS key, c.person_type = 'individual' AS personal,
             h.dep_source, h.dep_entity, h.dep_snapshot, ${clientTail}
        FROM hit h JOIN shared s USING (source_id, ref) JOIN free f ON f.source_id = h.source_id AND f.ref = h.ref
        JOIN clients c ON c.client_id = h.client_id
      UNION ALL
      SELECT ${onecMeta('onec_counterparty')},  cp.source_id || ':' || cp.ref, ${onecPersonal('cp.data')},
             ${NO_DEP}, ${onecTail}
        FROM free cp JOIN shared s ON s.source_id = cp.source_id AND s.ref = cp.ref` : EMPTY,
  },
  {
    code: 'supplier.name', entityKind: 'supplier', kinds: ['supplier'], strength: 'exact', maskKind: 'name',
    label: 'Одинаковое название (без формы собственности)', external: null, readsOnec: false,
    sql: () => `
      SELECT ${erpMeta('supplier', 's', 'supplier_id')}, n.k AS key, false AS personal, ${NO_DEP}, ${erpTail('s')}
        FROM suppliers s CROSS JOIN LATERAL (SELECT ${normalizedName('s.supplier_name')} AS k) n WHERE s.is_active AND n.k <> ''`,
  },
  {
    code: 'supplier.phone', entityKind: 'supplier', kinds: ['supplier'], strength: 'exact', maskKind: 'phone',
    label: 'Одинаковый телефон', external: null, readsOnec: true,
    sql: ({ onec }) => `
      WITH x AS (
        SELECT sc.supplier_id, ${normalizedPhone('sc.value_normalized')} AS k, ${NO_DEP}
          FROM supplier_contacts sc WHERE sc.kind = 'phone' AND sc.origin = 'erp'
        UNION ALL
        SELECT s.supplier_id, ${normalizedPhone('s.phone')}, ${NO_DEP} FROM suppliers s WHERE s.phone IS NOT NULL
        ${onec ? `UNION ALL
        SELECT s.supplier_id, ph.p, ph.source_id, ph.entity_code, ph.snapshot_version
          FROM suppliers s ${linkSource('lower(s.ref_key_1c::text)')}
          JOIN (${onecPhones}) ph ON ph.source_id = ls.source_id AND ph.ref = lower(s.ref_key_1c::text) WHERE s.ref_key_1c IS NOT NULL` : ''})
      SELECT ${erpMeta('supplier', 's', 'supplier_id')}, x.k AS key, false AS personal, x.dep_source, x.dep_entity, x.dep_snapshot, ${erpTail('s')}
        FROM x JOIN suppliers s ON s.supplier_id = x.supplier_id WHERE s.is_active AND length(x.k) = 10`,
  },
  {
    code: 'supplier.counterparty_bin', entityKind: 'supplier', kinds: ['supplier'], strength: 'exact', maskKind: 'bin',
    label: 'Одинаковый ИИН/БИН связанных контрагентов 1С', external: null, readsOnec: true, valueFromOnec: true,
    sql: ({ onec }) => onec ? `
      SELECT ${erpMeta('supplier', 's', 'supplier_id')}, ${digits("cp.data->>'ИдентификационныйНомер'")} AS key, false AS personal, ${NO_DEP}, ${erpTail('s')}
        FROM suppliers s ${linkSource('lower(s.ref_key_1c::text)')}
        JOIN (${onecCounterpartiesBySource}) cp ON cp.source_id = ls.source_id AND cp.ref = lower(s.ref_key_1c::text)
       WHERE s.is_active AND length(${digits("cp.data->>'ИдентификационныйНомер'")}) = 12` : EMPTY,
  },
  {
    code: 'onec_counterparty.bin', entityKind: 'onec_counterparty', kinds: ['onec_counterparty'], strength: 'exact', maskKind: 'bin',
    label: 'Одинаковый ИИН/БИН в 1С', external: 'onec', readsOnec: true, valueFromOnec: true,
    sql: ({ onec }) => onec ? `
      SELECT ${onecMeta('onec_counterparty')}, ${digits("cp.data->>'ИдентификационныйНомер'")} AS key, ${onecPersonal('cp.data')} AS personal, ${NO_DEP}, ${onecTail}
        FROM (${onecCounterpartiesBySource}) cp WHERE length(${digits("cp.data->>'ИдентификационныйНомер'")}) = 12` : EMPTY,
  },
  {
    code: 'onec_counterparty.name', entityKind: 'onec_counterparty', kinds: ['onec_counterparty'], strength: 'exact', maskKind: 'name',
    label: 'Одинаковое название в 1С', external: 'onec', readsOnec: true, valueFromOnec: true,
    sql: ({ onec }) => onec ? `
      SELECT ${onecMeta('onec_counterparty')}, n.k AS key, ${onecPersonal('cp.data')} AS personal, ${NO_DEP}, ${onecTail}
        FROM (${onecCounterpartiesBySource}) cp CROSS JOIN LATERAL (SELECT ${normalizedName("cp.data->>'Description'")} AS k) n WHERE n.k <> ''` : EMPTY,
  },
  {
    code: 'onec_item.name', entityKind: 'onec_item', kinds: ['onec_item'], strength: 'likely', maskKind: 'composite',
    label: 'Одинаковое название и единица в 1С', external: 'onec', readsOnec: true, valueFromOnec: true,
    sql: ({ onec }) => onec ? `
      SELECT 'onec'::text AS system, 'onec_item'::text AS entity_kind, i.source_id || ':' || lower(i.source_key) AS record_key, NULL::bigint AS erp_entity_id,
             n.k || ':' || COALESCE(lower(i.data->>'ЕдиницаИзмерения_Key'), '') AS key, false AS personal, ${NO_DEP}, ${onecTail}
        FROM onec_etl_mirror_rows i CROSS JOIN LATERAL (SELECT ${plainName("i.data->>'Description'")} AS k) n
       WHERE i.entity_code = 'items' AND NOT i.deleted AND i.missing_in_source_at IS NULL
         AND COALESCE(i.data->>'IsFolder', 'false') <> 'true' AND COALESCE(i.data->>'DeletionMark', 'false') <> 'true' AND n.k <> ''` : EMPTY,
  },
  {
    code: 'vendor.name', entityKind: 'vendor', kinds: ['vendor'], strength: 'exact', maskKind: 'composite',
    label: 'Одинаковое название при одном виде материала', external: null, readsOnec: false,
    sql: () => `
      SELECT ${erpMeta('vendor', 'v', 'vendor_id')}, n.k || ':' || COALESCE(v.material_type_id::text, '') AS key, false AS personal, ${NO_DEP}, ${erpTail('v')}
        FROM vendors v CROSS JOIN LATERAL (SELECT ${normalizedName('v.vendor_name')} AS k) n WHERE v.is_active AND n.k <> ''`,
  },
  {
    code: 'film.name_vendor', entityKind: 'film', kinds: ['film'], strength: 'exact', maskKind: 'composite',
    label: 'Одинаковое название у одного производителя', external: null, readsOnec: false,
    sql: () => `
      SELECT ${erpMeta('film', 'f', 'film_id')}, n.k || ':' || COALESCE(f.vendor_id::text, '') AS key, false AS personal, ${NO_DEP}, ${erpTail('f')}
        FROM films f CROSS JOIN LATERAL (SELECT ${plainName('f.film_name')} AS k) n
       WHERE f.is_active AND f.canonical_film_id IS NULL AND n.k <> ''`,
  },
  {
    code: 'sheet_material.article', entityKind: 'sheet_material', kinds: ['sheet_material'], strength: 'exact', maskKind: 'composite',
    label: 'Одинаковый артикул у одного производителя', external: null, readsOnec: false,
    sql: () => `
      SELECT ${erpMeta('sheet_material', 'm', 'sheet_material_type_id')}, lower(btrim(m.supplier_article)) || ':' || COALESCE(m.vendor_id::text, '') AS key,
             false AS personal, ${NO_DEP}, ${erpTail('m')}
        FROM sheet_material_types m WHERE m.is_active AND btrim(COALESCE(m.supplier_article, '')) <> ''`,
  },
  {
    code: 'sheet_material.name_size', entityKind: 'sheet_material', kinds: ['sheet_material'], strength: 'exact', maskKind: 'composite',
    label: 'Одинаковые название, толщина и размер', external: null, readsOnec: false,
    sql: () => `
      SELECT ${erpMeta('sheet_material', 'm', 'sheet_material_type_id')},
             n.k || ':' || COALESCE(m.thickness_mm::text, '') || ':' || COALESCE(m.width_mm::text, '') || ':' || COALESCE(m.height_mm::text, '') AS key,
             false AS personal, ${NO_DEP}, ${erpTail('m')}
        FROM sheet_material_types m CROSS JOIN LATERAL (SELECT ${plainName('m.name')} AS k) n WHERE m.is_active AND n.k <> ''`,
  },
  {
    code: 'material.name', entityKind: 'material', kinds: ['material'], strength: 'exact', maskKind: 'name',
    label: 'Одинаковое название', external: null, readsOnec: false,
    sql: () => `
      SELECT ${erpMeta('material', 'm', 'material_id')}, n.k AS key, false AS personal, ${NO_DEP}, ${erpTail('m')}
        FROM materials m CROSS JOIN LATERAL (SELECT ${plainName('m.material_name')} AS k) n
       WHERE m.is_active AND NOT COALESCE(m.is_sheet_shadow, false) AND n.k <> ''`,
  },
  refKeyRule('client', 'clients', 'client_id'),
  refKeyRule('supplier', 'suppliers', 'supplier_id'),
  refKeyRule('vendor', 'vendors', 'vendor_id'),
  refKeyRule('film', 'films', 'film_id', 't.canonical_film_id IS NULL'),
  refKeyRule('sheet_material', 'sheet_material_types', 'sheet_material_type_id'),
  refKeyRule('material', 'materials', 'material_id', 'NOT COALESCE(t.is_sheet_shadow, false)'),
];

/** A rule with nothing to read yields nothing (the same columns, no rows). */
const EMPTY = `SELECT NULL::text AS system, NULL::text AS entity_kind, NULL::text AS record_key, NULL::bigint AS erp_entity_id, NULL::text AS key,
  false AS personal, ${NO_DEP}, NULL::timestamptz AS created_at, NULL::bigint AS author, NULL::text AS via WHERE false`;

export const RULES_BY_CODE = new Map(DUPLICATE_RULES.map((rule) => [rule.code, rule]));

/** Rules reading 1C: a publication of 1C sets reruns them all. */
export const ONEC_RULES = DUPLICATE_RULES.filter((rule) => rule.readsOnec);
