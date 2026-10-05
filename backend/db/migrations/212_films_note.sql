-- Примечание плёнки: свободный текст (виден в SQL и через Hasura). Импорт каталога 1С дописывает
-- в него строку «Прежнее название: …» у переименованных плёнок (полная история — film_name_history).
ALTER TABLE public.films ADD COLUMN IF NOT EXISTS note TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.films'::regclass AND conname = 'chk_films_note_length'
  ) THEN
    ALTER TABLE public.films ADD CONSTRAINT chk_films_note_length CHECK (note IS NULL OR length(note) <= 2000);
  END IF;
END $$;

COMMENT ON COLUMN public.films.note IS
  'Примечание (до 2000 символов); импорт каталога 1С дописывает «Прежнее название: …»';
