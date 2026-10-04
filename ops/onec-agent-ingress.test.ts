import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const vps = load(read('templates/docker-compose.vps.yml')) as { services: Record<string, any> };
const overlay = load(read('templates/docker-compose.onec-agent.yml')) as { services: Record<string, any> };
const tls = load(read('traefik/dynamic/onec-mtls.yml')) as any;
const deploy = read('deploy-stack.sh');

describe('1C agent mTLS ingress', () => {
  it('adds a dedicated Traefik entrypoint with long upload timeouts and a file provider', () => {
    const command: string[] = vps.services.traefik.command;
    expect(command).toContain('--entrypoints.onecsecure.address=:8443');
    expect(command).toContain('--entrypoints.onecsecure.transport.respondingTimeouts.readTimeout=330s');
    expect(command).toContain('--entrypoints.onecsecure.transport.respondingTimeouts.writeTimeout=330s');
    expect(command).toContain('--providers.file.directory=/etc/traefik/dynamic');
    // websecure keeps Traefik defaults (no relaxed timeouts for the regular API).
    expect(command.some((flag) => flag.startsWith('--entrypoints.websecure.transport'))).toBe(false);
    expect(vps.services.traefik.ports).toContain('8443:8443');
    expect(vps.services.traefik.volumes).toContain('./data/traefik/dynamic:/etc/traefik/dynamic:ro');
  });

  it('pins the regular backend router to its own service and strips agent trust headers', () => {
    const labels: string[] = vps.services.backend.labels;
    expect(labels).toContain('traefik.http.routers.backend.service=backend');
    expect(labels).toContain('traefik.http.routers.backend.middlewares=backend-strip-onec-headers');
    for (const name of ['X-Onec-Ingress-Auth', 'X-Forwarded-Tls-Client-Cert', 'X-Forwarded-Tls-Client-Cert-Info']) {
      expect(labels).toContain(`traefik.http.middlewares.backend-strip-onec-headers.headers.customrequestheaders.${name}=`);
    }
    expect(labels.some((label) => label.startsWith('traefik.http.routers.onec-agent.'))).toBe(false);
    expect(vps.services.backend.environment.BACKEND_ENABLE_ONEC_AGENT).toBe('${BACKEND_ENABLE_ONEC_AGENT:-false}');
  });

  it('routes the agent host only through mTLS options, client-cert forwarding and the ingress secret', () => {
    const labels: string[] = overlay.services.backend.labels;
    expect(labels).toContain('traefik.http.routers.onec-agent.entrypoints=onecsecure');
    expect(labels).toContain('traefik.http.routers.onec-agent.tls.options=onec-mtls@file');
    expect(labels).toContain('traefik.http.routers.onec-agent.middlewares=onec-ratelimit,onec-client-cert,onec-ingress-auth');
    expect(labels).toContain('traefik.http.middlewares.onec-ratelimit.ratelimit.average=20');
    // The overlay carries the backend env itself (existing compose files are not rewritten).
    for (const key of ['BACKEND_ENABLE_ONEC_AGENT', 'ONEC_AGENT_PORT', 'ONEC_INGRESS_SECRET', 'BACKEND_ONEC_MONITOR_OWNER']) {
      expect(overlay.services.backend.environment[key]).toMatch(new RegExp(`^\\$\\{${key}`));
    }
    expect(labels).toContain('traefik.http.routers.onec-agent.service=onec-agent');
    expect(labels).toContain('traefik.http.middlewares.onec-client-cert.passtlsclientcert.pem=true');
    expect(labels).toContain('traefik.http.services.onec-agent.loadbalancer.server.port=${ONEC_AGENT_PORT:-3001}');
    expect(tls.tls.options['onec-mtls'].clientAuth.clientAuthType).toBe('RequireAnyClientCert');
    expect(tls.tls.options['onec-mtls'].minVersion).toBe('VersionTLS12');
  });

  it('deploy-stack applies the overlay only when enabled and syncs the TLS options file', () => {
    expect(deploy).toMatch(/BACKEND_ENABLE_ONEC_AGENT\)" == "true" \]\]; then[\s\S]*COMPOSE_FILE_ARGS\+=\(-f "\$ONEC_AGENT_OVERLAY"\)/);
    expect(deploy).toContain('ONEC_AGENT_FQDN is required when BACKEND_ENABLE_ONEC_AGENT=true');
    expect(deploy).toContain('ONEC_INGRESS_SECRET is required when BACKEND_ENABLE_ONEC_AGENT=true');
    expect(deploy).toContain('cp "$TRAEFIK_DYNAMIC_SRC"/*.yml "$PROJECT_DIR/data/traefik/dynamic/"');
  });

  it('local harnesses never register routers in the host shared Traefik', () => {
    // A harness container with traefik labels duplicated the stage `backend` router
    // ("Router defined multiple times") and broke stage routing. Harnesses must use a
    // private Traefik with the file provider only, and carry no labels.
    for (const script of ['onec-agent-ingress-harness.sh', 'onec-agent-ingress-e2e.sh']) {
      const text = read(script);
      expect(text, script).not.toContain('docker.sock');
      expect(text, script).not.toMatch(/'labels'\s*:/);
      expect(text, script).toContain("not c.startswith('--providers.docker')");
      expect(text, script).toContain('onec_ingress_labels_to_file.py');
    }
  });
});
