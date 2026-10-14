-- 254: trim_text_fields() — trim text columns without breaking on quotes, backslashes or newlines.
--
-- The legacy trigger function (initial schema, BEFORE INSERT/UPDATE on clients, suppliers, vendors)
-- rebuilt every trimmed string as ('"' || btrim(value) || '"')::jsonb. A value containing `"`, `\`,
-- a newline or a tab is not a valid JSON string literal, so the cast failed with
-- "invalid input syntax for type json" and the whole INSERT/UPDATE was rejected: a client named
-- ТОО "Ромашка" or with a multi-line note could not be saved from any path (UI, Bitrix24, 1C).
--
-- to_jsonb(btrim(text)) stores exactly the trimmed text. For text accepted by the old expression and
-- containing no backslashes the result is the same as before. Intentional change: the old cast also
-- DECODED JSON escape sequences typed as text — a literal `\n`, `\"`, `\\` or `\u0041` was silently
-- stored as a newline, `"`, `\` or `A`;
-- now such text is kept literally. Same signature, same triggers, generated columns are still
-- skipped, non-string values are passed through.
--
-- Only the function body is replaced: no table lock, no data change, compatible with the running
-- backend before and after. A backend rollback keeps this migration.
--
-- FORWARD-ONLY: do not restore the previous body once rows with `"`, `\`, newlines or tabs exist in
-- clients/suppliers/vendors. The old trigger rebuilds EVERY string column on each UPDATE, so even an
-- unrelated update of such a row (e.g. is_active) would fail, and literal escape sequences saved
-- under 254 would be silently decoded. Fix problems forward with a new migration.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regprocedure('public.trim_text_fields()') IS NULL THEN
    RAISE EXCEPTION 'migration 254: public.trim_text_fields() not found';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.trim_text_fields()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  j jsonb;
BEGIN
  j := (
    SELECT jsonb_object_agg(e.k,
             CASE
               WHEN jsonb_typeof(e.v) = 'string'
                 THEN to_jsonb(btrim(e.v #>> '{}'::text[]))
               ELSE e.v
             END)
    FROM jsonb_each(to_jsonb(NEW)) AS e(k, v)
    LEFT JOIN (
      -- исключаем сгенерированные (GENERATED) столбцы
      SELECT attname
      FROM pg_attribute
      WHERE attrelid = TG_RELID
        AND attgenerated <> ''
    ) g ON g.attname = e.k
    WHERE g.attname IS NULL
  );

  NEW := jsonb_populate_record(NEW, COALESCE(j, '{}'::jsonb));
  RETURN NEW;
END;
$function$;

COMMIT;

-- Previous body, for reference only (see FORWARD-ONLY above; it rejects `"`, `\`, newlines and
-- tabs and decodes literal escape sequences):
--   THEN ('"' || btrim(e.v#>>'{}'::text[]) || '"')::jsonb
