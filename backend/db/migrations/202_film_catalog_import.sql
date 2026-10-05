-- Film catalog identity, import staging, merge integrity, and rename history.
-- Schema only: existing films and other business data are not backfilled.

ALTER TABLE public.films
  ADD COLUMN IF NOT EXISTS canonical_film_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS nomenclature_type VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS nomenclature_category VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS catalog_key TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_films_canonical_film' AND conrelid = 'public.films'::regclass) THEN
    ALTER TABLE public.films ADD CONSTRAINT fk_films_canonical_film
      FOREIGN KEY (canonical_film_id) REFERENCES public.films(film_id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_films_canonical_not_self' AND conrelid = 'public.films'::regclass) THEN
    ALTER TABLE public.films ADD CONSTRAINT chk_films_canonical_not_self
      CHECK (canonical_film_id IS NULL OR canonical_film_id <> film_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_films_merged_inactive' AND conrelid = 'public.films'::regclass) THEN
    ALTER TABLE public.films ADD CONSTRAINT chk_films_merged_inactive
      CHECK (canonical_film_id IS NULL OR is_active = false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_films_merged_no_keys' AND conrelid = 'public.films'::regclass) THEN
    ALTER TABLE public.films ADD CONSTRAINT chk_films_merged_no_keys
      CHECK (canonical_film_id IS NULL OR (catalog_key IS NULL AND ref_key_1c IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_films_catalog_key_format' AND conrelid = 'public.films'::regclass) THEN
    ALTER TABLE public.films ADD CONSTRAINT chk_films_catalog_key_format
      CHECK (catalog_key IS NULL OR (catalog_key = btrim(catalog_key) AND length(catalog_key) > 0));
  END IF;
END $$;

ALTER TABLE public.films DROP CONSTRAINT IF EXISTS uq_films_name_vendor;

CREATE UNIQUE INDEX IF NOT EXISTS uq_films_name_vendor_canonical
  ON public.films (film_name, vendor_id) WHERE canonical_film_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_films_catalog_key
  ON public.films (catalog_key) WHERE catalog_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_films_canonical
  ON public.films (canonical_film_id) WHERE canonical_film_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.films_canonical_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_canonical BIGINT;
BEGIN
  IF NEW.canonical_film_id IS NOT NULL THEN
    SELECT canonical_film_id INTO target_canonical
      FROM public.films WHERE film_id = NEW.canonical_film_id;
    IF NOT FOUND OR target_canonical IS NOT NULL THEN
      RAISE EXCEPTION 'film % must point to an existing canonical film, not a duplicate', NEW.film_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.canonical_film_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.films WHERE canonical_film_id = NEW.film_id
  ) THEN
    RAISE EXCEPTION 'film % cannot become a duplicate while other films reference it', NEW.film_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_films_canonical_integrity ON public.films;
CREATE CONSTRAINT TRIGGER trg_films_canonical_integrity
  AFTER INSERT OR UPDATE OF canonical_film_id, is_active ON public.films
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.films_canonical_integrity();

CREATE OR REPLACE FUNCTION public.films_guard_backend_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND (NEW.canonical_film_id IS NOT NULL OR NEW.catalog_key IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (
       NEW.canonical_film_id IS DISTINCT FROM OLD.canonical_film_id
       OR NEW.catalog_key IS DISTINCT FROM OLD.catalog_key
     )) THEN
    IF COALESCE(current_setting('erp.film_catalog', true), '') <> 'on' THEN
      RAISE EXCEPTION 'films.canonical_film_id/catalog_key are backend-owned'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_films_guard_backend_columns ON public.films;
CREATE TRIGGER trg_films_guard_backend_columns
  BEFORE INSERT OR UPDATE ON public.films
  FOR EACH ROW EXECUTE FUNCTION public.films_guard_backend_columns();

CREATE TABLE IF NOT EXISTS public.catalog_import_batches (
  batch_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind TEXT NOT NULL,
  file_name TEXT NULL,
  file_sha256 TEXT NULL,
  sheet_name TEXT NULL,
  onec_source_id BIGINT NULL REFERENCES public.onec_sources(source_id),
  onec_category_key UUID NULL,
  options JSONB NOT NULL DEFAULT '{"createMissing": true}'::jsonb,
  counters JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  reference_kind TEXT NOT NULL DEFAULT 'films',
  version INT NOT NULL DEFAULT 1,
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  applied_by BIGINT NULL REFERENCES public.users(user_id),
  reverted_by BIGINT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ NULL,
  reverted_at TIMESTAMPTZ NULL,
  request_id TEXT NOT NULL,
  correlation_id TEXT NULL,
  CONSTRAINT chk_catalog_import_batches_source_kind CHECK (source_kind IN ('file', 'onec_mirror')),
  CONSTRAINT chk_catalog_import_batches_source CHECK (
    (source_kind = 'file' AND file_name IS NOT NULL AND file_sha256 IS NOT NULL AND sheet_name IS NOT NULL)
    OR (source_kind = 'onec_mirror' AND onec_source_id IS NOT NULL AND onec_category_key IS NOT NULL)
  ),
  CONSTRAINT chk_catalog_import_batches_status CHECK (status IN ('draft', 'applied', 'cancelled', 'reverted')),
  CONSTRAINT chk_catalog_import_batches_reference CHECK (reference_kind = 'films'),
  CONSTRAINT chk_catalog_import_batches_version CHECK (version >= 1),
  CONSTRAINT chk_catalog_import_batches_applied CHECK (status <> 'applied' OR (applied_at IS NOT NULL AND applied_by IS NOT NULL)),
  CONSTRAINT chk_catalog_import_batches_reverted CHECK (status <> 'reverted' OR (reverted_at IS NOT NULL AND reverted_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.catalog_import_rows (
  row_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES public.catalog_import_batches(batch_id) ON DELETE CASCADE,
  row_no INT NOT NULL,
  name_original TEXT NOT NULL,
  name_full TEXT NOT NULL,
  supplier TEXT NOT NULL,
  nomenclature_type TEXT NULL,
  unit TEXT NULL,
  nomenclature_category TEXT NULL,
  target_name TEXT NOT NULL,
  catalog_key TEXT NOT NULL,
  vendor_id SMALLINT NULL REFERENCES public.vendors(vendor_id),
  ref_key_1c UUID NULL,
  row_status TEXT NOT NULL,
  issue TEXT NULL,
  canonical_film_id BIGINT NULL REFERENCES public.films(film_id),
  canonical_film_texture BOOLEAN NULL,
  canonical_film_type_id SMALLINT NULL REFERENCES public.film_types(film_type_id),
  onec_source_key TEXT NULL,
  onec_row_hash TEXT NULL,
  CONSTRAINT uq_catalog_import_rows_batch_row UNIQUE (batch_id, row_no),
  CONSTRAINT chk_catalog_import_rows_status CHECK (row_status IN ('ok', 'invalid', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_import_rows_key
  ON public.catalog_import_rows (batch_id, catalog_key) WHERE row_status = 'ok';

CREATE TABLE IF NOT EXISTS public.catalog_import_matches (
  batch_id BIGINT NOT NULL REFERENCES public.catalog_import_batches(batch_id) ON DELETE CASCADE,
  film_id BIGINT NOT NULL REFERENCES public.films(film_id),
  row_id BIGINT NULL REFERENCES public.catalog_import_rows(row_id),
  match_status TEXT NOT NULL,
  score NUMERIC(5,3) NULL,
  candidates JSONB NULL,
  fingerprint TEXT NOT NULL,
  before JSONB NULL,
  after JSONB NULL,
  CONSTRAINT pk_catalog_import_matches PRIMARY KEY (batch_id, film_id),
  CONSTRAINT chk_catalog_import_matches_status CHECK (match_status IN ('linked', 'auto', 'suggested', 'confirmed', 'manual', 'none', 'unchanged')),
  CONSTRAINT chk_catalog_import_matches_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_matches_batch_row
  ON public.catalog_import_matches (batch_id, row_id);

CREATE TABLE IF NOT EXISTS public.vendor_import_aliases (
  source_norm TEXT PRIMARY KEY,
  vendor_id SMALLINT NOT NULL REFERENCES public.vendors(vendor_id),
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_vendor_import_aliases_source_norm CHECK (
    source_norm = lower(btrim(source_norm)) AND length(source_norm) > 0
  )
);

CREATE TABLE IF NOT EXISTS public.film_name_history (
  history_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  film_id BIGINT NOT NULL REFERENCES public.films(film_id),
  old_name VARCHAR(200) NOT NULL,
  new_name VARCHAR(200) NOT NULL,
  old_vendor_id SMALLINT NULL,
  new_vendor_id SMALLINT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by BIGINT NULL REFERENCES public.users(user_id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  batch_id BIGINT NULL REFERENCES public.catalog_import_batches(batch_id),
  CONSTRAINT chk_film_name_history_source CHECK (source IN ('manual', 'manual_unknown_actor', 'catalog_import', 'catalog_import_revert'))
);

CREATE INDEX IF NOT EXISTS idx_film_name_history_film
  ON public.film_name_history (film_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_film_name_history_old_trgm
  ON public.film_name_history USING gin (old_name gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.films_record_name_history()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id BIGINT;
DECLARE source_name TEXT;
DECLARE batch BIGINT;
DECLARE setting_value TEXT;
BEGIN
  actor_id := NULL;
  BEGIN
    setting_value := NULLIF(current_setting('erp.film_change_actor', true), '');
    IF setting_value IS NOT NULL THEN actor_id := setting_value::BIGINT; END IF;
  EXCEPTION WHEN OTHERS THEN actor_id := NULL;
  END;
  IF actor_id IS NULL THEN
    BEGIN
      setting_value := NULLIF(current_setting('hasura.user', true), '');
      IF setting_value IS NOT NULL THEN
        actor_id := NULLIF(setting_value::JSON ->> 'x-hasura-user-id', '')::BIGINT;
      END IF;
    EXCEPTION WHEN OTHERS THEN actor_id := NULL;
    END;
  END IF;
  IF actor_id IS NULL THEN
    BEGIN
      setting_value := NULLIF(current_setting('app.user_id', true), '');
      IF setting_value IS NOT NULL THEN actor_id := setting_value::BIGINT; END IF;
    EXCEPTION WHEN OTHERS THEN actor_id := NULL;
    END;
  END IF;

  source_name := NULLIF(current_setting('erp.film_change_source', true), '');
  IF source_name IS NULL OR source_name NOT IN ('manual', 'manual_unknown_actor', 'catalog_import', 'catalog_import_revert') THEN
    source_name := 'manual';
  END IF;
  IF source_name = 'manual' AND actor_id IS NULL THEN source_name := 'manual_unknown_actor'; END IF;

  batch := NULL;
  BEGIN
    setting_value := NULLIF(current_setting('erp.film_change_batch', true), '');
    IF setting_value IS NOT NULL THEN batch := setting_value::BIGINT; END IF;
  EXCEPTION WHEN OTHERS THEN batch := NULL;
  END;

  INSERT INTO public.film_name_history (
    film_id, old_name, new_name, old_vendor_id, new_vendor_id, changed_by, source, batch_id
  ) VALUES (
    NEW.film_id, OLD.film_name, NEW.film_name, OLD.vendor_id, NEW.vendor_id, actor_id, source_name, batch
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_films_name_history ON public.films;
CREATE TRIGGER trg_films_name_history
  AFTER UPDATE OF film_name, vendor_id ON public.films
  FOR EACH ROW
  WHEN (OLD.film_name IS DISTINCT FROM NEW.film_name OR OLD.vendor_id IS DISTINCT FROM NEW.vendor_id)
  EXECUTE FUNCTION public.films_record_name_history();
