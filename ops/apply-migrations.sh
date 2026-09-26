#!/usr/bin/env bash
#
# apply-migrations.sh — ordered, ledgered runner for backend/db/migrations/*.sql.
#
# The backend has NO built-in migration runner: schema lands either from a DB
# dump restore or by applying the numbered SQL files in order. This script does
# the latter safely, tracking applied files in a `schema_migrations` ledger so
# re-runs are idempotent.
#
# It talks to Postgres via `docker exec` into the stack's postgres container and
# resolves the user/db from the container's own env (POSTGRES_USER/POSTGRES_DB),
# so no DB password is ever read into the host shell.
#
# Modes:
#   dry-run   (default) List which migrations WOULD apply. Read-only, no writes.
#   status            Show applied vs pending (+ checksum drift). Read-only.
#   apply             Apply pending migrations in order, recording each in the
#                     ledger. Requires confirmation (or --yes).
#   baseline          Record ALL current migration files as applied WITHOUT
#                     running them. For an existing DB (e.g. erp_test) that was
#                     migrated before this ledger existed — adopt the ledger so
#                     `apply` does not try to re-run history. Run this ONCE.
#   mark-applied      Record SPECIFIC migrations as applied WITHOUT running them
#                     (real checksum, no drift). For a restored dump that already
#                     contains some migrations (prod baseline) or a migration that
#                     must be skipped (e.g. 003 when prod orders_view is newer).
#                     Targets: --upto NNN (mark 001..NNN) and/or explicit
#                     versions/filenames (e.g. `mark-applied 003`).
#   auto              ONE-COMMAND bring-up for a freshly RESTORED prod dump of
#                     ANY migration level (holes included): per-file effect
#                     probes detect what the dump already contains (marked
#                     applied with real checksums), the delta is applied in
#                     order, the Variant B gate (033/034) runs its coverage /
#                     preflight / verify checks machine-parsed, view drift is
#                     auto-healed, sequences are realigned. Fail-closed: any
#                     non-autofixable state aborts with exact remediation and
#                     an idempotent re-run continues from that point.
#   probe <migration>  Read-only: classify one migration as PRESENT/PENDING.
#                     Intended for diagnostics and integration tests.
#   classify-material-name <name>
#                     (internal) print the --auto-map heuristic verdict for one
#                     legacy material name: "cuttable|<mm>|<mtype>" for known
#                     sheet-material names, "unknown|1|3" otherwise. Used by
#                     unit tests. Placement decides the final row: a material
#                     used on order details is ALWAYS mapped cuttable (unknown
#                     names get sentinel 1×1×1 dims so the operator can find
#                     and fix them later); header-only stays non-cuttable.
#
# Selection: backend/db/migrations/[0-9]*.sql, sorted by version, EXCLUDING the
# manual Variant-B side files *_preflight.sql / *_verify.sql / *_rollback.sql and
# the *.test.ts files. Those are applied by their own plan, not this runner.
#
# Usage:
#   ops/apply-migrations.sh [dry-run|status|apply|baseline|mark-applied] [options]
# Options:
#   --container NAME   Postgres container (default: erp_test-postgresdb-1 or $PG_CONTAINER)
#   --user NAME        Override DB user (default: container $POSTGRES_USER)
#   --db NAME          Override DB name (default: container $POSTGRES_DB)
#   --dir PATH         Migrations dir (default: <repo_erp>/backend/db/migrations)
#   --to NNN           apply: stop AFTER migration version NNN (controlled stop,
#                      e.g. `apply --to 032` to halt before the 033/034 Variant B).
#   --upto NNN         mark-applied: mark migrations 001..NNN as applied.
#   --yes              Skip the confirmation prompt.
#   --detect-only      auto: print the detection report and exit. Read-only.
#   --auto-map         auto: apply heuristic conversion-map candidate rows for
#                      uncovered legacy materials (default: abort with a
#                      candidates artifact for review).
#   --artifacts DIR    auto: where to write reports/candidates (default
#                      <repo>/../backups/migration-auto-<UTC>).
#   --assume-restored  auto: accept a restored dump whose orders table is empty
#                      (default aborts and explains both paths).
#   --run-041-reset    auto: at the 041 slot, run the Bazis layout reset even
#                      though pre-existing/drifted label templates were found.
#   --skip-041         auto: at the 041 slot, mark 041 applied WITHOUT running
#                      it, preserving live template layouts.
#   --clear-hard-stop  auto: remove a persistent hard-stop sentinel left by a
#                      failed 034 verify after manual investigation.
#
# Examples:
#   ops/apply-migrations.sh                            # dry-run: what is pending?
#   ops/apply-migrations.sh baseline --yes             # adopt ledger on an already-migrated DB
#   ops/apply-migrations.sh mark-applied --upto 005 --yes   # restored prod baseline at 005
#   ops/apply-migrations.sh mark-applied 003 --yes     # skip 003 (prod orders_view newer)
#   ops/apply-migrations.sh apply --to 032 --yes       # apply 006..032, stop before Variant B
#   ops/apply-migrations.sh apply --yes                # apply all pending
#
set -euo pipefail

# --- Locate paths ------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ERP="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_DIR_DEFAULT="$REPO_ERP/backend/db/migrations"

# --- Defaults / args ---------------------------------------------------------
MODE="dry-run"
CONTAINER="${PG_CONTAINER:-erp_test-postgresdb-1}"
USER_OVERRIDE=""
DB_OVERRIDE=""
MIG_DIR="$MIG_DIR_DEFAULT"
ASSUME_YES=0
APPLY_TO=""               # apply: stop after this version (e.g. 032)
MARK_UPTO=""              # mark-applied: mark 001..NNN
declare -a TARGETS=()     # mark-applied: explicit versions/filenames
DETECT_ONLY=0             # auto: report only
AUTO_MAP=0                # auto: heuristic conversion-map fill
ARTIFACTS_DIR=""          # auto: report/candidate output dir
ASSUME_RESTORED=0         # auto: accept zero-orders restored dump
RUN_041_RESET=0           # auto: 041 slot — run the reset
SKIP_041=0                # auto: 041 slot — mark applied without running
CLEAR_HARD_STOP=0         # auto: clear the zz_hard_stop sentinel first

err() { printf 'apply-migrations: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

case "${1:-}" in
  dry-run|status|apply|baseline|mark-applied|auto|probe) MODE="$1"; shift ;;
  classify-material-name)
    shift
    # Pure heuristic, no DB access — used by --auto-map and unit tests.
    name="${1:-}"
    if printf '%s' "$name" | grep -qiE 'МДФ|ЛДСП|ДСП|ХДФ|ДВП|ФАНЕР'; then
      th="$(printf '%s' "$name" | grep -oiE '[0-9]+[[:space:]]*мм' | grep -oE '[0-9]+' | head -1)" || true
      [ -n "$th" ] || th=16
      mtype=3
      printf '%s' "$name" | grep -qiE 'МДФ' && mtype=1
      echo "cuttable|$th|$mtype"
    else
      echo "unknown|1|3"
    fi
    exit 0
    ;;
  -h|--help|help) sed -n '2,100p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "" ) ;;                                   # no arg → default dry-run
  -* ) ;;                                   # first token is an option → default mode
  * ) die "unknown mode '${1}' (use dry-run|status|apply|baseline|mark-applied|auto|probe)";;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:?}"; shift 2 ;;
    --user)      USER_OVERRIDE="${2:?}"; shift 2 ;;
    --db)        DB_OVERRIDE="${2:?}"; shift 2 ;;
    --dir)       MIG_DIR="${2:?}"; shift 2 ;;
    --to)        APPLY_TO="${2:?}"; shift 2 ;;
    --upto)      MARK_UPTO="${2:?}"; shift 2 ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    --detect-only)     DETECT_ONLY=1; shift ;;
    --auto-map)        AUTO_MAP=1; shift ;;
    --artifacts)       ARTIFACTS_DIR="${2:?}"; shift 2 ;;
    --assume-restored) ASSUME_RESTORED=1; shift ;;
    --run-041-reset)   RUN_041_RESET=1; shift ;;
    --skip-041)        SKIP_041=1; shift ;;
    --clear-hard-stop) CLEAR_HARD_STOP=1; shift ;;
    -*) die "unknown option '$1'" ;;
    *)  TARGETS+=("$1"); shift ;;           # positional: mark-applied targets
  esac
done

[ -d "$MIG_DIR" ] || die "migrations dir not found: $MIG_DIR"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "postgres container not found: $CONTAINER (set --container or \$PG_CONTAINER)"

# --- psql helpers (user/db resolved INSIDE the container) --------------------
# Override vars are passed into the exec env; the inner shell prefers them, else
# falls back to the container's own POSTGRES_USER/POSTGRES_DB.
_exec() { docker exec -i -e MIG_USER="$USER_OVERRIDE" -e MIG_DB="$DB_OVERRIDE" "$CONTAINER" "$@"; }

# Run a single SQL string, return rows unaligned/tuples-only.
pg_query() {
  _exec sh -c 'psql -U "${MIG_USER:-$POSTGRES_USER}" -d "${MIG_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1 -qtAF "|" -c "$1"' _ "$1"
}
# Pipe a .sql file on stdin. A guarded prelude sets app.user_id (session
# scope) so migrations whose DML fires the set_created_by/set_edited_by audit
# triggers do not abort with "app.user_id is not set" on a restored dump.
APPLY_PRELUDE="DO \$prelude\$ BEGIN
  IF to_regprocedure('set_session_user(bigint)') IS NOT NULL
     AND to_regclass('public.users') IS NOT NULL
     AND EXISTS (SELECT 1 FROM users) THEN
    PERFORM set_session_user((SELECT min(user_id) FROM users));
  END IF;
END \$prelude\$;"
pg_apply_file() {
  { printf '%s\n' "$APPLY_PRELUDE"; cat "$1"; } \
    | _exec sh -c 'psql -U "${MIG_USER:-$POSTGRES_USER}" -d "${MIG_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1'
}

ensure_ledger() {
  pg_query "CREATE TABLE IF NOT EXISTS schema_migrations (
             filename text PRIMARY KEY,
             checksum text NOT NULL,
             applied_at timestamptz NOT NULL DEFAULT now());" >/dev/null
}
ledger_exists() {
  [ "$(pg_query "SELECT to_regclass('public.schema_migrations') IS NOT NULL;")" = "t" ]
}

# --- Build the ordered migration list ----------------------------------------
mapfile -t FILES < <(
  cd "$MIG_DIR" && ls -1 [0-9]*.sql 2>/dev/null \
    | grep -vE '_(preflight|verify|rollback)\.sql$' \
    | sort -V
)
[ "${#FILES[@]}" -gt 0 ] || die "no migration .sql files in $MIG_DIR"

checksum_of() { sha256sum "$MIG_DIR/$1" | awk '{print $1}'; }
# Numeric version from a filename or version token ("003_x.sql"/"003"/"3" -> 3).
version_of() { local b="${1##*/}"; b="${b%%_*}"; echo "$((10#$b))"; }

# ============================ auto-mode machinery ============================
HARD_STOP_PREFIX="zz_hard_stop"

# Persistent hard-stop sentinel: written when 034 verify fails; blocks EVERY
# mutating mode (apply/baseline/mark-applied/auto) until --clear-hard-stop.
hard_stop_present() {
  ledger_exists || return 1
  [ -n "$(pg_query "SELECT filename FROM schema_migrations WHERE filename LIKE '${HARD_STOP_PREFIX}%' LIMIT 1;")" ]
}
hard_stop_gate() {
  hard_stop_present || return 0
  local row; row="$(pg_query "SELECT filename || ' :: ' || checksum FROM schema_migrations WHERE filename LIKE '${HARD_STOP_PREFIX}%' ORDER BY filename LIMIT 1;")"
  die "HARD-STOP sentinel present: $row
A previous run failed the 034 post-verify. Investigate first (034_rollback.sql,
production-go-live runbook), then clear with:
  $0 auto --clear-hard-stop [--container ...] and re-run."
}

# Column / table / constraint / index probe helpers (read-only, booleans).
q_col()   { echo "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2');"; }
q_tbl()   { echo "SELECT to_regclass('public.$1') IS NOT NULL;"; }
q_con()   { echo "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='$1');"; }
q_con_on(){ echo "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='$2' AND conrelid='public.$1'::regclass);"; }
q_idx()   { echo "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='$1');"; }
q_trg()   { echo "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='$1');"; }
q_con_def() { echo "SELECT COALESCE((SELECT pg_get_constraintdef(oid)='$2' FROM pg_constraint WHERE conname='$1'), false);"; }
q_trg_def() { echo "SELECT COALESCE((SELECT pg_get_triggerdef(oid)='$2' FROM pg_trigger WHERE tgname='$1'), false);"; }
q_con_def_on() { echo "SELECT COALESCE((SELECT pg_get_constraintdef(oid)='$3' FROM pg_constraint WHERE conname='$1' AND conrelid='public.$2'::regclass), false);"; }
q_con_def_on_safe() { echo "SELECT COALESCE((SELECT pg_get_constraintdef(oid)=\$erp_probe\$$3\$erp_probe\$ FROM pg_constraint WHERE conname='$1' AND conrelid='public.$2'::regclass), false);"; }
q_con_hash_on() { echo "SELECT COALESCE((SELECT md5(pg_get_constraintdef(oid))='$3' FROM pg_constraint WHERE conname='$1' AND conrelid='public.$2'::regclass), false);"; }
q_idx_hash() { echo "SELECT COALESCE((SELECT md5(indexdef)='$2' FROM pg_indexes WHERE schemaname='public' AND indexname='$1'), false);"; }
q_fun_hash() { echo "SELECT COALESCE((SELECT md5(pg_get_functiondef(oid))='$2' FROM pg_proc WHERE oid=to_regprocedure('$1')), false);"; }
q_colset_hash() { echo "SELECT COALESCE((SELECT md5(string_agg(format('%s|%s|%s|%s|%s',ordinal_position,column_name,data_type,is_nullable,COALESCE(column_default,'∅')), ', ' ORDER BY ordinal_position))='$3' FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name=ANY(string_to_array('$2',','))), false);"; }
q_colset_fun_hash_pair() { echo "SELECT CASE WHEN (SELECT md5(pg_get_functiondef(oid))='$7' FROM pg_proc WHERE oid=to_regprocedure('$6')) THEN (SELECT COALESCE(md5(string_agg(format('%s|%s|%s|%s|%s',ordinal_position,column_name,data_type,is_nullable,COALESCE(column_default,'∅')), ', ' ORDER BY ordinal_position))='$3',false) FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name=ANY(string_to_array('$2',','))) WHEN (SELECT md5(pg_get_functiondef(oid))='$8' FROM pg_proc WHERE oid=to_regprocedure('$6')) THEN (SELECT COALESCE(md5(string_agg(format('%s|%s|%s|%s|%s',ordinal_position,column_name,data_type,is_nullable,COALESCE(column_default,'∅')), ', ' ORDER BY ordinal_position))='$5',false) FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name=ANY(string_to_array('$4',','))) ELSE false END;"; }
q_conset_hash() { echo "SELECT COALESCE((SELECT md5(string_agg(conname||'|'||contype::text||'|'||confdeltype::text||'|'||pg_get_constraintdef(oid), ', ' ORDER BY conname))='$3' FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid::regclass::text='$1' AND conname=ANY(string_to_array('$2',','))), false);"; }
q_idxset_hash() { echo "SELECT COALESCE((SELECT md5(string_agg(indexname||'|'||indexdef, ', ' ORDER BY indexname))='$3' FROM pg_indexes WHERE schemaname='public' AND tablename='$1' AND indexname=ANY(string_to_array('$2',','))), false);"; }
q_stmt_trg() { echo "SELECT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname='$1' AND t.tgrelid='public.$2'::regclass AND t.tgfoid='$3()'::regprocedure AND t.tgtype=$4 AND t.tgenabled='O' AND NOT t.tgisinternal AND COALESCE(t.tgoldtable, '')='$5' AND COALESCE(t.tgnewtable, '')='$6');"; }
q_trg_def_on() { echo "SELECT COALESCE((SELECT pg_get_triggerdef(oid)='$3' FROM pg_trigger WHERE tgname='$1' AND tgrelid='public.$2'::regclass), false);"; }
probe_true() { [ "$(pg_query "$1")" = "t" ]; }
# AND-chain: every argument is a boolean SQL statement; all must be true.
probe_all() { local q; for q in "$@"; do probe_true "$q" || return 1; done; return 0; }

