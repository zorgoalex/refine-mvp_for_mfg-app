import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const script = resolve(__dirname, 'apply-migrations.sh');
const migDir = resolve(__dirname, '..', 'backend', 'db', 'migrations');
const scriptText = readFileSync(script, 'utf8');

function run(args: string[]) {
  return execFileSync('bash', [script, ...args], { encoding: 'utf8' });
}

describe('apply-migrations.sh auto — classification completeness guard', () => {
  // Every runner-selected migration file MUST have an auto-mode classification:
  // a probe_file() case arm, or the dedicated 003/041 policy logic. A new
  // migration landing without one must fail this test (probe map maintenance).
  const files = readdirSync(migDir)
    .filter((f) => /^[0-9].*\.sql$/.test(f))
    .filter((f) => !/_(preflight|verify|rollback)\.sql$/.test(f))
    .sort();

  it('finds the migration set (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('034_order_material_sunset_legacy.sql');
  });

  // Scope the arm scan to the probe_file() function body only — an arm in the
  // apply loop (e.g. the 034 gate) must NOT satisfy the classification guard.
  const probeFnStart = scriptText.indexOf('probe_file() {');
  const probeFnEnd = scriptText.indexOf('# 003 policy probe', probeFnStart);
  const probeFn = scriptText.slice(probeFnStart, probeFnEnd);

  it('scopes the guard to the probe_file body (sanity)', () => {
    expect(probeFnStart).toBeGreaterThan(-1);
    expect(probeFnEnd).toBeGreaterThan(probeFnStart);
    expect(probeFn).toContain('esac');
  });

  it.each(files)('%s is classified in auto mode', (f) => {
    if (f.startsWith('003_') || f.startsWith('041_')) {
      // Dedicated policy / deferred-slot logic, asserted below.
      return;
    }
    // A case arm must match this file INSIDE probe_file(). Reproduce the shell
    // matching: an arm pattern like `034_*)` or `040_seed_standard_label_template*)`.
    const arms = [...probeFn.matchAll(/^\s+([0-9][A-Za-z0-9_]*)\*\)/gm)].map((m) => m[1]);
    const matched = arms.some((prefix) => f.startsWith(prefix));
    expect(matched, `probe_file() has no case arm for ${f} — extend the probe map`).toBe(true);
  });

  it('003 has the policy probe and 041 the deferred slot', () => {
    expect(scriptText).toMatch(/probe_003_guard\(\)/);
    expect(scriptText).toMatch(/2147483647/);
    expect(scriptText).toMatch(/DEFERRED \(decided at its apply slot/);
    expect(scriptText).toMatch(/--run-041-reset/);
    expect(scriptText).toMatch(/--skip-041/);
  });

  it('the three 040_* files have distinct arms (filename-keyed map)', () => {
    expect(scriptText).toMatch(/040_cut_job_sheet_material\*/);
    expect(scriptText).toMatch(/040_seed_standard_label_template\*/);
    expect(scriptText).toMatch(/040_user_preferences\*/);
  });

  it('fingerprints every realtime constraint, function, and statement trigger', () => {
    const requiredConstraints = [
      'order_realtime_stream_pkey',
      'order_realtime_stream_order_id_fkey',
      'chk_order_realtime_stream_commit_sequence',
      'chk_order_realtime_stream_detail_status_revision',
      'chk_order_realtime_stream_cut_refs_revision',
      'pk_realtime_event_log',
      'realtime_event_log_order_id_fkey',
      'uq_realtime_event_log_source',
      'chk_realtime_event_log_commit_sequence',
      'chk_realtime_event_log_schema_version',
      'chk_realtime_event_log_domains',
      'chk_realtime_event_log_domain_revisions',
    ];
    const sql098 = readFileSync(resolve(migDir, '098_order_realtime_producer_bridge.sql'), 'utf8');
    const requiredFunctions = [...sql098.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)/g)]
      .map((match) => match[1]);
    const requiredTriggers = [...sql098.matchAll(/CREATE TRIGGER\s+(\w+)/g)]
      .map((match) => match[1]);

    expect(requiredFunctions).toHaveLength(18);
    expect(requiredTriggers).toHaveLength(11);
    for (const name of requiredConstraints) expect(probeFn).toContain(`q_con_hash_on ${name} `);
    for (const name of requiredFunctions) expect(probeFn).toContain(`q_fun_hash '${name}(`);
    for (const name of requiredTriggers) expect(probeFn).toContain(`q_stmt_trg ${name} `);
    expect(scriptText).toMatch(/q_fun_hash\(\).*md5\(pg_get_functiondef\(oid\)\)/);
    expect(scriptText).not.toMatch(/q_fun_hash\(\).*md5\(prosrc\)/);
    expect(probeFn).toContain("q_fun_hash 'cnc_telegram_worker_reason_code_valid(text)'");
    expect(probeFn.match(/q_fun_hash '[^']+' [a-f0-9]{32}/g)).toHaveLength(requiredFunctions.length + 2);
  });

  it('requires realtime end-state probes before advancing the migration ledger', () => {
    const verifyStart = scriptText.indexOf('verify_applied_effect() {');
    const verifyEnd = scriptText.indexOf('probe_076_endstate()', verifyStart);
    const verifyFn = scriptText.slice(verifyStart, verifyEnd);
    expect(verifyFn).toMatch(/\|097_\*\|098_\*\|099_\*\|100_\*\|101_\*\|102_\*\|103_\*\|104_\*\|105_\*\|106_\*\|107_\*\|108_\*\|109_\*\|110_\*\|111_\*\|112_\*\|113_\*\|114_\*\|115_\*\|116_\*\|117_\*\|118_\*\|119_\*\|120_\*\|121_\*\|122_\*\|123_\*\|124_\*\|125_\*\|126_\*\|127_\*\|128_\*\|129_\*\|130_\*\|131_\*\|132_\*\|133_\*\|134_\*\|135_\*\|136_\*\|137_\*\|138_\*\|139_\*\|140_\*\|141_\*\|142_\*\|143_\*\)/);
    expect(scriptText).toMatch(/verify_applied_effect "\$f"[\s\S]*INSERT INTO schema_migrations/);
  });

  it('requires migration 140 end-state markers before advancing the ledger', () => {
    expect(scriptText).toMatch(/140_cnc_telegram_worker_operation_display_number\*\) probe_all/);
    expect(scriptText).toContain('q_col cnc_telegram_worker_operations cut_job_display_number');
    expect(scriptText).toContain(
      'q_con_on cnc_telegram_worker_operations chk_cnc_tg_worker_operation_display_number',
    );
  });

  it('requires migration 136 end-state probe before advancing the ledger', () => {
    const verifyStart = scriptText.indexOf('verify_applied_effect() {');
    const verifyEnd = scriptText.indexOf('probe_076_endstate()', verifyStart);
    const verifyFn = scriptText.slice(verifyStart, verifyEnd);
    expect(verifyFn).toContain('|136_*');
    expect(scriptText).toMatch(/136_cnc_telegram_manual_import\*\) probe_all/);
    for (const marker of [
      'q_tbl cnc_telegram_import_scans',
      'q_tbl cnc_telegram_import_candidates',
      'q_tbl cnc_telegram_import_candidate_matches',
      'q_tbl cnc_telegram_import_requests',
      'q_tbl cnc_telegram_import_items',
      'chk_cnc_tg_import_scan_range',
      'chk_cnc_tg_import_item_lease',
      'uq_cnc_tg_import_request_active_selection',
      'idx_cnc_tg_import_item_claim',
      "cnc.telegram_import.manage_all",
    ]) expect(scriptText).toContain(marker);
  });

  it('pins the complete Telegram worker audit schema before advancing 107/108/109', () => {
    const workerProbe = probeFn.slice(probeFn.indexOf('107_cnc_telegram_worker_audit*'), probeFn.indexOf('*) return 2'));
    expect(workerProbe.match(/q_colset_hash cnc_telegram_worker_/g)).toHaveLength(4);
    expect(workerProbe.match(/q_conset_hash cnc_telegram_worker_/g)).toHaveLength(4);
    expect(workerProbe.match(/q_idxset_hash cnc_telegram_worker_/g)).toHaveLength(4);
    for (const marker of [
      'cnc_telegram_worker_scans_writer_user_id_fkey',
      'chk_cnc_tg_worker_message_status',
      'chk_cnc_tg_worker_operation_status',
      'cnc_telegram_worker_message_observations_operation_id_fkey',
      'idx_cnc_tg_worker_messages_search',
      'uq_cnc_tg_worker_observation_operation_ordinal',
      "q_fun_hash 'cnc_telegram_worker_reason_code_valid(text)'",
      'chk_cnc_tg_worker_scan_reason_codes',
      'chk_cnc_tg_worker_message_reason_codes',
      'chk_cnc_tg_worker_operation_reason_codes',
      'chk_cnc_tg_worker_observation_reason_codes',
      'chk_cnc_tg_worker_observation_classification_code',
    ]) expect(workerProbe).toContain(marker);
    expect(scriptText).toMatch(/q_colset_hash\(\).*ordinal_position.*column_default/);
    expect(scriptText).toMatch(/q_conset_hash\(\).*pg_get_constraintdef/);
    expect(scriptText).toMatch(/q_idxset_hash\(\).*indexdef/);
  });

  it('pins all migration 101 effect markers', () => {
    expect(probeFn).toContain('101_export_templates*');
    expect(probeFn).toContain('q_tbl export_templates');
    expect(probeFn).toContain('q_col export_templates schema_version');
    expect(probeFn).toContain('q_con_on export_templates chk_export_templates_target_source');
    expect(probeFn).toContain('q_con_on export_templates chk_export_templates_default_active');
    expect(probeFn).toContain('q_idx uq_export_templates_code');
    expect(probeFn).toContain('q_idx uq_export_templates_live_name');
    expect(probeFn).toContain('q_idx uq_export_templates_active_default');
    expect(probeFn).toContain('q_idx idx_export_templates_runtime');
    const migration101Probe = probeFn.slice(probeFn.indexOf('101_export_templates*'), probeFn.indexOf('*) return 2'));
    expect(migration101Probe).not.toContain('bazis-cut-set-standard-v1');
    expect(migration101Probe).not.toContain('bazis-project-cut-standard-v1');
  });

  it('pins migration 102 Bazis designer effect markers', () => {
    expect(probeFn).toContain('102_bazis_project_design_engineer*');
    expect(probeFn).toContain('q_col bazis_projects design_engineer_id');
    expect(probeFn).toContain('q_col bazis_projects design_engineer_xml_name');
    expect(probeFn).toContain('q_col bazis_projects design_engineer_source');
    expect(probeFn).toContain('q_con_on bazis_projects chk_bazis_projects_design_engineer_source');
    expect(probeFn).toContain('q_idx bazis_projects_design_engineer_idx');
  });

  it('pins migrations 103/104/105 Bazis product and panel-link end states', () => {
    expect(probeFn).toContain('103_bazis_cut_position_sources*');
    expect(probeFn).toContain('bazis-cut-position-v4:');
    const migration103Probe = probeFn.slice(
      probeFn.indexOf('103_bazis_cut_position_sources*'),
      probeFn.indexOf('104_bazis_order_detail_product_mapping*'),
    );
    expect(migration103Probe).toContain('manual snapshot edits are preserved by migration 107');
    expect(probeFn).toContain('104_bazis_order_detail_product_mapping*');
    expect(probeFn).toContain('Basis product name from the panel-level Product column');
    expect(probeFn).toContain('104_bazis_panel_order_links*');
    expect(probeFn).toContain('q_col bazis_node_order_detail_map import_source');
    expect(probeFn).toContain('q_con_hash_on bazis_node_order_detail_map_mapping_kind_check');
    expect(probeFn).toContain("q_fun_hash 'reconcile_bazis_panel_order_links(bigint,bigint[],text,bigint,text)'");
    expect(probeFn).toContain('v104 exact current-revision Basis PDF detail to Bazis panel reconciliation');
    expect(probeFn).toContain('d4f7e31052321242dfea61056bae41e7');
    expect(probeFn).toContain('v109 exact current-revision panel reconciliation with one-product NULL product support');
    expect(probeFn).toContain('105_bazis_order_detail_product_link_fallback*');
    expect(probeFn).toContain("products.root_product_count <= 1");
  });

  it('pins migration 109 and lets its function supersede the migration 104 marker', () => {
    expect(probeFn).toContain('109_bazis_single_product_reprojection*');
    expect(probeFn).toContain("q_fun_hash 'reconcile_bazis_panel_order_links(bigint,bigint[],text,bigint,text)' d4f7e31052321242dfea61056bae41e7");
    const migration104Probe = probeFn.slice(
      probeFn.indexOf('104_bazis_panel_order_links*'),
      probeFn.indexOf('105_bazis_order_detail_product_link_fallback*'),
    );
    expect(migration104Probe).toContain('14cfb20b020779a070e7ee2ba070ba0d');
    expect(migration104Probe).toContain('d4f7e31052321242dfea61056bae41e7');
  });

  it('pins migration 107 Bazis ERP identity completion marker', () => {
    expect(probeFn).toContain('107_bazis_cut_erp_identity*');
    expect(probeFn).toContain("'bazis_cut_set_details'::regclass");
    expect(probeFn).toContain('manual snapshot edits are preserved by migration 107');
  });

  it('pins migration 110 Telegram label evidence, provenance, and immutability markers', () => {
    const migration110Probe = probeFn.slice(
      probeFn.indexOf('110_cnc_telegram_label_maps*'),
      probeFn.indexOf('*) return 2'),
    );
    for (const marker of [
      'cnc_telegram_packet_evidence_set',
      'cnc_telegram_packet_item_evidence',
      'cnc_telegram_label_sheet_map',
      'cnc_telegram_label_placement',
      'label_generation_media_asset',
      'label_generation_telegram_source',
      'fk_label_generation_telegram_source_media',
      'fk_label_generation_telegram_source_sheet',
      'fk_label_generation_telegram_source_placement',
      'trg_label_generation_cut_placement_immutable',
      'trg_label_generation_cut_source_exclusive_cut',
      'trg_label_generation_cut_source_exclusive_telegram',
      'reject_cnc_telegram_label_immutable_mutation()',
      'guard_label_generation_cut_source_exclusive()',
    ]) expect(migration110Probe).toContain(marker);
  });

  it('pins migration 111 Telegram media restore queue end state', () => {
    const migration111Probe = probeFn.slice(
      probeFn.indexOf('111_cnc_telegram_media_restore*'),
      probeFn.indexOf('*) return 2'),
    );
    for (const marker of [
      'cnc_telegram_media_restore_requests',
      'restore_request_id',
      'available_until',
      'chk_cnc_telegram_media_restore_state',
      'uq_cnc_telegram_media_restore_active_packet',
      'idx_cnc_telegram_media_restore_claim',
      'idx_cnc_telegram_media_restore_packet_history',
    ]) expect(migration111Probe).toContain(marker);
  });
  it('pins migrations 112/113 cut-job orientation and 115 CNC/vacuum end states', () => {
    const migration112Probe = probeFn.slice(
      probeFn.indexOf('112_cut_job_rotation_allowed*'),
      probeFn.indexOf('113_cut_job_texture_direction*'),
    );
    for (const marker of [
      "column_name = 'rotation_allowed'",
      "data_type = 'boolean'",
      "is_nullable = 'NO'",
      "column_default = 'true'",
    ]) expect(migration112Probe).toContain(marker);

    const migration113Probe = probeFn.slice(
      probeFn.indexOf('113_cut_job_texture_direction*'),
      probeFn.indexOf('*) return 2'),
    );
    for (const marker of [
      "column_name = 'texture_direction'",
      "data_type = 'text'",
      "column_default = '''none''::text'",
      "conname = 'cut_job_texture_direction_check'",
      'convalidated',
      "LIKE '%vertical%'",
      "LIKE '%horizontal%'",
      "LIKE '%none%'",
    ]) expect(migration113Probe).toContain(marker);

    const migration115MdfProbe = probeFn.slice(
      probeFn.indexOf('115_cnc_telegram_packet_mdf_board_hidden*'),
      probeFn.indexOf('115_vacuum_cut_numbering*'),
    );
    for (const marker of [
      'q_col cnc_telegram_packets mdf_board_hidden_at',
      'q_col cnc_telegram_packets mdf_board_hidden_by',
      'q_col cnc_telegram_packets mdf_board_hidden_reason',
      'q_col cnc_telegram_packets mdf_board_hidden_cut_job_id',
      'q_idx idx_cnc_telegram_packets_mdf_visible_workday',
      'q_idx idx_cnc_telegram_packets_mdf_hidden_cut_job',
    ]) expect(migration115MdfProbe).toContain(marker);

    const migration115Probe = probeFn.slice(
      probeFn.indexOf('115_vacuum_cut_numbering*'),
      probeFn.indexOf('*) return 2'),
    );
    for (const marker of [
      'q_col bazis_cut_set_details source_bath_cut_number',
      "LIKE 'bazis-cut-bath-number-v2:%'",
      "source_bath_cut_number ~ '^[0-9]+-[0-9]+$'",
    ]) expect(migration115Probe).toContain(marker);

    const migration116Probe = probeFn.slice(
      probeFn.indexOf('116_telegram_svg_cut_job_display_number*'),
      probeFn.indexOf('117_dedupe_telegram_svg_image_packets*'),
    );
    for (const marker of [
      'q_col cut_job source_display_number',
      "LIKE 'Operator-facing cut job number from the source system;%'",
      "packet.svg_cut_import_status = 'imported'",
      "job.selection_criteria->>'source' = 'cnc_telegram_svg'",
      'job.source_display_number IS DISTINCT FROM packet.cutting_sequence_no::text',
    ]) expect(migration116Probe).toContain(marker);

    const migration117DedupeProbe = probeFn.slice(
      probeFn.indexOf('117_dedupe_telegram_svg_image_packets*'),
      probeFn.indexOf('117_mdf_board_manual_moves*'),
    );
    for (const marker of [
      'packet.cutting_sequence_no IS NOT NULL',
      "regexp_replace(lower(trim(COALESCE(packet.program_name, ''))), '\\.[^.]+$', '') AS program_key",
      "duplicate.cut_layout_json = canonical.cut_layout_json",
      'duplicate.detail_signature IS NOT DISTINCT FROM canonical.detail_signature',
      'canonical.cutting_sequence_no < duplicate.cutting_sequence_no',
    ]) expect(migration117DedupeProbe).toContain(marker);

    const migration117ManualMovesProbe = probeFn.slice(
      probeFn.indexOf('117_mdf_board_manual_moves*'),
      probeFn.indexOf('118_mdf_board_completed_baths_terminal*'),
    );
    for (const marker of [
      'q_tbl mdf_board_manual_moves',
      'uq_mdf_board_manual_moves_card',
      'chk_mdf_board_manual_moves_kind_target',
      'idx_mdf_board_manual_moves_lookup',
      "LIKE 'mdf-board-manual-moves-v1:%'",
    ]) expect(migration117ManualMovesProbe).toContain(marker);

    const migration118Probe = probeFn.slice(
      probeFn.indexOf('118_mdf_board_completed_baths_terminal*'),
      probeFn.indexOf('*) return 2'),
    );
    for (const marker of [
      'q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_target_column',
      'q_con_on mdf_board_manual_moves chk_mdf_board_manual_moves_kind_target',
      'completed_baths',
      "obj_description(oid, 'pg_constraint') LIKE 'mdf-board-manual-moves-v2:%'",
    ]) expect(migration118Probe).toContain(marker);

    const migration133Probe = probeFn.slice(
      probeFn.indexOf('133_cut_job_split_display_numbers*'),
      probeFn.indexOf('119_cnc_manual_svg_comment_presets*'),
    );
    for (const marker of [
      'q_idx uq_cut_job_source_display_number',
      "LIKE 'Operator-facing cut job number. Regular jobs use numeric text;%'",
      "NULLIF(btrim(j.source_display_number), '') ~ '^[0-9]+$'",
      "profile.params->>'layout_mode' = 'vacuum_table'",
      "g.summary->>'engine_used' = 'vacuum_table'",
    ]) expect(migration133Probe).toContain(marker);

    const migration125Probe = probeFn.slice(
      probeFn.indexOf('125_order_hdf_details*'),
      probeFn.indexOf('*) return 2'),
    );
    const migration124RolesProbe = probeFn.slice(
      probeFn.indexOf('124_roles_matrix*'),
      probeFn.indexOf('125_order_hdf_details*'),
    );
    for (const marker of [
      'q_tbl permissions_catalog',
      'q_tbl role_permissions',
      'q_tbl role_policy_scopes',
      'q_tbl permissions_state',
      'q_col permissions_catalog permission_name',
      'q_col role_permissions is_enabled',
      'q_col role_policy_scopes scope_value',
      'q_col permissions_state version',
      'role_permissions_role_id_fkey',
      'role_policy_scopes_scope_value_check',
      'permissions_state_singleton',
      'idx_role_permissions_permission_enabled',
      'idx_role_policy_scopes_key_value',
      'version >= 1',
    ]) expect(migration124RolesProbe).toContain(marker);

    for (const marker of [
      'q_tbl order_hdf_details',
      'q_tbl hdf_calculation_config_state',
      'q_col orders hdf_min_threshold_mm',
      'q_col cut_job_item order_hdf_detail_id',
      'chk_cut_job_item_source_exactly_one',
      'q_col bazis_cut_set_details source_order_hdf_detail_id',
      'chk_bazis_cut_set_details_hdf_source_exclusive',
      'q_col order_realtime_stream hdf_details_revision',
      'production.hdf.min_side_threshold_mm',
      "pg_get_functiondef('recalc_order_production_status(bigint)'::regprocedure)",
    ]) expect(migration125Probe).toContain(marker);

    expect(scriptText).toMatch(/111_\*\|112_\*\|113_\*\|114_\*\|115_\*\|116_\*\|117_\*\|118_\*\|119_\*\|120_\*\|121_\*\|122_\*\|123_\*\|124_\*\|125_\*\|126_\*\|127_\*\|128_\*\|129_\*\|130_\*\|131_\*\|132_\*\|133_\*\|134_\*\|135_\*\|136_\*\|137_\*\|138_\*\|139_\*\|140_\*\|141_\*\|142_\*\|143_\*\)/);
  });
});

