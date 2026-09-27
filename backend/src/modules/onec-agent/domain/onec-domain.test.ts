import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintFromForwardedHeader, formatFingerprint, parseCertificateInput } from './onec-certificates';
import { isMaintenanceMode, validateOnecConfiguration } from './onec-config';
import { heartbeatSchema, isVersionAtLeast, sessionStartSchema } from './onec-protocol';

const PEM = readFileSync(join(__dirname, '..', '__fixtures__', 'test-agent-a.cert.pem'), 'utf8');
const DER = new X509Certificate(PEM).raw;
const SHA = createHash('sha256').update(DER).digest();

const entity = {
  entityCode: 'items',
  oDataPath: 'Catalog_Номенклатура',
  keyField: 'Ref_Key',
  updatedAtField: null,
  deletedField: 'DeletionMark',
  select: ['Ref_Key', 'Description', 'DeletionMark'],
  syncMode: 'full',
  pageSize: 500,
  overlapMinutes: 0,
  schemaVersion: 1,
  oDataVersion: 3,
  enabled: true,
};

describe('1C agent configuration validation', () => {
  it('accepts the agent-proposed entity shape and returns the canonical hash', () => {
    const result = validateOnecConfiguration({ mode: 'Normal', commandTypes: ['integration_probe'], etlIntervalMinutes: 60, etlEntities: [entity] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canonical.canonical.startsWith('{"commandTypes":["integration_probe"],"etlEntities":[{"deletedField"')).toBe(true);
      expect(result.canonical.canonical).toContain('"oDataPath":"Catalog_\\u041D');
    }
  });

  it.each([
    [{ mode: 'Normal', commandTypes: ['integration_probe', 'integration_probe'], etlIntervalMinutes: 60, etlEntities: [] }, 'commandTypes'],
    [{ mode: 'Normal', commandTypes: ['drop_database'], etlIntervalMinutes: 60, etlEntities: [] }, 'commandTypes.0'],
    [{ mode: 'Normal', commandTypes: [], etlIntervalMinutes: 0, etlEntities: [] }, 'etlIntervalMinutes'],
    [{ mode: 'Unknown', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [] }, 'mode'],
    [{ mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [entity, entity] }, 'etlEntities'],
    [{ mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [{ ...entity, pageSize: 10001 }] }, 'etlEntities.0.pageSize'],
    [{ mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [{ ...entity, keyField: undefined }] }, 'etlEntities.0.keyField'],
    [{ mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [{ ...entity, select: ['Description'] }] }, 'etlEntities.0.select'],
    [{ mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [], extra: 1 }, ''],
  ])('rejects invalid configuration (%#)', (input, path) => {
    const result = validateOnecConfiguration(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain(path);
  });

  it('rejects property names that differ only by case (spec §2.4)', () => {
    const result = validateOnecConfiguration({ mode: 'Normal', Mode: 'Normal', commandTypes: [], etlIntervalMinutes: 60, etlEntities: [] });
    expect(result.ok).toBe(false);
  });

  it('reports maintenance for Maintenance and Disabled only', () => {
    expect(isMaintenanceMode('Maintenance')).toBe(true);
    expect(isMaintenanceMode('Disabled')).toBe(true);
    expect(isMaintenanceMode('PauseEtl')).toBe(false);
  });
});

describe('1C agent protocol contracts', () => {
  it('compares versions major.minor[.build]', () => {
    expect(isVersionAtLeast('1.2.3', '1.2')).toBe(true);
    expect(isVersionAtLeast('1.2.0', '1.2.1')).toBe(false);
    expect(isVersionAtLeast('2.0', '1.99.99')).toBe(true);
    expect(isVersionAtLeast('garbage', '1.0')).toBe(false);
  });

  it('ignores unknown heartbeat fields and clips free text', () => {
    const parsed = heartbeatSchema.parse({
      agentId: 'a', version: '1.0.0', state: 'degraded', stateReason: 'x'.repeat(500),
      oneC: { lastError: 'e'.repeat(2000) }, futureField: { nested: true },
    });
    expect(parsed).not.toHaveProperty('futureField');
    expect(parsed.stateReason).toHaveLength(128);
    expect(parsed.oneC?.lastError).toHaveLength(512);
  });

  it('requires a valid session/start body', () => {
    expect(sessionStartSchema.safeParse({ agentId: 'a', siteId: 's', agentVersion: '1.0.7' }).success).toBe(true);
    expect(sessionStartSchema.safeParse({ agentId: 'a', siteId: 's', agentVersion: 'v1' }).success).toBe(false);
  });
});

describe('1C agent certificates', () => {
  it('fingerprints the Traefik passTLSClientCert header (URL-escaped base64 DER, chain first)', () => {
    const header = encodeURIComponent(DER.toString('base64')) + ',' + encodeURIComponent('AAAA');
    expect(fingerprintFromForwardedHeader(header)?.equals(SHA)).toBe(true);
    expect(fingerprintFromForwardedHeader(encodeURIComponent(PEM))?.equals(SHA)).toBe(true);
    expect(fingerprintFromForwardedHeader(undefined)).toBeNull();
    expect(fingerprintFromForwardedHeader('%E0%A4%A')).toBeNull();
    expect(fingerprintFromForwardedHeader('short')).toBeNull();
  });

  it('parses an operator PEM or fingerprint and refuses private keys', () => {
    const parsed = parseCertificateInput({ pem: PEM });
    expect(parsed.fingerprint.equals(SHA)).toBe(true);
    expect(parsed.subject).toContain('e2e-onec-agent-a');
    expect(parsed.notAfter!.getTime()).toBeGreaterThan(Date.now());
    expect(parseCertificateInput({ sha256Fingerprint: formatFingerprint(SHA) }).fingerprint.equals(SHA)).toBe(true);
    expect(() => parseCertificateInput({ pem: '-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----' })).toThrow(/закрытый ключ/);
    expect(() => parseCertificateInput({ sha256Fingerprint: 'abc' })).toThrow();
    expect(() => parseCertificateInput({})).toThrow();
  });
});