# Effect probe per migration FILE (not version — the three 040_* differ).
# Prints PRESENT / PENDING for regular files. 003/034/041 have dedicated logic.
probe_file() {
  local f="$1"
  case "$f" in
    001_*) probe_all "$(q_tbl auth_sessions)" "$(q_col refresh_tokens token_family_id)" ;;
    002_*) # incl. the late idempotency hardening (real-VPS drift 2026-07-04:
           # a dump carried the deadline tables but NOT the ALTER'ed column)
           probe_all "$(q_tbl deadline_policies)" "$(q_tbl deadline_instances)" \
                     "$(q_tbl deadline_events)" "$(q_tbl outbox_events)" "$(q_tbl notifications)" \
                     "$(q_col deadline_events idempotency_key)" \
                     "$(q_idx uq_deadline_events_idempotency_key)" ;;
    004_*) probe_all "$(q_tbl command_idempotency_keys)" \
                     "$(q_col audit_log related_order_id)" "$(q_col audit_log related_client_id)" \
                     "$(q_col audit_log related_production_event_id)" "$(q_col audit_log source)" \
                     "$(q_col audit_log status_code)" "$(q_col audit_log stage_code)" ;;
    005_*) probe_all "$(q_tbl order_import_runs)" "$(q_tbl order_import_entity_map)" ;;
    006_*) probe_all "$(q_col notifications idempotency_key)" ;;
    007_*) probe_all "$(q_col deadline_instances idempotency_key)" ;;
    008_*) probe_all "$(q_tbl deadline_order_overrides)" "$(q_col deadline_action_executions rule_version_id)" ;;
    # After rename-migration 054, project_* objects no longer exist; create-migration probes check END-state group_*.
    009_*) probe_all "$(q_tbl group_groups)" ;;
    010_*) probe_all "$(q_tbl group_order_groups)" ;;
    011_*) probe_all "$(q_tbl group_members)" ;;
    012_*) probe_all "$(q_col audit_log related_payment_id)" "$(q_col audit_log related_deadline_id)" ;;
    013_*) probe_all "$(q_tbl group_entity_types)" "$(q_tbl group_entity_links)" "$(q_tbl group_participant_roles)" "$(q_tbl group_participants)" ;;
    014_*) probe_all "$(q_tbl notification_rules)" ;;
    015_*) probe_all "$(q_tbl notification_rules)" "SELECT EXISTS (SELECT 1 FROM notification_rules WHERE rule_code='deadline-expired-notify-manager');" ;;
    016_*) probe_all "$(q_tbl directions)" "$(q_tbl direction_heads)" ;;
    017_*) probe_all "$(q_col audit_log related_user_id)" ;;
    018_*) probe_all "$(q_col notification_rules group_id)" ;;
    019_*) probe_all "$(q_tbl notification_rules)" "SELECT EXISTS (SELECT 1 FROM notification_rules WHERE rule_code='deadline-final-order-expired-manager');" ;;
    020_*) probe_all "$(q_tbl audit_log_related_entity)" ;;
    021_*) probe_all "$(q_tbl sheet_material_types)" "$(q_col materials sheet_material_type_id)" ;;
    022_*) probe_all "$(q_tbl cut_job)" "$(q_tbl cut_group)" "$(q_tbl cut_job_item)" ;;
    023_*) probe_all "$(q_tbl cut_param_profiles)" "$(q_tbl cut_settings)" "$(q_tbl cut_render_presets)" ;;
    024_*) probe_all "$(q_col sheet_material_types version)" ;;
    025_*) probe_all "$(q_tbl crm_sync_mapping)" "$(q_tbl crm_sync_outbox)" "$(q_trg trg_crm_sync_orders)" ;;
    026_*) probe_all "$(q_col sheet_material_types unit_id)" "$(q_col sheet_material_types supplier_id)" \
                     "$(q_col sheet_material_types vendor_id)" "$(q_col sheet_material_types supplier_article)" \
                     "$(q_col sheet_material_types texture)" "$(q_col sheet_material_types color)" \
                     "$(q_con fk_sheet_material_types_unit)" "$(q_con fk_sheet_material_types_supplier)" \
                     "$(q_con fk_sheet_material_types_vendor)" \
                     "SELECT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='sheet_material_types' AND a.attname='unit_id' AND a.attnotnull);" ;;
    027_*) probe_all "$(q_tbl sheet_material_copy_runs)" ;;
    028_*) probe_all "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='crm_sync_enqueue' AND prosrc LIKE '%IF v_entity = ''client'' THEN%');" ;;
    029_*) probe_all "$(q_col order_details sheet_material_type_id)" "$(q_col materials is_sheet_shadow)" "$(q_col orders sheet_eligible)" ;;
    030_*) # 034 legitimately DROPS this trigger: sunset end-state absorbs 030.
           if probe_034_endstate; then return 0; fi
           probe_all "$(q_trg trg_order_detail_shadow_pairing)" ;;
    031_*) # END-state: 031 DROPS the global guard and adds the per-job guard +
           # lookup index. Probing the dropped index would be inverted.
           probe_all "SELECT NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_cut_job_item_active_detail');" \
                     "$(q_idx uq_cut_job_item_active_job_detail)" \
                     "$(q_idx idx_cut_job_item_order_detail)" ;;
    032_*) probe_all "$(q_col cut_job failure_code)" "$(q_col cut_job failure_reason)" ;;
    033_*) # Composite: full replace manifest is re-runnable by design, so ANY
           # partial effect => PENDING (re-apply converges).
           probe_all "$(q_tbl sheet_material_conversion_map)" \
                     "$(q_col sheet_material_types conversion_key)" \
                     "$(q_col sheet_material_types is_cuttable)" \
                     "$(q_idx uq_sheet_material_types_conversion_key)" \
                     "SELECT EXISTS (SELECT 1 FROM sheet_material_conversion_map WHERE target_key='NOT_DEFINED');" ;;
    034_*) probe_034_endstate ;;
    035_*) probe_all "$(q_con fk_cut_job_param_profile)" "$(q_col cut_job param_profile_id)" "$(q_idx idx_cut_job_param_profile_id)" ;;
    036_*) probe_all "$(q_col order_details basis_project)" "$(q_col order_details basis_data)" \
                     "SELECT CASE WHEN to_regclass('public.order_details_view') IS NULL THEN false ELSE pg_get_viewdef('public.order_details_view') LIKE '%basis_project%' END;" ;;
    037_*) probe_all "$(q_col cut_param_profiles seed_key)" "$(q_idx uq_cut_param_profiles_seed_key)" ;;
    038_*) probe_all "$(q_tbl cut_param_profiles)" "$(q_col cut_param_profiles seed_key)" \
                     "SELECT EXISTS (SELECT 1 FROM cut_param_profiles WHERE seed_key='vacuum_optimal');" \
                     "SELECT EXISTS (SELECT 1 FROM cut_param_profiles WHERE seed_key='vacuum_width');" \
                     "SELECT EXISTS (SELECT 1 FROM cut_param_profiles WHERE seed_key='vacuum_height');" ;;
    039_*) probe_all "$(q_tbl label_templates)" "$(q_tbl label_template_elements)" "$(q_tbl order_label_generations)" ;;
    040_cut_job_sheet_material*) probe_all "$(q_con fk_cut_job_sheet_material_type)" "$(q_col cut_job sheet_material_type_id)" "$(q_idx idx_cut_job_sheet_material_type_id)" ;;
    040_seed_standard_label_template*) probe_all "$(q_tbl label_templates)" "SELECT EXISTS (SELECT 1 FROM label_templates WHERE lower(name)=lower('Стандартная бирка Bazis 85x88'));" ;;
    040_user_preferences*) probe_all "$(q_tbl user_preferences)" ;;
    042_*) probe_all "$(q_col cut_job combine_films)" ;;
    043_*) probe_all "$(q_col cut_job split_by_material)" ;;
    044_*) probe_all "$(q_col user_preferences order_detail_columns)" ;;
    045_*) probe_all "$(q_tbl cut_group_manual_layout)" "$(q_col cut_job last_calc_basis)" ;;
    046_*) probe_all "$(q_con chk_order_label_generations_scope)" "$(q_con chk_order_label_generations_scope_json_object)" \
                     "$(q_col order_label_generations generation_scope)" "$(q_col order_label_generations scope_json)" \
                     "$(q_idx idx_order_label_generations_scope_generated_at)" \
                     "SELECT NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='order_label_generations' AND a.attname='order_id' AND a.attnotnull);" ;;
    047_*) probe_all "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_label_template_elements_kind' AND pg_get_constraintdef(oid) LIKE '%''qr''%');" ;;
    048_*) probe_all "$(q_tbl cut_pdf_templates)" \
                     "SELECT EXISTS (SELECT 1 FROM cut_pdf_templates WHERE code='standard');" \
                     "SELECT EXISTS (SELECT 1 FROM cut_pdf_templates WHERE code='bath_profiles');" ;;
    049_*) probe_all "$(q_col cut_pdf_templates layout)" ;;
    050_*) probe_all "$(q_col cut_job pdf_template_code)" "$(q_col cut_group pdf_template_code)" ;;
    051_*) probe_all "$(q_tbl label_qr_templates)" ;;
    052_*) probe_all "$(q_tbl user_identities)" "$(q_idx idx_user_identities_user)" \
                     "$(q_col users login_policy)" "$(q_col auth_sessions provider_session_id)" \
                     "$(q_col auth_sessions auth_source)" ;;
    053_*) probe_all "$(q_tbl label_ocr_templates)" "$(q_idx label_ocr_templates_name_active_uniq)" ;;
    054_*) probe_all "$(q_tbl group_groups)" ;;
    055_*) probe_all "$(q_col user_identities auth_method)" ;;
    056_*) probe_all "$(q_tbl projects)" "$(q_col orders project_id)" ;;
    057_*) probe_all "$(q_col order_details basis_designation)" ;;
    058_*) probe_all "$(q_tbl bazis_projects)" "$(q_tbl bazis_import_runs)" ;;
    059_*) probe_all "$(q_col order_details basis_product)" ;;
    060_*) probe_all "$(q_col label_templates field_catalog_snapshot)" \
                     "$(q_col label_qr_templates field_catalog_snapshot)" \
                     "$(q_con chk_label_templates_field_catalog_snapshot_object)" \
                     "$(q_con chk_label_qr_templates_field_catalog_snapshot_object)" ;;
    061_*) probe_all "$(q_col user_preferences ui_size)" ;;
    062_*) probe_all "$(q_col bazis_project_revisions bazis_order_no)" ;;
    063_*) probe_all "$(q_col order_details doweling)" \
                     "$(q_col order_details_view doweling)" ;;
    064_*) probe_all "$(q_col bazis_nodes notes)" ;;
    065_*) probe_all "$(q_col orders deleted_at)" \
                     "$(q_col orders deleted_by)" ;;
    066_*) probe_all "$(q_tbl status_automation_rules)" ;;
    067_*) probe_all "SELECT NOT EXISTS (
                       SELECT 1
                       FROM order_details od
                       WHERE od.area IS DISTINCT FROM ROUND(
                         (od.height::numeric * od.width::numeric * od.quantity::numeric) / 1000000,
                         2
                       )
                     );" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                       FROM orders o
                       WHERE o.total_area IS DISTINCT FROM (
                         SELECT ROUND(
                           COALESCE(SUM(od.height::numeric * od.width::numeric * od.quantity::numeric), 0) / 1000000,
                           2
                         )
                         FROM order_details od
                         WHERE od.order_id = o.order_id
                           AND od.delete_flag = false
                       )
                     );" ;;
    068_*) probe_all "$(q_tbl bazis_cut_sets)" "$(q_tbl bazis_cut_set_details)" \
                     "$(q_col bazis_cut_set_details source_order_detail_id)" \
                     "$(q_col bazis_cut_set_details film)" \
                     "$(q_idx uq_bazis_cut_set_details_source_detail)" ;;
    069_*) probe_all "SELECT NOT EXISTS (
                       SELECT 1
                       FROM bazis_cut_set_details snapshot
                       JOIN order_details source
                         ON source.detail_id = snapshot.source_order_detail_id
                       WHERE NULLIF(btrim(COALESCE(snapshot.source_bazis_order_no, '')), '') IS NULL
                         AND NULLIF(btrim(COALESCE(source.basis_product, '')), '') IS NOT NULL
                     );" ;;
    070_*) probe_all "$(q_col clients sort_order)" \
                     "$(q_col materials sort_order)" \
                     "$(q_col sheet_material_types sort_order)" \
                     "$(q_col films sort_order)" \
                     "$(q_col film_types sort_order)" \
                     "$(q_col vendors sort_order)" \
                     "$(q_col suppliers sort_order)" \
                     "$(q_col units sort_order)" \
                     "$(q_col transaction_direction sort_order)" \
                     "$(q_col workshops sort_order)" \
                     "$(q_col work_centers sort_order)" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                       FROM pg_constraint
                       WHERE conname IN (
                         'uq_order_statuses_sort_order',
                         'uq_payment_statuses_sort_order',
                         'uq_production_statuses_sort_order'
                       )
                     );" ;;
    071_*) probe_all "$(q_col user_preferences recent_reference_entities)" ;;
    072_*) probe_all "$(q_tbl bazis_pdf_table_patterns)" \
                     "$(q_idx idx_bazis_pdf_table_patterns_active)" \
                     "$(q_con uq_bazis_pdf_table_patterns_fingerprint)" \
                     "$(q_con chk_bazis_pdf_table_patterns_fingerprint)" \
                     "$(q_con chk_bazis_pdf_table_patterns_signature)" \
                     "$(q_con chk_bazis_pdf_table_patterns_mapping)" \
                     "$(q_con chk_bazis_pdf_table_patterns_approval)" \
                     "$(q_con chk_bazis_pdf_table_patterns_version)" \
                     "$(q_col bazis_pdf_table_patterns fingerprint_version)" \
                     "$(q_col bazis_pdf_table_patterns parser_major)" \
                     "$(q_col bazis_pdf_table_patterns signature_json)" \
                     "$(q_col bazis_pdf_table_patterns mapping_json)" \
                     "$(q_col bazis_pdf_table_patterns mapping_hash)" \
                     "$(q_col bazis_pdf_table_patterns approval_status)" \
                     "$(q_col bazis_pdf_table_patterns is_active)" \
                     "$(q_col bazis_pdf_table_patterns version)" ;;
    073_*) probe_all "SELECT EXISTS (
                       SELECT 1
                         FROM information_schema.columns
                        WHERE table_schema='public'
                          AND table_name='clients'
                          AND column_name='person_type'
                          AND data_type='text'
                          AND is_nullable='NO'
                          AND column_default='''individual''::text'
                     );" \
                     "SELECT count(*) = 3
                        FROM information_schema.columns
                       WHERE table_schema='public'
                         AND table_name='crm_sync_mapping'
                         AND (
                           (column_name='bitrix_object' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='bitrix_id' AND data_type='text' AND is_nullable='YES')
                           OR (column_name='parent_erp_id' AND data_type='text' AND is_nullable='YES')
                         );" \
                     "SELECT COALESCE((
                       SELECT pg_get_constraintdef(oid) =
                         'CHECK ((person_type = ANY (ARRAY[''individual''::text, ''legal''::text])))'
                         FROM pg_constraint
                        WHERE conname='chk_clients_person_type'
                          AND conrelid='public.clients'::regclass
                     ), false);" \
                     "SELECT COALESCE((
                       SELECT pg_get_constraintdef(oid) =
                         'CHECK ((entity_type = ANY (ARRAY[''client''::text, ''order''::text, ''payment''::text])))'
                         FROM pg_constraint
                        WHERE conname='crm_sync_mapping_entity_type_check'
                          AND conrelid='public.crm_sync_mapping'::regclass
                     ), false);" \
                     "$(q_con_def_on uq_crm_sync_mapping_bitrix crm_sync_mapping 'UNIQUE (entity_type, bitrix_object, bitrix_id)')" \
                     "SELECT COALESCE((
                       SELECT indexdef = 'CREATE INDEX idx_crm_sync_mapping_parent ON public.crm_sync_mapping USING btree (entity_type, parent_erp_id) WHERE (parent_erp_id IS NOT NULL)'
                         FROM pg_indexes
                        WHERE schemaname='public'
                          AND indexname='idx_crm_sync_mapping_parent'
                     ), false);" \
                     "$(q_trg_def_on trg_crm_sync_client_phones client_phones 'CREATE TRIGGER trg_crm_sync_client_phones AFTER INSERT OR DELETE OR UPDATE ON public.client_phones FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue_client_phone()')" \
                     "$(q_trg_def_on trg_crm_sync_client_person_type_orders clients 'CREATE TRIGGER trg_crm_sync_client_person_type_orders AFTER UPDATE OF person_type ON public.clients FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue_client_orders()')" \
                     "SELECT COALESCE((
                       SELECT pg_get_functiondef('crm_sync_enqueue_client_phone()'::regprocedure)
                                LIKE '%crm.sync.client.upsert%'
                          AND pg_get_functiondef('crm_sync_enqueue_client_phone()'::regprocedure)
                                LIKE '%TG_OP = ''DELETE''%'
                     ), false);" \
                     "SELECT COALESCE((
                       SELECT pg_get_functiondef('crm_sync_enqueue_client_orders()'::regprocedure)
                                LIKE '%OLD.person_type IS NOT DISTINCT FROM NEW.person_type%'
                          AND pg_get_functiondef('crm_sync_enqueue_client_orders()'::regprocedure)
                                LIKE '%crm.sync.order.upsert%'
                     ), false);" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                         FROM clients
                        WHERE person_type IS NULL
                           OR person_type NOT IN ('individual', 'legal')
                     );" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                         FROM information_schema.columns
                        WHERE table_schema='public'
                          AND table_name='crm_sync_mapping'
                          AND column_name IN ('twenty_object', 'twenty_id')
                     );" ;;
    074_*) probe_all "SELECT count(*) = 6
                        FROM information_schema.columns
                       WHERE table_schema='public'
                         AND table_name='crm_sync_payment_create_guard'
                         AND (
                           (column_name='erp_payment_id' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='erp_order_id' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='bitrix_deal_id' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='before_ids' AND data_type='jsonb' AND is_nullable='NO')
                           OR (column_name='created_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default='now()')
                           OR (column_name='updated_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default='now()')
                         );" \
                     "SELECT count(*) = 3
                        FROM information_schema.columns
                       WHERE table_schema='public'
                         AND table_name='crm_sync_writer_lock'
                         AND (
                           (column_name='lock_name' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='lock_token' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='locked_at' AND data_type='timestamp with time zone' AND is_nullable='NO')
                         );" \
                     "$(q_con_def_on crm_sync_payment_create_guard_pkey crm_sync_payment_create_guard 'PRIMARY KEY (erp_payment_id)')" \
                     "$(q_con_def_on crm_sync_writer_lock_pkey crm_sync_writer_lock 'PRIMARY KEY (lock_name)')" \
                     "SELECT COALESCE((
                       SELECT pg_get_constraintdef(oid) =
                         'CHECK ((jsonb_typeof(before_ids) = ''array''::text))'
                         FROM pg_constraint
                        WHERE conname='crm_sync_payment_create_guard_before_ids_check'
                          AND conrelid='public.crm_sync_payment_create_guard'::regclass
                     ), false);" \
                     "$(q_trg_def_on trg_crm_sync_payments payments 'CREATE TRIGGER trg_crm_sync_payments AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue_payment_order()')" \
                     "SELECT COALESCE((
                       SELECT pg_get_functiondef('crm_sync_enqueue_order_id(bigint)'::regprocedure)
                                LIKE '%FROM orders%'
                          AND pg_get_functiondef('crm_sync_enqueue_order_id(bigint)'::regprocedure)
                                LIKE '%crm.sync.order.upsert%'
                          AND pg_get_functiondef('crm_sync_enqueue_order_id(bigint)'::regprocedure)
                                LIKE '%status = ''pending''%'
                     ), false);" \
                     "SELECT COALESCE((
                       SELECT pg_get_functiondef('crm_sync_enqueue_payment_order()'::regprocedure)
                                LIKE '%OLD.order_id IS DISTINCT FROM NEW.order_id%'
                          AND pg_get_functiondef('crm_sync_enqueue_payment_order()'::regprocedure)
                                LIKE '%crm_sync_enqueue_order_id(OLD.order_id)%'
                          AND pg_get_functiondef('crm_sync_enqueue_payment_order()'::regprocedure)
                                LIKE '%crm_sync_enqueue_order_id(NEW.order_id)%'
                     ), false);" ;;
    075_*) probe_075_endstate ;;
    076_*) probe_076_endstate ;;
    077_*) probe_077_endstate ;;
    078_*) probe_078_endstate ;;
    079_z_cut_result_jsonb_object_length_compat.sql)
           probe_true "SELECT to_regprocedure('jsonb_object_length(jsonb)') IS NOT NULL;" ;;
    079_*) probe_all "$(q_tbl cut_result)" "$(q_tbl cut_result_command)" \
                     "$(q_col cut_job current_cut_result_id)" "$(q_col cut_job next_cut_result_no)" \
                     "$(q_con uq_cut_result_job_no)" "$(q_con fk_cut_result_command_payload)" ;;
    080_*) probe_all "$(q_con chk_cut_result_command_identity)" \
                     "$(q_con chk_cut_result_snapshot_shape)" \
                     "$(q_con fk_cut_job_current_result_same_job)" \
                     "$(q_trg trg_cut_result_append_only)" \
                     "$(q_trg trg_cut_result_command_state)" \
                     "$(q_trg trg_cut_result_command_terminal_immutable)" \
                     "$(q_trg trg_cut_result_ledger_state)" ;;
    081_label_cut_maps*) probe_all "$(q_tbl cut_result_sheet_map)" "$(q_tbl cut_result_placement)" \
                     "$(q_tbl cut_result_label_map_projection)" \
                     "$(q_tbl label_generation_cut_placement)" \
                     "SELECT to_regprocedure('cut_result_label_map_expected_counts(jsonb)') IS NOT NULL;" \
                     "$(q_trg_def trg_cut_result_label_map_projection 'CREATE TRIGGER trg_cut_result_label_map_projection AFTER INSERT ON public.cut_result FOR EACH ROW EXECUTE FUNCTION project_new_cut_result_label_maps()')" \
                     "$(q_trg_def trg_cut_result_sheet_map_projection_insert 'CREATE TRIGGER trg_cut_result_sheet_map_projection_insert BEFORE INSERT ON public.cut_result_sheet_map FOR EACH ROW EXECUTE FUNCTION guard_cut_result_label_map_projection_insert()')" \
                     "$(q_trg_def trg_cut_result_placement_projection_insert 'CREATE TRIGGER trg_cut_result_placement_projection_insert BEFORE INSERT ON public.cut_result_placement FOR EACH ROW EXECUTE FUNCTION guard_cut_result_label_map_projection_insert()')" \
                     "$(q_trg_def trg_cut_result_label_map_projection_insert 'CREATE TRIGGER trg_cut_result_label_map_projection_insert BEFORE INSERT ON public.cut_result_label_map_projection FOR EACH ROW EXECUTE FUNCTION guard_cut_result_label_map_projection_insert()')" \
                     "$(q_trg_def trg_cut_result_sheet_map_append_only 'CREATE TRIGGER trg_cut_result_sheet_map_append_only BEFORE DELETE OR UPDATE ON public.cut_result_sheet_map FOR EACH ROW EXECUTE FUNCTION reject_cut_result_label_map_mutation()')" \
                     "$(q_trg_def trg_cut_result_placement_append_only 'CREATE TRIGGER trg_cut_result_placement_append_only BEFORE DELETE OR UPDATE ON public.cut_result_placement FOR EACH ROW EXECUTE FUNCTION reject_cut_result_label_map_mutation()')" \
                     "$(q_trg_def trg_cut_result_label_map_projection_append_only 'CREATE TRIGGER trg_cut_result_label_map_projection_append_only BEFORE DELETE OR UPDATE ON public.cut_result_label_map_projection FOR EACH ROW EXECUTE FUNCTION reject_cut_result_label_map_mutation()')" \
                     "$(q_con_def fk_cut_result_placement_exact_sheet 'FOREIGN KEY (cut_result_sheet_map_id, cut_result_id, cut_job_id, cut_group_id, variant, sheet_index) REFERENCES cut_result_sheet_map(cut_result_sheet_map_id, cut_result_id, cut_job_id, cut_group_id, variant, sheet_index) ON DELETE RESTRICT')" \
                     "SELECT pg_get_functiondef('guard_cut_result_label_map_projection_insert()'::regprocedure)
                              LIKE '%current_setting(''erp.cut_label_projection_result_id'', TRUE)%';" \
                     "SELECT pg_get_functiondef('project_cut_result_label_maps(bigint)'::regprocedure)
                              LIKE '%set_config(''erp.cut_label_projection_result_id'', '''', TRUE)%';" \
                     "SELECT pg_get_constraintdef(oid) LIKE '%cut_map%'
                        FROM pg_constraint
                       WHERE conname='chk_label_template_elements_kind';" ;;
    081_user_preferences_page_sizes*) probe_all "$(q_col user_preferences page_size_preferences)" ;;
    082_label_cut_maps_backfill*) probe_true "SELECT NOT EXISTS (
                       SELECT 1
                         FROM cut_result r
                         CROSS JOIN LATERAL cut_result_label_map_expected_counts(r.snapshot_job) expected
                         LEFT JOIN cut_result_label_map_projection p USING (cut_result_id)
                        WHERE p.cut_result_id IS NULL
                           OR p.snapshot_digest IS DISTINCT FROM r.snapshot_digest
                           OR p.sheet_count IS DISTINCT FROM expected.sheet_count
                           OR p.placement_count IS DISTINCT FROM expected.placement_count
                           OR p.sheet_count IS DISTINCT FROM (
                             SELECT count(*) FROM cut_result_sheet_map s
                              WHERE s.cut_result_id = r.cut_result_id)
                           OR p.placement_count IS DISTINCT FROM (
                             SELECT count(*) FROM cut_result_placement cp
                             WHERE cp.cut_result_id = r.cut_result_id)
                     );" ;;
    082_cnc_telegram_packets*) probe_all "$(q_tbl cnc_telegram_packets)" "$(q_tbl cnc_telegram_packet_items)" \
                     "$(q_col cnc_telegram_packets source_version)" \
                     "$(q_col cnc_telegram_packets payload_hash)" \
                     "$(q_col cnc_telegram_packet_items packet_item_id)" \
                     "$(q_idx idx_cnc_telegram_packets_workday_updated)" ;;
    083_orders_production_done_backfill*) probe_true "SELECT
                       (SELECT count(*)
                          FROM production_statuses ps
                         WHERE LOWER(BTRIM(ps.production_status_name)) IN ('done', 'завершено')
                            OR LOWER(BTRIM(ps.production_status_code)) ~ '^(done|zaversheno)(_|$)') = 1
                       AND NOT EXISTS (
                       SELECT 1
                         FROM orders o
                        WHERE o.created_at < CURRENT_TIMESTAMP - INTERVAL '1 month'
                          AND (
                            o.production_status_id IS DISTINCT FROM (
                              SELECT ps.production_status_id
                                FROM production_statuses ps
                               WHERE LOWER(BTRIM(ps.production_status_name)) IN ('done', 'завершено')
                                  OR LOWER(BTRIM(ps.production_status_code)) ~ '^(done|zaversheno)(_|$)'
                               ORDER BY ps.production_status_id
                               LIMIT 1
                            )
                            OR o.production_status_from_details_enabled IS DISTINCT FROM false
                          )
                     );" ;;
    084_user_preferences_ui_variant*) probe_all "$(q_col user_preferences ui_variant)" "$(q_con chk_user_preferences_ui_variant)" ;;
    085_cut_result_manual_revisions*) probe_all "$(q_col cut_result revision_no)" \
                     "$(q_con uq_cut_result_job_no)" \
                     "$(q_con chk_cut_result_revision_no)" ;;
    086_deadline_default_schedule*) probe_all "$(q_tbl deadline_default_schedule_config)" \
                     "$(q_tbl deadline_default_stage_durations)" \
                     "$(q_con chk_deadline_default_schedule_singleton)" \
                     "$(q_con chk_deadline_default_schedule_reserve_days)" \
                     "$(q_con chk_deadline_default_schedule_version)" \
                     "$(q_con fk_deadline_default_schedule_updated_by)" \
                     "$(q_con chk_deadline_default_stage_duration_days)" \
                     "$(q_con chk_deadline_default_stage_position)" \
                     "$(q_con uq_deadline_default_stage_position)" \
                     "$(q_con fk_deadline_default_stage_production_status)" \
                     "$(q_con fk_deadline_default_stage_updated_by)" \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM deadline_default_schedule_config
                         WHERE config_id = 1
                           AND reserve_days BETWEEN 0 AND 3650
                           AND version > 0
                      );" ;;
    087_deadline_default_parallel_stages*) probe_all \
                     "$(q_col deadline_default_stage_durations parallel_with_previous)" \
                     "$(q_con chk_deadline_default_stage_first_not_parallel)" ;;
    087_bitrix24_backfill_checkpoint*) probe_all \
                     "$(q_tbl crm_sync_backfill_checkpoint)" \
                     "SELECT count(*) = 9
                        FROM information_schema.columns
                       WHERE table_schema='public'
                         AND table_name='crm_sync_backfill_checkpoint'
                         AND (
                           (column_name='scope' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='phase' AND data_type='text' AND is_nullable='NO')
                           OR (column_name='last_client_id' AND data_type='text' AND is_nullable='YES')
                           OR (column_name='last_order_id' AND data_type='text' AND is_nullable='YES')
                           OR (column_name='processed_clients' AND data_type='bigint' AND is_nullable='NO' AND column_default='0')
                           OR (column_name='processed_orders' AND data_type='bigint' AND is_nullable='NO' AND column_default='0')
                           OR (column_name='started_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default='now()')
                           OR (column_name='updated_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default='now()')
                           OR (column_name='completed_at' AND data_type='timestamp with time zone' AND is_nullable='YES')
                         );" \
                     "$(q_con_def_on_safe crm_sync_backfill_checkpoint_pkey crm_sync_backfill_checkpoint 'PRIMARY KEY (scope)')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_scope crm_sync_backfill_checkpoint 'CHECK ((scope = ANY (ARRAY['\''clients'\''::text, '\''all'\''::text])))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_phase crm_sync_backfill_checkpoint 'CHECK ((phase = ANY (ARRAY['\''clients'\''::text, '\''orders'\''::text, '\''completed'\''::text])))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_scope_phase crm_sync_backfill_checkpoint 'CHECK (((scope = '\''all'\''::text) OR (phase <> '\''orders'\''::text)))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_scope_state crm_sync_backfill_checkpoint 'CHECK (((scope = '\''all'\''::text) OR ((last_order_id IS NULL) AND (processed_orders = 0))))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_phase_state crm_sync_backfill_checkpoint 'CHECK (((phase <> '\''clients'\''::text) OR ((last_order_id IS NULL) AND (processed_orders = 0))))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_client_cursor crm_sync_backfill_checkpoint 'CHECK (((last_client_id IS NULL) OR (last_client_id ~ '\''^[0-9]+$'\''::text)))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_order_cursor crm_sync_backfill_checkpoint 'CHECK (((last_order_id IS NULL) OR (last_order_id ~ '\''^[0-9]+$'\''::text)))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_counts crm_sync_backfill_checkpoint 'CHECK (((processed_clients >= 0) AND (processed_orders >= 0)))')" \
                     "$(q_con_def_on_safe chk_crm_sync_backfill_completed_at crm_sync_backfill_checkpoint 'CHECK (((phase = '\''completed'\''::text) = (completed_at IS NOT NULL)))')" ;;
    087_cnc_telegram_source_created_at*) probe_all "$(q_col cnc_telegram_packets source_created_at)" \
                     "$(q_idx idx_cnc_telegram_packets_workday_source_created)" ;;
    088_cnc_telegram_vector_media*) probe_all "$(q_col cnc_telegram_packets sheet_image_storage_key)" \
                     "$(q_col cnc_telegram_packets sheet_image_content_type)" \
                     "$(q_col cnc_telegram_packets sheet_image_size_bytes)" \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM pg_constraint
                         WHERE conname = 'chk_cnc_telegram_packet_items_source'
                           AND pg_get_constraintdef(oid) LIKE '%vector%'
                      );" \
                     "$(q_idx idx_cnc_telegram_packets_sheet_image_storage_key)" ;;
    089_notification_channels_telegram*) probe_all \
                     "$(q_col notification_rules channels_json)" \
                     "$(q_con chk_notification_rules_channels_nonempty)" \
                     "$(q_tbl notification_channel_bindings)" \
                     "$(q_tbl notification_channel_link_tokens)" \
                     "$(q_tbl notification_channel_deliveries)" \
                     "$(q_tbl telegram_notification_webhook_updates)" \
                     "$(q_col notification_channel_deliveries notification_channel_delivery_id)" \
                     "$(q_col notification_channel_deliveries notification_rule_id)" \
                     "$(q_col notification_channel_deliveries outbox_event_id)" \
                     "$(q_col notification_channel_deliveries user_id)" \
                     "$(q_col notification_channel_deliveries channel)" \
                     "$(q_col notification_channel_deliveries level)" \
                     "$(q_col notification_channel_deliveries title)" \
                     "$(q_col notification_channel_deliveries message)" \
                     "$(q_col notification_channel_deliveries entity_type)" \
                     "$(q_col notification_channel_deliveries entity_id)" \
                     "$(q_col notification_channel_deliveries source_type)" \
                     "$(q_col notification_channel_deliveries source_id)" \
                     "$(q_col notification_channel_deliveries idempotency_key)" \
                     "$(q_col notification_channel_deliveries status)" \
                     "$(q_col notification_channel_deliveries attempts)" \
                     "$(q_col notification_channel_deliveries next_attempt_at)" \
                     "$(q_col notification_channel_deliveries locked_at)" \
                     "$(q_col notification_channel_deliveries locked_by)" \
                     "$(q_col notification_channel_deliveries send_started_at)" \
                     "$(q_col notification_channel_deliveries delivered_at)" \
                     "$(q_col notification_channel_deliveries external_message_id)" \
                     "$(q_col notification_channel_deliveries last_error_code)" \
                     "$(q_col notification_channel_deliveries last_error_message)" \
                     "$(q_col notification_channel_deliveries created_at)" \
                     "$(q_col notification_channel_deliveries updated_at)" \
                     "SELECT count(*) = 13
                        FROM information_schema.columns
                       WHERE table_schema='public'
                         AND table_name='notification_channel_deliveries'
                         AND column_name IN (
                           'notification_channel_delivery_id', 'user_id', 'channel',
                           'level', 'title', 'message', 'source_type', 'idempotency_key',
                           'status', 'attempts', 'next_attempt_at', 'created_at', 'updated_at'
                         )
                         AND is_nullable='NO';" \
                     "$(q_con_on notification_channel_deliveries notification_channel_deliveries_pkey)" \
                     "$(q_con_on notification_channel_deliveries fk_notification_channel_delivery_rule)" \
                     "$(q_con_on notification_channel_deliveries fk_notification_channel_delivery_outbox_event)" \
                     "$(q_con_on notification_channel_deliveries fk_notification_channel_delivery_user)" \
                     "$(q_con_on notification_channel_deliveries uq_notification_channel_delivery_idempotency)" \
                     "$(q_con_on notification_channel_deliveries chk_notification_channel_delivery_channel)" \
                     "$(q_con_on notification_channel_deliveries chk_notification_channel_delivery_level)" \
                     "$(q_con_on notification_channel_deliveries chk_notification_channel_delivery_status)" \
                     "$(q_con_on notification_channel_deliveries chk_notification_channel_delivery_attempts)" \
                     "$(q_idx uq_notification_channel_link_token_active)" \
                     "$(q_idx idx_notification_channel_deliveries_pending)" \
                     "$(q_idx idx_notification_channel_deliveries_processing)" \
                     "$(q_idx idx_notification_channel_deliveries_user)" ;;
    090_user_preferences_ui_variant_default_evolution*) probe_all "$(q_col user_preferences ui_variant)" \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM information_schema.columns
                         WHERE table_schema='public'
                           AND table_name='user_preferences'
                           AND column_name='ui_variant'
                           AND column_default='''evolution''::text'
                      );" ;;
    091_user_preferences_line_air_ui_variants*) probe_all "$(q_col user_preferences ui_variant)" \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM information_schema.columns
                         WHERE table_schema='public'
                           AND table_name='user_preferences'
                           AND column_name='ui_variant'
                           AND column_default='''evolution''::text'
                      );" \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM pg_constraint
                         WHERE conname = 'chk_user_preferences_ui_variant'
                           AND conrelid = 'user_preferences'::regclass
                           AND pg_get_constraintdef(oid) LIKE '%legacy%'
                           AND pg_get_constraintdef(oid) LIKE '%evolution%'
                           AND pg_get_constraintdef(oid) LIKE '%line%'
                           AND pg_get_constraintdef(oid) LIKE '%air%'
                      );" ;;
    092_cut_result_archive_state*) probe_all "$(q_tbl cut_result_archive_state)" \
                     "$(q_con fk_cut_result_archive_state_job)" \
                     "$(q_con chk_cut_result_archive_state_result_no)" ;;
    093_packer_role*) probe_all \
                     "SELECT EXISTS (
                        SELECT 1 FROM public.roles
                         WHERE role_id = 30
                           AND role_code = 'packer'
                           AND is_active = true
                      );" ;;
    144_bitrix24_reverse_sync*) probe_all \
                     "$(q_col crm_sync_mapping source_system)" \
                     "$(q_col crm_sync_mapping last_bitrix_hash)" \
                     "$(q_col crm_sync_mapping last_bitrix_updated_at)" \
                     "$(q_tbl bitrix24_app_installation)" \
                     "$(q_col bitrix24_app_installation access_token_ciphertext)" \
                     "$(q_col bitrix24_app_installation refresh_lock_token)" \
                     "$(q_tbl bitrix24_inbound_event)" \
                     "$(q_col bitrix24_inbound_event lock_token)" \
                     "$(q_tbl bitrix24_reconcile_cursor)" \
                     "$(q_col bitrix24_reconcile_cursor last_bitrix_id)" \
                     "$(q_col bitrix24_reconcile_cursor cycle_id)" \
                     "$(q_col bitrix24_reconcile_cursor next_cycle_at)" \
                     "$(q_tbl bitrix24_remote_state)" \
                     "$(q_col bitrix24_remote_state normalized_hash)" \
                     "$(q_tbl bitrix24_incoming_request)" \
                     "$(q_col bitrix24_incoming_request crm_amount)" \
                     "$(q_col bitrix24_incoming_request linked_order_id)" \
                     "$(q_tbl bitrix24_incoming_request_payment)" \
                     "$(q_col bitrix24_incoming_request_payment erp_order_id)" \
                     "$(q_tbl bitrix24_payment_type_mapping)" \
                     "$(q_tbl bitrix24_outbound_operation)" \
                     "$(q_col bitrix24_outbound_operation expires_at)" \
                     "$(q_con_on crm_sync_mapping chk_crm_sync_mapping_source_system)" \
                     "$(q_con_on bitrix24_inbound_event uq_bitrix24_inbound_event_fingerprint)" \
                     "$(q_con_on bitrix24_inbound_event chk_bitrix24_inbound_event_payload_size)" \
                     "$(q_con_on bitrix24_reconcile_cursor bitrix24_reconcile_cursor_scope_check)" \
                     "$(q_con_on bitrix24_incoming_request_payment chk_bitrix24_request_payment_owner)" \
                     "$(q_idx idx_bitrix24_inbound_event_pending)" \
                     "$(q_idx uq_bitrix24_inbound_event_open_object)" \
                     "$(q_idx idx_bitrix24_incoming_request_state)" \
                     "SELECT to_regprocedure('crm_sync_is_bitrix_inbound()') IS NOT NULL;" ;;
    145_order_kinds_bitrix_crm_requests*) probe_all \
                     "$(q_col orders order_kind)" \
                     "$(q_col orders source_system)" \
                     "$(q_col orders legacy_zero_detail_exempt)" \
                     "$(q_col orders legacy_duplicate_name_exempt)" \
                     "$(q_tbl order_legacy_duplicate_name_registry)" \
                     "$(q_tbl order_legacy_duplicate_name_ledger)" \
                     "$(q_col order_statuses order_status_code)" \
                     "$(q_col users is_service_account)" \
                     "$(q_tbl bitrix24_user_mapping)" \
                     "$(q_tbl order_kind_conversion_command)" \
                     "$(q_col bitrix24_incoming_request counterparty_object_type)" \
                     "$(q_col bitrix24_incoming_request remote_revision)" \
                     "$(q_col bitrix24_incoming_request sync_version)" \
                     "$(q_col bitrix24_incoming_request archived_by_source)" \
                     "$(q_col bitrix24_incoming_request_payment sync_version)" \
                     "$(q_col bitrix24_remote_state is_deleted)" \
                     "$(q_con_on orders chk_orders_kind_source)" \
                     "$(q_con_on orders chk_orders_kind_project)" \
                     "$(q_con_on bitrix24_incoming_request chk_bitrix24_request_state_link)" \
                     "$(q_idx uq_orders_name_production_active)" \
                     "$(q_idx uq_bitrix24_incoming_request_linked_order)" \
                     "$(q_trg trg_bitrix24_user_mapping_reconcile)" \
                     "SELECT to_regprocedure('normalize_order_name(text)') IS NOT NULL;" \
                     "$(q_trg trg_bitrix24_mapped_user_reconcile)" \
                     "$(q_trg ctrg_bitrix24_request_client_mapping)" \
                     "SELECT to_regprocedure('validate_order_kind_aggregate_id(bigint)') IS NOT NULL;" \
                     "SELECT to_regprocedure('validate_bitrix24_incoming_request_link()') IS NOT NULL;" ;;
    094_cnc_telegram_cutting_sequence*) probe_all "$(q_col cnc_telegram_packets cutting_sequence_no)" \
                     "$(q_idx uq_cnc_telegram_packets_cutting_sequence_no)" \
                     "$(q_con chk_cnc_telegram_packets_cutting_sequence_positive)" ;;
    093_packer_role*) probe_all "SELECT EXISTS (
                        SELECT 1
                          FROM public.roles
                         WHERE role_id = 30
                           AND role_code = 'packer'
                           AND role_name = 'Упаковщик'
                           AND is_active IS TRUE
                      );" ;;
    093_cnc_telegram_svg_cut_import*) probe_all "$(q_col cnc_telegram_packets cut_layout_json)" \
                     "$(q_col cnc_telegram_packets svg_cut_job_id)" \
                     "$(q_col cnc_telegram_packets svg_cut_result_id)" \
                     "$(q_col cnc_telegram_packets svg_cut_import_status)" \
                     "$(q_con_on cnc_telegram_packets chk_cnc_telegram_packets_svg_cut_import_status)" \
                     "$(q_con_on cnc_telegram_packets fk_cnc_telegram_packets_svg_cut_job)" \
                     "$(q_con_on cnc_telegram_packets fk_cnc_telegram_packets_svg_cut_result_same_job)" \
                     "$(q_con_on cnc_telegram_packets chk_cnc_telegram_packets_svg_cut_result_requires_job)" \
                     "$(q_idx idx_cnc_telegram_packets_svg_cut_job)" \
                     "$(q_idx idx_cnc_telegram_packets_cut_layout_valid)" ;;
    094_user_preferences_sidebar_menu_order*) probe_all "$(q_col user_preferences sidebar_menu_order)" ;;
    095_bazis_panel_dimensions_rounding*) probe_all "SELECT EXISTS (
                        SELECT 1
                          FROM pg_constraint
                         WHERE conname = 'chk_bazis_panel_dimensions_integer'
                           AND conrelid = 'bazis_nodes'::regclass
                           AND convalidated
                      );" ;;
    096_bazis_cut_document_fields*) probe_all "SELECT
                       col_description('bazis_cut_set_details'::regclass,
                         (SELECT attnum FROM pg_attribute
                          WHERE attrelid='bazis_cut_set_details'::regclass
                            AND attname='source_bazis_project_name'))
                         LIKE 'bazis-cut-document-fields-v2:%';" \
                     "SELECT
                       COALESCE(col_description('bazis_cut_set_details'::regclass,
                         (SELECT attnum FROM pg_attribute
                          WHERE attrelid='bazis_cut_set_details'::regclass
                            AND attname='position')), '')
                         LIKE ANY (ARRAY['bazis-cut-document-fields-v2:%', 'bazis-cut-position-v3:%']);" ;;
    097_order_realtime_invalidation*) probe_all "$(q_tbl order_realtime_stream)" \
                     "$(q_tbl realtime_event_log)" \
                     "$(q_con_hash_on order_realtime_stream_pkey order_realtime_stream 5c77932d9dfbffa547edc0134599bff5)" \
                     "$(q_con_hash_on order_realtime_stream_order_id_fkey order_realtime_stream 194ff749324dcdbff3899d715d005561)" \
                     "$(q_con_hash_on chk_order_realtime_stream_commit_sequence order_realtime_stream 3ef7ee200ff69a3f0320dc922a8f5d07)" \
                     "$(q_con_hash_on chk_order_realtime_stream_detail_status_revision order_realtime_stream e049683d0915ba49b8a54954b76a78a5)" \
                     "$(q_con_hash_on chk_order_realtime_stream_cut_refs_revision order_realtime_stream 52774b3be8f2ba8bf3445059b10111b9)" \
                     "$(q_con_hash_on pk_realtime_event_log realtime_event_log 3e84dec0fbdc6dbdfbb04a9161201a97)" \
                     "$(q_con_hash_on realtime_event_log_order_id_fkey realtime_event_log 194ff749324dcdbff3899d715d005561)" \
                     "$(q_con_hash_on uq_realtime_event_log_source realtime_event_log 48be58aeda25080b496f72c48e9b5bf6)" \
                     "$(q_con_hash_on chk_realtime_event_log_commit_sequence realtime_event_log 8b746f19cb6635aa79787c84223a919b)" \
                     "$(q_con_hash_on chk_realtime_event_log_schema_version realtime_event_log 082bc7d916e4cd09f835790c2342c81f)" \
                     "$(q_con_hash_on chk_realtime_event_log_domains realtime_event_log f143a6a68aca2dfed7baf88e1c3d1f93)" \
                     "$(q_con_hash_on chk_realtime_event_log_domain_revisions realtime_event_log 9edd9a167624f74c4637ddaed6db6bd9)" \
                     "$(q_idx_hash idx_realtime_event_log_created_at bbc642b29444fce67811fe60872a3cd9)" \
                     "$(q_idx_hash idx_realtime_event_log_detail_status_replay 01776c00a1db4f9220379de8576276be)" \
                     "$(q_idx_hash idx_realtime_event_log_cut_refs_replay 2aa58272654629ea30c5e35408af94da)" \
                     "SELECT obj_description('realtime_event_log'::regclass) = 'order-realtime-invalidation-v1';" ;;
    098_order_realtime_producer_bridge*) probe_all "SELECT EXISTS (
                       SELECT 1 FROM app_settings
                       WHERE setting_key = 'order_realtime.writes'
                         AND is_active = true
                         AND value_json ? 'enabled'
                         AND value_json ? 'maxFanoutOrders'
                         AND value_json ? 'maxDetailIds'
                     );" \
                     "SELECT EXISTS (
                       SELECT 1 FROM app_settings
                       WHERE setting_key = 'order_realtime.rollout'
                         AND is_active = true
                         AND value_json ? 'enabled'
                         AND value_json ? 'userIds'
                         AND value_json ? 'rolloutPercent'
                     );" \
                     "SELECT obj_description(
                       'order_realtime_emit_one(bigint,text[],bigint[],text)'::regprocedure,
                       'pg_proc'
                     ) = 'order-realtime-producer-bridge-v1';" \
                     "$(q_fun_hash 'order_realtime_bridge_config()' e01f74bddefb964202c854e017a183cb)" \
                     "$(q_fun_hash 'order_realtime_bridge_enabled_for_fanout(integer)' 31c9de672533a32b0493235924ea8261)" \
                     "$(q_fun_hash 'order_realtime_bridge_max_detail_ids()' d0485616d61b3904e36418387a09f506)" \
                     "$(q_fun_hash 'order_realtime_cut_job_snapshot_visible(bigint,text,text,bigint)' d0bb80f56f3010c62312a66b6a3575d2)" \
                     "$(q_fun_hash 'order_realtime_emit_one(bigint,text[],bigint[],text)' bbf8a2f2fad9cd1483a144244fe9d522)" \
                     "$(q_fun_hash 'order_realtime_lock_cut_roots(bigint[])' 496b5bf6aebf43754456e0ec0dbb47d2)" \
                     "$(q_fun_hash 'order_realtime_order_snapshot_visible(bigint)' a8e335d989b19d0246523aa34fbfc324)" \
                     "$(q_fun_hash 'trg_order_realtime_detail_status_insert()' d3a33ea887a1ef1110ff46eb164773ea)" \
                     "$(q_fun_hash 'trg_order_realtime_detail_status_update()' b7d647c727baa47e28b099f666348392)" \
                     "$(q_fun_hash 'trg_order_realtime_detail_status_delete()' 2f0a2b87d4dc4fcbc12bd772b120d267)" \
                     "$(q_fun_hash 'trg_order_realtime_order_visibility_update()' b8f1151d541def16ed99645dcbd0bd00)" \
                     "$(q_fun_hash 'trg_order_realtime_cut_item_insert()' 7cb9c7c6011f976c0dc6905413dc3d4c)" \
                     "$(q_fun_hash 'trg_order_realtime_cut_item_update()' bdaeb834d7bf4605625a8e1c1a47d31e)" \
                     "$(q_fun_hash 'trg_order_realtime_cut_item_delete()' 6a0779b7b23e5f18b348d32dee71cff4)" \
                     "$(q_fun_hash 'trg_order_realtime_cut_job_update()' a17812b9593da92363ffc4948ad91171)" \
                     "$(q_fun_hash 'trg_order_realtime_cut_archive_insert()' 9affe83ae3c2f3d4a19a76d77af396ec)" \
                     "$(q_fun_hash 'trg_order_realtime_cut_archive_delete()' f967e352db6ced39819e7fbc0a5b9212)" \
                     "$(q_fun_hash 'trg_order_realtime_cut_profile_update()' d5b60c2bc01f2f41cda19353c495d48b)" \
                     "$(q_stmt_trg trg_order_realtime_detail_status_insert order_details trg_order_realtime_detail_status_insert 4 '' new_rows)" \
                     "$(q_stmt_trg trg_order_realtime_detail_status_update order_details trg_order_realtime_detail_status_update 16 old_rows new_rows)" \
                     "$(q_stmt_trg trg_order_realtime_detail_status_delete order_details trg_order_realtime_detail_status_delete 8 old_rows '')" \
                     "$(q_stmt_trg trg_order_realtime_order_visibility_update orders trg_order_realtime_order_visibility_update 16 old_rows new_rows)" \
                     "$(q_stmt_trg trg_order_realtime_cut_item_insert cut_job_item trg_order_realtime_cut_item_insert 4 '' new_rows)" \
                     "$(q_stmt_trg trg_order_realtime_cut_item_update cut_job_item trg_order_realtime_cut_item_update 16 old_rows new_rows)" \
                     "$(q_stmt_trg trg_order_realtime_cut_item_delete cut_job_item trg_order_realtime_cut_item_delete 8 old_rows '')" \
                     "$(q_stmt_trg trg_order_realtime_cut_job_update cut_job trg_order_realtime_cut_job_update 16 old_rows new_rows)" \
                     "$(q_stmt_trg trg_order_realtime_cut_archive_insert cut_result_archive_state trg_order_realtime_cut_archive_insert 4 '' new_rows)" \
                     "$(q_stmt_trg trg_order_realtime_cut_archive_delete cut_result_archive_state trg_order_realtime_cut_archive_delete 8 old_rows '')" \
                     "$(q_stmt_trg trg_order_realtime_cut_profile_update cut_param_profiles trg_order_realtime_cut_profile_update 16 old_rows new_rows)" ;;
    099_bazis_cut_ordinary_erp_positions*) probe_all "SELECT
                       col_description('bazis_cut_set_details'::regclass,
                         (SELECT attnum FROM pg_attribute
                          WHERE attrelid='bazis_cut_set_details'::regclass
                            AND attname='position'))
                         LIKE 'bazis-cut-position-v3:%';" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                       FROM bazis_cut_set_details snapshot
                       JOIN order_details source ON source.detail_id = snapshot.source_order_detail_id
                       WHERE NULLIF(btrim(snapshot.source_order_name), '') IS NOT NULL
                         AND COALESCE(NULLIF(btrim(snapshot.source_bazis_project_name), ''), '') = ''
                         AND COALESCE(NULLIF(btrim(snapshot.source_bazis_order_no), ''), '') = ''
                         AND COALESCE(NULLIF(btrim(snapshot.source_bazis_product_name), ''), '') = ''
                         AND COALESCE(NULLIF(btrim(source.basis_project), ''), '') = ''
                         AND COALESCE(NULLIF(btrim(source.basis_product), ''), '') = ''
                         AND COALESCE(NULLIF(btrim(source.basis_designation), ''), '') = ''
                         AND COALESCE(NULLIF(btrim(source.basis_data), ''), '') = ''
                         AND btrim(snapshot.position) IN ('', '.')
                     );" ;;
    100_bazis_cut_product_bath_export*) probe_all \
                     "$(q_col bazis_cut_set_details source_bath_cut_number)" \
                     "SELECT EXISTS (
                       SELECT 1
                       FROM information_schema.columns
                       WHERE table_schema='public'
                         AND table_name='bazis_cut_set_details'
                         AND column_name='source_bath_cut_number'
                         AND is_nullable='NO'
                         AND column_default IS NOT NULL
                     );" \
                     "SELECT col_description(
                       'bazis_cut_set_details'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='bazis_cut_set_details'::regclass
                          AND attname='source_bath_cut_number')
                     ) LIKE 'bazis-cut-bath-number-v1:%';" ;;
    101_export_templates*) probe_all \
                     "$(q_tbl export_templates)" \
                     "$(q_col export_templates schema_version)" \
                     "$(q_con_on export_templates chk_export_templates_target_source)" \
                     "$(q_con_on export_templates chk_export_templates_default_active)" \
                     "$(q_idx uq_export_templates_code)" \
                     "$(q_idx uq_export_templates_live_name)" \
                     "$(q_idx uq_export_templates_active_default)" \
                     "$(q_idx idx_export_templates_runtime)" ;;
    102_bazis_project_design_engineer*) probe_all \
                     "$(q_col bazis_projects design_engineer_id)" \
                     "$(q_col bazis_projects design_engineer_xml_name)" \
                     "$(q_col bazis_projects design_engineer_source)" \
                     "$(q_con_on bazis_projects chk_bazis_projects_design_engineer_source)" \
                     "$(q_idx bazis_projects_design_engineer_idx)" \
                     "SELECT EXISTS (
                       SELECT 1
                       FROM pg_constraint
                       WHERE conrelid = 'public.bazis_projects'::regclass
                         AND contype = 'f'
                         AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (design_engineer_id) REFERENCES employees(employee_id)%ON DELETE SET NULL%'
                     );" ;;
    103_bazis_cut_position_sources*) probe_all \
                     "SELECT COALESCE(col_description(
                       'bazis_cut_set_details'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='bazis_cut_set_details'::regclass
                          AND attname='position')
                     ) LIKE 'bazis-cut-position-v4:%', false)
                     OR col_description(
                       'bazis_cut_set_details'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='bazis_cut_set_details'::regclass
                          AND attname='position')
                     ) = 'ERP Basis designation when basis_project is filled; otherwise ERP detail_number; manual snapshot edits are preserved by migration 107';" ;;
    104_bazis_order_detail_product_mapping*) probe_all \
                     "SELECT col_description(
                       'order_details'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='order_details'::regclass
                          AND attname='basis_product')
                     ) = 'Basis product name from the panel-level Product column; NULL when Product exists only in the project summary';" ;;
    104_bazis_panel_order_links*) probe_all \
                     "$(q_col bazis_node_order_detail_map import_source)" \
                     "$(q_col bazis_node_order_detail_map imported_by)" \
                     "$(q_col bazis_node_order_detail_map request_id)" \
                     "$(q_con_hash_on bazis_node_order_detail_map_mapping_kind_check bazis_node_order_detail_map e972b603d9254aa8bdaed8dd0d485166)" \
                     "$(q_con_hash_on bazis_node_order_detail_map_imported_provenance_check bazis_node_order_detail_map 628f04bad23b7d05e30440ec0b12f5f0)" \
                     "$(q_idx bazis_node_map_import_source_idx)" \
                     "SELECT COALESCE((
                       SELECT (
                         md5(pg_get_functiondef(oid)) = '14cfb20b020779a070e7ee2ba070ba0d'
                         AND obj_description(oid, 'pg_proc') = 'v104 exact current-revision Basis PDF detail to Bazis panel reconciliation'
                       ) OR (
                         md5(pg_get_functiondef(oid)) = 'd4f7e31052321242dfea61056bae41e7'
                         AND obj_description(oid, 'pg_proc') = 'v109 exact current-revision panel reconciliation with one-product NULL product support'
                       )
                       FROM pg_proc
                       WHERE oid = to_regprocedure('reconcile_bazis_panel_order_links(bigint,bigint[],text,bigint,text)')
                     ), false);" ;;
    105_bazis_order_detail_product_link_fallback*) probe_all "SELECT NOT EXISTS (
                       WITH revision_products AS (
                         SELECT revision.bazis_revision_id AS revision_id,
                                COUNT(root_product.bazis_node_id)::int AS root_product_count,
                                MIN(NULLIF(btrim(root_product.raw_json->>'Заказ'), '')) AS root_order_no
                         FROM bazis_project_revisions revision
                         LEFT JOIN bazis_nodes root_product
                           ON root_product.revision_id = revision.bazis_revision_id
                          AND root_product.parent_node_id IS NULL
                          AND root_product.node_kind = 'product'
                         GROUP BY revision.bazis_revision_id
                       )
                       SELECT 1
                       FROM bazis_order_links link
                       JOIN bazis_project_revisions revision
                         ON revision.bazis_revision_id = link.revision_id
                       JOIN bazis_projects project
                         ON project.bazis_project_id = link.bazis_project_id
                       JOIN revision_products products
                         ON products.revision_id = link.revision_id
                       JOIN bazis_node_order_detail_map map
                         ON map.order_id = link.order_id
                        AND map.mapping_kind IN ('created', 'imported')
                       JOIN bazis_nodes panel
                         ON panel.bazis_node_id = map.node_id
                        AND panel.revision_id = link.revision_id
                        AND panel.object_type = 'Панель'
                       JOIN order_details detail
                         ON detail.order_id = link.order_id
                        AND (
                          map.order_detail_id = detail.detail_id
                          OR (
                            map.order_detail_id IS NULL
                            AND btrim(COALESCE(detail.basis_data, '')) = CONCAT(
                              COALESCE(panel.position, ''), '/',
                              COALESCE(panel.designation, ''), '/',
                              COALESCE(panel.name, '')
                            )
                            AND btrim(COALESCE(panel.designation, '')) =
                                btrim(COALESCE(detail.basis_designation, ''))
                          )
                        )
                       WHERE products.root_product_count <= 1
                         AND NULLIF(btrim(detail.basis_product), '') IS NOT NULL
                         AND btrim(COALESCE(detail.basis_project, '')) = COALESCE(
                           products.root_order_no,
                           NULLIF(btrim(revision.bazis_order_no), ''),
                           btrim(project.name)
                         )
                     );" ;;
    106_user_preferences_tablet_mode*) probe_all "$(q_col user_preferences tablet_mode)" ;;
    107_bazis_cut_erp_identity*) probe_all "SELECT col_description(
                       'bazis_cut_set_details'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='bazis_cut_set_details'::regclass
                          AND attname='position')
                     ) = 'ERP Basis designation when basis_project is filled; otherwise ERP detail_number; manual snapshot edits are preserved by migration 107';" ;;
    107_cnc_telegram_worker_audit*) probe_all \
                     "$(q_colset_hash cnc_telegram_worker_scans 'scan_id,source_chat_id,workday,status,started_at,finished_at,session_user_id,day_yielded_count,day_exhausted,day_truncated,day_error_code,reply_search_yielded_count,reply_search_exhausted,reply_search_truncated,reply_search_error_code,svg_count,processed_count,ingested_count,skipped_count,failed_count,parser_version,worker_version,can_write_chat,error_code,error_message,writer_user_id,created_at,updated_at' 93fcf901a0f61b530dda86ed932a153d)" \
                     "$(q_colset_hash cnc_telegram_worker_message_logs 'log_id,log_key,raw_source_digest,sanitizer_version,source_chat_id,source_message_id,source_thread_id,reply_to_message_id,sender_user_id,source_created_at,source_edited_at,workday,message_type,filename,mime_type,message_text,outgoing,status,reason_code,reason_message,error_code,error_message,related_source_message_id,external_packet_key,source_version,packet_id,cut_job_id,cut_result_no,cutting_sequence_no,backend_applied,backend_stale,ever_ingested,first_observed_at,last_observed_at,last_decision_at,last_scan_id,observed_count,attempt_count,created_at,updated_at' 0c9340f3c3b800a68c4119d19b46d181)" \
                     "$(q_colset_hash cnc_telegram_worker_operations 'operation_id,operation_key,scan_id,log_id,operation_type,status,planned_at,finished_at,reason_code,reason_message,error_code,error_message,external_packet_key,source_version,packet_id,cut_job_id,cut_result_no,cutting_sequence_no,backend_applied,backend_stale,reply_text,reply_to_message_id,session_sender_user_id,sent_telegram_message_id,reconciliation_yielded_count,reconciliation_exhausted,reconciliation_truncated,reconciliation_error_code,reconciliation_window_from,reconciliation_window_to,steps_json,responses_json,created_at,updated_at' 460b3edcaee829bdfa87ba1564512179)" \
                     "$(q_colset_hash cnc_telegram_worker_message_observations 'observation_id,scan_id,log_id,operation_id,source_chat_id,source_message_id,observed_at,read_source,read_ordinal,classification_code,decision_code,related_source_message_id' fcb74f33a29709c731b85a97c1653ff7)" \
                     "$(q_conset_hash cnc_telegram_worker_scans 'chk_cnc_tg_worker_scan_counts,chk_cnc_tg_worker_scan_error_lengths,chk_cnc_tg_worker_scan_status,cnc_telegram_worker_scans_pkey,cnc_telegram_worker_scans_writer_user_id_fkey' a38fdc32909e327b4d72f8976fb55197)" \
                     "$(q_conset_hash cnc_telegram_worker_message_logs 'chk_cnc_tg_worker_message_bounds,chk_cnc_tg_worker_message_status,chk_cnc_tg_worker_message_type,cnc_telegram_worker_message_logs_last_scan_id_fkey,cnc_telegram_worker_message_logs_log_key_key,cnc_telegram_worker_message_logs_pkey' 470479b7b1483448760f303f90139aac)" \
                     "$(q_conset_hash cnc_telegram_worker_operations 'chk_cnc_tg_worker_operation_arrays,chk_cnc_tg_worker_operation_bounds,chk_cnc_tg_worker_operation_status,chk_cnc_tg_worker_operation_type,cnc_telegram_worker_operations_log_id_fkey,cnc_telegram_worker_operations_operation_key_key,cnc_telegram_worker_operations_pkey,cnc_telegram_worker_operations_scan_id_fkey' bd78095c69dbabacb354db12160f82a1)" \
                     "$(q_conset_hash cnc_telegram_worker_message_observations 'chk_cnc_tg_worker_observation_ordinal,chk_cnc_tg_worker_observation_owner,chk_cnc_tg_worker_observation_source,cnc_telegram_worker_message_observations_log_id_fkey,cnc_telegram_worker_message_observations_operation_id_fkey,cnc_telegram_worker_message_observations_pkey,cnc_telegram_worker_message_observations_scan_id_fkey' c1187695840e3dea969d2a91292f4459)" \
                     "$(q_idxset_hash cnc_telegram_worker_scans 'cnc_telegram_worker_scans_pkey,idx_cnc_tg_worker_scans_started,idx_cnc_tg_worker_scans_status_started' 30c7dde7036a5db58f8801eb18dd8561)" \
                     "$(q_idxset_hash cnc_telegram_worker_message_logs 'cnc_telegram_worker_message_logs_log_key_key,cnc_telegram_worker_message_logs_pkey,idx_cnc_tg_worker_messages_reason,idx_cnc_tg_worker_messages_search,idx_cnc_tg_worker_messages_source,idx_cnc_tg_worker_messages_status,idx_cnc_tg_worker_messages_type,idx_cnc_tg_worker_messages_workday' b89261e2356a3cd1967d5c07e9b34ceb)" \
                     "$(q_idxset_hash cnc_telegram_worker_operations 'cnc_telegram_worker_operations_operation_key_key,cnc_telegram_worker_operations_pkey,idx_cnc_tg_worker_operations_log,idx_cnc_tg_worker_operations_scan,idx_cnc_tg_worker_operations_type_status' 6e836ddb93d11c98f68670a6152b1f97)" \
                     "$(q_idxset_hash cnc_telegram_worker_message_observations 'cnc_telegram_worker_message_observations_pkey,idx_cnc_tg_worker_observations_log,idx_cnc_tg_worker_observations_scan,uq_cnc_tg_worker_observation_operation_ordinal,uq_cnc_tg_worker_observation_scan_ordinal' 0a32f1eea571da3ee5b7e372e0f9ce00)" ;;
    108_cnc_telegram_worker_audit_reason_codes*) probe_all \
                     "$(q_fun_hash 'cnc_telegram_worker_reason_code_valid(text)' bb6b155edab4b6ebcc5545fe2b9ab3bc)" \
                     "$(q_con_hash_on chk_cnc_tg_worker_scan_reason_codes cnc_telegram_worker_scans c2b3deed5b285a3ddd0dcc481617f104)" \
                     "$(q_con_hash_on chk_cnc_tg_worker_message_reason_codes cnc_telegram_worker_message_logs 522f7d03cbabbfdca19e57af30c1a84e)" \
                     "$(q_con_hash_on chk_cnc_tg_worker_operation_reason_codes cnc_telegram_worker_operations c403770f0b23cad6082202420969102c)" \
                     "$(q_con_hash_on chk_cnc_tg_worker_observation_reason_codes cnc_telegram_worker_message_observations edb8109e18cd30146d4ab50cb75b151a)" ;;
    109_cnc_telegram_worker_audit_classification_codes*) probe_all \
                     "$(q_con_hash_on chk_cnc_tg_worker_observation_classification_code cnc_telegram_worker_message_observations d00cffd4b59ca731fd8c92aaa5e23409)" ;;
    109_bazis_single_product_reprojection*) probe_all \
                     "$(q_fun_hash 'reconcile_bazis_panel_order_links(bigint,bigint[],text,bigint,text)' d4f7e31052321242dfea61056bae41e7)" \
                     "SELECT obj_description(
                       'reconcile_bazis_panel_order_links(bigint,bigint[],text,bigint,text)'::regprocedure,
                       'pg_proc'
                     ) = 'v109 exact current-revision panel reconciliation with one-product NULL product support';" ;;
    110_cnc_telegram_label_maps*) probe_all \
                     "$(q_tbl cnc_telegram_packet_evidence_set)" \
                     "$(q_tbl cnc_telegram_packet_item_evidence)" \
                     "$(q_tbl cnc_telegram_label_sheet_map)" \
                     "$(q_tbl cnc_telegram_label_placement)" \
                     "$(q_tbl label_generation_media_asset)" \
                     "$(q_tbl label_generation_telegram_source)" \
                     "$(q_con_on cnc_telegram_packet_evidence_set pk_cnc_telegram_packet_evidence_set)" \
                     "$(q_con_on cnc_telegram_packet_item_evidence fk_cnc_telegram_packet_item_evidence_set)" \
                     "$(q_con_on cnc_telegram_label_sheet_map uq_cnc_telegram_label_sheet_map_identity)" \
                     "$(q_con_on cnc_telegram_label_sheet_map fk_cnc_telegram_label_sheet_map_evidence)" \
                     "$(q_con_on cnc_telegram_label_placement uq_cnc_telegram_label_placement_identity)" \
                     "$(q_con_on label_generation_media_asset chk_label_generation_media_asset_bytes)" \
                     "$(q_con_on label_generation_telegram_source chk_label_generation_telegram_source_variant)" \
                     "$(q_con_on label_generation_telegram_source fk_label_generation_telegram_source_media)" \
                     "$(q_con_on label_generation_telegram_source fk_label_generation_telegram_source_sheet)" \
                     "$(q_con_on label_generation_telegram_source fk_label_generation_telegram_source_placement)" \
                     "$(q_idx idx_cnc_telegram_packet_item_evidence_detail)" \
                     "$(q_idx idx_cnc_telegram_label_sheet_map_packet_current)" \
                     "$(q_idx idx_cnc_telegram_label_placement_detail)" \
                     "$(q_idx idx_label_generation_telegram_source_packet)" \
                     "$(q_trg trg_cnc_telegram_packet_evidence_set_immutable)" \
                     "$(q_trg trg_cnc_telegram_packet_item_evidence_immutable)" \
                     "$(q_trg trg_cnc_telegram_label_sheet_map_immutable)" \
                     "$(q_trg trg_cnc_telegram_label_placement_immutable)" \
                     "$(q_trg trg_label_generation_media_asset_immutable)" \
                     "$(q_trg trg_label_generation_telegram_source_immutable)" \
                     "$(q_trg trg_label_generation_cut_placement_immutable)" \
                     "$(q_trg trg_label_generation_cut_source_exclusive_cut)" \
                     "$(q_trg trg_label_generation_cut_source_exclusive_telegram)" \
                     "SELECT to_regprocedure('reject_cnc_telegram_label_immutable_mutation()') IS NOT NULL;" \
                     "SELECT to_regprocedure('guard_label_generation_cut_source_exclusive()') IS NOT NULL;" ;;
    111_cnc_telegram_media_restore*) probe_all \
                     "$(q_tbl cnc_telegram_media_restore_requests)" \
                     "$(q_col cnc_telegram_media_restore_requests restore_request_id)" \
                     "$(q_col cnc_telegram_media_restore_requests packet_id)" \
                     "$(q_col cnc_telegram_media_restore_requests requested_by)" \
                     "$(q_col cnc_telegram_media_restore_requests request_trace_id)" \
                     "$(q_col cnc_telegram_media_restore_requests status)" \
                     "$(q_col cnc_telegram_media_restore_requests attempt_count)" \
                     "$(q_col cnc_telegram_media_restore_requests requested_at)" \
                     "$(q_col cnc_telegram_media_restore_requests claimed_at)" \
                     "$(q_col cnc_telegram_media_restore_requests finished_at)" \
                     "$(q_col cnc_telegram_media_restore_requests available_until)" \
                     "$(q_col cnc_telegram_media_restore_requests last_error)" \
                     "$(q_col cnc_telegram_media_restore_requests updated_at)" \
                     "$(q_con_on cnc_telegram_media_restore_requests cnc_telegram_media_restore_requests_pkey)" \
                     "$(q_con_on cnc_telegram_media_restore_requests cnc_telegram_media_restore_requests_packet_id_fkey)" \
                     "$(q_con_on cnc_telegram_media_restore_requests cnc_telegram_media_restore_requests_requested_by_fkey)" \
                     "$(q_con_on cnc_telegram_media_restore_requests chk_cnc_telegram_media_restore_status)" \
                     "$(q_con_on cnc_telegram_media_restore_requests chk_cnc_telegram_media_restore_attempts)" \
                     "$(q_con_on cnc_telegram_media_restore_requests chk_cnc_telegram_media_restore_error)" \
                     "$(q_con_on cnc_telegram_media_restore_requests chk_cnc_telegram_media_restore_state)" \
                     "$(q_idx uq_cnc_telegram_media_restore_active_packet)" \
                     "$(q_idx idx_cnc_telegram_media_restore_claim)" \
                     "$(q_idx idx_cnc_telegram_media_restore_packet_history)" ;;
    112_cut_job_rotation_allowed*) probe_all \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM information_schema.columns
                         WHERE table_schema = 'public'
                           AND table_name = 'cut_job'
                           AND column_name = 'rotation_allowed'
                           AND data_type = 'boolean'
                           AND is_nullable = 'NO'
                           AND column_default = 'true'
                      );" ;;
    113_cut_job_texture_direction*) probe_all \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM information_schema.columns
                         WHERE table_schema = 'public'
                           AND table_name = 'cut_job'
                           AND column_name = 'texture_direction'
                           AND data_type = 'text'
                           AND is_nullable = 'NO'
                           AND column_default = '''none''::text'
                      );" \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM pg_constraint
                         WHERE conname = 'cut_job_texture_direction_check'
                           AND conrelid = 'public.cut_job'::regclass
                           AND convalidated
                           AND pg_get_constraintdef(oid) LIKE '%texture_direction%'
                           AND pg_get_constraintdef(oid) LIKE '%vertical%'
                           AND pg_get_constraintdef(oid) LIKE '%horizontal%'
                           AND pg_get_constraintdef(oid) LIKE '%none%'
                      );" ;;
    114_production_status_always_from_details*) probe_all \
                     "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='recalc_order_production_status' AND prosrc LIKE '%erp.order_status_to_details_sync%' AND prosrc NOT LIKE '%v_enabled%');" \
                     "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='trg_orders_sync_details_status' AND prosrc LIKE '%erp.detail_status_to_order_recalc%' AND prosrc NOT LIKE '%NEW.production_status_from_details_enabled%');" ;;
    114_cnc_manual_svg_comment_presets*) probe_all \
                     "$(q_tbl cnc_manual_svg_comment_presets)" \
                     "$(q_con_on cnc_manual_svg_comment_presets cnc_manual_svg_comment_presets_pkey)" \
                     "$(q_con_on cnc_manual_svg_comment_presets chk_cnc_manual_svg_comment_presets_label)" \
                     "$(q_con_on cnc_manual_svg_comment_presets chk_cnc_manual_svg_comment_presets_comment)" \
                     "$(q_con_on cnc_manual_svg_comment_presets chk_cnc_manual_svg_comment_presets_category)" \
                     "$(q_idx uq_cnc_manual_svg_comment_presets_active_text)" \
                     "$(q_idx idx_cnc_manual_svg_comment_presets_active_order)" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM cnc_manual_svg_comment_presets
                        WHERE label = 'Весь заказ'
                          AND comment_text = 'весь заказ'
                          AND category = 'order'
                     );" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM cnc_manual_svg_comment_presets
                        WHERE label = 'Переделка'
                          AND comment_text = 'переделка'
                          AND category = 'rework'
                     );" ;;
    115_cnc_telegram_packet_mdf_board_hidden*) probe_all \
                     "$(q_col cnc_telegram_packets mdf_board_hidden_at)" \
                     "$(q_col cnc_telegram_packets mdf_board_hidden_by)" \
                     "$(q_col cnc_telegram_packets mdf_board_hidden_reason)" \
                     "$(q_col cnc_telegram_packets mdf_board_hidden_cut_job_id)" \
                     "$(q_idx idx_cnc_telegram_packets_mdf_visible_workday)" \
                     "$(q_idx idx_cnc_telegram_packets_mdf_hidden_cut_job)" ;;
    115_vacuum_cut_numbering*) probe_all \
                     "$(q_col bazis_cut_set_details source_bath_cut_number)" \
                     "SELECT col_description(
                       'bazis_cut_set_details'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='bazis_cut_set_details'::regclass
                          AND attname='source_bath_cut_number')
                     ) LIKE 'bazis-cut-bath-number-v2:%';" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                       FROM bazis_cut_set_details
                       WHERE source_bath_cut_number ~ '^[0-9]+-[0-9]+$'
                     );" ;;
    116_telegram_svg_cut_job_display_number*) probe_all \
                     "$(q_col cut_job source_display_number)" \
                     "SELECT col_description(
                       'cut_job'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='cut_job'::regclass
                          AND attname='source_display_number')
                     ) LIKE 'Operator-facing cut job number from the source system;%';" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                       FROM cnc_telegram_packets packet
                       JOIN cut_job job
                         ON job.cut_job_id = packet.svg_cut_job_id
                       WHERE packet.svg_cut_job_id IS NOT NULL
                         AND packet.svg_cut_result_id IS NOT NULL
                         AND packet.svg_cut_import_status = 'imported'
                         AND packet.cutting_sequence_no IS NOT NULL
                         AND packet.cut_layout_json->>'status' = 'valid'
                         AND job.source = 'api'
                         AND job.selection_criteria->>'source' = 'cnc_telegram_svg'
                         AND job.source_display_number IS DISTINCT FROM packet.cutting_sequence_no::text
                     );" ;;
    117_dedupe_telegram_svg_image_packets*) probe_true "SELECT NOT EXISTS (
                       WITH imported AS (
                         SELECT
                           packet.packet_id,
                           packet.source_chat_id,
                           COALESCE(packet.source_created_at, packet.source_updated_at, packet.created_at) AS source_at,
                           packet.workday,
                           regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\.[^.]+$', '') AS program_key,
                           lower(trim(COALESCE(packet.material_name, 'МДФ 16мм'))) AS material_key,
                           packet.cut_layout_json,
                           packet.sheet_image_storage_key,
                           packet.cutting_sequence_no,
                           item_signature.detail_signature
                         FROM cnc_telegram_packets packet
                         JOIN cut_job job
                           ON job.cut_job_id = packet.svg_cut_job_id
                         LEFT JOIN LATERAL (
                           SELECT string_agg(
                             cji.order_detail_id::text || ':' || cji.order_id::text || ':' || cji.qty::text,
                             ',' ORDER BY cji.order_detail_id, cji.order_id, cji.qty
                           ) AS detail_signature
                           FROM cut_job_item cji
                           WHERE cji.cut_job_id = packet.svg_cut_job_id
                         ) item_signature ON TRUE
                         WHERE packet.svg_cut_import_status = 'imported'
                           AND packet.svg_cut_job_id IS NOT NULL
                           AND packet.svg_cut_result_id IS NOT NULL
                           AND packet.cutting_sequence_no IS NOT NULL
                           AND packet.cut_layout_json->>'status' = 'valid'
                           AND job.source = 'api'
                           AND job.selection_criteria->>'source' = 'cnc_telegram_svg'
                           AND regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\.[^.]+$', '') <> ''
                       )
                       SELECT 1
                       FROM imported canonical
                       JOIN imported duplicate
                         ON duplicate.packet_id <> canonical.packet_id
                        AND duplicate.source_chat_id = canonical.source_chat_id
                        AND duplicate.workday = canonical.workday
                        AND duplicate.program_key = canonical.program_key
                        AND duplicate.material_key = canonical.material_key
                        AND duplicate.cut_layout_json = canonical.cut_layout_json
                        AND duplicate.detail_signature IS NOT DISTINCT FROM canonical.detail_signature
                       WHERE canonical.sheet_image_storage_key IS NULL
                         AND duplicate.sheet_image_storage_key IS NOT NULL
                         AND canonical.cutting_sequence_no IS NOT NULL
                         AND duplicate.cutting_sequence_no IS NOT NULL
                         AND canonical.cutting_sequence_no < duplicate.cutting_sequence_no
                       LIMIT 1
                     );" ;;
    117_mdf_board_manual_moves*) probe_all \
                     "$(q_tbl mdf_board_manual_moves)" \
                     "$(q_col mdf_board_manual_moves move_id)" \
                     "$(q_col mdf_board_manual_moves card_kind)" \
                     "$(q_col mdf_board_manual_moves card_id)" \
                     "$(q_col mdf_board_manual_moves target_column)" \
                     "$(q_col mdf_board_manual_moves version)" \
                     "$(q_col mdf_board_manual_moves created_by_user_id)" \
                     "$(q_col mdf_board_manual_moves updated_by_user_id)" \
                     "$(q_col mdf_board_manual_moves created_at)" \
                     "$(q_col mdf_board_manual_moves updated_at)" \
                     "$(q_con_on mdf_board_manual_moves mdf_board_manual_moves_pkey)" \
                     "$(q_con_on mdf_board_manual_moves uq_mdf_board_manual_moves_card)" \
                     "$(q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_card_kind)" \
                     "$(q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_card_id)" \
                     "$(q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_target_column)" \
                     "$(q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_kind_target)" \
                     "$(q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_version)" \
                     "$(q_idx idx_mdf_board_manual_moves_lookup)" \
                     "$(q_idx idx_mdf_board_manual_moves_updated)" \
                     "SELECT obj_description('mdf_board_manual_moves'::regclass) LIKE 'mdf-board-manual-moves-v1:%';" ;;
    118_mdf_board_completed_baths_terminal*) probe_all \
                     "$(q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_target_column)" \
                     "$(q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_kind_target)" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM pg_constraint
                        WHERE conname = 'chk_mdf_board_manual_moves_target_column'
                          AND conrelid = 'public.mdf_board_manual_moves'::regclass
                          AND pg_get_constraintdef(oid) LIKE '%completed_baths%'
                     );" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM pg_constraint
                        WHERE conname = 'chk_mdf_board_manual_moves_kind_target'
                          AND conrelid = 'public.mdf_board_manual_moves'::regclass
                          AND pg_get_constraintdef(oid) LIKE '%completed_baths%'
                     );" \
                     "SELECT COALESCE((
                       SELECT obj_description(oid, 'pg_constraint') LIKE 'mdf-board-manual-moves-v2:%'
                         FROM pg_constraint
                        WHERE conname = 'chk_mdf_board_manual_moves_target_column'
                          AND conrelid = 'public.mdf_board_manual_moves'::regclass
	                       ), false);" ;;
    133_cut_job_split_display_numbers*) probe_all \
                     "$(q_idx uq_cut_job_source_display_number)" \
                     "SELECT col_description(
                       'cut_job'::regclass,
                       (SELECT attnum FROM pg_attribute
                        WHERE attrelid='cut_job'::regclass
                          AND attname='source_display_number')
                     ) LIKE 'Operator-facing cut job number. Regular jobs use numeric text;%';" \
                     "SELECT NOT EXISTS (
                       SELECT 1
                       FROM cut_job j
                       LEFT JOIN cut_param_profiles profile
                         ON profile.cut_param_profile_id = j.param_profile_id
                       WHERE NULLIF(btrim(j.source_display_number), '') ~ '^[0-9]+$'
                         AND (
                           profile.params->>'layout_mode' = 'vacuum_table'
                           OR j.last_calc_params->>'layout_mode' = 'vacuum_table'
                           OR EXISTS (
                             SELECT 1
                             FROM cut_group g
                             WHERE g.cut_job_id = j.cut_job_id
                               AND (
                                 g.summary->>'engine_used' = 'vacuum_table'
                                 OR g.summary->>'layout_mode' = 'vacuum_table'
                               )
                           )
                         )
                     );" ;;
    119_cnc_manual_svg_comment_presets*) probe_all \
                     "$(q_tbl cnc_manual_svg_comment_presets)" \
                     "$(q_con_on cnc_manual_svg_comment_presets cnc_manual_svg_comment_presets_pkey)" \
                     "$(q_con_on cnc_manual_svg_comment_presets chk_cnc_manual_svg_comment_presets_label)" \
                     "$(q_con_on cnc_manual_svg_comment_presets chk_cnc_manual_svg_comment_presets_comment)" \
                     "$(q_con_on cnc_manual_svg_comment_presets chk_cnc_manual_svg_comment_presets_category)" \
                     "$(q_idx uq_cnc_manual_svg_comment_presets_active_text)" \
                     "$(q_idx idx_cnc_manual_svg_comment_presets_active_order)" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM cnc_manual_svg_comment_presets
                        WHERE label = 'Весь заказ'
                          AND comment_text = 'весь заказ'
                          AND category = 'order'
                     );" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM cnc_manual_svg_comment_presets
                        WHERE label = 'Переделка'
                          AND comment_text = 'переделка'
                          AND category = 'rework'
                     );" ;;
    120_cnc_manual_svg_comment_preset_seed*) probe_all \
                     "$(q_tbl cnc_manual_svg_comment_presets)" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM cnc_manual_svg_comment_presets
                        WHERE lower(trim(comment_text)) = lower('Фрезы для ХДФ: 8')
                          AND category = 'tool'
                     );" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM cnc_manual_svg_comment_presets
                        WHERE lower(trim(comment_text)) = lower('Черновой с двух сторон!!!')
                          AND category = 'general'
                     );" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM cnc_manual_svg_comment_presets
                        WHERE lower(trim(comment_text)) = lower('Фреза для ламинированной стороны:')
                         AND category = 'tool'
                     );" ;;
    121_cut_result_informational_snapshots*) probe_all \
                     "SELECT pg_get_functiondef('cut_result_expected_manifest(jsonb)'::regprocedure)
                              LIKE '%piece_rows AS%'
                         AND pg_get_functiondef('cut_result_expected_manifest(jsonb)'::regprocedure)
                              LIKE '%count(DISTINCT item_id)%';" \
                     "SELECT pg_get_functiondef('cut_result_snapshot_is_complete(jsonb,jsonb,text)'::regprocedure)
                              LIKE '%informational_snapshot := item_count = 0%'
                         AND pg_get_functiondef('cut_result_snapshot_is_complete(jsonb,jsonb,text)'::regprocedure)
                              LIKE '%max_instance <> instances%'
                         AND pg_get_functiondef('cut_result_snapshot_is_complete(jsonb,jsonb,text)'::regprocedure)
                              LIKE '%label,detailId%';" ;;
    122_cut_result_informational_label_maps*) probe_all \
                     "SELECT COALESCE((
                        SELECT attnotnull = false
                          FROM pg_attribute
                         WHERE attrelid = 'public.cut_result_placement'::regclass
                           AND attname = 'order_detail_id'
                           AND NOT attisdropped
                     ), false);" \
                     "SELECT pg_get_functiondef('project_cut_result_label_maps(bigint)'::regprocedure)
                              LIKE '%informational_snapshot := jsonb_array_length%'
                         AND pg_get_functiondef('project_cut_result_label_maps(bigint)'::regprocedure)
                              LIKE '%piece_json #> ''{label,orderId}''%'
                         AND pg_get_functiondef('project_cut_result_label_maps(bigint)'::regprocedure)
                              LIKE '%has unknown order for item%';" ;;
    123_doweling_orders_view_active_flag*) probe_all \
                     "SELECT EXISTS (
                        SELECT 1
                          FROM information_schema.columns
                         WHERE table_schema = 'public'
                           AND table_name = 'doweling_orders_view'
                           AND column_name = 'delete_flag'
                     );" \
                     "SELECT pg_get_viewdef('public.doweling_orders_view'::regclass)
                              LIKE '%odl.delete_flag = false%'
                         AND pg_get_viewdef('public.doweling_orders_view'::regclass)
                              NOT LIKE '%WHERE d.delete_flag = false%';" ;;
    124_cnc_manual_svg_telegram_files*) probe_all \
                     "$(q_tbl cnc_manual_svg_upload_files)" \
                     "$(q_tbl cnc_manual_svg_upload_file_orders)" \
                     "$(q_tbl cnc_manual_svg_telegram_send_requests)" \
                     "$(q_tbl cnc_manual_svg_telegram_send_request_files)" \
                     "$(q_con_on cnc_manual_svg_upload_files chk_cnc_manual_svg_upload_files_kind)" \
                     "$(q_con_on cnc_manual_svg_upload_files chk_cnc_manual_svg_upload_files_size)" \
                     "$(q_con_on cnc_manual_svg_upload_files chk_cnc_manual_svg_upload_files_ttl)" \
                     "$(q_con_on cnc_manual_svg_telegram_send_requests chk_cnc_manual_svg_telegram_send_status)" \
                     "$(q_con_on cnc_manual_svg_telegram_send_requests chk_cnc_manual_svg_telegram_send_idempotency_key)" \
                     "$(q_idx uq_cnc_manual_svg_upload_files_packet_kind)" \
                     "$(q_idx idx_cnc_manual_svg_upload_files_expires)" \
                     "$(q_idx idx_cnc_manual_svg_upload_file_orders_order)" \
                     "$(q_idx uq_cnc_manual_svg_telegram_send_idempotency_key)" \
                     "$(q_idx uq_cnc_manual_svg_telegram_send_active_packet)" \
                     "$(q_idx idx_cnc_manual_svg_telegram_send_claim)" ;;
    124_roles_matrix*) probe_all \
                     "$(q_tbl permissions_catalog)" \
                     "$(q_tbl role_permissions)" \
                     "$(q_tbl role_policy_scopes)" \
                     "$(q_tbl permissions_state)" \
                     "$(q_col permissions_catalog permission_name)" \
                     "$(q_col permissions_catalog is_dangerous)" \
                     "$(q_col role_permissions is_enabled)" \
                     "$(q_col role_policy_scopes scope_value)" \
                     "$(q_col permissions_state version)" \
                     "$(q_con_on role_permissions role_permissions_role_id_fkey)" \
                     "$(q_con_on role_permissions role_permissions_permission_name_fkey)" \
                     "$(q_con_on role_policy_scopes role_policy_scopes_role_id_fkey)" \
                     "$(q_con_on role_policy_scopes role_policy_scopes_scope_value_check)" \
                     "$(q_con_on permissions_state permissions_state_singleton)" \
                     "$(q_con_on permissions_state permissions_state_positive_version)" \
                     "$(q_idx idx_role_permissions_permission_enabled)" \
                     "$(q_idx idx_role_policy_scopes_key_value)" \
                     "SELECT EXISTS (SELECT 1 FROM permissions_state WHERE id = true AND version >= 1);" ;;
    125_order_hdf_details*) probe_all \
                     "$(q_col app_settings version)" \
                     "$(q_col milling_types hdf_enabled)" \
                     "$(q_col milling_types hdf_edge_mm)" \
                     "$(q_col orders hdf_min_threshold_mm)" \
                     "$(q_tbl hdf_calculation_config_state)" \
                     "$(q_tbl order_hdf_details)" \
                     "$(q_col cut_job_item source_type)" \
                     "$(q_col cut_job_item order_hdf_detail_id)" \
                     "$(q_con_on cut_job_item chk_cut_job_item_source_exactly_one)" \
                     "$(q_idx uq_cut_job_item_active_hdf_detail)" \
                     "$(q_col bazis_cut_set_details source_type)" \
                     "$(q_col bazis_cut_set_details source_order_hdf_detail_id)" \
                     "$(q_con_on bazis_cut_set_details chk_bazis_cut_set_details_hdf_source_exclusive)" \
                     "$(q_idx uq_bazis_cut_set_details_hdf_source)" \
                     "$(q_col order_realtime_stream hdf_details_revision)" \
                     "$(q_col order_realtime_stream materials_revision)" \
                     "$(q_col realtime_event_log hdf_details_revision)" \
                     "$(q_col realtime_event_log materials_revision)" \
                     "SELECT count(*) = 2
                        FROM app_settings
                       WHERE setting_key IN (
                         'production.hdf.min_side_threshold_mm',
                         'production.hdf.sheet_material_type_id'
                       );" \
                     "SELECT pg_get_functiondef('recalc_order_production_status(bigint)'::regprocedure)
                              LIKE '%order_hdf_details%'
                          OR obj_description('recalc_order_production_status(bigint)'::regprocedure)
                              LIKE 'v142:%';" ;;
    126_workos_user_controls*) probe_all \
                     "$(q_col users workos_self_link_enabled)" \
                     "$(q_col users workos_self_unlink_enabled)" \
                     "$(q_tbl workos_link_invitations)" \
                     "$(q_col workos_link_invitations invitation_id)" \
                     "$(q_col workos_link_invitations target_user_id)" \
                     "$(q_col workos_link_invitations created_by_user_id)" \
                     "$(q_col workos_link_invitations token_hash)" \
                     "$(q_col workos_link_invitations expires_at)" \
                     "$(q_col workos_link_invitations consumed_at)" \
                     "$(q_col workos_link_invitations revoked_at)" \
                     "$(q_con ck_workos_link_invitations_token_hash)" \
                     "$(q_con ck_workos_link_invitations_expiry)" \
                     "$(q_idx idx_workos_link_invitations_target)" \
                     "$(q_idx idx_workos_link_invitations_active)" ;;
    127_milling_extra_resources*) probe_all \
                     "$(q_tbl milling_type_extra_resources)" \
                     "$(q_col milling_type_extra_resources milling_type_extra_resource_id)" \
                     "$(q_col milling_type_extra_resources milling_type_id)" \
                     "$(q_col milling_type_extra_resources resource_kind)" \
                     "$(q_col milling_type_extra_resources resource_name)" \
                     "$(q_col milling_type_extra_resources unit_id)" \
                     "$(q_col milling_type_extra_resources accounting_method)" \
                     "$(q_col milling_type_extra_resources parameter_name)" \
                     "$(q_col milling_type_extra_resources parameter_mm)" \
                     "$(q_col milling_type_extra_resources hdf_auto_enabled)" \
                     "$(q_col milling_type_extra_resources is_active)" \
                     "$(q_col milling_type_extra_resources version)" \
                     "$(q_idx idx_milling_type_extra_resources_milling)" \
                     "$(q_idx idx_milling_type_extra_resources_hdf_auto)" ;;
    127_milling_type_min_dimensions*) probe_all \
                     "$(q_col milling_types min_width_mm)" \
                     "$(q_col milling_types min_height_mm)" \
                     "$(q_con_on milling_types chk_milling_types_min_width_mm)" \
                     "$(q_con_on milling_types chk_milling_types_min_height_mm)" ;;
    128_order_detail_hdf_parameter_override*) probe_all \
                     "$(q_col order_details hdf_parameter_override_mm)" \
                     "$(q_con_on order_details chk_order_details_hdf_parameter_override_mm)" ;;
    129_cut_render_styles*) probe_all \
                     "SELECT EXISTS (SELECT 1 FROM cut_settings WHERE key = 'render.styles'
                                      AND value->>'version' = '1'
                                      AND value->'profiles' ? 'mdf_board_preview');" ;;
    130_cut_render_style_legibility*) probe_all \
                     "SELECT EXISTS (SELECT 1 FROM cut_settings WHERE key = 'render.styles'
                                      AND value #>> '{profiles,mdf_board_preview,sourceSvg,strokeColorMode}' = 'piece-pastel'
                                      AND (value #>> '{profiles,mdf_board_preview,sourceSvg,minStrokePx}')::numeric = 1.6
                                      AND (value #>> '{profiles,mdf_board_preview,piece,strokeWidthMm}')::numeric = 1.6
                                      AND value #>> '{profiles,mdf_board_preview,label,darkTextStroke}' = '#ffffff'
                                      AND (value #>> '{profiles,mdf_board_preview,label,fontWeight}')::int = 800);" ;;
    131_cut_render_style_templates*) probe_all \
                     "SELECT EXISTS (SELECT 1 FROM cut_settings WHERE key = 'render.styles'
                                      AND value->>'defaultProfileId' = 'mdf_board_preview'
                                      AND jsonb_typeof(value->'templates') = 'array'
                                      AND jsonb_array_length(value->'templates') > 0
                                      AND value->'templates'->0->>'id' = 'mdf_board_preview'
                                      AND jsonb_typeof(value->'templates'->0->'profile') = 'object');" ;;
    132_user_preferences_sidebar_collapsed*) probe_all "$(q_col user_preferences sidebar_collapsed)" ;;
    129_extra_resources_directory*) probe_all \
                     "$(q_tbl extra_resources)" \
                     "$(q_col extra_resources extra_resource_id)" \
                     "$(q_col extra_resources resource_kind)" \
                     "$(q_col extra_resources resource_name)" \
                     "$(q_col extra_resources unit_id)" \
                     "$(q_col extra_resources accounting_method)" \
                     "$(q_col extra_resources default_parameter_name)" \
                     "$(q_col extra_resources default_parameter_mm)" \
                     "$(q_col extra_resources hdf_auto_default)" \
                     "$(q_col extra_resources is_active)" \
                     "$(q_col extra_resources version)" \
                     "$(q_col milling_type_extra_resources extra_resource_id)" \
                     "$(q_idx uq_extra_resources_active_kind_name)" \
                     "$(q_idx idx_milling_type_extra_resources_extra_resource)" ;;
    134_cnc_telegram_worker_technical_logs*) probe_all \
                     "$(q_tbl cnc_telegram_worker_technical_logs)" \
                     "$(q_col cnc_telegram_worker_technical_logs worker_instance_id)" \
                     "$(q_col cnc_telegram_worker_technical_logs sequence)" \
                     "$(q_col cnc_telegram_worker_technical_logs observed_at)" \
                     "$(q_col cnc_telegram_worker_technical_logs stream)" \
                     "$(q_col cnc_telegram_worker_technical_logs message)" \
                     "$(q_col cnc_telegram_worker_technical_logs redaction_categories)" \
                     "$(q_con_on cnc_telegram_worker_technical_logs uq_cnc_tg_technical_instance_sequence)" \
                     "$(q_con_on cnc_telegram_worker_technical_logs chk_cnc_tg_technical_stream)" \
                     "$(q_con_on cnc_telegram_worker_technical_logs chk_cnc_tg_technical_message)" \
                     "$(q_idx idx_cnc_tg_technical_observed)" \
                     "$(q_idx idx_cnc_tg_technical_instance_observed)" \
                     "$(q_idx idx_cnc_tg_technical_stream_observed)" \
                     "SELECT EXISTS (SELECT 1 FROM permissions_catalog WHERE permission_name='audit.technical.view' AND is_active=true AND is_dangerous=true);" ;;
    134_status_automation_mapping_actions*) probe_all \
                     "$(q_col status_automation_rules action_config_json)" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM information_schema.columns
                        WHERE table_schema='public'
                          AND table_name='status_automation_rules'
                          AND column_name='target_status_id'
                          AND is_nullable='YES'
                     );" \
                     "SELECT EXISTS (
                       SELECT 1
                         FROM pg_constraint
                        WHERE conname='status_automation_rules_action_type_check'
                          AND conrelid='public.status_automation_rules'::regclass
                          AND pg_get_constraintdef(oid) LIKE '%map_order_status_to_details_production_status%'
                          AND pg_get_constraintdef(oid) LIKE '%map_production_status_to_order_status%'
                     );" ;;
    135_cnc_telegram_worker_session_leases*) probe_all \
                     "$(q_tbl cnc_telegram_worker_session_leases)" \
                     "$(q_col cnc_telegram_worker_session_leases lease_token)" \
                     "$(q_col cnc_telegram_worker_session_leases lease_generation)" \
                     "$(q_col cnc_telegram_worker_session_leases worker_instance_id)" \
                     "$(q_col cnc_telegram_worker_session_leases worker_image_revision)" \
                     "$(q_col cnc_telegram_worker_session_leases heartbeat_at)" \
                     "$(q_col cnc_telegram_worker_session_leases expires_at)" \
                     "$(q_con_on cnc_telegram_worker_session_leases chk_cnc_tg_session_lease_expiry)" \
                     "$(q_idx idx_cnc_tg_session_leases_expiry)" \
                     "$(q_col cnc_telegram_media_restore_requests lease_token)" \
                     "$(q_col cnc_telegram_media_restore_requests lease_generation)" \
                     "$(q_col cnc_telegram_media_restore_requests lease_worker_instance_id)" \
                     "$(q_col cnc_telegram_media_restore_requests lease_expires_at)" \
                     "$(q_con_on cnc_telegram_media_restore_requests chk_cnc_tg_restore_item_lease_shape)" \
                     "$(q_idx idx_cnc_tg_restore_item_lease_expiry)" \
                     "$(q_col cnc_manual_svg_telegram_send_requests lease_token)" \
                     "$(q_col cnc_manual_svg_telegram_send_requests lease_generation)" \
                     "$(q_col cnc_manual_svg_telegram_send_requests lease_worker_instance_id)" \
                     "$(q_col cnc_manual_svg_telegram_send_requests lease_expires_at)" \
                     "$(q_con_on cnc_manual_svg_telegram_send_requests chk_cnc_tg_send_item_lease_shape)" \
                     "$(q_idx idx_cnc_tg_send_item_lease_expiry)" ;;
    136_cnc_telegram_manual_import*) probe_all \
                     "$(q_tbl cnc_telegram_import_scans)" \
                     "$(q_tbl cnc_telegram_import_candidates)" \
                     "$(q_tbl cnc_telegram_import_candidate_matches)" \
                     "$(q_tbl cnc_telegram_import_requests)" \
                     "$(q_tbl cnc_telegram_import_items)" \
                     "$(q_con_on cnc_telegram_import_scans chk_cnc_tg_import_scan_range)" \
                     "$(q_con_on cnc_telegram_import_items chk_cnc_tg_import_item_lease)" \
                     "$(q_idx uq_cnc_tg_import_request_active_selection)" \
                     "$(q_idx idx_cnc_tg_import_item_claim)" \
                     "SELECT EXISTS (SELECT 1 FROM permissions_catalog WHERE permission_name='cnc.telegram_import.manage_all' AND is_active=true);" ;;
    137_cnc_telegram_import_scan_messages*) probe_all \
                     "$(q_tbl cnc_telegram_import_scan_messages)" \
                     "$(q_con_on cnc_telegram_import_scan_messages chk_cnc_tg_import_scan_message_bounds)" \
                     "$(q_con_on cnc_telegram_import_scan_messages chk_cnc_tg_import_scan_message_role)" \
                     "$(q_idx idx_cnc_tg_import_scan_message_chronological)" \
                     "$(q_idx idx_cnc_tg_import_scan_message_ordinal)" ;;
    138_cnc_mdf_card_kinds*) probe_all \
                     "$(q_col cnc_telegram_packets mdf_board_card_kind)" \
                     "$(q_con_on cnc_telegram_packets chk_cnc_telegram_packets_mdf_board_card_kind)" \
                     "$(q_idx idx_cnc_telegram_packets_cut_job_card_kind)" \
                     "$(q_idx idx_cnc_telegram_packet_items_unmatched_order_key)" \
                     "$(q_tbl cnc_telegram_packet_whole_order_keys)" \
                     "$(q_con_on cnc_telegram_packet_whole_order_keys cnc_telegram_packet_whole_order_keys_pkey)" \
                     "$(q_idx idx_cnc_telegram_packet_whole_order_keys_order)" ;;
    139_cnc_mdf_original_board_indexes*) probe_all \
                     "$(q_idx idx_cnc_telegram_packets_mdf_original_created)" \
                     "$(q_idx idx_cut_result_original_board_created_job)" ;;
    139_vacuum_cut_number_legacy_floor*) probe_all \
                     "SELECT NOT EXISTS (
                       WITH boundary AS (
                         SELECT applied_at
                         FROM schema_migrations
                         WHERE filename = '133_cut_job_split_display_numbers.sql'
                       ),
                       vacuum_jobs AS (
                         SELECT j.cut_job_id, j.created_at, j.source_display_number
                         FROM cut_job j
                         LEFT JOIN cut_param_profiles profile
                           ON profile.cut_param_profile_id = j.param_profile_id
                         WHERE profile.params->>'layout_mode' = 'vacuum_table'
                            OR j.last_calc_params->>'layout_mode' = 'vacuum_table'
                            OR EXISTS (
                              SELECT 1 FROM cut_group g
                              WHERE g.cut_job_id = j.cut_job_id
                                AND (g.summary->>'engine_used' = 'vacuum_table'
                                  OR g.summary->>'layout_mode' = 'vacuum_table')
                            )
                       ),
                       legacy_floor AS (
                         SELECT COALESCE(MAX(j.cut_job_id), 0) AS value
                         FROM vacuum_jobs j CROSS JOIN boundary b
                         WHERE j.created_at < b.applied_at
                       )
                       SELECT 1
                       FROM vacuum_jobs j
                       CROSS JOIN boundary b
                       CROSS JOIN legacy_floor floor
                       WHERE (j.created_at < b.applied_at
                              AND j.source_display_number IS DISTINCT FROM 'В-' || j.cut_job_id::text)
                          OR (j.created_at >= b.applied_at
                              AND (COALESCE(j.source_display_number, '') !~ '^В-[0-9]+$'
                                   OR substring(j.source_display_number FROM 3)::integer <= floor.value))
                     );" ;;
    140_cnc_telegram_worker_operation_display_number*) probe_all \
                     "$(q_col cnc_telegram_worker_operations cut_job_display_number)" \
                     "$(q_con_on cnc_telegram_worker_operations chk_cnc_tg_worker_operation_display_number)" ;;
    141_mdf_board_history*) probe_all \
                     "$(q_tbl mdf_board_history_events)" \
                     "$(q_tbl mdf_board_history_state)" \
                     "$(q_tbl mdf_board_history_coverage)" \
                     "$(q_con_on mdf_board_history_events mdf_board_history_events_pkey)" \
                     "$(q_con_on mdf_board_history_events mdf_board_history_events_event_key_key)" \
                     "$(q_con_on mdf_board_history_events chk_mdf_history_subject_kind)" \
                     "$(q_con_on mdf_board_history_events chk_mdf_history_event_kind)" \
                     "$(q_con_on mdf_board_history_events chk_mdf_history_provenance)" \
                     "$(q_idx idx_mdf_board_history_order_time)" \
                     "$(q_idx idx_mdf_board_history_subject)" \
                     "$(q_idx idx_mdf_board_history_correlation)" \
                     "$(q_idx idx_mdf_board_history_state_subject)" \
                     "$(q_trg trg_record_mdf_board_history_from_audit)" \
                     "$(q_trg trg_record_mdf_board_history_from_audit_relation)" \
                     "$(q_trg trg_mdf_board_history_events_append_only)" \
                     "SELECT to_regprocedure('record_mdf_board_history_from_audit()') IS NOT NULL;" \
                     "SELECT to_regprocedure('record_mdf_board_history_from_audit_relation()') IS NOT NULL;" \
                     "SELECT obj_description('mdf_board_history_events'::regclass) LIKE 'mdf-board-history-v1:%';" ;;
    142_order_production_status_exclude_hdf*) probe_all \
                     "SELECT obj_description('recalc_order_production_status(bigint)'::regprocedure) LIKE 'v142:%';" \
                     "SELECT pg_get_functiondef('recalc_order_production_status(bigint)'::regprocedure)
                              LIKE '%FROM order_details od%'
                         AND pg_get_functiondef('recalc_order_production_status(bigint)'::regprocedure)
                              NOT LIKE '%order_hdf_details%'
                         AND pg_get_functiondef('recalc_order_production_status(bigint)'::regprocedure)
                              LIKE '%erp.order_status_to_details_sync%'
                         AND pg_get_functiondef('recalc_order_production_status(bigint)'::regprocedure)
                              LIKE '%erp.detail_status_to_order_recalc%';" \
                     "SELECT NOT EXISTS (
                        SELECT 1
                        FROM orders o
                        JOIN LATERAL (
                          SELECT ps.production_status_id
                          FROM order_details od
                          JOIN production_statuses ps
                            ON ps.production_status_id = od.production_status_id
                          WHERE od.order_id = o.order_id
                            AND COALESCE(od.delete_flag, false) = false
                            AND od.production_status_id IS NOT NULL
                          ORDER BY ps.sort_order ASC, ps.production_status_id ASC
                          LIMIT 1
                        ) expected ON true
                        WHERE COALESCE(o.delete_flag, false) = false
                          AND o.production_status_id IS DISTINCT FROM expected.production_status_id
                     );" \
                     "SELECT NOT EXISTS (
                        SELECT 1
                        FROM production_statuses
                        GROUP BY lower(btrim(production_status_name))
                        HAVING count(DISTINCT production_status_code) > 1
                     );" ;;
    143_cnc_telegram_manual_send_routing*) probe_all \
                     "$(q_col cnc_manual_svg_telegram_send_requests destination_chat_id)" \
                     "$(q_con_on cnc_manual_svg_telegram_send_requests chk_cnc_manual_svg_telegram_destination_chat)" \
                     "$(q_idx idx_cnc_manual_svg_telegram_send_destination_claim)" \
                     "$(q_col cnc_telegram_worker_session_leases can_send_manual_svg_uploads)" \
                     "$(q_col cnc_telegram_worker_session_leases manual_svg_send_poll_interval_seconds)" \
                     "$(q_con_on cnc_telegram_worker_session_leases chk_cnc_tg_session_runtime_evidence)" ;;
    146_order_delete_role_scopes*) probe_all \
                     "SELECT EXISTS (
                        SELECT 1
                        FROM role_permissions rp
                        JOIN roles r ON r.role_id = rp.role_id
                        WHERE r.role_code = 'top_manager'
                          AND rp.permission_name = 'orders.delete'
                          AND rp.is_enabled = true
                     );" \
                     "SELECT EXISTS (
                        SELECT 1
                        FROM role_permissions rp
                        JOIN roles r ON r.role_id = rp.role_id
                        WHERE r.role_code = 'manager'
                          AND rp.permission_name = 'orders.delete'
                          AND rp.is_enabled = true
                     );" \
                     "SELECT EXISTS (
                        SELECT 1
                        FROM role_policy_scopes rps
                        JOIN roles r ON r.role_id = rps.role_id
                        WHERE r.role_code = 'top_manager'
                          AND rps.scope_key = 'orders.delete'
                          AND rps.scope_value = 'all'
                     );" \
                     "SELECT EXISTS (
                        SELECT 1
                        FROM role_policy_scopes rps
                        JOIN roles r ON r.role_id = rps.role_id
                        WHERE r.role_code = 'manager'
                          AND rps.scope_key = 'orders.delete'
                          AND rps.scope_value = 'own'
                     );" ;;
    147_bitrix24_payment_widget*) probe_all \
                     "$(q_col bitrix24_app_installation executor_bitrix_user_id)" \
                     "$(q_col bitrix24_app_installation executor_is_admin)" \
                     "$(q_con_on bitrix24_app_installation chk_bitrix24_installation_executor_user)" \
                     "$(q_tbl bitrix24_app_install_attempt)" \
                     "$(q_tbl bitrix24_widget_session)" \
                     "$(q_tbl bitrix24_manual_payment_command)" \
                     "$(q_tbl bitrix24_pay_system_catalog)" \
                     "$(q_con_on bitrix24_manual_payment_command uq_bitrix24_manual_payment_idempotency)" \
                     "$(q_con_on bitrix24_manual_payment_command chk_bitrix24_manual_payment_owner)" \
                     "$(q_con_on bitrix24_manual_payment_command chk_bitrix24_manual_payment_overpayment_confirmation)" \
                     "$(q_idx uq_bitrix24_manual_payment_remote_create)" \
                     "$(q_col bitrix24_incoming_request_payment payment_local_date)" \
                     "$(q_col bitrix24_incoming_request_payment manual_command_id)" \
                     "$(q_con_on bitrix24_incoming_request_payment fk_bitrix24_request_payment_manual_command)" \
                     "$(q_idx uq_bitrix24_request_payment_manual_command)" \
                     "$(q_col bitrix24_payment_type_mapping widget_enabled)" \
                     "$(q_col bitrix24_payment_type_mapping is_default)" \
                     "$(q_idx uq_bitrix24_payment_type_mapping_widget_default)" \
                     "SELECT count(*) = 2 FROM permissions_catalog WHERE permission_name IN ('bitrix24.payments.create','bitrix24.payments.confirm_overpayment');" ;;
    147_mdf_order_status_detail_cascade*) probe_true \
                     "SELECT obj_description(to_regclass('public.status_automation_rules')) =
                       'Status automation rules; MDF order lifecycle cascade installed by migration 147';" ;;
    148_cut_job_number_reuse*) probe_all \
                     "$(q_col cnc_telegram_import_items requested_cut_job_id)" \
                     "$(q_con_on cnc_telegram_import_items chk_cnc_tg_import_requested_number)" \
                     "SELECT EXISTS (
                       SELECT 1 FROM pg_index i
                       WHERE i.indexrelid = to_regclass('public.uq_cut_job_source_display_number')
                         AND i.indisunique AND i.indisvalid
                         AND pg_get_expr(i.indpred, i.indrelid) =
                           '((status <> ''archived''::text) AND (NULLIF(btrim(source_display_number), ''''::text) IS NOT NULL))'
                         AND pg_get_expr(i.indexprs, i.indrelid) =
                           'NULLIF(btrim(source_display_number), ''''::text)'
                     );" ;;
    149_cut_result_board_projection*) probe_all \
                     "$(q_col cut_result_board_projection snapshot_digest)" \
                     "$(q_col cut_result_board_projection is_vacuum)" \
                     "$(q_col cut_result_board_projection cut_job_name)" \
                     "$(q_col cut_result_board_projection result_created_at)" \
                     "SELECT to_regprocedure('public.project_cut_result_board_metadata(bigint)') IS NOT NULL;" \
                     "SELECT to_regprocedure('public.cut_result_snapshot_is_vacuum(jsonb)') IS NOT NULL;" \
                     "SELECT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('public.idx_cut_result_board_vacuum_created') AND indisvalid);" \
                     "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.cut_result') AND tgname = 'trg_cut_result_board_projection' AND tgenabled = 'O');" \
                     "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.cut_result_board_projection') AND tgname = 'trg_cut_result_board_projection_guard' AND tgenabled = 'O');" ;;
    150_cut_result_board_projection_backfill*) probe_true "SELECT NOT EXISTS (
                     SELECT 1 FROM cut_result r
                     LEFT JOIN cut_result_board_projection p USING (cut_result_id)
                     WHERE p.cut_result_id IS NULL OR p.snapshot_digest IS DISTINCT FROM r.snapshot_digest
                        OR p.result_created_at IS DISTINCT FROM r.created_at
                        OR p.is_vacuum IS DISTINCT FROM cut_result_snapshot_is_vacuum(r.snapshot_job)
                        OR p.cut_job_name IS DISTINCT FROM r.snapshot_job ->> 'name'
                     );" ;;
    156_bitrix24_authorship*) probe_all "$(q_col bitrix24_incoming_request_payment paid_by_id)" "$(q_col bitrix24_incoming_request_payment paid_by_name)" "$(q_col bitrix24_manual_payment_command bitrix_actor_name)" ;;
    157_products_services_catalog*) probe_all "$(q_col catalog_items base_price)" "$(q_col catalog_items version)" "$(q_col catalog_items currency)" \
      "$(q_col catalog_items created_by)" "$(q_col catalog_items edited_by)" "$(q_col catalog_item_commands response_json)" \
      "$(q_col catalog_item_commands request_hash)" "$(q_col catalog_item_commands actor_user_id)" \
      "$(q_idx catalog_items_sku_unique)" "$(q_idx catalog_items_list_idx)" \
      "$(q_con catalog_items_unit_id_fkey)" "$(q_con catalog_items_kind_check)" "$(q_con catalog_items_currency_check)" \
      "$(q_con catalog_items_base_price_check)" "$(q_con catalog_item_commands_pkey)" ;;
    160_cad_editor_workflow*) probe_all "$(q_tbl cad_export_reviews)" "$(q_tbl cad_approval_commands)" "$(q_col cad_export_reviews acknowledged_at)" "$(q_col cad_approval_commands receipt)" ;;
    161_catalog_reference_service_fields*) probe_all "$(q_col catalog_items ref_key_1c)" "$(q_col catalog_items sort_order)" "$(q_idx catalog_items_sort_idx)" "$(q_idx catalog_items_ref_key_1c_unique)" ;;
    163_mdf_production_return*) probe_all "$(q_col cnc_telegram_packets mdf_completion_returned)" ;;
    162_order_catalog_lines*) probe_all "$(q_tbl order_catalog_lines)" \
      "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.order_catalog_lines') AND attname='amount' AND attgenerated='s');" \
      "SELECT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.order_catalog_lines_order_idx') AND indisvalid);" \
      "$(q_con_on order_catalog_lines order_catalog_lines_order_id_fkey)" \
      "$(q_con_on order_catalog_lines order_catalog_lines_catalog_item_id_fkey)" \
      "$(q_con_on order_catalog_lines order_catalog_lines_unit_id_fkey)" \
      "$(q_con_on order_catalog_lines order_catalog_lines_created_by_fkey)" \
      "$(q_con_on order_catalog_lines order_catalog_lines_edited_by_fkey)" \
      "$(q_con_on order_catalog_lines order_catalog_lines_quantity_check)" \
      "$(q_con_on order_catalog_lines order_catalog_lines_unit_price_check)" \
      "$(q_con_on order_catalog_lines order_catalog_lines_kind_check)" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.order_catalog_lines') AND tgname='ctrg_order_catalog_lines_kind_aggregate' AND tgenabled='O' AND tgdeferrable AND tginitdeferred);" \
      "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.validate_order_kind_aggregate_id(bigint)') AND position('order_catalog_lines' in prosrc)>0 AND position('FOR UPDATE' in prosrc)>0);" ;;
    154_svg_source_instance_sequences*) probe_all "SELECT position('svg_source_instance_sequence_v1' in pg_get_functiondef('cut_result_snapshot_is_complete(jsonb,jsonb,text)'::regprocedure)) > 0;" ;;
    155_order_production_composition*) probe_all \
                     "$(q_col orders production_detail_count)" \
                     "$(q_col orders_view production_unassigned_count)" \
                     "SELECT obj_description('recalc_order_production_status(bigint)'::regprocedure) LIKE 'v155:%';" ;;
    153_svg_partial_label_maps*) probe_all \
                     "$(q_con chk_cut_result_placement_source_only_order)" \
                     "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.cut_result_placement'::regclass AND attname='order_id' AND attnotnull=false);" ;;
    151_cad_workspaces*) probe_all \
                     "$(q_col cad_workspaces order_id)" \
                     "$(q_col cad_sources data)" \
                     "$(q_col cad_variants revision)" \
                     "$(q_col cad_variant_revisions data)" \
                     "$(q_col cad_recipe_mappings recipe)" \
                     "$(q_col cad_commands access_order_ids)" \
                     "$(q_col cad_runs package_actor)" \
                     "$(q_col cad_runs package_request_id)" \
                     "$(q_col cad_events audit_id)" \
                     "$(q_col cad_event_sources detail_id)" \
                     "SELECT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.cad_one_original') AND indisunique AND indisvalid);" \
                     "SELECT count(*)=3 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND
                       (tgrelid=to_regclass('public.cad_sources') AND tgname='cad_sources_immutable'
                        OR tgrelid=to_regclass('public.cad_variant_revisions') AND tgname='cad_revisions_immutable'
                       OR tgrelid=to_regclass('public.cad_variants') AND tgname='cad_original_immutable');" ;;
    152_whatsapp_admin*) probe_all \
                     "$(q_col whatsapp_message_templates template_id)" \
                     "$(q_col whatsapp_keyword_rules keywords)" \
                     "$(q_col whatsapp_webhook_events external_event_id)" \
                     "$(q_col whatsapp_delivery_jobs lock_token)" \
                     "SELECT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.whatsapp_delivery_jobs_claim_idx') AND indisvalid);" \
                     "SELECT count(*)=2 FROM permissions_catalog WHERE permission_name IN ('whatsapp.view','whatsapp.manage') AND is_active;" ;;
    # 164-169: PostgreSQL 16 fingerprints derived from the actual SQL in a
    # disposable database. Pin only migration-owned objects, not mutable runtime
    # values (enabled/mode/revision). New additive columns/constraints remain allowed.
    # Keep these probes and the real-PostgreSQL regression test in sync.
    164_unicode_business_names*) probe_all \
      "$(q_tbl projects)" \
      "$(q_con_hash_on chk_projects_code projects 87ffc4764527f15006178543a6b9c578)" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.projects') AND conname='chk_projects_code' AND convalidated);" \
      "$(q_tbl group_groups)" \
      "$(q_con_hash_on chk_group_groups_code_format group_groups 07744ab3851eef752ac32def384dee66)" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.group_groups') AND conname='chk_group_groups_code_format' AND convalidated);" \
      "$(q_tbl cnc_telegram_packet_whole_order_keys)" \
      "$(q_con_hash_on cnc_telegram_packet_whole_order_keys_order_key_check cnc_telegram_packet_whole_order_keys f321a543db86f38590f86e4d19956491)" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.cnc_telegram_packet_whole_order_keys') AND conname='cnc_telegram_packet_whole_order_keys_order_key_check' AND convalidated);" ;;
    165_mdf_engine_foundation*) probe_all \
      "$(q_tbl mdf_engine_state)" \
      "$(q_colset_hash mdf_engine_state singleton,mode,published_revision,updated_at 3351be2122967ff57258484929535b32)" \
      "$(q_conset_hash mdf_engine_state mdf_engine_state_mode_check,mdf_engine_state_pkey,mdf_engine_state_published_revision_check,mdf_engine_state_singleton_check 370a0310fb34e9754cc2e78c9f759c48)" \
      "$(q_idxset_hash mdf_engine_state mdf_engine_state_pkey faf1299cb88e62ceeaa800ca1bd73f90)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_engine_state') AND conname=ANY(string_to_array('mdf_engine_state_mode_check,mdf_engine_state_pkey,mdf_engine_state_published_revision_check,mdf_engine_state_singleton_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_engine_state') AND indexrelid::regclass::text=ANY(string_to_array('mdf_engine_state_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_evidence_revisions)" \
      "$(q_colset_hash mdf_evidence_revisions source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key,created_at 2756535717dc500e744466b436cefca9)" \
      "$(q_conset_hash mdf_evidence_revisions mdf_evidence_revisions_cause_key_check,mdf_evidence_revisions_origin_check,mdf_evidence_revisions_payload_digest_check,mdf_evidence_revisions_pkey,mdf_evidence_revisions_request_id_check,mdf_evidence_revisions_revision_key_check,mdf_evidence_revisions_source_id_check,mdf_evidence_revisions_source_kind_check aa851e6d7696157951527a3d39815b4b)" \
      "$(q_idxset_hash mdf_evidence_revisions mdf_evidence_revisions_pkey eb1dace4a1ac05ab6cf8ace31988e6d2)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_evidence_revisions') AND conname=ANY(string_to_array('mdf_evidence_revisions_cause_key_check,mdf_evidence_revisions_origin_check,mdf_evidence_revisions_payload_digest_check,mdf_evidence_revisions_pkey,mdf_evidence_revisions_request_id_check,mdf_evidence_revisions_revision_key_check,mdf_evidence_revisions_source_id_check,mdf_evidence_revisions_source_kind_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_evidence_revisions') AND indexrelid::regclass::text=ANY(string_to_array('mdf_evidence_revisions_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_revision_seals)" \
      "$(q_colset_hash mdf_revision_seals source_kind,source_id,revision_key,sealed_at 74bef53014efde2fd9928d60a5464dca)" \
      "$(q_conset_hash mdf_revision_seals mdf_revision_seals_pkey,mdf_revision_seals_source_kind_source_id_revision_key_fkey 9d0f34ff234c6732fc9bac130b0ae78b)" \
      "$(q_idxset_hash mdf_revision_seals mdf_revision_seals_pkey e91f7fd8383b5644973a3a3515dd5b0d)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_revision_seals') AND conname=ANY(string_to_array('mdf_revision_seals_pkey,mdf_revision_seals_source_kind_source_id_revision_key_fkey',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_revision_seals') AND indexrelid::regclass::text=ANY(string_to_array('mdf_revision_seals_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_source_heads)" \
      "$(q_colset_hash mdf_source_heads source_kind,source_id,received_revision_key,accepted_revision_key,correction_epoch,version,updated_at 7f515f65ed086aca98a19e4cc42c2933)" \
      "$(q_conset_hash mdf_source_heads mdf_source_heads_correction_epoch_check,mdf_source_heads_pkey,mdf_source_heads_source_kind_source_id_accepted_revision_k_fkey,mdf_source_heads_source_kind_source_id_received_revision_k_fkey,mdf_source_heads_version_check 82235e455cfa10b584d702511b3f7f1b)" \
      "$(q_idxset_hash mdf_source_heads mdf_source_heads_pkey 15ac5b1cb9b58a3a5ecdc430fdfbc214)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_source_heads') AND conname=ANY(string_to_array('mdf_source_heads_correction_epoch_check,mdf_source_heads_pkey,mdf_source_heads_source_kind_source_id_accepted_revision_k_fkey,mdf_source_heads_source_kind_source_id_received_revision_k_fkey,mdf_source_heads_version_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_source_heads') AND indexrelid::regclass::text=ANY(string_to_array('mdf_source_heads_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_evidence_lines)" \
      "$(q_colset_hash mdf_evidence_lines evidence_line_id,source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework,created_at 56ea1f2fbd6af9a8741d1f00d9b23cb7)" \
      "$(q_conset_hash mdf_evidence_lines mdf_evidence_lines_detail_id_check,mdf_evidence_lines_evidence_kind_check,mdf_evidence_lines_evidence_line_id_order_id_detail_id_key,mdf_evidence_lines_line_key_check,mdf_evidence_lines_order_id_check,mdf_evidence_lines_pkey,mdf_evidence_lines_quantity_check,mdf_evidence_lines_source_kind_source_id_revision_key_fkey,mdf_evidence_lines_source_kind_source_id_revision_key_line__key,mdf_evidence_lines_stage_code_check e59a64567956902b99c67c505d32389a)" \
      "$(q_idxset_hash mdf_evidence_lines idx_mdf_evidence_position,mdf_evidence_lines_evidence_line_id_order_id_detail_id_key,mdf_evidence_lines_pkey,mdf_evidence_lines_source_kind_source_id_revision_key_line__key 08e74461f82132955762d89c72cc4b23)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_evidence_lines') AND conname=ANY(string_to_array('mdf_evidence_lines_detail_id_check,mdf_evidence_lines_evidence_kind_check,mdf_evidence_lines_evidence_line_id_order_id_detail_id_key,mdf_evidence_lines_line_key_check,mdf_evidence_lines_order_id_check,mdf_evidence_lines_pkey,mdf_evidence_lines_quantity_check,mdf_evidence_lines_source_kind_source_id_revision_key_fkey,mdf_evidence_lines_source_kind_source_id_revision_key_line__key,mdf_evidence_lines_stage_code_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_evidence_lines') AND indexrelid::regclass::text=ANY(string_to_array('idx_mdf_evidence_position,mdf_evidence_lines_evidence_line_id_order_id_detail_id_key,mdf_evidence_lines_pkey,mdf_evidence_lines_source_kind_source_id_revision_key_line__key',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_bath_allocations)" \
      "$(q_colset_hash mdf_bath_allocations allocation_id,evidence_line_id,bath_id,bath_revision,order_id,detail_id,quantity,state,cause_key,created_at,updated_at 21b592a56ef199e2313221b5764b6b36)" \
      "$(q_conset_hash mdf_bath_allocations mdf_bath_allocations_bath_id_check,mdf_bath_allocations_bath_revision_check,mdf_bath_allocations_cause_key_check,mdf_bath_allocations_cause_key_evidence_line_id_bath_id_bat_key,mdf_bath_allocations_evidence_line_id_order_id_detail_id_fkey,mdf_bath_allocations_pkey,mdf_bath_allocations_quantity_check,mdf_bath_allocations_state_check 1f82685dcd54390485b71186cc1190a3)" \
      "$(q_idxset_hash mdf_bath_allocations idx_mdf_allocation_bath,idx_mdf_allocation_position,idx_mdf_allocation_supply,mdf_bath_allocations_cause_key_evidence_line_id_bath_id_bat_key,mdf_bath_allocations_pkey 8de862aedb7ca0d6adb2677e693eca8f)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_bath_allocations') AND conname=ANY(string_to_array('mdf_bath_allocations_bath_id_check,mdf_bath_allocations_bath_revision_check,mdf_bath_allocations_cause_key_check,mdf_bath_allocations_cause_key_evidence_line_id_bath_id_bat_key,mdf_bath_allocations_evidence_line_id_order_id_detail_id_fkey,mdf_bath_allocations_pkey,mdf_bath_allocations_quantity_check,mdf_bath_allocations_state_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_bath_allocations') AND indexrelid::regclass::text=ANY(string_to_array('idx_mdf_allocation_bath,idx_mdf_allocation_position,idx_mdf_allocation_supply,mdf_bath_allocations_cause_key_evidence_line_id_bath_id_bat_key,mdf_bath_allocations_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_recalculation_jobs)" \
      "$(q_colset_hash mdf_recalculation_jobs job_id,event_key,source_kind,source_id,revision_key,correction_epoch,actor_user_id,request_id,status,attempts,next_attempt_at,error_code,created_at,finished_at c5f49ef45d0467d70084010ac017c506)" \
      "$(q_conset_hash mdf_recalculation_jobs mdf_recalculation_jobs_attempts_check,mdf_recalculation_jobs_correction_epoch_check,mdf_recalculation_jobs_event_key_check,mdf_recalculation_jobs_event_key_key,mdf_recalculation_jobs_pkey,mdf_recalculation_jobs_request_id_check,mdf_recalculation_jobs_source_kind_source_id_revision_key_fkey,mdf_recalculation_jobs_status_check 1a1a594aeae089dd8ae8841aeaaf48cf)" \
      "$(q_idxset_hash mdf_recalculation_jobs idx_mdf_job_pending,idx_mdf_job_source,mdf_recalculation_jobs_event_key_key,mdf_recalculation_jobs_pkey a2cf2f6f742549679dcbb5fd6055a635)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_recalculation_jobs') AND conname=ANY(string_to_array('mdf_recalculation_jobs_attempts_check,mdf_recalculation_jobs_correction_epoch_check,mdf_recalculation_jobs_event_key_check,mdf_recalculation_jobs_event_key_key,mdf_recalculation_jobs_pkey,mdf_recalculation_jobs_request_id_check,mdf_recalculation_jobs_source_kind_source_id_revision_key_fkey,mdf_recalculation_jobs_status_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_recalculation_jobs') AND indexrelid::regclass::text=ANY(string_to_array('idx_mdf_job_pending,idx_mdf_job_source,mdf_recalculation_jobs_event_key_key,mdf_recalculation_jobs_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_recalculation_job_rules)" \
      "$(q_colset_hash mdf_recalculation_job_rules job_id,rule_id,rule_version 3469299f734218c1abb1fb8d19e354d4)" \
      "$(q_conset_hash mdf_recalculation_job_rules mdf_recalculation_job_rules_job_id_fkey,mdf_recalculation_job_rules_pkey,mdf_recalculation_job_rules_rule_id_check,mdf_recalculation_job_rules_rule_version_check cb468e04796c960e1d9bf75bda14679b)" \
      "$(q_idxset_hash mdf_recalculation_job_rules mdf_recalculation_job_rules_pkey 29b18004c0bdcf68b2ee2a6acf818bbe)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_recalculation_job_rules') AND conname=ANY(string_to_array('mdf_recalculation_job_rules_job_id_fkey,mdf_recalculation_job_rules_pkey,mdf_recalculation_job_rules_rule_id_check,mdf_recalculation_job_rules_rule_version_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_recalculation_job_rules') AND indexrelid::regclass::text=ANY(string_to_array('mdf_recalculation_job_rules_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_fun_hash 'public.mdf_reject_evidence_change()' a51e1b51d407124a856f1993d9c54fe8)" \
      "$(q_fun_hash 'public.mdf_guard_revision_membership()' 916d14bf7da7dd4d4ea73c68ad26bf0c)" \
      "$(q_fun_hash 'public.mdf_guard_allocation()' beb8e18b0d57e88de4233e6f11cb3c37)" \
      "$(q_fun_hash 'public.mdf_guard_accepted_revision()' 945aada9b298e291ecda1442e6391f6d)" \
      "$(q_trg_def_on mdf_revision_immutable mdf_evidence_revisions 'CREATE TRIGGER mdf_revision_immutable BEFORE DELETE OR UPDATE ON public.mdf_evidence_revisions FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_evidence_revisions') AND tgname='mdf_revision_immutable' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_line_immutable mdf_evidence_lines 'CREATE TRIGGER mdf_line_immutable BEFORE DELETE OR UPDATE ON public.mdf_evidence_lines FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_evidence_lines') AND tgname='mdf_line_immutable' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_seal_immutable mdf_revision_seals 'CREATE TRIGGER mdf_seal_immutable BEFORE DELETE OR UPDATE ON public.mdf_revision_seals FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_revision_seals') AND tgname='mdf_seal_immutable' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_job_rules_immutable mdf_recalculation_job_rules 'CREATE TRIGGER mdf_job_rules_immutable BEFORE DELETE OR UPDATE ON public.mdf_recalculation_job_rules FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_recalculation_job_rules') AND tgname='mdf_job_rules_immutable' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_line_insert_guard mdf_evidence_lines 'CREATE TRIGGER mdf_line_insert_guard BEFORE INSERT ON public.mdf_evidence_lines FOR EACH ROW EXECUTE FUNCTION mdf_guard_revision_membership()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_evidence_lines') AND tgname='mdf_line_insert_guard' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_seal_insert_guard mdf_revision_seals 'CREATE TRIGGER mdf_seal_insert_guard BEFORE INSERT ON public.mdf_revision_seals FOR EACH ROW EXECUTE FUNCTION mdf_guard_revision_membership()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_revision_seals') AND tgname='mdf_seal_insert_guard' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_allocation_guard mdf_bath_allocations 'CREATE TRIGGER mdf_allocation_guard BEFORE INSERT OR DELETE OR UPDATE ON public.mdf_bath_allocations FOR EACH ROW EXECUTE FUNCTION mdf_guard_allocation()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_bath_allocations') AND tgname='mdf_allocation_guard' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_accepted_revision_guard mdf_source_heads 'CREATE TRIGGER mdf_accepted_revision_guard BEFORE UPDATE ON public.mdf_source_heads FOR EACH ROW EXECUTE FUNCTION mdf_guard_accepted_revision()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_source_heads') AND tgname='mdf_accepted_revision_guard' AND tgenabled='O' AND NOT tgisinternal);" \
      "SELECT EXISTS (SELECT 1 FROM mdf_engine_state WHERE singleton);" ;;
    166_mdf_engine_fences*) probe_all \
      "$(q_fun_hash 'public.mdf_guard_source_fence()' 5865eedf3ea4c2cf2b715b6ac210d49a)" \
      "$(q_fun_hash 'public.mdf_guard_published_fence()' a63689d699558290a343b5fd1829fef7)" \
      "$(q_trg_def_on mdf_source_fence_guard mdf_source_heads 'CREATE TRIGGER mdf_source_fence_guard BEFORE DELETE OR UPDATE ON public.mdf_source_heads FOR EACH ROW EXECUTE FUNCTION mdf_guard_source_fence()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_source_heads') AND tgname='mdf_source_fence_guard' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on mdf_published_fence_guard mdf_engine_state 'CREATE TRIGGER mdf_published_fence_guard BEFORE DELETE OR UPDATE ON public.mdf_engine_state FOR EACH ROW EXECUTE FUNCTION mdf_guard_published_fence()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_engine_state') AND tgname='mdf_published_fence_guard' AND tgenabled='O' AND NOT tgisinternal);" ;;
    167_mdf_shadow_observations*) probe_all \
      "$(q_tbl mdf_shadow_observations)" \
      "$(q_colset_hash mdf_shadow_observations source_kind,source_id,revision_key,source_digest,issues,candidate_quantities,created_at f66389a0112a62136ad760d1100ad594)" \
      "$(q_conset_hash mdf_shadow_observations mdf_shadow_observations_pkey,mdf_shadow_observations_source_digest_check,mdf_shadow_observations_source_kind_source_id_revision_key_fkey 3903f9eeeb9fec0b9689e18b121fa69e)" \
      "$(q_idxset_hash mdf_shadow_observations idx_mdf_shadow_created,mdf_shadow_observations_pkey e0a3cbfff6ae366bd8469fbbe1029c14)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_shadow_observations') AND conname=ANY(string_to_array('mdf_shadow_observations_pkey,mdf_shadow_observations_source_digest_check,mdf_shadow_observations_source_kind_source_id_revision_key_fkey',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_shadow_observations') AND indexrelid::regclass::text=ANY(string_to_array('idx_mdf_shadow_created,mdf_shadow_observations_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_trg_def_on mdf_shadow_immutable mdf_shadow_observations 'CREATE TRIGGER mdf_shadow_immutable BEFORE DELETE OR UPDATE ON public.mdf_shadow_observations FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_shadow_observations') AND tgname='mdf_shadow_immutable' AND tgenabled='O' AND NOT tgisinternal);" ;;
    168_bitrix24_order_stages*) probe_all \
      "$(q_tbl bitrix24_stage_config)" \
      "$(q_colset_hash bitrix24_stage_config singleton,member_id,domain,category_id,completed_status_id,enabled,binding_locked,version,epoch,updated_by,updated_at 83fdd19a306683eea7aed9c08d11d600)" \
      "$(q_conset_hash bitrix24_stage_config bitrix24_stage_config_category_id_check,bitrix24_stage_config_check,bitrix24_stage_config_completed_status_id_fkey,bitrix24_stage_config_member_id_fkey,bitrix24_stage_config_pkey,bitrix24_stage_config_singleton_check,bitrix24_stage_config_updated_by_fkey e26b3c3ef7ee9ed912dcc22bd0acc2af)" \
      "$(q_idxset_hash bitrix24_stage_config bitrix24_stage_config_pkey 377253b38c014e7361aee51fbb236b83)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.bitrix24_stage_config') AND conname=ANY(string_to_array('bitrix24_stage_config_category_id_check,bitrix24_stage_config_check,bitrix24_stage_config_completed_status_id_fkey,bitrix24_stage_config_member_id_fkey,bitrix24_stage_config_pkey,bitrix24_stage_config_singleton_check,bitrix24_stage_config_updated_by_fkey',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.bitrix24_stage_config') AND indexrelid::regclass::text=ANY(string_to_array('bitrix24_stage_config_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl bitrix24_stage_catalog)" \
      "$(q_colset_hash bitrix24_stage_catalog member_id,category_id,category_name,stages,revision,fetched_at 771547ab5261debc69e95b422459cf8c)" \
      "$(q_conset_hash bitrix24_stage_catalog bitrix24_stage_catalog_category_id_check,bitrix24_stage_catalog_member_id_fkey,bitrix24_stage_catalog_pkey,bitrix24_stage_catalog_stages_check b6e8b412ec18e1c9e6ff7a22321b4d88)" \
      "$(q_idxset_hash bitrix24_stage_catalog bitrix24_stage_catalog_pkey 43d53f00ca8bf5b0efb081f845706c63)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.bitrix24_stage_catalog') AND conname=ANY(string_to_array('bitrix24_stage_catalog_category_id_check,bitrix24_stage_catalog_member_id_fkey,bitrix24_stage_catalog_pkey,bitrix24_stage_catalog_stages_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.bitrix24_stage_catalog') AND indexrelid::regclass::text=ANY(string_to_array('bitrix24_stage_catalog_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl bitrix24_stage_mapping)" \
      "$(q_colset_hash bitrix24_stage_mapping member_id,category_id,order_status_id,stage_id,updated_by,updated_at 57bee8b8054ce8ed63652e67443396e3)" \
      "$(q_conset_hash bitrix24_stage_mapping bitrix24_stage_mapping_member_id_category_id_fkey,bitrix24_stage_mapping_order_status_id_fkey,bitrix24_stage_mapping_pkey,bitrix24_stage_mapping_updated_by_fkey 25994519c203673f982954429ea2d4b7)" \
      "$(q_idxset_hash bitrix24_stage_mapping bitrix24_stage_mapping_pkey a742ca42193f52089431fc115b418c0c)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.bitrix24_stage_mapping') AND conname=ANY(string_to_array('bitrix24_stage_mapping_member_id_category_id_fkey,bitrix24_stage_mapping_order_status_id_fkey,bitrix24_stage_mapping_pkey,bitrix24_stage_mapping_updated_by_fkey',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.bitrix24_stage_mapping') AND indexrelid::regclass::text=ANY(string_to_array('bitrix24_stage_mapping_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl bitrix24_stage_work)" \
      "$(q_colset_hash bitrix24_stage_work member_id,category_id,order_id,epoch,revision,initialized,source_status_id,applied_status_id,status,bitrix_id,observed_stage,target_stage,attempts,restore_count,restore_window,next_attempt_at,locked_at,lock_token,last_error,approval,job_id,actor_user_id,request_id,created_at,updated_at,processed_at c41fba3e884fecb27f5078dd9640be3a)" \
      "$(q_conset_hash bitrix24_stage_work bitrix24_stage_work_actor_user_id_fkey,bitrix24_stage_work_member_id_category_id_fkey,bitrix24_stage_work_order_id_fkey,bitrix24_stage_work_pkey,bitrix24_stage_work_status_check ebdbccebde765b0ffda5c5f2e87f6885)" \
      "$(q_idxset_hash bitrix24_stage_work bitrix24_stage_work_pkey,idx_bitrix24_stage_work_due 88152bcb8296c9943415dceb12a45ff0)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.bitrix24_stage_work') AND conname=ANY(string_to_array('bitrix24_stage_work_actor_user_id_fkey,bitrix24_stage_work_member_id_category_id_fkey,bitrix24_stage_work_order_id_fkey,bitrix24_stage_work_pkey,bitrix24_stage_work_status_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.bitrix24_stage_work') AND indexrelid::regclass::text=ANY(string_to_array('bitrix24_stage_work_pkey,idx_bitrix24_stage_work_due',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl bitrix24_stage_job)" \
      "$(q_colset_hash bitrix24_stage_job job_id,member_id,category_id,epoch,config_version,kind,payload,results,actor_user_id,request_id,created_at,expires_at 994c53576b30902dff7655e8ebe01f8b)" \
      "$(q_conset_hash bitrix24_stage_job bitrix24_stage_job_actor_user_id_fkey,bitrix24_stage_job_kind_check,bitrix24_stage_job_member_id_category_id_fkey,bitrix24_stage_job_pkey 2f3fb505a93491dba61e170af1b67294)" \
      "$(q_idxset_hash bitrix24_stage_job bitrix24_stage_job_pkey e8c4c2a097f04fdf48720cfa2c5197ed)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.bitrix24_stage_job') AND conname=ANY(string_to_array('bitrix24_stage_job_actor_user_id_fkey,bitrix24_stage_job_kind_check,bitrix24_stage_job_member_id_category_id_fkey,bitrix24_stage_job_pkey',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.bitrix24_stage_job') AND indexrelid::regclass::text=ANY(string_to_array('bitrix24_stage_job_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl bitrix24_stage_attempt)" \
      "$(q_colset_hash bitrix24_stage_attempt attempt_id,member_id,category_id,order_id,epoch,revision,config_version,bitrix_id,before_stage,target_stage,state,actor_user_id,request_id,created_at,verified_at 41977afb343beda1941969b31deadfd3)" \
      "$(q_conset_hash bitrix24_stage_attempt bitrix24_stage_attempt_pkey,bitrix24_stage_attempt_state_check c8baa03091ac414fd9de4adbd4da4b79)" \
      "$(q_idxset_hash bitrix24_stage_attempt bitrix24_stage_attempt_pkey,idx_bitrix24_stage_attempt_order 66ce78139696f92237beacf82894cd76)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.bitrix24_stage_attempt') AND conname=ANY(string_to_array('bitrix24_stage_attempt_pkey,bitrix24_stage_attempt_state_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.bitrix24_stage_attempt') AND indexrelid::regclass::text=ANY(string_to_array('bitrix24_stage_attempt_pkey,idx_bitrix24_stage_attempt_order',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_fun_hash 'public.bitrix24_stage_enqueue(bigint)' 07ca83d0de7c5f5e382a4e52b99114f7)" \
      "$(q_fun_hash 'public.bitrix24_stage_order_changed()' 4a39064a2ba080c5c72bc879de832c62)" \
      "$(q_fun_hash 'public.bitrix24_stage_mapping_available()' a8f2f26ab3d033b56d7e346b86d94e7b)" \
      "$(q_trg_def_on trg_bitrix24_stage_order_changed orders 'CREATE TRIGGER trg_bitrix24_stage_order_changed AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION bitrix24_stage_order_changed()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.orders') AND tgname='trg_bitrix24_stage_order_changed' AND tgenabled='O' AND NOT tgisinternal);" \
      "$(q_trg_def_on trg_bitrix24_stage_mapping_available crm_sync_mapping 'CREATE TRIGGER trg_bitrix24_stage_mapping_available AFTER INSERT OR UPDATE ON public.crm_sync_mapping FOR EACH ROW EXECUTE FUNCTION bitrix24_stage_mapping_available()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.crm_sync_mapping') AND tgname='trg_bitrix24_stage_mapping_available' AND tgenabled='O' AND NOT tgisinternal);" \
      "SELECT EXISTS (SELECT 1 FROM bitrix24_stage_config WHERE singleton);" ;;
    169_mdf_shadow_comparison*) probe_all \
      "$(q_tbl mdf_shadow_comparisons)" \
      "$(q_colset_hash mdf_shadow_comparisons source_kind,source_id,revision_key,algorithm_version,status,snapshot_at,duration_ms,report,created_at b0614cc238b42dc578015de62445c077)" \
      "$(q_conset_hash mdf_shadow_comparisons mdf_shadow_comparisons_duration_ms_check,mdf_shadow_comparisons_pkey,mdf_shadow_comparisons_report_check,mdf_shadow_comparisons_source_kind_source_id_revision_key_fkey,mdf_shadow_comparisons_status_check eea3e7ed2d8a73739d3eb8990cb92c2c)" \
      "$(q_idxset_hash mdf_shadow_comparisons idx_mdf_shadow_comparison_created,mdf_shadow_comparisons_pkey ebf389d2009f2b1f6a39040c7548b9cf)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_shadow_comparisons') AND conname=ANY(string_to_array('mdf_shadow_comparisons_duration_ms_check,mdf_shadow_comparisons_pkey,mdf_shadow_comparisons_report_check,mdf_shadow_comparisons_source_kind_source_id_revision_key_fkey,mdf_shadow_comparisons_status_check',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_shadow_comparisons') AND indexrelid::regclass::text=ANY(string_to_array('idx_mdf_shadow_comparison_created,mdf_shadow_comparisons_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_tbl mdf_shadow_comparison_attempts)" \
      "$(q_colset_hash mdf_shadow_comparison_attempts source_kind,source_id,revision_key,algorithm_version,attempts,next_attempt_at,error_code 0d35cf6e4a960b69191650dc144a771b)" \
      "$(q_conset_hash mdf_shadow_comparison_attempts mdf_shadow_comparison_attempt_source_kind_source_id_revisi_fkey,mdf_shadow_comparison_attempts_attempts_check,mdf_shadow_comparison_attempts_pkey c02837aa007a1865e3b180b2dda73a13)" \
      "$(q_idxset_hash mdf_shadow_comparison_attempts mdf_shadow_comparison_attempts_pkey adfedcdc67e358cd632d30a2ef60af33)" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_shadow_comparison_attempts') AND conname=ANY(string_to_array('mdf_shadow_comparison_attempt_source_kind_source_id_revisi_fkey,mdf_shadow_comparison_attempts_attempts_check,mdf_shadow_comparison_attempts_pkey',',')) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_shadow_comparison_attempts') AND indexrelid::regclass::text=ANY(string_to_array('mdf_shadow_comparison_attempts_pkey',',')) AND (NOT indisvalid OR NOT indisready));" \
      "$(q_trg_def_on mdf_shadow_comparison_immutable mdf_shadow_comparisons 'CREATE TRIGGER mdf_shadow_comparison_immutable BEFORE DELETE OR UPDATE ON public.mdf_shadow_comparisons FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change()')" \
      "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_shadow_comparisons') AND tgname='mdf_shadow_comparison_immutable' AND tgenabled='O' AND NOT tgisinternal);" ;;
    173_inbound_signals*) probe_all \
                     "$(q_tbl message_processing_configuration)" \
                     "$(q_tbl inbound_message_receipts)" \
                     "$(q_tbl inbound_messages)" \
                     "$(q_tbl inbound_signal_occurrences)" \
                     "$(q_tbl inbound_signal_steps)" \
                     "$(q_tbl inbound_signal_commands)" \
                     "$(q_col inbound_signal_occurrences execution_guard)" \
                     "$(q_col inbound_signal_occurrences lock_token)" \
                     "$(q_con_on inbound_signal_occurrences inbound_signal_occurrences_state_check)" \
                     "$(q_con_on inbound_signal_occurrences inbound_signal_occurrences_message_id_signal_code_key)" \
                     "$(q_idx inbound_messages_expiry_idx)" \
                     "$(q_idx inbound_signals_queue_idx)" \
                     "SELECT count(*)=4 FROM permissions_catalog WHERE permission_name IN ('message_signals.view','message_signals.resolve','message_signals.technical','message_signals.manage_config');" ;;
    171_mdf_shadow_commands*) probe_all \
                     "$(q_tbl mdf_shadow_commands)" \
                     "$(q_col mdf_shadow_commands observation_id)" \
                     "$(q_col mdf_shadow_commands audit_event_id)" \
                     "$(q_col mdf_shadow_commands composition_digest)" \
                     "$(q_col mdf_shadow_commands target_stage_id)" \
                     "$(q_col mdf_shadow_commands target_stage_code)" \
                     "$(q_col mdf_shadow_commands preview_digest)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_pkey)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_audit_event_id_key)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_observation_id_key)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_source_kind_source_id_revision_key_fkey)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_source_kind_check)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_command_kind_check)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_composition_digest_check)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_check)" \
                     "$(q_con_on mdf_shadow_commands mdf_shadow_commands_check1)" \
                     "$(q_idx idx_mdf_shadow_commands_source)" \
                     "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.mdf_shadow_commands') AND tgname='mdf_shadow_commands_immutable' AND tgenabled='O' AND tgfoid=to_regprocedure('public.mdf_reject_evidence_change()'));" ;;
    177_cut_result_typed_hdf*) probe_all \
      "SELECT count(*)=2 FROM pg_attribute WHERE attrelid=to_regclass('public.cut_result_placement') AND attname IN ('order_detail_id','order_hdf_detail_id') AND atttypid='bigint'::regtype AND NOT attnotnull AND NOT attisdropped;" \
      "$(q_con_hash_on chk_cut_result_placement_source_only_order cut_result_placement 62ea16377e0581db7bf34d6683754b9a)" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.cut_result_placement') AND conname='chk_cut_result_placement_source_only_order' AND convalidated);" \
      "$(q_idx_hash idx_cut_result_placement_hdf_candidates 480f25e0d125edc44147aa80299043fd)" \
      "SELECT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_cut_result_placement_hdf_candidates') AND indisvalid AND indisready);" \
      "$(q_fun_hash 'public.cut_result_item_identity(jsonb)' fb5fb2b3032389fe823e46e736796730)" \
      "$(q_fun_hash 'public.cut_result_snapshot_is_complete(jsonb,jsonb,text)' bca526581a7bed1c793800f93e3e0db7)" \
      "$(q_fun_hash 'public.project_cut_result_label_maps(bigint)' 5c498726a7bad70cb21c0c3f39c26cfd)" ;;
    176_whatsapp_reply_templates*) probe_all \
                     "$(q_col whatsapp_message_templates body_mode)" \
                     "$(q_col whatsapp_keyword_rules reply_mode)" \
                     "$(q_col whatsapp_keyword_rules counter_value)" \
                     "$(q_col whatsapp_delivery_jobs reply_to)" \
                     "$(q_col whatsapp_delivery_jobs reply_mode)" \
                     "$(q_col whatsapp_delivery_jobs rendered_at)" \
                     "$(q_col whatsapp_delivery_jobs counter_value)" \
                     "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='whatsapp_keyword_rules'::regclass AND conname='whatsapp_keyword_rules_match_mode_check' AND pg_get_constraintdef(oid) LIKE '%pattern_exact%');" \
                     "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='whatsapp_webhook_events'::regclass AND conname='whatsapp_webhook_events_result_code_check' AND pg_get_constraintdef(oid) LIKE '%failed%');" ;;
    170_whatsapp_technical_logs*) probe_all \
                     "$(q_tbl whatsapp_technical_logs)" \
                     "$(q_con_on whatsapp_technical_logs whatsapp_technical_logs_pkey)" \
                     "$(q_con_on whatsapp_technical_logs whatsapp_technical_logs_component_check)" \
                     "$(q_con_on whatsapp_technical_logs whatsapp_technical_logs_level_check)" \
                     "$(q_con_on whatsapp_technical_logs whatsapp_technical_logs_event_code_check)" \
                     "$(q_con_on whatsapp_technical_logs whatsapp_technical_logs_outcome_check)" \
                     "$(q_con_on whatsapp_technical_logs whatsapp_technical_logs_details_check)" \
                     "$(q_idx whatsapp_technical_logs_time_idx)" \
                     "$(q_idx whatsapp_technical_logs_error_idx)" \
                     "$(q_idx whatsapp_technical_logs_event_idx)" ;;
    172_bitrix_paid_request_conversion*) probe_all \
                     "$(q_col bitrix24_incoming_request auto_conversion_status)" \
                     "$(q_col bitrix24_incoming_request auto_conversion_reason)" \
                     "$(q_con_on bitrix24_incoming_request bitrix24_incoming_request_auto_conversion_status_check)" \
                     "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.orders') AND tgname='bitrix_paid_request_recheck' AND tgenabled='O' AND tgfoid=to_regprocedure('public.bitrix_paid_request_recheck()'));" ;;
    175_mdf_command_placement*) probe_all \
      "$(q_colset_hash mdf_revision_context manual_placement_column 14a75d57b0d8cf4a6eb566b34af50873)" \
      "$(q_conset_hash mdf_revision_context mdf_context_manual_placement_check c614fa7218df99c3fa199b8609fc4fe2)" \
      "$(q_colset_hash mdf_manual_command_results actor_user_id,command_key,request_digest,source_kind,source_id,order_ids,response,created_at 472e096aaefa864ed4b6e46f3626351d)" \
      "$(q_conset_hash mdf_manual_command_results mdf_manual_command_results_actor_user_id_check,mdf_manual_command_results_command_key_check,mdf_manual_command_results_order_ids_check,mdf_manual_command_results_pkey,mdf_manual_command_results_request_digest_check,mdf_manual_command_results_response_check,mdf_manual_command_results_source_id_check,mdf_manual_command_results_source_kind_check 979383da95b11c5a7e68b6620044c355)" \
      "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='mdf_manual_command_results' AND indexname='mdf_manual_command_results_pkey' AND indexdef='CREATE UNIQUE INDEX mdf_manual_command_results_pkey ON public.mdf_manual_command_results USING btree (actor_user_id, command_key)');" \
      "$(q_fun_hash 'public.mdf_reject_evidence_change()' a51e1b51d407124a856f1993d9c54fe8)" \
      "SELECT count(*)=2 FROM (VALUES ('mdf_revision_context','mdf_context_immutable'),('mdf_manual_command_results','mdf_manual_command_result_immutable')) expected(tbl,trg) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.mdf_reject_evidence_change()') AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_revision_context'),to_regclass('public.mdf_manual_command_results')]) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.mdf_manual_command_results') AND (NOT indisvalid OR NOT indisready));" ;;
    174_mdf_execution_context*) probe_all \
      "$(q_colset_hash mdf_revision_context source_kind,source_id,revision_key,schema_version,source_created_at,display_name,prior_column,composition_complete,demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key f4409d464360dedee5ad9c390ffdc73c)" \
      "$(q_conset_hash mdf_revision_context mdf_revision_context_demand_digest_check,mdf_revision_context_display_name_check,mdf_revision_context_pkey,mdf_revision_context_prior_column_check,mdf_revision_context_schema_version_check,mdf_revision_context_source_kind_source_id_revision_key_fkey 5590dd3a1cd92da4b844f655e8a7ae62)" \
      "$(q_idxset_hash mdf_revision_context mdf_revision_context_pkey 54dbfead0ba6ba83e61d877b42e84367)" \
      "$(q_colset_hash mdf_revision_demand source_kind,source_id,revision_key,order_id,detail_id,quantity 2b399b430366ec3d70ea5c69fc6fb626)" \
      "$(q_conset_hash mdf_revision_demand mdf_revision_demand_detail_id_check,mdf_revision_demand_order_id_check,mdf_revision_demand_pkey,mdf_revision_demand_quantity_check,mdf_revision_demand_source_kind_source_id_revision_key_fkey 6bb0193facf41c231b69c7075f43e3e8)" \
      "$(q_idxset_hash mdf_revision_demand mdf_revision_demand_pkey f003a1f3a84cb82846a69c145ade490b)" \
      "$(q_colset_hash mdf_published_sources source_kind,source_id,received_revision_key,accepted_revision_key,source_created_at,display_name,column_key,reason,issues,published_revision 7a1c1c0f454ea571f8b00cdc9e0494e3)" \
      "$(q_conset_hash mdf_published_sources mdf_published_sources_column_key_check,mdf_published_sources_pkey,mdf_published_sources_published_revision_check,mdf_published_sources_source_kind_check,mdf_published_sources_source_kind_source_id_fkey a5f00e72298c782bd5a9c3ba48e8c38a)" \
      "$(q_idxset_hash mdf_published_sources idx_mdf_published_source_window,mdf_published_sources_pkey 918635d839f1a99ca3ed2bb369b70dc2)" \
      "$(q_colset_hash mdf_published_source_members source_kind,source_id,order_id,detail_id,quantity 01c391348f16fd1653f8ac5afb8de93c)" \
      "$(q_conset_hash mdf_published_source_members mdf_published_source_members_pkey,mdf_published_source_members_quantity_check,mdf_published_source_members_source_kind_source_id_fkey 95f3538f8c796c76407959cf615b9ff7)" \
      "$(q_idxset_hash mdf_published_source_members idx_mdf_published_member_order,mdf_published_source_members_pkey 078f6188fcbc58e1d1227cd517921c20)" \
      "$(q_colset_hash mdf_published_positions order_id,detail_id,required_quantity,cut_quantity,rolled_quantity,credited_cut,credited_rolled,remaining,issues,published_revision 466dfad3e2dbbca6f8fcdf6711445f22)" \
      "$(q_conset_hash mdf_published_positions mdf_published_positions_check,mdf_published_positions_credited_cut_check,mdf_published_positions_credited_rolled_check,mdf_published_positions_cut_quantity_check,mdf_published_positions_pkey,mdf_published_positions_published_revision_check,mdf_published_positions_remaining_check,mdf_published_positions_required_quantity_check,mdf_published_positions_rolled_quantity_check 947f7956a7c4b95c49928d121d65c1ae)" \
      "$(q_idxset_hash mdf_published_positions mdf_published_positions_pkey cfc467ad9853f299daf442c23de4778f)" \
      "$(q_fun_hash 'public.mdf_guard_execution_context_insert()' 59172c9dc4387441e1b7460e5e00df41)" \
      "SELECT count(*)=4 FROM (VALUES ('mdf_revision_context','mdf_context_insert_guard','mdf_guard_execution_context_insert()',7),('mdf_revision_demand','mdf_demand_insert_guard','mdf_guard_execution_context_insert()',7),('mdf_revision_context','mdf_context_immutable','mdf_reject_evidence_change()',27),('mdf_revision_demand','mdf_demand_immutable','mdf_reject_evidence_change()',27)) expected(tbl,trg,fun,kind) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.'||fun) AND t.tgtype=kind AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_revision_context'),to_regclass('public.mdf_revision_demand'),to_regclass('public.mdf_published_sources'),to_regclass('public.mdf_published_source_members'),to_regclass('public.mdf_published_positions')]) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=ANY(ARRAY[to_regclass('public.mdf_revision_context'),to_regclass('public.mdf_revision_demand'),to_regclass('public.mdf_published_sources'),to_regclass('public.mdf_published_source_members'),to_regclass('public.mdf_published_positions')]) AND (NOT indisvalid OR NOT indisready));" ;;
    178_mdf_correction_receipts*) probe_all \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mdf_revision_context' AND column_name='effect_policy' AND data_type='text' AND is_nullable='NO' AND column_default='''forward''::text');" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mdf_recalculation_jobs' AND column_name='effect_policy' AND data_type='text' AND is_nullable='NO' AND column_default='''forward''::text');" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_revision_context') AND conname='mdf_revision_context_effect_policy_check' AND contype='c' AND convalidated AND md5(pg_get_constraintdef(oid))='762134ad47d34c70223ce0ce81067951');" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_recalculation_jobs') AND conname='mdf_recalculation_jobs_effect_policy_check' AND contype='c' AND convalidated AND md5(pg_get_constraintdef(oid))='762134ad47d34c70223ce0ce81067951');" \
      "$(q_fun_hash 'public.mdf_guard_job_effect_policy_binding()' 45e1620014c367515f61c170f2bcf0f5)" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_recalculation_jobs') AND t.tgname='mdf_job_effect_policy_binding' AND t.tgfoid=to_regprocedure('public.mdf_guard_job_effect_policy_binding()') AND t.tgtype=23 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "$(q_fun_hash 'public.mdf_reject_evidence_change()' a51e1b51d407124a856f1993d9c54fe8)" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_revision_context') AND t.tgname='mdf_context_immutable' AND t.tgfoid=to_regprocedure('public.mdf_reject_evidence_change()') AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_revision_context'),to_regclass('public.mdf_recalculation_jobs')]) AND NOT convalidated);" ;;
    179_mdf_active_return*) probe_all \
      "$(q_colset_hash mdf_correction_command_results actor_user_id,command_key,request_digest,source_kind,source_id,order_ids,response,created_at 472e096aaefa864ed4b6e46f3626351d)" \
      "$(q_conset_hash mdf_correction_command_results mdf_correction_command_results_actor_user_id_check,mdf_correction_command_results_command_key_check,mdf_correction_command_results_order_ids_check,mdf_correction_command_results_pkey,mdf_correction_command_results_request_digest_check,mdf_correction_command_results_response_check,mdf_correction_command_results_source_id_check,mdf_correction_command_results_source_kind_check 12852bdfb98b41e1bc7b8525cfb57ca4)" \
      "$(q_idxset_hash mdf_correction_command_results mdf_correction_command_results_pkey 8904331b527955cd6afb69762cb245f8)" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_correction_command_results') AND t.tgname='mdf_correction_command_result_immutable' AND t.tgfoid=to_regprocedure('public.mdf_reject_evidence_change()') AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "$(q_colset_hash mdf_correction_job_effect_suppressions job_id,affected_order_id,correction_source_kind,correction_source_id,correction_epoch,command_key,created_at 277b3a158b9ae318826ac38d3dc335c2)" \
      "$(q_conset_hash mdf_correction_job_effect_suppressions mdf_correction_job_effect_suppressions_affected_order_id_check,mdf_correction_job_effect_suppressions_command_key_check,mdf_correction_job_effect_suppressions_correction_epoch_check,mdf_correction_job_effect_suppressio_correction_source_id_check,mdf_correction_job_effect_suppress_correction_source_kind_check,mdf_correction_job_effect_suppressions_pkey cebc56e18c6d83644a0a0db1784b530e)" \
      "$(q_idxset_hash mdf_correction_job_effect_suppressions idx_mdf_correction_job_effect_suppressions_order,mdf_correction_job_effect_suppressions_pkey 9027e841e29fbf97366380dfc9283c10)" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_correction_job_effect_suppressions') AND t.tgname='mdf_correction_job_effect_suppression_immutable' AND t.tgfoid=to_regprocedure('public.mdf_reject_evidence_change()') AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.mdf_correction_job_effect_suppressions') AND c.contype='f' AND c.confrelid=to_regclass('public.mdf_recalculation_jobs'));" \
      "$(q_colset_hash mdf_cnc_return_fences packet_id,correction_epoch,baseline_source_version,pending_source_version,completion_source_version,state,created_at,updated_at 9e3d189a5bb7f2694778eb04c97b9fb4)" \
      "$(q_conset_hash mdf_cnc_return_fences mdf_cnc_return_fences_baseline_source_version_check,mdf_cnc_return_fences_correction_epoch_check,mdf_cnc_return_fences_packet_id_fkey,mdf_cnc_return_fences_pkey,mdf_cnc_return_fences_state_check 8d0c64ba064394cb48bd7ac95d7d811f)" \
      "$(q_idxset_hash mdf_cnc_return_fences mdf_cnc_return_fences_pkey fa6c7fddbb7d49d529ce84a8d4b4b37b)" \
      "$(q_fun_hash 'public.mdf_guard_cnc_return_fence()' d026131d8311f356670a7d23d54d73aa)" \
      "$(q_fun_hash 'public.mdf_reject_evidence_change()' a51e1b51d407124a856f1993d9c54fe8)" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_cnc_return_fences') AND t.tgname='mdf_cnc_return_fence_guard' AND t.tgfoid=to_regprocedure('public.mdf_guard_cnc_return_fence()') AND t.tgtype=31 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_correction_command_results'),to_regclass('public.mdf_correction_job_effect_suppressions'),to_regclass('public.mdf_cnc_return_fences')]) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=ANY(ARRAY[to_regclass('public.mdf_correction_command_results'),to_regclass('public.mdf_correction_job_effect_suppressions'),to_regclass('public.mdf_cnc_return_fences')]) AND (NOT indisvalid OR NOT indisready));" ;;
    180_mdf_cnc_observations*) probe_all \
      "$(q_tbl cnc_telegram_packets)" "$(q_tbl cnc_telegram_import_candidates)" "$(q_tbl cnc_telegram_import_items)" \
      "$(q_tbl mdf_source_heads)" "$(q_tbl mdf_recalculation_jobs)" "$(q_tbl mdf_cnc_return_fences)" \
      "$(q_colset_fun_hash_pair mdf_cnc_observation_targets packet_id,import_item_id,candidate_id,source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,accepted_revision_key,last_observation_version,work_state,next_due_at,claim_id,claim_token_hash,claim_generation,claim_worker_instance_id,claim_session_generation,claim_expires_at,claim_head_version,claim_correction_epoch,claim_raw_source_version,claim_observation_version,created_at,updated_at 58c9e312f16b38ba45c5534146e41ace packet_id,import_item_id,candidate_id,source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,accepted_revision_key,last_observation_version,work_state,next_due_at,claim_id,claim_token_hash,claim_generation,claim_worker_instance_id,claim_session_generation,claim_expires_at,claim_head_version,claim_correction_epoch,claim_raw_source_version,claim_observation_version,created_at,updated_at,registration_kind,manual_send_request_id 48bbfe7c44d81a3641ca98da18e89227 'public.mdf_guard_cnc_observation_target()' 518942b013d23e6160eb47e06237a0d2 d241972faa5d662ff436a873690ff619)" \
      "$(q_conset_hash mdf_cnc_observation_targets chk_mdf_cnc_observation_target_claim,mdf_cnc_observation_targets_accepted_revision_key_check,mdf_cnc_observation_targets_candidate_id_fkey,mdf_cnc_observation_targets_claim_generation_check,mdf_cnc_observation_targets_claim_token_hash_check,mdf_cnc_observation_targets_import_item_id_fkey,mdf_cnc_observation_targets_import_item_id_key,mdf_cnc_observation_targets_last_observation_version_check,mdf_cnc_observation_targets_message_bindings_check,mdf_cnc_observation_targets_packet_id_fkey,mdf_cnc_observation_targets_pkey,mdf_cnc_observation_targets_registered_membership_digest_check,mdf_cnc_observation_targets_registered_revision_key_check,mdf_cnc_observation_targets_source_chat_id_check,mdf_cnc_observation_targets_source_group_message_id_check,mdf_cnc_observation_targets_work_state_check 14d491731eb52f0a2c23e87fdb8129df)" \
      "$(q_idxset_hash mdf_cnc_observation_targets idx_mdf_cnc_observation_due,mdf_cnc_observation_targets_import_item_id_key,mdf_cnc_observation_targets_pkey 7821d51124214275c01987dacf631670)" \
      "$(q_colset_hash mdf_cnc_observation_receipts claim_id,packet_id,claim_generation,claim_token_hash,worker_instance_id,session_generation,head_version,correction_epoch,raw_source_version,observation_version,report_state,failure_code,report_digest,report,result,created_at b9f99f4745220b221cbf5884e57ff0ed)" \
      "$(q_conset_hash mdf_cnc_observation_receipts chk_mdf_cnc_observation_receipt_failure,mdf_cnc_observation_receipts_claim_generation_check,mdf_cnc_observation_receipts_claim_token_hash_check,mdf_cnc_observation_receipts_correction_epoch_check,mdf_cnc_observation_receipts_failure_code_check,mdf_cnc_observation_receipts_head_version_check,mdf_cnc_observation_receipts_observation_version_check,mdf_cnc_observation_receipts_packet_id_fkey,mdf_cnc_observation_receipts_pkey,mdf_cnc_observation_receipts_raw_source_version_check,mdf_cnc_observation_receipts_report_check,mdf_cnc_observation_receipts_report_digest_check,mdf_cnc_observation_receipts_report_state_check,mdf_cnc_observation_receipts_result_check,mdf_cnc_observation_receipts_session_generation_check a11437465812fd395e0de3193864263d)" \
      "$(q_idxset_hash mdf_cnc_observation_receipts idx_mdf_cnc_observation_receipt_sequence,mdf_cnc_observation_receipts_pkey aafc76b66f97eccf6e9769810c00a936)" \
      "$(q_colset_hash mdf_cnc_observation_job_authorities job_id,packet_id,claim_id,authority,created_at 6a9edc964e9da23dd9ca659d7a27297c)" \
      "$(q_conset_hash mdf_cnc_observation_job_authorities mdf_cnc_observation_job_authorities_authority_check,mdf_cnc_observation_job_authorities_claim_id_fkey,mdf_cnc_observation_job_authorities_claim_id_key,mdf_cnc_observation_job_authorities_packet_id_fkey,mdf_cnc_observation_job_authorities_pkey 8e5c2533815f1dd0184e7851c9e60b94)" \
      "$(q_idxset_hash mdf_cnc_observation_job_authorities mdf_cnc_observation_job_authorities_claim_id_key,mdf_cnc_observation_job_authorities_pkey 7cdb1d017c3efa3cb34ea09c72bf89d0)" \
      "$(q_fun_hash 'public.mdf_reject_evidence_change()' a51e1b51d407124a856f1993d9c54fe8)" \
      "SELECT count(*)=3 FROM (VALUES ('mdf_cnc_observation_targets','mdf_cnc_observation_target_guard','mdf_guard_cnc_observation_target()',31),('mdf_cnc_observation_receipts','mdf_cnc_observation_receipt_immutable','mdf_reject_evidence_change()',27),('mdf_cnc_observation_job_authorities','mdf_cnc_observation_job_authority_immutable','mdf_reject_evidence_change()',27)) expected(tbl,trg,fun,kind) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.'||fun) AND t.tgtype=kind AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT count(*)=6 FROM (VALUES ('mdf_cnc_observation_targets','cnc_telegram_packets'),('mdf_cnc_observation_targets','cnc_telegram_import_candidates'),('mdf_cnc_observation_targets','cnc_telegram_import_items'),('mdf_cnc_observation_receipts','mdf_cnc_observation_targets'),('mdf_cnc_observation_job_authorities','mdf_cnc_observation_targets'),('mdf_cnc_observation_job_authorities','mdf_cnc_observation_receipts')) expected(tbl,ref) JOIN pg_constraint c ON c.conrelid=to_regclass('public.'||tbl) AND c.contype='f' AND c.confrelid=to_regclass('public.'||ref) WHERE NOT EXISTS (SELECT 1 FROM pg_constraint bad WHERE bad.conrelid=to_regclass('public.'||tbl) AND bad.contype='f' AND bad.confrelid=to_regclass('public.mdf_recalculation_jobs'));" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_cnc_observation_targets'),to_regclass('public.mdf_cnc_observation_receipts'),to_regclass('public.mdf_cnc_observation_job_authorities')]) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=ANY(ARRAY[to_regclass('public.mdf_cnc_observation_targets'),to_regclass('public.mdf_cnc_observation_receipts'),to_regclass('public.mdf_cnc_observation_job_authorities')]) AND (NOT indisvalid OR NOT indisready));" ;;
    181_cnc_manual_send_observation*) probe_all \
      "$(q_tbl cnc_manual_svg_telegram_send_requests)" "$(q_tbl cnc_manual_svg_telegram_send_request_files)" \
      "$(q_tbl cnc_manual_svg_upload_files)" "$(q_tbl cnc_telegram_packets)" "$(q_tbl mdf_cnc_observation_targets)" \
      "$(q_colset_hash cnc_manual_svg_observation_claim_snapshots send_request_id,lease_generation,worker_instance_id,session_generation,lease_token_hash,packet_id,destination_chat_id,requested_file_count,files_qualified,files_snapshot,source_eligible,source_fence,ineligible_reason,created_at eca628417e7d71f4f05e9bd1d1e3729c)" \
      "$(q_colset_hash cnc_manual_svg_observation_send_bindings send_request_id,lease_generation,sent_chat_id,transport_message_ids,sent_files,binding_error,completion_digest,created_at 0ea7fefef06e9a2981bb9e939b2181ce)" \
      "$(q_colset_hash cnc_manual_svg_observation_registration_work send_request_id,lease_generation,work_state,reason,attempt_count,next_attempt_at,created_at,updated_at f473e0973769cfbcb60aa715664b5d30)" \
      "$(q_colset_hash mdf_cnc_observation_targets packet_id,import_item_id,candidate_id,source_chat_id,source_group_message_id,message_bindings,registered_revision_key,registered_membership_digest,accepted_revision_key,last_observation_version,work_state,next_due_at,claim_id,claim_token_hash,claim_generation,claim_worker_instance_id,claim_session_generation,claim_expires_at,claim_head_version,claim_correction_epoch,claim_raw_source_version,claim_observation_version,created_at,updated_at,registration_kind,manual_send_request_id 48bbfe7c44d81a3641ca98da18e89227)" \
      "$(q_conset_hash cnc_manual_svg_observation_claim_snapshots chk_cnc_manual_svg_observation_snapshot_shape,cnc_manual_svg_observation_claim_sna_requested_file_count_check,cnc_manual_svg_observation_claim_snap_destination_chat_id_check,cnc_manual_svg_observation_claim_snaps_session_generation_check,cnc_manual_svg_observation_claim_snapsh_ineligible_reason_check,cnc_manual_svg_observation_claim_snapsho_lease_generation_check,cnc_manual_svg_observation_claim_snapsho_lease_token_hash_check,cnc_manual_svg_observation_claim_snapshots_files_snapshot_check,cnc_manual_svg_observation_claim_snapshots_pkey,cnc_manual_svg_observation_claim_snapshots_send_request_id_fkey,cnc_manual_svg_observation_claim_snapshots_source_fence_check cb172fa1f14d23161886f580e7b8be3e)" \
      "$(q_conset_hash cnc_manual_svg_observation_send_bindings chk_cnc_manual_svg_observation_binding_choice,cnc_manual_svg_observation_se_send_request_id_lease_genera_fkey,cnc_manual_svg_observation_send_bin_transport_message_ids_check,cnc_manual_svg_observation_send_binding_completion_digest_check,cnc_manual_svg_observation_send_bindings_binding_error_check,cnc_manual_svg_observation_send_bindings_lease_generation_check,cnc_manual_svg_observation_send_bindings_pkey,cnc_manual_svg_observation_send_bindings_sent_chat_id_check,cnc_manual_svg_observation_send_bindings_sent_files_check 3b2f3cf98c8132022bd8cfe45f620967)" \
      "$(q_conset_hash cnc_manual_svg_observation_registration_work chk_cnc_manual_svg_observation_work_reason,cnc_manual_svg_observation_re_send_request_id_lease_genera_fkey,cnc_manual_svg_observation_registration__lease_generation_check,cnc_manual_svg_observation_registration_wor_attempt_count_check,cnc_manual_svg_observation_registration_work_pkey,cnc_manual_svg_observation_registration_work_reason_check,cnc_manual_svg_observation_registration_work_work_state_check 7f7dba43c6b43af86ce34657040e7770)" \
      "$(q_conset_hash mdf_cnc_observation_targets chk_mdf_cnc_observation_target_claim,chk_mdf_cnc_observation_target_registration_kind,mdf_cnc_observation_targets_accepted_revision_key_check,mdf_cnc_observation_targets_candidate_id_fkey,mdf_cnc_observation_targets_claim_generation_check,mdf_cnc_observation_targets_claim_token_hash_check,mdf_cnc_observation_targets_import_item_id_fkey,mdf_cnc_observation_targets_import_item_id_key,mdf_cnc_observation_targets_last_observation_version_check,mdf_cnc_observation_targets_manual_send_request_id_fkey,mdf_cnc_observation_targets_message_bindings_check,mdf_cnc_observation_targets_packet_id_fkey,mdf_cnc_observation_targets_pkey,mdf_cnc_observation_targets_registered_membership_digest_check,mdf_cnc_observation_targets_registered_revision_key_check,mdf_cnc_observation_targets_source_chat_id_check,mdf_cnc_observation_targets_source_group_message_id_check,mdf_cnc_observation_targets_work_state_check 02fad0863784f5bf8c13310d873be105)" \
      "$(q_idxset_hash cnc_manual_svg_observation_claim_snapshots cnc_manual_svg_observation_claim_snapshots_pkey c246869b70663118d9fce67e3a34acf6)" \
      "$(q_idxset_hash cnc_manual_svg_observation_send_bindings cnc_manual_svg_observation_send_bindings_pkey 73f6d4083eec681244cc51c8a5b6e39d)" \
      "$(q_idxset_hash cnc_manual_svg_observation_registration_work cnc_manual_svg_observation_registration_work_pkey,idx_cnc_manual_svg_observation_registration_due 3f83026700f84394068c1c6b624b0cd5)" \
      "$(q_idxset_hash mdf_cnc_observation_targets mdf_cnc_observation_targets_pkey,mdf_cnc_observation_targets_import_item_id_key,idx_mdf_cnc_observation_due,uq_mdf_cnc_observation_manual_send ac9e56036817b6c6baeb29ac2112d261)" \
      "$(q_fun_hash 'public.mdf_guard_cnc_manual_svg_observation_append_only()' b2f7ad914fece1fa6e50a291108a884f)" \
      "$(q_fun_hash 'public.mdf_guard_cnc_manual_svg_observation_work()' 6fb75265fe9bab58adda8bb558593ff7)" \
      "$(q_fun_hash 'public.mdf_guard_cnc_observation_target()' d241972faa5d662ff436a873690ff619)" \
      "SELECT count(*)=4 FROM (VALUES ('cnc_manual_svg_observation_claim_snapshots','cnc_manual_svg_observation_claim_immutable','mdf_guard_cnc_manual_svg_observation_append_only()',27),('cnc_manual_svg_observation_send_bindings','cnc_manual_svg_observation_binding_immutable','mdf_guard_cnc_manual_svg_observation_append_only()',27),('cnc_manual_svg_observation_registration_work','cnc_manual_svg_observation_work_guard','mdf_guard_cnc_manual_svg_observation_work()',31),('mdf_cnc_observation_targets','mdf_cnc_observation_target_guard','mdf_guard_cnc_observation_target()',31)) expected(tbl,trg,fun,kind) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.'||fun) AND t.tgtype=kind AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT count(*)=7 FROM (VALUES ('cnc_manual_svg_observation_claim_snapshots','cnc_manual_svg_telegram_send_requests'),('cnc_manual_svg_observation_send_bindings','cnc_manual_svg_observation_claim_snapshots'),('cnc_manual_svg_observation_registration_work','cnc_manual_svg_observation_send_bindings'),('mdf_cnc_observation_targets','cnc_telegram_packets'),('mdf_cnc_observation_targets','cnc_telegram_import_candidates'),('mdf_cnc_observation_targets','cnc_telegram_import_items'),('mdf_cnc_observation_targets','cnc_manual_svg_telegram_send_requests')) expected(tbl,ref) JOIN pg_constraint c ON c.conrelid=to_regclass('public.'||tbl) AND c.contype='f' AND c.confrelid=to_regclass('public.'||ref) WHERE NOT EXISTS (SELECT 1 FROM pg_constraint bad WHERE bad.conrelid=ANY(ARRAY[to_regclass('public.cnc_manual_svg_observation_claim_snapshots'),to_regclass('public.cnc_manual_svg_observation_send_bindings'),to_regclass('public.cnc_manual_svg_observation_registration_work'),to_regclass('public.mdf_cnc_observation_targets')]) AND bad.contype='f' AND bad.confrelid=to_regclass('public.mdf_recalculation_jobs')) AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.cnc_manual_svg_observation_claim_snapshots') AND contype='f') AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.cnc_manual_svg_observation_send_bindings') AND contype='f') AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.cnc_manual_svg_observation_registration_work') AND contype='f') AND (SELECT count(*)=4 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_cnc_observation_targets') AND contype='f');" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.cnc_manual_svg_observation_claim_snapshots'),to_regclass('public.cnc_manual_svg_observation_send_bindings'),to_regclass('public.cnc_manual_svg_observation_registration_work'),to_regclass('public.mdf_cnc_observation_targets')]) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=ANY(ARRAY[to_regclass('public.cnc_manual_svg_observation_claim_snapshots'),to_regclass('public.cnc_manual_svg_observation_send_bindings'),to_regclass('public.cnc_manual_svg_observation_registration_work'),to_regclass('public.mdf_cnc_observation_targets')]) AND (NOT indisvalid OR NOT indisready));" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_cnc_observation_targets') AND conname='chk_mdf_cnc_observation_target_registration_kind' AND contype='c' AND convalidated AND md5(pg_get_constraintdef(oid))='204acf8f78ca96322703a19077e5e145');" ;;
    183_whatsapp_daily_digest*) probe_all \
      "$(q_tbl whatsapp_daily_digest_settings)" \
      "$(q_tbl whatsapp_daily_digest_runs)" \
      "$(q_tbl whatsapp_daily_digest_pages)" \
      "SELECT count(*)=3 FROM pg_class WHERE oid=ANY(ARRAY[to_regclass('public.idx_whatsapp_daily_digest_auto_date'),to_regclass('public.idx_whatsapp_daily_digest_manual_idempotency'),to_regclass('public.idx_whatsapp_daily_digest_pages_file')]) AND relkind='i';" \
      "SELECT count(*)=1 FROM whatsapp_daily_digest_settings WHERE singleton_id=1;" \
      "SELECT count(*)=8 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_daily_digest_settings' AND is_nullable='NO' AND ((column_name='version' AND column_default='1') OR (column_name='enabled' AND column_default='false') OR (column_name='send_time' AND column_default LIKE '%08:45%') OR (column_name='time_zone' AND column_default LIKE '%Asia/Almaty%') OR (column_name='catch_up_policy' AND column_default LIKE '%until_deadline%') OR (column_name='catch_up_deadline' AND column_default LIKE '%10:00%') OR (column_name='partial_policy' AND column_default LIKE '%remaining%') OR (column_name='cards_per_message' AND column_default='2'));" \
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_settings'::regclass AND conname='chk_whatsapp_daily_digest_cards_per_message' AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%cards_per_message%' AND pg_get_constraintdef(oid) LIKE '%ARRAY[1, 2]%');" \
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_pages'::regclass AND conname='chk_whatsapp_daily_digest_page_index' AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%page_index%' AND pg_get_constraintdef(oid) LIKE '%500%');" ;;
    184_whatsapp_daily_digest_schedule*) probe_all \
      "$(q_tbl whatsapp_daily_digest_schedules)" \
      "SELECT COALESCE((SELECT data_type='integer' AND is_nullable='NO' AND column_default='0' FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_daily_digest_settings' AND column_name='send_window_minutes'),false);" \
      "SELECT count(*)=3 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_settings'::regclass AND contype='c' AND convalidated AND conname IN ('chk_whatsapp_daily_digest_window_minutes_range','chk_whatsapp_daily_digest_window_same_day','chk_whatsapp_daily_digest_deadline_after_window');" \
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_settings'::regclass AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%catch_up_deadline >= send_time%');" \
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_schedules'::regclass AND contype='p' AND pg_get_constraintdef(oid) LIKE '%business_date%');" \
      "SELECT count(*)=8 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_schedules'::regclass AND contype='c' AND convalidated;" \
      "SELECT count(*)=2 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_schedules'::regclass AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%AT TIME ZONE%';" \
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_schedules'::regclass AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%date_trunc%');" \
      "SELECT NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.whatsapp_daily_digest_settings'::regclass AND NOT convalidated);" ;;
    185_mdf_bazis_composition*) probe_all \
      "$(q_tbl mdf_evidence_revisions)" "$(q_tbl mdf_revision_context)" "$(q_tbl mdf_revision_demand)" \
      "$(q_tbl mdf_revision_seals)" "$(q_tbl mdf_evidence_lines)" "$(q_tbl mdf_source_heads)" \
      "$(q_tbl mdf_physical_lineage_contracts)" "$(q_tbl mdf_physical_lineage_transitions)" \
      "$(q_tbl mdf_recalculation_jobs)" "$(q_tbl mdf_bath_allocations)" \
      "$(q_tbl bazis_cut_sets)" "$(q_tbl bazis_cut_set_details)" \
      "$(q_colset_hash mdf_bazis_assignment_states source_kind,source_id,revision_key,assignment_state_id,root_intent_id,predecessor_revision_key,predecessor_state_id,membership_digest,intentional_empty,created_at 7c8e35fd85174def4370da92813f0bda)" \
      "$(q_colset_hash mdf_bazis_composition_intents intent_id,job_id,source_kind,source_id,revision_key,predecessor_revision_key,assignment_state_id,set_id,set_version,raw_snapshot_digest,membership_digest,intentional_empty,owner_ids,allocation_snapshot_digest,preview_digest,actor_user_id,request_id,command_key,created_at 25d043103a689c70d3732e862a2a69e2)" \
      "$(q_conset_hash mdf_bazis_assignment_states fk_mdf_bazis_assignment_root_intent,mdf_bazis_assignment_states_check,mdf_bazis_assignment_states_membership_digest_check,mdf_bazis_assignment_states_pkey,mdf_bazis_assignment_states_revision_key_check,mdf_bazis_assignment_states_source_id_check,mdf_bazis_assignment_states_source_kind_check,mdf_bazis_assignment_states_source_kind_source_id_predeces_fkey,mdf_bazis_assignment_states_source_kind_source_id_revision__key,mdf_bazis_assignment_states_source_kind_source_id_revision_fkey 28027224d245e073777c3a83adadcb15)" \
      "$(q_conset_hash mdf_bazis_composition_intents mdf_bazis_composition_intent_job_guard,mdf_bazis_composition_intents_actor_user_id_check,mdf_bazis_composition_intents_actor_user_id_command_key_key,mdf_bazis_composition_intents_allocation_snapshot_digest_check,mdf_bazis_composition_intents_check,mdf_bazis_composition_intents_command_key_check,mdf_bazis_composition_intents_job_id_fkey,mdf_bazis_composition_intents_job_id_key,mdf_bazis_composition_intents_membership_digest_check,mdf_bazis_composition_intents_owner_ids_check,mdf_bazis_composition_intents_owner_ids_check1,mdf_bazis_composition_intents_pkey,mdf_bazis_composition_intents_predecessor_revision_key_check,mdf_bazis_composition_intents_preview_digest_check,mdf_bazis_composition_intents_raw_snapshot_digest_check,mdf_bazis_composition_intents_request_id_check,mdf_bazis_composition_intents_revision_key_check,mdf_bazis_composition_intents_set_id_check,mdf_bazis_composition_intents_set_version_check,mdf_bazis_composition_intents_source_id_check,mdf_bazis_composition_intents_source_kind_check,mdf_bazis_composition_intents_source_kind_source_id_predec_fkey,mdf_bazis_composition_intents_source_kind_source_id_revisi_fkey,mdf_bazis_composition_intents_source_kind_source_id_revisio_key 25c766d22da2e71829e9945daf195c01)" \
      "$(q_idxset_hash mdf_bazis_assignment_states idx_mdf_bazis_assignment_state_id,mdf_bazis_assignment_states_pkey,mdf_bazis_assignment_states_source_kind_source_id_revision__key 2ea244aca9759044c36943e27c621536)" \
      "$(q_idxset_hash mdf_bazis_composition_intents idx_mdf_bazis_composition_intent_job,mdf_bazis_composition_intents_actor_user_id_command_key_key,mdf_bazis_composition_intents_job_id_key,mdf_bazis_composition_intents_pkey,mdf_bazis_composition_intents_source_kind_source_id_revisio_key 2ea3abb5d89f4f8b489c53825b3e398a)" \
      "$(q_fun_hash 'public.mdf_guard_bazis_assignment_state_insert()' 2d6c181ca20df43da653d44409a9073a)" \
      "$(q_fun_hash 'public.mdf_guard_bazis_assignment_state_seal()' aaa36c569106fe12b38a8d71ebb4f45f)" \
      "$(q_fun_hash 'public.mdf_guard_bazis_composition_intent_insert()' 8fe6e4df8cbeff3c28b44959da4e412b)" \
      "$(q_fun_hash 'public.mdf_validate_bazis_composition_intent_job()' 006a828cf13a2b5f9f116bab7813c115)" \
      "$(q_fun_hash 'public.mdf_reject_bazis_composition_marker_change()' 93cbd0bde882a11eeecbb86623beb05a)" \
      "SELECT count(*)=6 FROM (VALUES ('mdf_bazis_assignment_states','mdf_bazis_assignment_state_insert_guard','mdf_guard_bazis_assignment_state_insert()',7),('mdf_bazis_assignment_states','mdf_bazis_assignment_state_immutable','mdf_reject_bazis_composition_marker_change()',27),('mdf_bazis_composition_intents','mdf_bazis_composition_intent_insert_guard','mdf_guard_bazis_composition_intent_insert()',7),('mdf_bazis_composition_intents','mdf_bazis_composition_intent_immutable','mdf_reject_bazis_composition_marker_change()',27),('mdf_bazis_composition_intents','mdf_bazis_composition_intent_job_guard','mdf_validate_bazis_composition_intent_job()',5),('mdf_revision_seals','mdf_bazis_assignment_state_seal_guard','mdf_guard_bazis_assignment_state_seal()',7)) expected(tbl,trg,fun,kind) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.'||fun) AND t.tgtype=kind AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND (trg<>'mdf_bazis_composition_intent_job_guard' OR (t.tgdeferrable AND t.tginitdeferred));" \
      "WITH expected(tbl,ref,expected_count) AS (VALUES ('mdf_bazis_assignment_states','mdf_revision_seals',2),('mdf_bazis_assignment_states','mdf_bazis_composition_intents',1),('mdf_bazis_composition_intents','mdf_recalculation_jobs',1),('mdf_bazis_composition_intents','mdf_bazis_assignment_states',1),('mdf_bazis_composition_intents','mdf_revision_seals',1)), actual AS (SELECT local.relname AS tbl,remote.relname AS ref,count(*) AS fk_count FROM pg_constraint c JOIN pg_class local ON local.oid=c.conrelid JOIN pg_namespace local_ns ON local_ns.oid=local.relnamespace JOIN pg_class remote ON remote.oid=c.confrelid JOIN pg_namespace remote_ns ON remote_ns.oid=remote.relnamespace WHERE local_ns.nspname='public' AND local.relname IN ('mdf_bazis_assignment_states','mdf_bazis_composition_intents') AND c.contype='f' AND c.confdeltype='r' AND c.convalidated AND remote_ns.nspname='public' GROUP BY local.relname,remote.relname) SELECT (SELECT COALESCE(sum(fk_count),0)=6 FROM actual) AND NOT EXISTS (SELECT 1 FROM expected e LEFT JOIN actual a ON a.tbl=e.tbl AND a.ref=e.ref WHERE COALESCE(a.fk_count,0)<>e.expected_count);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_bazis_assignment_states'),to_regclass('public.mdf_bazis_composition_intents')]) AND NOT convalidated);" \
      "SELECT (SELECT count(*)=10 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_bazis_assignment_states')) AND (SELECT count(*)=24 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_bazis_composition_intents'));" \
      "SELECT (SELECT count(*)=3 FROM pg_indexes WHERE schemaname='public' AND tablename='mdf_bazis_assignment_states') AND (SELECT count(*)=5 FROM pg_indexes WHERE schemaname='public' AND tablename='mdf_bazis_composition_intents');" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=ANY(ARRAY[to_regclass('public.mdf_bazis_assignment_states'),to_regclass('public.mdf_bazis_composition_intents')]) AND (NOT indisvalid OR NOT indisready));" ;;
    187_mdf_bazis_refill_rows*) probe_all \
      "$(q_tbl mdf_bazis_raw_row_creations)" "$(q_tbl mdf_bazis_composition_new_rows)" \
      "SELECT count(*)=4 FROM information_schema.columns WHERE table_schema='public' AND table_name='mdf_bazis_raw_row_creations' AND column_name=ANY(ARRAY['row_id','set_id','created_txid','created_at']);" \
      "SELECT count(*)=7 FROM information_schema.columns WHERE table_schema='public' AND table_name='mdf_bazis_composition_new_rows';" \
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.mdf_bazis_composition_new_rows'::regclass AND contype='p' AND convalidated AND pg_get_constraintdef(oid) LIKE '%intent_id, row_id%');" \
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.mdf_bazis_raw_row_creations'::regclass AND contype='p' AND convalidated AND pg_get_constraintdef(oid) LIKE '%row_id, created_txid%');" \
      "SELECT count(*)=1 FROM pg_constraint WHERE conrelid='public.mdf_bazis_composition_new_rows'::regclass AND contype='f' AND convalidated AND confdeltype='r' AND confrelid=to_regclass('public.mdf_bazis_composition_intents');" \
      "SELECT count(*)=4 FROM (VALUES ('bazis_cut_set_details','mdf_bazis_raw_row_creation_log','mdf_log_bazis_raw_row_creation()',5),('mdf_bazis_raw_row_creations','mdf_bazis_raw_row_creation_immutable','mdf_reject_bazis_refill_log_change()',27),('mdf_bazis_composition_new_rows','mdf_bazis_composition_new_row_insert_guard','mdf_guard_bazis_composition_new_row_insert()',7),('mdf_bazis_composition_new_rows','mdf_bazis_composition_new_row_immutable','mdf_reject_bazis_refill_log_change()',27)) expected(tbl,trg,fun,kind) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.'||fun) AND t.tgtype=kind AND t.tgenabled='O' AND NOT t.tgisinternal;" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_bazis_raw_row_creations'),to_regclass('public.mdf_bazis_composition_new_rows')]) AND NOT convalidated);" ;;
    188_mdf_order_cascade_intents*) probe_all \
      "$(q_tbl mdf_order_cascade_intents)" \
      "SELECT to_regprocedure('public.mdf_guard_order_cascade_intent_insert()') IS NOT NULL AND to_regprocedure('public.mdf_validate_order_cascade_intent_commit()') IS NOT NULL AND to_regprocedure('public.mdf_reject_order_cascade_intent_change()') IS NOT NULL;" \
      "SELECT count(*)=3 FROM (VALUES ('mdf_order_cascade_intent_insert_guard','mdf_guard_order_cascade_intent_insert()'),('mdf_order_cascade_intent_immutable','mdf_reject_order_cascade_intent_change()'),('mdf_order_cascade_intent_commit_guard','mdf_validate_order_cascade_intent_commit()')) expected(trg,fun) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.mdf_order_cascade_intents') AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.'||fun) AND t.tgenabled='O' AND NOT t.tgisinternal;" ;;
    189_mdf_placement_inputs*) probe_all \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mdf_published_sources' AND column_name='placement_inputs' AND data_type='jsonb');" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mdf_published_sources_placement_inputs_object' AND conrelid='public.mdf_published_sources'::regclass AND contype='c' AND convalidated);" \
      "SELECT to_regprocedure('public.mdf_placement_inputs_valid(jsonb,bigint)') IS NOT NULL;" ;;
    186_bitrix24_product_import*) probe_all \
      "$(q_tbl bitrix24_product_mapping)" \
      "SELECT count(*)=8 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_mapping';" \
      "SELECT count(*)=6 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_mapping' AND is_nullable='NO' AND column_name=ANY(string_to_array('bitrix_product_id,catalog_item_id,active,version,created_at,updated_at',','));" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_mapping' AND column_name='version' AND data_type='integer' AND column_default='1');" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bitrix24_product_mapping'::regclass AND conname='bitrix24_product_mapping_pkey' AND contype='p' AND convalidated AND pg_get_constraintdef(oid) LIKE '%bitrix_product_id%');" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bitrix24_product_mapping'::regclass AND conname='bitrix24_product_mapping_catalog_item_id_fkey' AND contype='f' AND convalidated AND confrelid='public.catalog_items'::regclass);" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bitrix24_product_mapping'::regclass AND conname='bitrix24_product_mapping_bitrix_product_id_check' AND contype='c' AND convalidated);" \
      "$(q_tbl bitrix24_product_row_snapshot)" \
      "SELECT count(*)=26 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_row_snapshot';" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_row_snapshot' AND column_name='applied_state' AND is_nullable='NO' AND column_default='''pending''::text');" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_row_snapshot' AND column_name='quantity' AND data_type='numeric' AND numeric_precision=14 AND numeric_scale=3 AND is_nullable='NO');" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_row_snapshot' AND column_name='unit_price' AND data_type='numeric' AND numeric_precision=14 AND numeric_scale=2 AND is_nullable='NO');" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_row_snapshot' AND column_name='raw_row' AND data_type='jsonb' AND is_nullable='NO');" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_product_row_snapshot' AND column_name='state' AND is_nullable='NO' AND column_default='''active''::text');" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bitrix24_product_row_snapshot'::regclass AND conname='bitrix24_product_row_snapshot_pkey' AND contype='p' AND convalidated AND pg_get_constraintdef(oid) LIKE '%request_id%bitrix_row_id%');" \
      "SELECT count(*)=3 FROM pg_constraint WHERE conrelid='public.bitrix24_product_row_snapshot'::regclass AND contype='f' AND convalidated AND confrelid=ANY(ARRAY[to_regclass('public.bitrix24_incoming_request'),to_regclass('public.catalog_items'),to_regclass('public.order_catalog_lines')]);" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bitrix24_product_row_snapshot'::regclass AND conname='bitrix24_product_row_snapshot_bitrix_product_id_check' AND contype='c' AND convalidated);" \
      "$(q_col bitrix24_incoming_request product_sync_status)" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_incoming_request' AND column_name='product_sync_status' AND is_nullable='NO' AND column_default='''pending''::text');" \
      "$(q_col bitrix24_incoming_request product_sync_error_code)" \
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_incoming_request' AND column_name='product_sync_blocked_ids' AND data_type='jsonb' AND is_nullable='NO' AND column_default LIKE '%[]%');" \
      "$(q_col bitrix24_incoming_request product_rows_hash)" \
      "$(q_col bitrix24_incoming_request product_rows_total)" \
      "$(q_col bitrix24_incoming_request product_order_fingerprint)" \
      "$(q_col bitrix24_incoming_request product_rows_synced_at)" \
      "$(q_con_on bitrix24_incoming_request chk_bitrix24_request_product_sync)" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_bitrix24_request_product_sync' AND convalidated AND pg_get_constraintdef(oid) LIKE '%pending%ready%blocked%');" \
      "$(q_idx idx_bitrix24_product_row_snapshot_product)" \
      "$(q_idx uq_bitrix24_product_row_snapshot_line)" \
      "SELECT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.uq_bitrix24_product_row_snapshot_line'::regclass AND indisunique AND indisvalid AND indisready);" \
      "$(q_tbl bitrix24_payment_sync_gen)" \
      "SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public' AND table_name='bitrix24_payment_sync_gen';" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bitrix24_payment_sync_gen'::regclass AND conname='bitrix24_payment_sync_gen_pkey' AND contype='p' AND convalidated);" \
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.bitrix24_payment_sync_gen'::regclass AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%gen >= 0%');" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.bitrix24_product_mapping'),to_regclass('public.bitrix24_product_row_snapshot')]) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=ANY(ARRAY[to_regclass('public.bitrix24_product_mapping'),to_regclass('public.bitrix24_product_row_snapshot')]) AND (NOT indisvalid OR NOT indisready));" ;;
    182_mdf_physical_lineage*) probe_all \
      "$(q_tbl mdf_evidence_revisions)" "$(q_tbl mdf_revision_context)" "$(q_tbl mdf_revision_demand)" \
      "$(q_tbl mdf_revision_seals)" "$(q_tbl mdf_source_heads)" "$(q_tbl mdf_evidence_lines)" \
      "$(q_colset_hash mdf_physical_lineage_contracts source_kind,source_id,revision_key,operation,production_authority,predecessor_accepted_revision_key,manifest_digest,dropped_predecessor_evidence_line_ids,created_at 5138882885769bc7fa70ca08c9f31850)" \
      "$(q_conset_hash mdf_physical_lineage_contracts chk_mdf_physical_lineage_authority,mdf_physical_lineage_contract_source_kind_source_id_predec_fkey,mdf_physical_lineage_contract_source_kind_source_id_revisi_fkey,mdf_physical_lineage_contracts_manifest_digest_check,mdf_physical_lineage_contracts_operation_check,mdf_physical_lineage_contracts_pkey,mdf_physical_lineage_contracts_production_authority_check,mdf_physical_lineage_contracts_revision_key_check,mdf_physical_lineage_contracts_source_id_check,mdf_physical_lineage_contracts_source_kind_check a1c435fd8e1718dfa27fc51b6e97a5b1)" \
      "$(q_idxset_hash mdf_physical_lineage_contracts mdf_physical_lineage_contracts_pkey d86e35e02578b17a844033efe13a00ce)" \
      "$(q_colset_hash mdf_physical_lineage_transitions source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,canonical_origin_evidence_line_id,created_at 75284260f5fbdf3850fce32f3c4ec0dd)" \
      "$(q_conset_hash mdf_physical_lineage_transitions chk_mdf_physical_lineage_transition_parent,mdf_physical_lineage_transiti_canonical_origin_evidence_li_fkey,mdf_physical_lineage_transiti_predecessor_evidence_line_id_fkey,mdf_physical_lineage_transiti_source_kind_source_id_revisi_fkey,mdf_physical_lineage_transiti_source_kind_source_id_revisi_key1,mdf_physical_lineage_transiti_source_kind_source_id_revisio_key,mdf_physical_lineage_transitions_action_check,mdf_physical_lineage_transitions_evidence_line_id_fkey,mdf_physical_lineage_transitions_pkey e8ffa2aa2aeba0b52cc70a1c10c47509)" \
      "$(q_idxset_hash mdf_physical_lineage_transitions mdf_physical_lineage_transiti_source_kind_source_id_revisi_key1,mdf_physical_lineage_transiti_source_kind_source_id_revisio_key,mdf_physical_lineage_transitions_pkey 9953302b7dd61a70a78069d48d67bff5)" \
      "$(q_fun_hash 'public.mdf_guard_physical_lineage_insert()' 5f33a57477dcf2397fa18783d9b7ecae)" \
      "$(q_fun_hash 'public.mdf_guard_physical_lineage_immutable()' 39d2c9d9500956c4bca2546c68d8cc15)" \
      "$(q_fun_hash 'public.mdf_validate_physical_lineage_seal()' 3067d8c18cdc8b1603397ce68a56824b)" \
      "$(q_fun_hash 'public.mdf_guard_physical_lineage_source_head()' d2ab89206c2d81b774c16779d302d789)" \
      "$(q_fun_hash 'public.mdf_guard_source_fence()' 5865eedf3ea4c2cf2b715b6ac210d49a)" \
      "$(q_fun_hash 'public.mdf_reject_evidence_change()' a51e1b51d407124a856f1993d9c54fe8)" \
      "$(q_fun_hash 'public.mdf_guard_accepted_revision()' 945aada9b298e291ecda1442e6391f6d)" \
      "$(q_fun_hash 'public.mdf_guard_job_effect_policy_binding()' 45e1620014c367515f61c170f2bcf0f5)" \
      "SELECT count(*)=6 FROM (VALUES ('mdf_physical_lineage_contracts','mdf_physical_lineage_contract_insert_guard','mdf_guard_physical_lineage_insert()',7),('mdf_physical_lineage_contracts','mdf_physical_lineage_contract_immutable','mdf_guard_physical_lineage_immutable()',27),('mdf_physical_lineage_transitions','mdf_physical_lineage_transition_insert_guard','mdf_guard_physical_lineage_insert()',7),('mdf_physical_lineage_transitions','mdf_physical_lineage_transition_immutable','mdf_guard_physical_lineage_immutable()',27),('mdf_revision_seals','mdf_physical_lineage_seal_guard','mdf_validate_physical_lineage_seal()',7),('mdf_source_heads','mdf_physical_lineage_source_head_guard','mdf_guard_physical_lineage_source_head()',23)) expected(tbl,trg,fun,kind) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.'||fun) AND t.tgtype=kind AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT count(*)=6 AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_physical_lineage_contracts') AND contype='f') AND (SELECT count(*)=4 FROM pg_constraint WHERE conrelid=to_regclass('public.mdf_physical_lineage_transitions') AND contype='f') FROM (VALUES ('mdf_physical_lineage_contracts','mdf_revision_context','mdf_physical_lineage_contract_source_kind_source_id_revisi_fkey'),('mdf_physical_lineage_contracts','mdf_revision_seals','mdf_physical_lineage_contract_source_kind_source_id_predec_fkey'),('mdf_physical_lineage_transitions','mdf_evidence_lines','mdf_physical_lineage_transitions_evidence_line_id_fkey'),('mdf_physical_lineage_transitions','mdf_evidence_lines','mdf_physical_lineage_transiti_predecessor_evidence_line_id_fkey'),('mdf_physical_lineage_transitions','mdf_evidence_lines','mdf_physical_lineage_transiti_canonical_origin_evidence_li_fkey'),('mdf_physical_lineage_transitions','mdf_physical_lineage_contracts','mdf_physical_lineage_transiti_source_kind_source_id_revisi_fkey')) expected(tbl,ref,fk) JOIN pg_constraint c ON c.conrelid=to_regclass('public.'||tbl) AND c.conname=fk AND c.contype='f' AND c.confdeltype='r' AND c.confrelid=to_regclass('public.'||ref) JOIN pg_class remote ON remote.oid=c.confrelid JOIN pg_namespace remote_ns ON remote_ns.oid=remote.relnamespace AND remote_ns.nspname='public' AND remote.relname=ref;" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass('public.mdf_physical_lineage_contracts'),to_regclass('public.mdf_physical_lineage_transitions')]) AND NOT convalidated);" \
      "SELECT NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid=ANY(ARRAY[to_regclass('public.mdf_physical_lineage_contracts'),to_regclass('public.mdf_physical_lineage_transitions')]) AND (NOT indisvalid OR NOT indisready));" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_source_heads') AND t.tgname='mdf_source_fence_guard' AND t.tgfoid=to_regprocedure('public.mdf_guard_source_fence()') AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT count(*)=2 FROM (VALUES ('mdf_revision_context','mdf_context_immutable'),('mdf_revision_demand','mdf_demand_immutable')) expected(tbl,trg) JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||tbl) AND t.tgname=trg AND t.tgfoid=to_regprocedure('public.mdf_reject_evidence_change()') AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_recalculation_jobs') AND t.tgname='mdf_job_effect_policy_binding' AND t.tgfoid=to_regprocedure('public.mdf_guard_job_effect_policy_binding()') AND t.tgtype=23 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" \
      "SELECT count(*)=1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.mdf_source_heads') AND t.tgname='mdf_accepted_revision_guard' AND t.tgfoid=to_regprocedure('public.mdf_guard_accepted_revision()') AND t.tgtype=19 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgattr=''::int2vector;" ;;
    *) return 2 ;;   # unknown file: no classification (guard test keeps this impossible)
  esac
}

