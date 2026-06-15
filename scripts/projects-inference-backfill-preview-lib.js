const REPO_ROOT = '/home/ovhtest/projects/erp_dev/repo_erp/';
const SPEC_ROOT = '/home/ovhtest/projects/erp_dev/spec_erp/';
const ALLOWED_RULE = 'strict-same-client';

function parseProjectsInferencePreviewArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed = {
    targetEnv: '',
    rule: '',
    output: '',
    limit: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--target-env':
        parsed.targetEnv = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--rule':
        parsed.rule = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--output':
        parsed.output = requireArgValue(args, index, arg);
        index += 1;
        break;
      case '--limit': {
        const value = requireArgValue(args, index, arg);
        if (!/^[1-9]\d*$/.test(value)) {
          throw new Error('--limit must be a positive integer');
        }
        parsed.limit = Number(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function assertProjectsInferencePreviewAllowed(config) {
  if (config.targetEnv !== 'backend-test') {
    throw new Error('--target-env backend-test is required');
  }
  if (config.rule !== ALLOWED_RULE) {
    throw new Error('--rule strict-same-client is required');
  }
  if (config.output.startsWith(REPO_ROOT)) {
    throw new Error('--output must be outside repo_erp');
  }
  if (!config.output || !config.output.startsWith(SPEC_ROOT)) {
    throw new Error('--output must be inside /home/ovhtest/projects/erp_dev/spec_erp');
  }
  if (!config.output.endsWith('.json')) {
    throw new Error('--output must be a JSON file');
  }
}

function buildStrictSameClientPreviewSql({ limit = null } = {}) {
  const limitClause = limit ? `limit ${Number(limit)}` : '';
  return `
with project_clients as (
  select distinct
    l.project_id,
    p.code as project_code,
    p.name as project_name,
    seed.client_id,
    c.client_name::text as client_name
  from project_entity_links l
  join project_projects p on p.id = l.project_id
  join orders seed on seed.order_id::text = l.entity_id_text
  left join clients c on c.client_id = seed.client_id
  where l.entity_type_code='order'
    and l.valid_to is null
),
raw_candidates as (
  select
    pc.project_id,
    pc.project_code,
    pc.project_name,
    pc.client_id,
    pc.client_name,
    o.order_id,
    o.order_name,
    s.order_status_name,
    o.order_date,
    'strict_same_client' as confidence,
    'same client_id as an existing active order link in this project' as reason
  from project_clients pc
  join orders o on o.client_id = pc.client_id
  left join order_statuses s on s.order_status_id = o.order_status_id
  where coalesce(o.delete_flag,false)=false
    and o.order_name !~* '^(E2E|TEST|Тест|Check-deafline)'
    and not exists (
      select 1
      from project_entity_links existing
      where existing.entity_type_code='order'
        and existing.entity_id_text=o.order_id::text
        and existing.valid_to is null
    )
),
classified as (
  select
    raw_candidates.*,
    project_counts.candidate_project_count,
    project_counts.conflict_project_codes
  from raw_candidates
  join (
    select
      order_id,
      count(*) as candidate_project_count,
      string_agg(project_code, ', ' order by project_code) as conflict_project_codes
    from raw_candidates
    group by order_id
  ) project_counts on project_counts.order_id = raw_candidates.order_id
)
select
  project_id,
  project_code,
  project_name,
  client_id,
  client_name,
  order_id,
  order_name,
  order_status_name,
  order_date,
  confidence,
  reason,
  candidate_project_count,
  conflict_project_codes
from classified
order by project_code, client_name, order_id desc
${limitClause};
`.trim();
}

function requireArgValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

module.exports = {
  assertProjectsInferencePreviewAllowed,
  buildStrictSameClientPreviewSql,
  parseProjectsInferencePreviewArgs,
};