describe('apply-migrations.sh auto — semantic view markers (pinned to real SQL)', () => {
  // The 034 end-state probe distinguishes pre/post Variant B view forms by the
  // absence of the legacy materials fallback `m.material_name`. Pin that
  // boundary against the actual migration texts so a future view rewrite that
  // breaks the invariant fails here.
  const sql034 = readFileSync(resolve(migDir, '034_order_material_sunset_legacy.sql'), 'utf8');
  const sql036 = readFileSync(resolve(migDir, '036_order_detail_basis_fields.sql'), 'utf8');
  const sql029 = readFileSync(resolve(migDir, '029_order_sheet_material_type.sql'), 'utf8');

  it('probe uses the m.material_name absence marker', () => {
    expect(scriptText).toMatch(/NOT LIKE '%m\.material_name%'/);
  });

  it('pre-034 form (029) HAS the legacy fallback; post forms (034/036) do NOT', () => {
    const viewBlock = (sql: string, view: string) => {
      const start = sql.indexOf(`CREATE OR REPLACE VIEW ${view}`);
      expect(start, `${view} not found`).toBeGreaterThan(-1);
      const rest = sql.slice(start);
      const end = rest.indexOf(';', rest.indexOf('FROM'));
      return rest.slice(0, end > 0 ? end : undefined);
    };
    expect(viewBlock(sql029, 'order_details_view')).toContain('m.material_name');
    expect(viewBlock(sql034, 'order_details_view')).not.toContain('m.material_name');
    expect(viewBlock(sql036, 'order_details_view')).not.toContain('m.material_name');
    for (const v of ['orders_view', 'orders_alias_view', 'doweling_orders_view', 'details_of_order']) {
      expect(viewBlock(sql034, v)).not.toContain('m.material_name');
    }
  });

  it('all five 034 views are probed', () => {
    for (const v of ['orders_view', 'order_details_view', 'orders_alias_view', 'doweling_orders_view', 'details_of_order']) {
      expect(scriptText).toContain(v);
    }
  });
});

