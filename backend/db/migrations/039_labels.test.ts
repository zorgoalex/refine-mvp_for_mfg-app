import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./039_labels.sql', import.meta.url), 'utf8');
const liveSql = sql.split(/--[^\n]*Down/i)[0];

describe('039_labels migration', () => {
  it('creates the four label domain tables additively', () => {
    expect(liveSql).toMatch(/CREATE TABLE IF NOT EXISTS label_templates/i);
    expect(liveSql).toMatch(/CREATE TABLE IF NOT EXISTS label_template_elements/i);
    expect(liveSql).toMatch(/CREATE TABLE IF NOT EXISTS order_label_detail_data/i);
    expect(liveSql).toMatch(/CREATE TABLE IF NOT EXISTS order_label_generations/i);
    expect(liveSql).not.toMatch(/\bDROP TABLE\b/i);
  });

  it('scopes saved label detail data by order, detail, and template', () => {
    expect(liveSql).toMatch(/label_template_id BIGINT NOT NULL REFERENCES label_templates\(label_template_id\)/i);
    expect(liveSql).toMatch(/custom_field_schema_snapshot JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
    expect(liveSql).toMatch(/version INTEGER NOT NULL DEFAULT 1/i);
    expect(liveSql).toMatch(/UNIQUE\s*\(order_id,\s*detail_id,\s*label_template_id\)/i);
    expect(liveSql).toMatch(/idx_order_label_detail_data_order_template/i);
  });

  it('stores generation evidence without making idempotency_key unique', () => {
    expect(liveSql).toMatch(/idempotency_key TEXT NOT NULL/i);
    expect(liveSql).toMatch(/request_hash TEXT NOT NULL/i);
    expect(liveSql).toMatch(/preview_token_hash TEXT NOT NULL/i);
    expect(liveSql).toMatch(/label_count INTEGER NOT NULL/i);
    expect(liveSql).toMatch(/CREATE INDEX IF NOT EXISTS idx_order_label_generations_idempotency_key/i);
    expect(liveSql).not.toMatch(/UNIQUE\s*\(\s*idempotency_key\s*\)/i);
  });

  it('limits export formats to the approved label outputs', () => {
    expect(liveSql).toMatch(/ARRAY\['bmp',\s*'png',\s*'emf'\]::TEXT\[\]/i);
    expect(liveSql).toMatch(/chk_label_templates_default_export_formats/i);
    expect(liveSql).toMatch(/chk_order_label_generations_export_formats/i);
  });

  it('matches API-supported MVP element kinds', () => {
    expect(liveSql).toMatch(/CHECK \(kind IN \('text', 'line', 'rect'\)\)/i);
    expect(liveSql).not.toMatch(/'barcode'|'qr'|'image'|'shape'/i);
  });

  it('documents static RBAC permission names and reversible drop order', () => {
    expect(sql).toContain('labels.view');
    expect(sql).toContain('labels.manage_templates');
    expect(sql).toContain('labels.generate');
    expect(sql).toMatch(/--\s*DROP TABLE IF EXISTS order_label_generations/i);
    expect(sql).toMatch(/--\s*DROP TABLE IF EXISTS order_label_detail_data/i);
    expect(sql).toMatch(/--\s*DROP TABLE IF EXISTS label_template_elements/i);
    expect(sql).toMatch(/--\s*DROP TABLE IF EXISTS label_templates/i);
  });
});
