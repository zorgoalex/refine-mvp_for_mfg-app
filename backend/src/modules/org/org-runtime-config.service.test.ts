import { describe, expect, it } from 'vitest';
import { OrgRuntimeConfigService } from './org-runtime-config.service';

function svc(values: Record<string, boolean>) {
  return new OrgRuntimeConfigService({ get: (k: string) => values[k] } as any);
}

describe('OrgRuntimeConfigService', () => {
  it('reads enable + read-only flags', () => {
    const flags = svc({
      BACKEND_ENABLE_ORG_MANAGEMENT: true,
      BACKEND_ORG_MANAGEMENT_READ_ONLY: false,
    }).getFeatureFlags();
    expect(flags).toEqual({ orgEnabled: true, orgReadOnly: false });
  });
});