# These migrations contain conditional or multi-step DDL, or define an exact
# realtime contract. A partial/drifted object must never advance the ledger.
# Never record them until the complete effect probe passes.
verify_applied_effect() {
  local f="$1"
  case "$f" in
    177_cut_result_typed_hdf*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    175_mdf_command_placement*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    174_mdf_execution_context*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    178_mdf_correction_receipts*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    179_mdf_active_return*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    180_mdf_cnc_observations*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    181_cnc_manual_send_observation*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    183_whatsapp_daily_digest*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    184_whatsapp_daily_digest_schedule*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    185_mdf_bazis_composition*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    187_mdf_bazis_refill_rows*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    188_mdf_order_cascade_intents*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    189_mdf_placement_inputs*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    186_bitrix24_product_import*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    182_mdf_physical_lineage*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    173_inbound_signals*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    151_*|152_*|156_*|157_*|160_*|161_*|162_*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    164_*|165_*|166_*|167_*|168_*|169_*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    170_*|171_*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    172_*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; not recorded in schema_migrations."
      ;;
    073_*|074_*|087_*|088_*|089_*|091_*|094_*|095_*|096_*|097_*|098_*|099_*|100_*|101_*|102_*|103_*|104_*|105_*|106_*|107_*|108_*|109_*|110_*|111_*|112_*|113_*|114_*|115_*|116_*|117_*|118_*|119_*|120_*|121_*|122_*|123_*|124_*|125_*|126_*|127_*|128_*|129_*|130_*|131_*|132_*|133_*|134_*|135_*|136_*|137_*|138_*|139_*|140_*|141_*|142_*|143_*|144_*|145_*|146_*|147_*|148_*|149_*|150_*|153_*|154_*)
      probe_file "$f" || die "migration '$f' executed but its end-state probe is still PENDING; it was NOT recorded in schema_migrations. Repair the partial schema, then re-run."
      ;;
  esac
}

