import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

const page = read('./OnecPage.tsx');
const api = read('./onecApi.ts');
const agentsTab = read('./AgentsTab.tsx');
const drawer = read('./AgentDetailsDrawer.tsx');
const configTab = read('./ConfigurationTab.tsx');
const alertsTab = read('./AlertsIncidentsTab.tsx');
const entityModal = read('./ConfigEntityModal.tsx');
const commandsTab = read('./CommandsTab.tsx');
const etlTab = read('./EtlTab.tsx');
const format = read('./onecFormat.ts');

describe('Onec (1C integration) UI wiring', () => {
  it('gates the whole section on the backend flag and onec permissions', () => {
    expect(page).toMatch(/featureFlags\.useBackendOnec/);
    expect(page).toMatch(/can\('onec\.view'\)/);
    expect(page).toMatch(/can\('onec\.manage'\)/);
    expect(page).toMatch(/can\('onec\.commands\.send'\)/);
  });

  it('shows a friendly empty state when the backend integration is disabled', () => {
    expect(page).toMatch(/ONEC_AGENT_DISABLED/);
  });

  it('auto-refreshes the overview every 30s and stops on unmount', () => {
    expect(page).toMatch(/ONEC_OVERVIEW_POLL_MS\s*=\s*30_000/);
    expect(page).toMatch(/clearInterval\(interval\)/);
    expect(page).toMatch(/document\.hidden/);
  });

  it('talks to the backend admin API only, never GraphQL', () => {
    for (const source of [api, agentsTab, drawer, configTab, alertsTab, commandsTab, etlTab]) {
      expect(source).not.toMatch(/gql`|useMutation\(|useQuery\(\s*gql/);
    }
    expect(api).toMatch(/httpClient\.get/);
    expect(api).toMatch(/httpClient\.post/);
    expect(api).toMatch(/httpClient\.put/);
    expect(api).toMatch(/httpClient\.patch/);
  });

  it('sends optimistic-lock versions on agent block/unblock/update', () => {
    expect(api).toMatch(/blockAgent\(agentId: string, version: number\)/);
    expect(api).toMatch(/unblockAgent\(agentId: string, version: number\)/);
    expect(drawer).toMatch(/onecApi\.blockAgent\(agent\.agentId, agent\.version\)/);
    expect(drawer).toMatch(/onecApi\.unblockAgent\(agent\.agentId, agent\.version\)/);
    expect(drawer).toMatch(/onecApi\.updateAgent\(agent\.agentId, \{ version: agent\.version/);
  });

  it('carries the draft revision as an If-Match header and omits it when there is no draft', () => {
    expect(api).toMatch(/onecIfMatchHeader\(revision\)/);
    // The draft revision of the LOADED agent (not merely the selected one).
    expect(configTab).toMatch(/onecApi\.saveDraft\(target, configState\.draft\?\.revision \?\? null, formConfig\)/);
  });

  it('publishes with exactly the revision and configHash shown to the operator', () => {
    // Captured when the confirm dialog opens, shown in it, and sent unchanged.
    expect(configTab).toMatch(/setPublishTarget\(\{ agentId: configState\.agentId, revision: configState\.draft\.revision, configHash: configState\.draft\.configHash \}\)/);
    expect(configTab).toMatch(/onecApi\.publish\(target\.agentId, target\.revision, target\.configHash\)/);
    expect(configTab).toMatch(/Хэш конфигурации: \{publishTarget\.configHash\}/);
  });

  it('handles STALE_DRAFT, ONEC_CONFIG_UNCHANGED, ONEC_CONFIG_PUBLISH_BLOCKED and ONEC_CONFIG_INVALID', () => {
    expect(configTab).toMatch(/STALE_DRAFT/);
    expect(configTab).toMatch(/ONEC_CONFIG_UNCHANGED/);
    expect(configTab).toMatch(/ONEC_CONFIG_PUBLISH_BLOCKED/);
    expect(configTab).toMatch(/ONEC_CONFIG_INVALID/);
  });

  it('warns operators to never paste a private key when adding a certificate', () => {
    expect(drawer).toMatch(/закрытый ключ/);
  });

  it('gates create/manage controls behind onec.manage and keeps alert acknowledge on onec.view', () => {
    expect(agentsTab).toMatch(/canManage &&[\s\S]{0,40}Button[\s\S]{0,80}Добавить источник/);
    expect(agentsTab).toMatch(/canManage &&[\s\S]{0,40}Button[\s\S]{0,120}Зарегистрировать агента/);
    expect(alertsTab).toMatch(/canView && alert\.state === 'open'/);
    expect(alertsTab).toMatch(/canManage && !incident\.resolvedAt/);
  });

  it('shows the identity_changed warning distinctly', () => {
    expect(drawer).toMatch(/onecIdentityWarning/);
    expect(agentsTab).toMatch(/identity_changed/);
  });

  it('never sends empty-string optional ETL entity fields to the strict backend schema', () => {
    expect(entityModal).toMatch(/onecEtlEntityFromFormValues/);
  });

  it('binds configuration writes to the loaded agent and publishes the confirmed triple', () => {
    const tab = read('./ConfigurationTab.tsx');
    expect(tab).toContain('onecConfigWritable({');
    expect(tab).toContain('onecIsCurrentResponse({');
    expect(tab).toMatch(/disabled=\{!writable \|\| !dirty/);
    expect(tab).toMatch(/disabled=\{!writable \|\| !configState\.draft/);
    expect(tab).toContain('onecApi.saveDraft(target, configState.draft?.revision ?? null, formConfig)');
    expect(tab).toContain('onecApi.publish(target.agentId, target.revision, target.configHash)');
    expect(tab).toContain('setPublishTarget({ agentId: configState.agentId, revision: configState.draft.revision, configHash: configState.draft.configHash })');
    // Switching agents clears the previous agent's form first.
    expect(tab).toMatch(/setConfigState\(null\);\s*setFormConfig\(null\);/);
  });

  it('drops stale live-validation answers (older form generation or another agent)', () => {
    const tab = read('./ConfigurationTab.tsx');
    expect(tab).toContain('const seq = ++validateSeq.current;');
    expect(tab).toMatch(/if \(isCurrent\(\)\) setValidationIssues\(result\.ok \? \[\] : result\.issues\)/);
    expect(tab).toMatch(/if \(isCurrent\(\)\) setValidationIssues\(null\)/);
  });

  it('adds a "Команды" tab wired to the backend command journal, gated on onec.commands.send', () => {
    expect(page).toMatch(/canSendCommands\s*=\s*can\('onec\.commands\.send'\)/);
    expect(page).toMatch(/key:\s*'commands'/);
    expect(page).toMatch(/label:\s*'Команды'/);
    expect(page).toMatch(/<CommandsTab[\s\S]{0,120}canSend=\{canSendCommands\}/);
    expect(api).toMatch(/listCommands\(/);
    expect(api).toMatch(/getCommand\(/);
    expect(api).toMatch(/sendCommand\(/);
    expect(api).toMatch(/cancelCommand\(/);
  });

  it('gates sending and cancelling commands behind onec.commands.send, never onec.view alone', () => {
    expect(commandsTab).toMatch(/canSend &&[\s\S]{0,60}Button[\s\S]{0,80}Отправить команду/);
    expect(commandsTab).toMatch(/canSend && onecCommandCancellable\(/);
  });

  it('keeps one Idempotency-Key per intent (new key on any form change) and sends it on the request', () => {
    expect(commandsTab).toMatch(/useState<string>\(\(\) => crypto\.randomUUID\(\)\)/);
    expect(commandsTab).toMatch(/onValuesChange=\{\(changed\) => \{\s*setIdempotencyKey\(crypto\.randomUUID\(\)\)/);
    expect(commandsTab).toMatch(/onecApi\.sendCommand\(values\.agentId, idempotencyKey,/);
    expect(api).toMatch(/headers:\s*\{\s*'Idempotency-Key':\s*idempotencyKey\s*\}/);
  });

  it('drops stale journal responses and resets entity choices when the agent changes', () => {
    expect(commandsTab).toMatch(/if \(seq !== requestSeq\.current\) return;/);
    expect(commandsTab).toMatch(/form\.setFieldsValue\(\{ entities: \[\], entity: undefined \}\)/);
    expect(commandsTab).toMatch(/\[agents, canSend, cancelCommand\]/);
    // A late cancel response refreshes the journal for the current filters.
    expect(commandsTab).toMatch(/loadRef\.current = load;/);
    const cancelBody = commandsTab.slice(commandsTab.indexOf('const cancelCommand = useCallback'), commandsTab.indexOf('const columns = useMemo'));
    expect(cancelBody).not.toMatch(/void load\(\)/);
  });

  it('builds admin/probe command payloads exactly as the backend schemas expect', () => {
    expect(commandsTab).toMatch(/onecCommandPayloadFromForm\(/);
  });

  it('keeps Table/Tooltip imports in CommandsTab routed through the delayed wrapper', () => {
    expect(commandsTab).toMatch(/from '\.\.\/\.\.\/ui\/tooltipDelay'/);
    expect(commandsTab).not.toMatch(/import\s+\{[^}]*\b(Table|Tooltip|Popover)\b[^}]*\}\s+from\s+'antd'/);
  });

  it('adds an "ETL" tab between "Команды" and "Алерты и инциденты", gated by the page-level onec.view guard', () => {
    expect(page).toMatch(/key:\s*'etl'/);
    expect(page).toMatch(/label:\s*'ETL'/);
    expect(page).toMatch(/<EtlTab[\s\S]{0,80}canSendCommands=\{canSendCommands\}/);
    const commandsIndex = page.indexOf("key: 'commands'");
    const etlIndex = page.indexOf("key: 'etl'");
    const alertsIndex = page.indexOf("key: 'alerts'");
    expect(commandsIndex).toBeGreaterThan(-1);
    expect(etlIndex).toBeGreaterThan(commandsIndex);
    expect(alertsIndex).toBeGreaterThan(etlIndex);
  });

  it('adds the ETL read endpoints to the API client', () => {
    expect(api).toMatch(/listEtlEntities\(/);
    expect(api).toMatch(/listEtlRuns\(/);
    expect(api).toMatch(/getEtlRun\(/);
  });

  it('keeps Table/Tooltip imports in EtlTab routed through the delayed wrapper', () => {
    expect(etlTab).toMatch(/from '\.\.\/\.\.\/ui\/tooltipDelay'/);
    expect(etlTab).not.toMatch(/import\s+\{[^}]*\b(Table|Tooltip|Popover)\b[^}]*\}\s+from\s+'antd'/);
  });

  it('gates ETL commands, keeps one Idempotency-Key per intent until success and blocks parallel sends', () => {
    expect(etlTab).toMatch(/const actionsReady = canSendCommands && !!agentId && loadedAgentId === agentId && sending === null;/);
    expect(etlTab).toMatch(/let key = intentKeys\.current\.get\(intentId\);/);
    expect(etlTab).toMatch(/await onecApi\.sendCommand\(agentId, key, command\);\s*intentKeys\.current\.delete\(intentId\);/);
    expect(etlTab).not.toMatch(/sendCommand\(agentId, crypto\.randomUUID\(\)/);
    expect(etlTab).toMatch(/if \(!agentId \|\| sending\) return;/);
  });

  it('never shows or acts on the previous agent rows after an agent switch', () => {
    expect(etlTab).toMatch(/useEffect\(\(\) => \{\s*setEntities\(\[\]\);\s*setRuns\(\[\]\);\s*setLoadedAgentId\(null\);\s*\}, \[agentId\]\);/);
    expect(etlTab).toMatch(/setLoadedAgentId\(agentId\);/);
    expect(etlTab).toMatch(/if \(seq !== requestSeq\.current \|\| selectedAgent\.current !== agentId\) return;/);
    expect(etlTab).toMatch(/if \(selectedAgent\.current === agentId\) void load\(\);/);
  });

  it('drops stale ETL journal responses for a previously selected agent', () => {
    expect(etlTab).toContain('const requestSeq = useRef(0);');
    expect(etlTab).toMatch(/if \(seq !== requestSeq\.current\) return;/);
    expect(etlTab).toMatch(/document\.hidden/);
  });

  it('never lets a saved/compared configuration keep the published sourceGeneration stamp', () => {
    expect(format).toMatch(/export function onecStripSourceGeneration/);
    expect(configTab).toContain('onecStripSourceGeneration(data.published.configuration)');
    expect(configTab).toContain('onecStripSourceGeneration(configState.published.configuration)');
  });

  it('offers the items/counterparties entity presets from ConfigurationTab without overwriting an existing code', () => {
    expect(configTab).toMatch(/ONEC_ETL_ENTITY_PRESETS/);
    expect(configTab).toMatch(/addEntityPreset/);
    expect(configTab).toMatch(/уже есть в списке; шаблон не применён/);
  });
});
