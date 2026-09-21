import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../permissions/permissions';
import { validateEnv } from '../../config/env.validation';

describe('inbound signals deployment and permission contracts', () => {
  it('registers every role grant explicitly', () => {
    expect(PERMISSIONS).toContain('message_signals.view');
    expect(ROLE_PERMISSIONS.manager).toContain('message_signals.view');
    expect(ROLE_PERMISSIONS.manager).not.toContain('message_signals.resolve');
    expect(ROLE_PERMISSIONS.top_manager).toContain('message_signals.resolve');
    expect(ROLE_PERMISSIONS.top_manager).not.toContain('message_signals.manage_config');
  });
  it('defaults inert and rejects relay without intake', () => {
    const env=validateEnv({});
    expect(env.BACKEND_ENABLE_INBOUND_SIGNALS).toBe(false);
    expect(env.BACKEND_INBOUND_SIGNALS_RELAY_OWNER).toBe('none');
    expect(() => validateEnv({ BACKEND_INBOUND_SIGNALS_RELAY_OWNER:'in_process' })).toThrow();
  });
  it('documents standalone routes and config permission separately from audit', () => {
    const contract=load(readFileSync(new URL('../../../contracts/04-api-contract.openapi.yaml',import.meta.url),'utf8')) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    expect(contract.paths['/api/v1/inbound-signals'].get['x-permission']).toBe('message_signals.view');
    expect(contract.paths['/api/v1/message-processing/configuration'].put['x-permission']).toBe('message_signals.manage_config');
  });
});