probe_076_endstate() {
  probe_all "$(q_col bazis_cut_set_details source_bazis_product_name)" \
            "SELECT NOT EXISTS (
               SELECT 1
               FROM bazis_cut_set_details snapshot
               JOIN order_details source ON source.detail_id = snapshot.source_order_detail_id
               WHERE snapshot.source_bazis_project_name IS DISTINCT FROM COALESCE(NULLIF(btrim(source.basis_project), ''), '')
                  OR snapshot.source_bazis_order_no IS DISTINCT FROM COALESCE(NULLIF(btrim(source.basis_project), ''), '')
                  OR snapshot.source_bazis_product_name IS DISTINCT FROM COALESCE(NULLIF(btrim(source.basis_product), ''), '')
             );"
}

probe_077_endstate() {
  probe_true "SELECT NOT EXISTS (
    WITH latest_order AS (
      SELECT DISTINCT ON (r.bazis_project_id)
             r.bazis_project_id,
             COALESCE(
               NULLIF(btrim(r.bazis_order_no), ''),
               (
                 SELECT NULLIF(btrim(n.raw_json->>'Заказ'), '')
                 FROM bazis_nodes n
                 WHERE n.revision_id = r.bazis_revision_id
                   AND n.parent_node_id IS NULL
                   AND NULLIF(btrim(n.raw_json->>'Заказ'), '') IS NOT NULL
                 ORDER BY n.seq
                 LIMIT 1
               )
             ) AS order_name
      FROM bazis_project_revisions r
      ORDER BY r.bazis_project_id, r.revision_no DESC, r.imported_at DESC, r.bazis_revision_id DESC
    )
    SELECT 1
    FROM bazis_projects project
    JOIN latest_order latest ON latest.bazis_project_id = project.bazis_project_id
    WHERE latest.order_name IS NOT NULL
      AND project.name IS DISTINCT FROM latest.order_name
      AND EXISTS (
        SELECT 1
        FROM bazis_project_revisions legacy_revision
        WHERE legacy_revision.bazis_project_id = project.bazis_project_id
          AND legacy_revision.product_name = project.name
      )
  );"
}

