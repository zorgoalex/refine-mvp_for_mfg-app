-- 1C agent: expected daily silence (UTC "HH:MM-HH:MM", may wrap midnight). The monitor does not raise «agent silent»
-- for a silence that this interval explains (a planned stop of the agent before a nightly reboot of the 1C computer).
-- NULL = not set. Names are unqualified like in 193–200: test harnesses apply these migrations in their own schema. The length limit (≤ 120 minutes) is enforced by the backend; the database checks the format.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE onec_agents
  ADD COLUMN IF NOT EXISTS expected_silence_utc TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_onec_agents_expected_silence_utc'
                   AND conrelid = 'onec_agents'::regclass) THEN
    ALTER TABLE onec_agents ADD CONSTRAINT chk_onec_agents_expected_silence_utc
      CHECK (expected_silence_utc IS NULL
             OR expected_silence_utc ~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
END $$;

COMMENT ON COLUMN onec_agents.expected_silence_utc IS
  'Expected daily silence of the agent, UTC "HH:MM-HH:MM" (may wrap midnight); the monitor does not alert on a silence it explains';

COMMIT;
