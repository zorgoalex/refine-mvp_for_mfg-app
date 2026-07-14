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
  dry-run|status|apply|baseline|mark-applied|auto) MODE="$1"; shift ;;
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
  * ) die "unknown mode '${1}' (use dry-run|status|apply|baseline|mark-applied|auto)";;
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
q_idx()   { echo "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='$1');"; }
q_trg()   { echo "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='$1');"; }
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
    063_*) probe_all "$(q_col order_details doweling)" ;;
    *) return 2 ;;   # unknown file: no classification (guard test keeps this impossible)
  esac
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