probe_078_endstate() {
  probe_all "SELECT EXISTS (
               SELECT 1
               FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name='bazis_cut_set_details'
                 AND column_name='position'
                 AND data_type='text'
             );" \
            "SELECT NOT EXISTS (
               SELECT 1
               FROM bazis_cut_set_details snapshot
               JOIN order_details source ON source.detail_id = snapshot.source_order_detail_id
               WHERE snapshot.position IS DISTINCT FROM CASE
                 WHEN NULLIF(btrim(COALESCE(source.basis_product, '')), '') IS NULL
                  AND NULLIF(btrim(COALESCE(source.basis_designation, '')), '') IS NULL
                   THEN ''
                 ELSE COALESCE(NULLIF(btrim(source.basis_product), ''), '')
                   || '.' || COALESCE(NULLIF(btrim(source.basis_designation), ''), '')
               END
             );"
}

# 075 includes a data rewrite. Columns alone are not enough: a restored
# database may already expose names while saved templates still bind raw ids.
probe_075_endstate() {
  probe_all "$(q_col order_details_view milling_type_name)" \
            "$(q_col order_details_view film_name)" \
            "$(q_col label_templates field_catalog_snapshot)" \
            "$(q_col label_qr_templates field_catalog_snapshot)" || return 1
  probe_true "SELECT NOT EXISTS (
    SELECT 1
    FROM label_template_elements lte
    WHERE btrim(COALESCE(lte.source_field, ''))
            IN ('detail.milling_type_id', 'detail.film_id')
       OR COALESCE(lte.style_json->>'qrTemplate', '')
            ~ '\{[[:space:]]*detail\.(milling_type_id|film_id)[[:space:]]*\}'
       OR btrim(COALESCE(lte.condition_json->>'field', ''))
            IN ('detail.milling_type_id', 'detail.film_id')
    UNION ALL
    SELECT 1
    FROM label_templates lt
    WHERE lt.field_catalog_snapshot
            ?| ARRAY['detail.milling_type_id', 'detail.film_id']
    UNION ALL
    SELECT 1
    FROM label_templates lt
    CROSS JOIN LATERAL jsonb_each(lt.custom_field_schema) entry
    WHERE btrim(COALESCE(entry.value->>'sourceField', ''))
            IN ('detail.milling_type_id', 'detail.film_id')
    UNION ALL
    SELECT 1
    FROM label_qr_templates lqt
    WHERE lqt.content_template
            ~ '\{[[:space:]]*detail\.(milling_type_id|film_id)[[:space:]]*\}'
       OR lqt.field_catalog_snapshot
            ?| ARRAY['detail.milling_type_id', 'detail.film_id']
    UNION ALL
    SELECT 1
    FROM order_label_detail_data data
    CROSS JOIN LATERAL jsonb_each(data.custom_field_schema_snapshot) entry
    WHERE btrim(COALESCE(entry.value->>'sourceField', ''))
            IN ('detail.milling_type_id', 'detail.film_id')
  );"
}

