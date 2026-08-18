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
                              LIKE '%order_hdf_details%';" ;;
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
    *) return 2 ;;   # unknown file: no classification (guard test keeps this impossible)
  esac
}

# These migrations contain conditional or multi-step DDL, or define an exact
# realtime contract. A partial/drifted object must never advance the ledger.
# let PostgreSQL finish the file without reaching the required end state. Never
# record those migrations in the ledger until the complete effect probe passes.
verify_applied_effect() {
  local f="$1"
  case "$f" in
    073_*|074_*|087_*|088_*|089_*|091_*|094_*|095_*|096_*|097_*|098_*|099_*|100_*|101_*|102_*|103_*|104_*|105_*|106_*|107_*|108_*|109_*|110_*|111_*|112_*|113_*|114_*|115_*|116_*|117_*|118_*|119_*|120_*|121_*|122_*|123_*|124_*|125_*|126_*|127_*|128_*|129_*|130_*|131_*|132_*|133_*|135_*)
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
         || [ "$(version_of "$f")" = "$(version_of "${TARGETS[0]}")" ]; then
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
