import { PERSONAL_DATA_TTL_MS } from './onec-etl';

/** SQL expressions shared by everything that compares 1C counterparties with ERP clients and suppliers. */

/**
 * Lowercase, drop quotes and legal-form words, collapse everything but letters/digits to single spaces.
 * Kazakh letters (ә ғ қ ң ө ұ ү һ і) are letters: «Қанат» and «Ғанат» stay different.
 */
export const normalizedName = (expr: string) =>
  `btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(${expr}, '')), '[«»"''“”„\`]', '', 'g'),
     '(^|\\s)(тоо|ип|ао|оао|зао|ооо|пк|кх|too|llp|ip)(?=\\s|$)', ' ', 'g'), '[^0-9a-zа-яёәғқңөұүһі]+', ' ', 'g'))`;
/**
 * KZ numbers: all digits, the first 11 (an extension typed after the number is dropped), then the last
 * 10 (+7 / 8 prefix does not matter). "+7 (701) 555-44-33", "87015554433", "87015554433-123" → 7015554433.
 */
export const normalizedPhone = (expr: string) => `right(left(regexp_replace(coalesce(${expr}, ''), '\\D', '', 'g'), 11), 10)`;
/**
 * JOIN that lets rows of a personal-data set (`counterparty_phones`, `counterparty_contacts`) be read: only from a
 * snapshot that is neither revoked nor older than the retention period, by the database clock — the rule of
 * `OnecCatalogReader.counterpartyContacts` and of the purge. Revoked or expired rows may still lie in the copy
 * until the purge; nobody may read them, not even to compare. `rows` — the alias of `onec_etl_mirror_rows`.
 */
export const livePersonalSnapshotJoin = (rows: string) =>
  `JOIN onec_etl_entity_state st ON st.source_id = ${rows}.source_id AND st.entity_code = ${rows}.entity_code
     AND st.revoked_at IS NULL AND st.snapshot_version IS NOT NULL
     AND st.snapshot_version >= now() - (${PERSONAL_DATA_TTL_MS}::bigint * interval '1 millisecond')`;