describe('apply-migrations.sh classify-material-name (auto-map heuristic)', () => {
  const classify = (name: string) => run(['classify-material-name', name]).trim();

  it('sheet materials are cuttable with parsed thickness', () => {
    expect(classify('МДФ 19мм')).toBe('cuttable|19|1');
    expect(classify('черновой МДФ 16мм')).toBe('cuttable|16|1');
    expect(classify('ЛДСП 10 мм')).toBe('cuttable|10|3');
    expect(classify('ХДФ 3мм белый')).toBe('cuttable|3|3');
    expect(classify('ФАНЕРА')).toBe('cuttable|16|3'); // no thickness -> default 16
  });

  it('non-sheet names are UNKNOWN (placement decides the final row)', () => {
    // On a detail an unknown name becomes a cuttable SENTINEL (1×1×1 dims);
    // header-only stays non-cuttable — asserted in the integration rehearsal.
    expect(classify('краска')).toBe('unknown|1|3');
    expect(classify('Стекло 4мм')).toBe('unknown|1|3');
    expect(classify('')).toBe('unknown|1|3');
  });

  it('sentinel row shape for unknown detail materials is pinned in the script', () => {
    // ALL required sheet fields are 1 so the operator can find these later
    // (WHERE width_mm = 1) — user-directed behavior 2026-07-04.
    expect(scriptText).toMatch(/true, 1, 1, 1, 1, 1\) ON CONFLICT DO NOTHING;\s+-- SENTINEL/);
  });
});

