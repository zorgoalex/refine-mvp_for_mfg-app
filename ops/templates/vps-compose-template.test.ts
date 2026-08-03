import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

function readTemplate(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('VPS compose backend runtime flags', () => {
  it('passes the Bazis-cut flag with a safe default and documents activation', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');
    const localCompose = readTemplate('backend/docker-compose.yml');
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(compose).toContain('BACKEND_ENABLE_BAZIS_CUT: ${BACKEND_ENABLE_BAZIS_CUT:-false}');
    expect(localCompose).toContain('BACKEND_ENABLE_BAZIS_CUT: ${BACKEND_ENABLE_BAZIS_CUT:-false}');
    expect(envExample).toContain('BACKEND_ENABLE_BAZIS_CUT=false');
  });

  it('passes Groups feature flags to the backend container with safe defaults', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');

    expect(compose).toContain('BACKEND_ENABLE_GROUPS: ${BACKEND_ENABLE_GROUPS:-false}');
    expect(compose).toContain('BACKEND_GROUPS_READ_ONLY: ${BACKEND_GROUPS_READ_ONLY:-true}');
    expect(compose).toContain(
      'BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE: ${BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE:-false}',
    );
    expect(compose).toContain(
      'BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS: ${BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS:-false}',
    );
  });

  it('documents Groups feature flags in the VPS env example with safe defaults', () => {
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(envExample).toContain('BACKEND_ENABLE_GROUPS=false');
    expect(envExample).toContain('BACKEND_GROUPS_READ_ONLY=true');
    expect(envExample).toContain('BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE=false');
    expect(envExample).toContain('BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS=false');
  });

  it('passes status automation through and documents its default-off behavior', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(compose).toContain(
      'BACKEND_STATUS_AUTOMATION: ${BACKEND_STATUS_AUTOMATION:-false}',
    );
    expect(envExample).toContain('# событийные автостатусы, движок off by default');
    expect(envExample).toContain('BACKEND_STATUS_AUTOMATION=false');
  });

  it('passes CNC Telegram feature gate with safe defaults', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');
    const localCompose = readTemplate('backend/docker-compose.yml');
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(compose).toContain('BACKEND_ENABLE_CNC_TELEGRAM: ${BACKEND_ENABLE_CNC_TELEGRAM:-false}');
    expect(localCompose).toContain('BACKEND_ENABLE_CNC_TELEGRAM: ${BACKEND_ENABLE_CNC_TELEGRAM:-false}');
    expect(envExample).toContain('BACKEND_ENABLE_CNC_TELEGRAM=false');
  });

  it('defines the CNC Telegram Telethon worker as an internal profile service', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');
    const overlay = readTemplate('ops/templates/docker-compose.cnc-telegram-worker.yml');
    const envExample = readTemplate('ops/templates/env.vps.example');
    const workerSegment = compose.slice(
      compose.indexOf('  cnc-telegram-worker:'),
      compose.indexOf('  cad-service:'),
    );

    expect(compose).toContain('glm-ocr-model-init:');
    expect(compose).toContain('image: ${GLM_OCR_MODEL_INIT_IMAGE:-curlimages/curl:8.10.1}');
    expect(compose).toContain('GLM_OCR_MODEL_URL: ${GLM_OCR_MODEL_URL:-https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main/GLM-OCR-Q8_0.gguf?download=true}');
    expect(compose).toContain('GLM_OCR_MMPROJ_URL: ${GLM_OCR_MMPROJ_URL:-https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main/mmproj-GLM-OCR-Q8_0.gguf?download=true}');
    expect(compose).toContain('glm-ocr-llama:');
    expect(compose).toContain('image: ${GLM_OCR_LLAMA_IMAGE:-ghcr.io/ggml-org/llama.cpp:server}');
    expect(compose).toContain('/models/${GLM_OCR_MODEL_FILE:-GLM-OCR-Q8_0.gguf}');
    expect(compose).toContain('/models/${GLM_OCR_MMPROJ_FILE:-mmproj-GLM-OCR-Q8_0.gguf}');
    expect(compose).toContain('glm-ocr-runner:');
    expect(compose).toContain('context: ${GLM_OCR_RUNNER_BUILD_CONTEXT:-./repo_erp/glm-ocr-runner}');
    expect(compose).toContain('LLAMA_SERVER_URL: ${LLAMA_SERVER_URL:-http://glm-ocr-llama:8080}');
    expect(compose).toContain('cnc-telegram-worker:');
    expect(compose).toContain('profiles: ["cnc-telegram"]');
    expect(compose).toContain('context: ${CNC_TELEGRAM_WORKER_BUILD_CONTEXT:-./repo_erp/cnc-telegram-worker}');
    expect(compose).toContain('ERP_STACK_ENV: ${ERP_STACK_ENV:-test}');
    expect(compose).toContain('CNC_TELEGRAM_WORKER_ROLE: ${CNC_TELEGRAM_WORKER_ROLE:-reader}');
    expect(compose).toContain('CNC_TELEGRAM_ALLOW_NON_PROD_WRITER: ${CNC_TELEGRAM_ALLOW_NON_PROD_WRITER:-false}');
    expect(compose).toContain('TELEGRAM_API_ID: ${TELEGRAM_API_ID:-}');
    expect(compose).toContain('ERP_API_URL: ${CNC_TELEGRAM_ERP_API_URL:-http://backend:3000/api/v1}');
    expect(compose).toContain('CNC_OCR_COMMAND: ${CNC_OCR_COMMAND:-python -m cnc_telegram_worker.rapid_ocr_client --image {image}}');
    expect(compose).toContain('GLM_OCR_RUNNER_URL: ${GLM_OCR_RUNNER_URL:-http://glm-ocr-runner:8001/ocr}');
    expect(compose).toContain('CNC_TEMP_TTL_HOURS: ${CNC_TEMP_TTL_HOURS:-24}');
    expect(compose).toContain('CNC_POLL_INTERVAL_SECONDS: ${CNC_POLL_INTERVAL_SECONDS:-60}');
    expect(compose).toContain('cnc-telegram-worker-data:/data');
    expect(compose).toContain('cnc-telegram-worker-data:');
    expect(compose).toContain('glm-ocr-model-cache:');
    expect(workerSegment).toMatch(/networks:[\s\S]*- back[\s\S]*- host_access[\s\S]*cpus:/);
    expect(overlay).toMatch(/cnc-telegram-worker:[\s\S]*networks:[\s\S]*- back[\s\S]*- host_access/);
    expect(workerSegment).not.toMatch(/traefik\.enable=true|ports:/);
    expect(overlay).toContain('glm-ocr-model-init:');
    expect(overlay).toContain('glm-ocr-llama:');
    expect(overlay).toContain('glm-ocr-runner:');
    expect(overlay).toContain('cnc-telegram-worker:');
    expect(overlay).toContain('profiles: ["cnc-telegram"]');
    expect(overlay).toContain('ERP_STACK_ENV: ${ERP_STACK_ENV:-test}');
    expect(overlay).toContain('CNC_TELEGRAM_WORKER_ROLE: ${CNC_TELEGRAM_WORKER_ROLE:-reader}');
    expect(overlay).toContain('cnc-telegram-worker-data:/data');
    expect(envExample).toContain('ERP_STACK_ENV=test');
    expect(envExample).toContain('COMPOSE_PROFILES=');
    expect(envExample).toContain('# COMPOSE_PROFILES=cnc-telegram');
    expect(envExample).toContain('CNC_TELEGRAM_WORKER_BUILD_CONTEXT=./repo_erp/cnc-telegram-worker');
    expect(envExample).toContain('CNC_TELEGRAM_WORKER_ROLE=reader');
    expect(envExample).toContain('CNC_TELEGRAM_ALLOW_NON_PROD_WRITER=false');
    expect(envExample).toContain('CNC_POLL_INTERVAL_SECONDS=60');
    expect(envExample).toContain('CNC_OCR_ENGINE=rapidocr-ppocrv5-eslav');
    expect(envExample).toContain('GLM_OCR_RUNNER_BUILD_CONTEXT=./repo_erp/glm-ocr-runner');
    expect(envExample).toContain('GLM_OCR_MODEL_FILE=GLM-OCR-Q8_0.gguf');
    expect(envExample).toContain('GLM_OCR_MMPROJ_FILE=mmproj-GLM-OCR-Q8_0.gguf');
  });

  it('defines target-specific Docker Compose overlays for test and prod', () => {
    const testOverlay = readTemplate('ops/templates/docker-compose.test.yml');
    const prodOverlay = readTemplate('ops/templates/docker-compose.prod.yml');

    expect(testOverlay).toContain('ERP_STACK_ENV: test');
    expect(testOverlay).toContain('CNC_TELEGRAM_WORKER_ROLE: reader');
    expect(testOverlay).toContain('CNC_BACKFILL_ON_START: "false"');
    expect(testOverlay).not.toContain('restart: "no"');
    expect(prodOverlay).toContain('ERP_STACK_ENV: prod');
    expect(prodOverlay).toContain('CNC_TELEGRAM_WORKER_ROLE: ${CNC_TELEGRAM_WORKER_ROLE:-writer}');
    expect(prodOverlay).toContain('CNC_TELEGRAM_ALLOW_NON_PROD_WRITER: "false"');
  });

  it('publishes the CAD service on a public traefik subdomain with internal access', () => {
    const compose = readTemplate('ops/templates/docker-compose.vps.yml');

    expect(compose).toContain('cad-service:');
    expect(compose).toContain('context: ${CAD_BUILD_CONTEXT:-./repo_svgdxf}');
    expect(compose).toContain('traefik.http.routers.cad.rule=Host(`${CAD_FQDN}`)');
    expect(compose).toContain('traefik.http.services.cad.loadbalancer.server.port=8000');
    expect(compose).toContain('CAD_SERVICE_TRUST_PROXY_HEADERS: ${CAD_SERVICE_TRUST_PROXY_HEADERS:-1}');
    expect(compose).toContain('CAD_SERVICE_BASE_URL: ${CAD_SERVICE_BASE_URL:-http://cad-service:8000}');
  });

  it('documents the CAD service env vars in the VPS env example', () => {
    const envExample = readTemplate('ops/templates/env.vps.example');

    expect(envExample).toContain('CAD_FQDN=cad-test.example.com');
    expect(envExample).toContain('CAD_BUILD_CONTEXT=./repo_svgdxf');
    expect(envExample).toContain('CAD_SERVICE_TRUST_PROXY_HEADERS=1');
    expect(envExample).toContain('CAD_SERVICE_BASE_URL=http://cad-service:8000');
  });
});