# 003 policy probe: the numeric-cast guard is present in orders_view.
probe_003_guard() {
  probe_true "SELECT CASE WHEN to_regclass('public.orders_view') IS NULL THEN false ELSE pg_get_viewdef('public.orders_view') LIKE '%2147483647%' END;"
}

# 034 end-state (Variant B sunset fully materialized). Runs prereq probes
# first so missing columns/views make it cleanly false instead of erroring.
probe_034_endstate() {
  probe_all "$(q_col materials is_sheet_shadow)" \
            "$(q_col order_details sheet_material_type_id)" || return 1
  local v
  for v in orders_view order_details_view orders_alias_view doweling_orders_view details_of_order; do
    probe_true "SELECT to_regclass('public.$v') IS NOT NULL;" || return 1
  done
  probe_all "$(q_con chk_orders_material_id_null)" \
            "$(q_con chk_order_details_sheet_only)" \
            "SELECT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='order_details' AND a.attname='sheet_material_type_id' AND a.attnotnull);" \
            "SELECT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_order_detail_shadow_pairing');" \
            "SELECT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='assert_order_detail_shadow_pairing');" \
            "SELECT NOT EXISTS (SELECT 1 FROM materials WHERE is_sheet_shadow);" \
            "SELECT NOT EXISTS (SELECT 1 FROM order_details WHERE material_id IS NOT NULL);" \
            "SELECT NOT EXISTS (SELECT 1 FROM orders WHERE material_id IS NOT NULL);" || return 1
  # Full parity with the 034_verify zero-set: a post-clear-hard-stop rerun must
  # not bless a state the verify script still calls failed.
  probe_all "SELECT NOT EXISTS (SELECT 1 FROM orders WHERE delete_flag = false AND sheet_eligible = false);" \
            "SELECT NOT EXISTS (SELECT 1 FROM order_details od JOIN sheet_material_types s ON s.sheet_material_type_id = od.sheet_material_type_id WHERE s.is_cuttable = false);" || return 1
  # Semantic sheet-only marker: no legacy materials fallback in any of the five
  # views (pre-034 forms all read m.material_name via LEFT JOIN materials m;
  # post-034/036 forms read smt.name only). Survives the legit 036 rewrite.
  for v in orders_view order_details_view orders_alias_view doweling_orders_view details_of_order; do
    probe_true "SELECT pg_get_viewdef('public.$v') NOT LIKE '%m.material_name%';" || return 1
  done
  return 0
}