describe('apply-migrations.sh — hard-stop is enforced in all mutating modes', () => {
  it('apply/baseline/mark-applied call the shared hard_stop_gate', () => {
    const dispatch = scriptText.slice(scriptText.indexOf('# --- Dispatch'));
    for (const mode of ['apply)', 'baseline)', 'mark-applied)']) {
      const idx = dispatch.indexOf(mode);
      expect(idx, `${mode} not found`).toBeGreaterThan(-1);
      const head = dispatch.slice(idx, idx + 200);
      expect(head, `${mode} must call hard_stop_gate first`).toContain('hard_stop_gate');
    }
  });

  it('auto clears the sentinel only with --clear-hard-stop', () => {
    expect(scriptText).toMatch(/CLEAR_HARD_STOP.*-eq 1.*ledger_exists/);
    expect(scriptText).toMatch(/DELETE FROM schema_migrations WHERE filename LIKE '\$\{HARD_STOP_PREFIX\}%'/);
  });
});

describe('apply-migrations.sh auto — detect-only against the live erp_test container', () => {
  // Cheap live smoke: erp_test is at head, so detect-only must classify every
  // file as applied/PRESENT and exit 0 without mutating anything. Skips when
  // the container is not reachable (e.g. CI without the stage stack).
  const containerUp = (() => {
    try {
      execFileSync('docker', ['inspect', process.env.PG_CONTAINER ?? 'erp_test-postgresdb-1'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!containerUp)('classifies the full head as applied/PRESENT', () => {
    const out = run(['auto', '--detect-only']);
    expect(out).toMatch(/detect-only: nothing changed/);
    expect(out).not.toMatch(/PENDING \(will apply\)/);
    expect(out).not.toMatch(/no classification/);
  }, 180_000);
});