ledger_insert() {  # $1 filename, $2 checksum
  pg_query "INSERT INTO schema_migrations(filename, checksum) VALUES ('$1', '$2')
            ON CONFLICT (filename) DO NOTHING;" >/dev/null
}

# --- view-drift auto-heal ----------------------------------------------------
VIEW_ALLOWLIST="orders_view order_details_view orders_alias_view doweling_orders_view details_of_order"

# Apply one file; on 'cannot change ... of view column' drop the file's own
# views (allowlist + no outside dependents) and retry ONCE.
apply_file_with_heal() {
  local f="$1" out
  if out="$(pg_apply_file "$MIG_DIR/$f" 2>&1)"; then return 0; fi
  printf '%s\n' "$out" | tail -15 >&2
  printf '%s' "$out" | grep -qE 'cannot change (name|data type) of( a)? view column' \
    || return 1
  local views v
  views="$(grep -oiE 'CREATE OR REPLACE VIEW[[:space:]]+[A-Za-z_"]+' "$MIG_DIR/$f" | awk '{print $NF}' | tr -d '"' | sort -u)"
  [ -n "$views" ] || return 1
  for v in $views; do
    case " $VIEW_ALLOWLIST " in
      *" $v "*) : ;;
      *) err "view-heal: '$v' is not in the ERP view allowlist — manual action required"; return 1 ;;
    esac
    # Dependency closure: any OTHER view/matview reading from $v means this
    # file will not recreate it -> abort (fail-closed).
    local deps
    deps="$(pg_query "SELECT DISTINCT c2.relname || '|' || c2.relkind
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class c2 ON c2.oid = rw.ev_class
      WHERE d.refobjid = to_regclass('public.$v')
        AND c2.relname <> '$v';")"
    if [ -n "$deps" ]; then
      err "view-heal: '$v' has dependent relations this migration will not recreate:"
      printf '%s\n' "$deps" >&2
      return 1
    fi
  done
  for v in $views; do
    err "view-heal: dropping stale view '$v' (drifted column set from the restored dump) and retrying $f"
    pg_query "DROP VIEW IF EXISTS public.$v;" >/dev/null
  done
  if out="$(pg_apply_file "$MIG_DIR/$f" 2>&1)"; then return 0; fi
  printf '%s\n' "$out" | tail -15 >&2
  return 1
}

# --- Variant B (033/034) gate -------------------------------------------------
COVERAGE_SQL="WITH mappable AS (
  SELECT material_id AS mid FROM materials WHERE is_sheet_shadow = false AND sheet_material_type_id IS NOT NULL
  UNION SELECT legacy_material_id FROM sheet_material_conversion_map WHERE legacy_material_id IS NOT NULL
  UNION SELECT m.material_id FROM sheet_material_conversion_map cm
          JOIN materials m ON m.material_name = cm.legacy_material_name AND NOT m.is_sheet_shadow
         WHERE cm.legacy_material_name IS NOT NULL
)
SELECT 'detail' AS src, od.material_id, m.material_name, count(*)
  FROM order_details od JOIN materials m ON m.material_id = od.material_id
 WHERE od.material_id IS NOT NULL AND od.sheet_material_type_id IS NULL
   AND od.material_id NOT IN (SELECT mid FROM mappable)
 GROUP BY 1,2,3
UNION ALL
SELECT 'header', o.material_id, m.material_name, count(*)
  FROM orders o JOIN materials m ON m.material_id = o.material_id
 WHERE o.material_id IS NOT NULL AND o.sheet_material_type_id IS NULL
   AND o.material_id NOT IN (SELECT mid FROM mappable)
 GROUP BY 1,2,3
ORDER BY 1,2;"

# Emit candidate INSERT rows for every uncovered legacy material.
# Placement decides cuttability (operator decision 2026-07-04):
#  - used on order details  -> ALWAYS cuttable (034 forbids non-cuttable on a
#    detail). Known sheet names get real dims; unknown names get SENTINEL
#    1×1×1 dims + unit/mtype = 1 so the operator can list and fix them later
#    (e.g. WHERE width_mm = 1) instead of the run stopping for manual work.
#  - seen ONLY on order headers -> non-cuttable placeholder (unchanged).
build_map_candidates() {   # stdin: src|mid|name|n rows; stdout: SQL
  local line src mid name n verdict th mtype cut
  declare -A on_detail=()
  declare -A names=()
  while IFS='|' read -r src mid name n; do
    [ -n "$mid" ] || continue
    names["$mid"]="$name"
    [ "$src" = "detail" ] && on_detail["$mid"]=1
  done
  echo "-- migration-auto conversion-map candidates ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "-- REVIEW each row; for real go-live commit reviewed rows into 033."
  local k
  for k in "${!names[@]}"; do
    name="${names[$k]}"
    local esc_name="${name//\'/\'\'}"
    # Deterministic immutable key by legacy id (name mangling of Cyrillic is
    # multibyte-unsafe in tr/sed); one target type per uncovered material.
    local key="AUTO_MAT_$k"
    if [ -n "${on_detail[$k]+x}" ]; then
      verdict="$(bash "$0" classify-material-name "$name")"
      IFS='|' read -r cut th mtype <<<"$verdict"
      if [ "$cut" = "cuttable" ]; then
        echo "INSERT INTO sheet_material_conversion_map (legacy_material_id, target_key, target_sheet_name, is_cuttable, target_unit_id, target_material_type_id, target_width_mm, target_height_mm, target_thickness_mm) VALUES ($k, '$key', '$esc_name', true, 1, $mtype, 2800, 2070, $th) ON CONFLICT DO NOTHING;"
      else
        # unknown detail material -> cuttable SENTINEL row (all required sheet
        # fields = 1); operator finds these later via width_mm = 1.
        echo "INSERT INTO sheet_material_conversion_map (legacy_material_id, target_key, target_sheet_name, is_cuttable, target_unit_id, target_material_type_id, target_width_mm, target_height_mm, target_thickness_mm) VALUES ($k, '$key', '$esc_name', true, 1, 1, 1, 1, 1) ON CONFLICT DO NOTHING;  -- SENTINEL: проверить и заполнить реальные размеры"
      fi
    else
      echo "INSERT INTO sheet_material_conversion_map (legacy_material_id, target_key, target_sheet_name, is_cuttable, target_unit_id, target_material_type_id, target_width_mm, target_height_mm, target_thickness_mm) VALUES ($k, '$key', '$esc_name', false, 1, 3, 1, 1, 1) ON CONFLICT DO NOTHING;"
    fi
  done
}
# ========================== end auto-mode machinery ==========================

# Applied set (psql -A emits "filename|checksum"), empty if no ledger.
declare -A APPLIED_SUM=()
if ledger_exists; then
  while IFS='|' read -r fn sum; do
    [ -n "$fn" ] && APPLIED_SUM["$fn"]="$sum"
  done < <(pg_query "SELECT filename, checksum FROM schema_migrations;")
fi

print_plan() {
  local pending=0 applied=0 drift=0
  printf '%-58s %s\n' "MIGRATION" "STATE"
  printf '%-58s %s\n' "---------" "-----"
  for f in "${FILES[@]}"; do
    local cur; cur="$(checksum_of "$f")"
    if [ -n "${APPLIED_SUM[$f]+x}" ]; then
      if [ "${APPLIED_SUM[$f]}" = "$cur" ]; then
        printf '%-58s applied\n' "$f"; applied=$((applied+1))
      else
        printf '%-58s applied (⚠ CHECKSUM DRIFT — file changed after apply)\n' "$f"
        applied=$((applied+1)); drift=$((drift+1))
      fi
    else
      printf '%-58s PENDING\n' "$f"; pending=$((pending+1))
    fi
  done
  echo
  echo "Total: ${#FILES[@]}  applied: $applied  pending: $pending  drift: $drift"
  PENDING_COUNT="$pending"; DRIFT_COUNT="$drift"
}

# --- Dispatch ----------------------------------------------------------------
case "$MODE" in
  probe)
    [ "${#TARGETS[@]}" -eq 1 ] \
      || die "probe needs exactly one migration filename or version"
    PROBE_TARGET=""
    PROBE_MATCHES=0
    for f in "${FILES[@]}"; do
      if [ "$f" = "${TARGETS[0]}" ] \
         || { [[ "${TARGETS[0]}" =~ ^[0-9]+$ ]] \
              && [ "$(version_of "$f")" = "$(version_of "${TARGETS[0]}")" ]; }; then
        PROBE_TARGET="$f"
        PROBE_MATCHES=$((PROBE_MATCHES + 1))
      fi
    done
    [ "$PROBE_MATCHES" -gt 0 ] || die "probe: no migration matches '${TARGETS[0]}'"
    [ "$PROBE_MATCHES" -eq 1 ] \
      || die "probe: version '${TARGETS[0]}' is ambiguous; pass the full filename"
    if probe_file "$PROBE_TARGET"; then
      echo "$PROBE_TARGET PRESENT"
      exit 0
    else
      PROBE_RC=$?
    fi
    [ "$PROBE_RC" -ne 2 ] \
      || die "probe: migration '$PROBE_TARGET' has no effect probe"
    echo "$PROBE_TARGET PENDING"
    exit 1
    ;;

  dry-run|status)
    if ! ledger_exists; then
      err "NOTE: schema_migrations ledger does not exist yet — every file shown as PENDING."
      err "If this DB was already migrated (e.g. erp_test), run: $0 baseline --yes"
    fi
    hard_stop_present && err "WARNING: a ${HARD_STOP_PREFIX}* sentinel is present — mutating modes are blocked (see 'auto --clear-hard-stop')."
    print_plan
    [ "$MODE" = "dry-run" ] && echo && echo "(dry-run: nothing applied)"
    exit 0
    ;;

  baseline)
    hard_stop_gate
    ensure_ledger
    echo "Baseline: recording ${#FILES[@]} migration files as applied WITHOUT running them."
    if [ "$ASSUME_YES" -ne 1 ]; then
      read -r -p "Proceed? [y/N] " a; [ "$a" = "y" ] || die "aborted"
    fi
    for f in "${FILES[@]}"; do
      pg_query "INSERT INTO schema_migrations(filename, checksum)
                VALUES ('$f', '$(checksum_of "$f")')
                ON CONFLICT (filename) DO NOTHING;" >/dev/null
    done
    echo "Baseline recorded. Pending is now empty (run '$0 status' to confirm)."
    ;;

  mark-applied)
    hard_stop_gate
    ensure_ledger
    declare -a SEL=()
    if [ -n "$MARK_UPTO" ]; then
      for f in "${FILES[@]}"; do
        [ "$(version_of "$f")" -le "$(version_of "$MARK_UPTO")" ] && SEL+=("$f")
      done
    fi
    for t in "${TARGETS[@]}"; do
      local_match=0
      for f in "${FILES[@]}"; do
        if [ "$f" = "$t" ] || [ "$(version_of "$f")" = "$(version_of "$t")" ]; then
          SEL+=("$f"); local_match=1
        fi
      done
      [ "$local_match" -eq 1 ] || die "no migration matches target '$t'"
    done
    [ "${#SEL[@]}" -gt 0 ] || die "mark-applied needs --upto NNN and/or target versions/filenames"
    mapfile -t SEL < <(printf '%s\n' "${SEL[@]}" | sort -u)
    echo "Mark as applied WITHOUT running (${#SEL[@]} file(s)):"
    printf '  %s\n' "${SEL[@]}"
    if [ "$ASSUME_YES" -ne 1 ]; then
      read -r -p "Proceed? [y/N] " a; [ "$a" = "y" ] || die "aborted"
    fi
    for f in "${SEL[@]}"; do
      pg_query "INSERT INTO schema_migrations(filename, checksum)
                VALUES ('$f', '$(checksum_of "$f")')
                ON CONFLICT (filename) DO NOTHING;" >/dev/null
    done
    echo "Marked. Run '$0 status' to confirm; remaining files stay PENDING."
    ;;

  apply)
    hard_stop_gate
    ensure_ledger
    # Recompute applied set now the ledger surely exists.
    APPLIED_SUM=()
    while IFS='|' read -r fn sum; do [ -n "$fn" ] && APPLIED_SUM["$fn"]="$sum"; done \
      < <(pg_query "SELECT filename, checksum FROM schema_migrations;")
    print_plan
    if [ "${PENDING_COUNT:-0}" -eq 0 ]; then echo; echo "Nothing to apply."; exit 0; fi
    echo
    err "About to apply pending migration(s) to db on container '$CONTAINER'$([ -n "$APPLY_TO" ] && echo " up to version $APPLY_TO")."
    err "Review the PENDING list above. Destructive/structural migrations (e.g. the"
    err "034 Variant-B sunset) change/drop data — be sure this is intended."
    if [ "$ASSUME_YES" -ne 1 ]; then
      read -r -p "Apply now? [y/N] " a; [ "$a" = "y" ] || die "aborted"
    fi
    for f in "${FILES[@]}"; do
      [ -n "${APPLIED_SUM[$f]+x}" ] && continue
      if [ -n "$APPLY_TO" ] && [ "$(version_of "$f")" -gt "$(version_of "$APPLY_TO")" ]; then
        echo "(stopping before $f — reached --to $APPLY_TO)"; break
      fi
      echo ">> applying $f"
      if pg_apply_file "$MIG_DIR/$f"; then
        verify_applied_effect "$f"
        pg_query "INSERT INTO schema_migrations(filename, checksum)
                  VALUES ('$f', '$(checksum_of "$f")')
                  ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();" >/dev/null
        echo "   ok"
      else
        die "FAILED on $f — stopped. Fix and re-run; already-applied files are skipped."
      fi
    done
    echo "All pending migrations applied."
    ;;

  auto)
    # ------------------------------------------------------------------
    # One-command bring-up of a freshly RESTORED prod dump to the current
    # migration head. See the plan:
    # spec_erp/plans/2026-07-04-auto-migrations-restored-dump-plan.md
    # ------------------------------------------------------------------
    if [ "$CLEAR_HARD_STOP" -eq 1 ] && ledger_exists; then
      err "Clearing ${HARD_STOP_PREFIX}* sentinel(s) on operator request."
      pg_query "DELETE FROM schema_migrations WHERE filename LIKE '${HARD_STOP_PREFIX}%';" >/dev/null
    fi
    hard_stop_gate

    # Step 0: restore-vs-greenfield discriminator (fail-closed).
    probe_true "SELECT to_regclass('public.orders') IS NOT NULL;" \
      || die "auto: table 'orders' not found — this looks like an EMPTY database.
auto is for a RESTORED dump. For greenfield use: schema v14 + '$0 apply --yes'."
    if ! probe_true "SELECT EXISTS (SELECT 1 FROM orders);"; then
      [ "$ASSUME_RESTORED" -eq 1 ] || die "auto: 'orders' is empty — cannot tell a restored dump from a fresh schema.
- greenfield (fresh v14 schema): use '$0 apply --yes' instead;
- genuinely restored dump with zero orders: re-run with --assume-restored."
    fi

    # detect-only stays DB-read-only: the ledger table is created lazily below.
    [ "$DETECT_ONLY" -eq 1 ] || ensure_ledger
    APPLIED_SUM=()
    if ledger_exists; then
      while IFS='|' read -r fn sum; do [ -n "$fn" ] && APPLIED_SUM["$fn"]="$sum"; done \
        < <(pg_query "SELECT filename, checksum FROM schema_migrations;")
    fi

    # Artifacts dir
    RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
    if [ -z "$ARTIFACTS_DIR" ]; then
      ARTIFACTS_DIR="$REPO_ERP/../backups/migration-auto-$RUN_TS"
      mkdir -p "$ARTIFACTS_DIR" 2>/dev/null || ARTIFACTS_DIR="$(mktemp -d /tmp/migration-auto-$RUN_TS.XXXX)"
    else
      mkdir -p "$ARTIFACTS_DIR"
    fi
    REPORT="$ARTIFACTS_DIR/detection-report.txt"

    # Run-start snapshot of 041 target candidates (case-insensitive SUPERSET of
    # 041's own selectors — standard template by lower(name), imports by ILIKE).
    SNAPSHOT_041=""
    if probe_true "SELECT to_regclass('public.label_templates') IS NOT NULL;"; then
      SNAPSHOT_041="$(pg_query "SELECT label_template_id FROM label_templates
        WHERE deleted_at IS NULL
          AND (lower(name) = lower('Стандартная бирка Bazis 85x88')
               OR name ILIKE 'импорт bazis %');")"
    fi

    # Step 1: detection — classify every non-ledgered file.
    # NOTE: no `| tee` around this block — a pipe would fork a subshell and
    # silently drop the CLASS[] assignments. Write the report, then cat it.
    declare -A CLASS=()   # filename -> APPLIED | PRESENT | PENDING | DEFERRED | POLICY-SKIP
    {
      printf '%-58s %s\n' "MIGRATION" "AUTO CLASSIFICATION"
      printf '%-58s %s\n' "---------" "-------------------"
      for f in "${FILES[@]}"; do
        if [ -n "${APPLIED_SUM[$f]+x}" ]; then
          CLASS["$f"]="APPLIED"; printf '%-58s applied (ledger)\n' "$f"; continue
        fi
        case "$f" in
          003_*)
            if probe_003_guard; then
              CLASS["$f"]="PRESENT"; printf '%-58s PRESENT (orders_view already carries the numeric guard)\n' "$f"
            else
              CLASS["$f"]="POLICY-SKIP"; printf '%-58s POLICY-SKIP (restore path never replaces the dump orders_view; 034 rebuilds it canonically)\n' "$f"
            fi ;;
          041_*)
            CLASS["$f"]="DEFERRED"; printf '%-58s DEFERRED (decided at its apply slot, after 039/040_seed)\n' "$f" ;;
          *)
            if probe_file "$f"; then
              CLASS["$f"]="PRESENT"; printf '%-58s PRESENT (effect found in dump)\n' "$f"
            else
              rc=$?
              [ "$rc" -eq 2 ] && die "auto: no classification for '$f' — extend probe_file() (guard test should have caught this)"
              CLASS["$f"]="PENDING"; printf '%-58s PENDING (will apply)\n' "$f"
            fi ;;
        esac
      done
    } > "$REPORT"
    cat "$REPORT"
    echo
    echo "Detection report saved: $REPORT"

    if [ "$DETECT_ONLY" -eq 1 ]; then echo "(detect-only: nothing changed)"; exit 0; fi

    if [ "$ASSUME_YES" -ne 1 ]; then
      read -r -p "Proceed with the plan above? [y/N] " a; [ "$a" = "y" ] || die "aborted"
    fi

    # Step 2: ledger for PRESENT + 003 policy (041 NEVER here — deferred).
    for f in "${FILES[@]}"; do
      case "${CLASS[$f]}" in
        PRESENT|POLICY-SKIP) ledger_insert "$f" "$(checksum_of "$f")" ;;
      esac
    done

    # Steps 3-5: ordered apply loop with the special slots.
    for f in "${FILES[@]}"; do
      case "${CLASS[$f]}" in APPLIED|PRESENT|POLICY-SKIP) continue ;; esac

      case "$f" in
        034_*)
          # ---- Variant B gate (033 is already applied by loop order) ----
          echo ">> Variant B gate before $f"
          # Approved recovery path: "review candidates -> commit rows into 033 ->
          # rerun auto". 033 is already ledgered by then, so replay it here on
          # checksum drift (only possible while 034 is not yet ledgered; the
          # manifest is a re-runnable full replace by design).
          F033="$(printf '%s\n' "${FILES[@]}" | grep '^033_' | head -1)"
          if [ -n "$F033" ] && [ -n "${APPLIED_SUM[$F033]+x}" ] \
             && [ "${APPLIED_SUM[$F033]}" != "$(checksum_of "$F033")" ]; then
            echo ">> $F033 was edited after it was ledgered — replaying the manifest"
            apply_file_with_heal "$F033" || die "auto: FAILED replaying edited $F033"
            pg_query "UPDATE schema_migrations SET checksum='$(checksum_of "$F033")', applied_at=now()
                      WHERE filename='$F033';" >/dev/null
          fi
          # Self-heal OUR earlier auto-map rows (AUTO_MAT_% only — committed
          # manifest rows are operator-reviewed and never touched): a previous
          # run may have classified a detail-used material non-cuttable; 034
          # forbids that, so flip such rows to the cuttable SENTINEL shape.
          if [ "$AUTO_MAP" -eq 1 ]; then
            FLIPPED="$(pg_query "UPDATE sheet_material_conversion_map cm
              SET is_cuttable = true, target_unit_id = 1, target_material_type_id = 1,
                  target_width_mm = 1, target_height_mm = 1, target_thickness_mm = 1
              WHERE cm.target_key LIKE 'AUTO_MAT_%' AND cm.is_cuttable = false
                AND EXISTS (SELECT 1 FROM order_details od
                            WHERE od.material_id = cm.legacy_material_id
                              AND od.sheet_material_type_id IS NULL)
              RETURNING cm.legacy_material_id;")"
            if [ -n "$FLIPPED" ]; then
              echo "auto-map: flipped earlier non-cuttable AUTO_MAT rows to cuttable SENTINEL (1×1×1) for detail-used materials: $(printf '%s' "$FLIPPED" | tr '\n' ' ')"
            fi
            # Type reconcile runs UNCONDITIONALLY (not only when rows were
            # flipped this run): if a previous run died between the map flip
            # and this sync, FLIPPED is empty on rerun but a stale
            # non-cuttable type would make 034's structural check abort
            # forever. Attrs come from the map row (matches 034 §0.0b2).
            pg_query "UPDATE sheet_material_types s
              SET is_cuttable = true, unit_id = cm.target_unit_id,
                  material_type_id = cm.target_material_type_id
              FROM sheet_material_conversion_map cm
              WHERE s.conversion_key = cm.target_key
                AND cm.target_key LIKE 'AUTO_MAT_%' AND cm.is_cuttable = true
                AND s.is_cuttable = false;" >/dev/null
          fi
          COV="$(pg_query "$COVERAGE_SQL")"
          if [ -n "$COV" ]; then
            CAND="$ARTIFACTS_DIR/conversion-map-candidates.sql"
            printf '%s\n' "$COV" | build_map_candidates > "$CAND"
            echo "Uncovered legacy materials:" ; printf '%s\n' "$COV"
            echo "Candidate manifest rows written to: $CAND"
            if [ "$AUTO_MAP" -ne 1 ]; then
              die "auto: conversion map does not cover all legacy materials.
Review $CAND — commit reviewed rows into 033 (go-live) or re-run with --auto-map."
            fi
            echo ">> --auto-map: applying candidate rows"
            pg_apply_file "$CAND" >/dev/null
            ledger_insert "zz_automap_${RUN_TS}" "$(sha256sum "$CAND" | awk '{print $1}')"
            COV="$(pg_query "$COVERAGE_SQL")"
            [ -z "$COV" ] || { printf '%s\n' "$COV"; die "auto: coverage still incomplete after --auto-map — manual manifest work required."; }
          fi
          echo ">> running 034_preflight.sql checks"
          PREF_OUT="$(_exec sh -c 'psql -U "${MIG_USER:-$POSTGRES_USER}" -d "${MIG_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1 -qtAF "|"' < "$MIG_DIR/034_preflight.sql" 2>&1)" \
            || { printf '%s\n' "$PREF_OUT"; die "auto: 034_preflight.sql failed to execute."; }
          printf '%s\n' "$PREF_OUT" > "$ARTIFACTS_DIR/034-preflight-output.txt"
          if printf '%s\n' "$PREF_OUT" | grep -qE '^(unmapped-|dual-mismatch|ambiguous-map|non-cuttable-on-detail)'; then
            printf '%s\n' "$PREF_OUT" | grep -E '^(unmapped-|dual-mismatch|ambiguous-map|non-cuttable-on-detail)' >&2
            die "auto: 034 preflight found blocking rows (see $ARTIFACTS_DIR/034-preflight-output.txt). These are not auto-fixable by design."
          fi
          if printf '%s\n' "$PREF_OUT" | grep -E 'shadow-FK-leak' | grep -vqE ': 0$'; then
            printf '%s\n' "$PREF_OUT" | grep -E 'shadow-FK-leak' >&2
            die "auto: shadow FK leak detected — resolve before Variant B (see runbook)."
          fi
          echo ">> applying $f (ledger deferred until verify passes)"
          apply_file_with_heal "$f" || die "auto: FAILED on $f — transaction rolled back; fix and re-run."
          echo ">> running 034_verify.sql"
          VER_OUT="$(_exec sh -c 'psql -U "${MIG_USER:-$POSTGRES_USER}" -d "${MIG_DB:-$POSTGRES_DB}" -v ON_ERROR_STOP=1 -qtAF "|"' < "$MIG_DIR/034_verify.sql" 2>&1)" \
            || { printf '%s\n' "$VER_OUT"; die "auto: 034_verify.sql failed to execute."; }
          printf '%s\n' "$VER_OUT" > "$ARTIFACTS_DIR/034-verify-output.txt"
          verify_get() { printf '%s\n' "$VER_OUT" | awk -F'|' -v k="$1" '$1==k {print $2; exit}'; }
          VER_FAIL=""
          for chk in "details WITHOUT sheet (all)" "details with material_id (all)" "orders with material_id (all)" "shadow materials remaining" "non-cuttable on a detail" "orders not sheet_eligible (non-deleted)"; do
            v="$(verify_get "$chk")"
            [ "$v" = "0" ] || VER_FAIL="$VER_FAIL; '$chk'=$v (expected 0)"
          done
          [ "$(verify_get 'details with sheet (all)')" = "$(verify_get 'details total (all)')" ] \
            || VER_FAIL="$VER_FAIL; details-with-sheet != details-total"
          if [ -n "$VER_FAIL" ]; then
            SENTINEL_REASON="verify-failed:${VER_FAIL:2}"
            SENTINEL_REASON="${SENTINEL_REASON//\'/}"   # keep the ledger INSERT quote-safe
            ledger_insert "${HARD_STOP_PREFIX}_034_${RUN_TS}" "$SENTINEL_REASON"
            die "auto: 034 POST-VERIFY FAILED:${VER_FAIL}
DB was converted but verification does not hold. HARD-STOP sentinel written —
ALL mutating runner modes are blocked. Investigate (034_rollback.sql, runbook,
$ARTIFACTS_DIR/034-verify-output.txt), then '$0 auto --clear-hard-stop'."
          fi
          ledger_insert "$f" "$(checksum_of "$f")"
          echo "   ok (verified)"
          ;;

        041_*)
          # ---- deferred operator-gated slot ----
          CUR="$(pg_query "SELECT label_template_id || '|' || name || '|' ||
                 CASE WHEN (name = 'Стандартная бирка Bazis 85x88' OR name LIKE 'Импорт Bazis %') THEN 'exact' ELSE 'drifted' END
            FROM label_templates
            WHERE deleted_at IS NULL
              AND (lower(name) = lower('Стандартная бирка Bazis 85x88')
                   OR name ILIKE 'импорт bazis %');")"
          if [ -z "$CUR" ]; then
            echo ">> applying $f (no candidate templates at all — genuine no-op)"
            apply_file_with_heal "$f" || die "auto: FAILED on $f"
            ledger_insert "$f" "$(checksum_of "$f")"
            continue
          fi
          PREEXIST=""; DRIFTED=""
          while IFS='|' read -r id name kind; do
            [ -n "$id" ] || continue
            case " ${SNAPSHOT_041//$'\n'/ } " in *" $id "*) PREEXIST="$PREEXIST  - [$kind] $name"$'\n' ;; esac
            [ "$kind" = "drifted" ] && DRIFTED="$DRIFTED  - $name"$'\n'
          done <<<"$CUR"
          if [ "$SKIP_041" -eq 1 ]; then
            echo ">> 041: --skip-041 — marking applied WITHOUT running (live layouts preserved)"
            ledger_insert "$f" "$(checksum_of "$f")"
            continue
          fi
          if [ -z "$PREEXIST" ] && [ -z "$DRIFTED" ]; then
            echo ">> applying $f (all target templates were created by THIS run — safe reset)"
            apply_file_with_heal "$f" || die "auto: FAILED on $f"
            ledger_insert "$f" "$(checksum_of "$f")"
            continue
          fi
          if [ "$RUN_041_RESET" -eq 1 ]; then
            [ -n "$DRIFTED" ] && err "041 NOTE: drifted names below will NOT be touched by 041 (rename back first if they must be reset):"$'\n'"$DRIFTED"
            echo ">> applying $f on operator request (--run-041-reset)"
            apply_file_with_heal "$f" || die "auto: FAILED on $f"
            ledger_insert "$f" "$(checksum_of "$f")"
            continue
          fi
          die "auto: 041 needs an operator decision — live label templates found:
${PREEXIST}${DRIFTED:+drifted (case-insensitive only; 041 would NOT touch them):
$DRIFTED}Re-run with:
  --skip-041       keep live layouts, mark 041 applied (usual for post-041 dumps)
  --run-041-reset  reset exact-matched templates to the canonical Bazis layout"
          ;;

        *)
          echo ">> applying $f"
          apply_file_with_heal "$f" || die "auto: FAILED on $f — stopped. Fix and re-run (idempotent)."
          verify_applied_effect "$f"
          ledger_insert "$f" "$(checksum_of "$f")"
          echo "   ok"
          ;;
      esac
    done

    # Step 6: realign identity/serial sequences (post-restore drift guard;
    # SQL mirrors ops/restore-prod-backup.sh — keep the two in sync).
    echo ">> realigning identity sequences to column max"
    pg_query "DO \$\$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col,
           pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I.%I), 1))',
                   r.seq, r.col, r.sch, r.tbl);
  END LOOP;
END \$\$;" >/dev/null

    # Step 7: final state must be clean.
    APPLIED_SUM=()
    while IFS='|' read -r fn sum; do [ -n "$fn" ] && APPLIED_SUM["$fn"]="$sum"; done \
      < <(pg_query "SELECT filename, checksum FROM schema_migrations;")
    print_plan
    [ "${PENDING_COUNT:-0}" -eq 0 ] || die "auto: ${PENDING_COUNT} migration(s) still pending — see above."
    echo
    # Loud visibility for the accepted --auto-map trade-off: unknown detail
    # materials were converted as cuttable SENTINELS (all-ones dims) instead
    # of stopping the run — list them so the operator fixes real sizes later.
    SENTINELS="$(pg_query "SELECT cm.legacy_material_id || ': ' || cm.target_sheet_name
      FROM sheet_material_conversion_map cm
      WHERE cm.target_key LIKE 'AUTO_MAT_%' AND cm.is_cuttable AND cm.target_width_mm = 1;" 2>/dev/null || true)"
    if [ -n "$SENTINELS" ]; then
      echo "⚠ SENTINEL materials converted with placeholder 1×1×1 dims — set real sheet sizes in the UI (Листовые материалы):"
      printf '%s\n' "$SENTINELS" | sed 's/^/    /'
      echo "    (list anytime: SELECT * FROM sheet_material_types WHERE width_mm = 1;)"
      echo
    fi
    echo "auto: DONE. Next steps:"
    echo "  1. Hasura metadata:  ops/apply-hasura-metadata.sh --metadata ops/hasura/metadata.json --env-file <.env>"
    echo "     (or up-all.sh provision --hasura bundled)"
    echo "  2. Feature flags + backend rebuild (see full-stack deployment doc §9)."
    echo "  3. Smoke: ops/smoke-vps.sh"
    ;;
esac
