import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('227 1C customer documents migration', () => {
  const sql = readFileSync(new URL('./227_onec_customer_documents.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds customer kinds, link/author columns and tables additively', () => {
    for (const column of ['author_ref_key', 'author_name', 'responsible_ref_key', 'responsible_name', 'onec_order_ref_key', 'basis_ref_key',
      'basis_type', 'line_section', 'settlement_doc_ref_key', 'settlement_doc_type', 'is_advance', 'content', 'line_shipment_date']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const kind of ['customer_order', 'cash_receipt', 'bank_receipt', 'cash_refund', 'bank_refund']) expect(sql).toContain(`'${kind}'`);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.onec_customer_orders');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.onec_document_audit_refs');
    expect(sql).toContain('(line_section = \'works\') = (line_no > 1000000)');
    // Compatible with the pre-v3 loader (total line written with the default section): no total ⇔ is_document_total CHECK.
    expect(sql).not.toMatch(/\(line_section = 'total'\) = is_document_total/);
    expect(sql).toContain("line_section VARCHAR(8) NOT NULL DEFAULT 'goods'");
    // Единственное изменение строк — раздел строки-итога оплаты; удалений нет.
    expect(sql.match(/^\s*UPDATE\s+/gim)).toHaveLength(1);
    expect(sql).toContain("SET line_section = 'total' WHERE is_document_total");
    expect(sql).not.toMatch(/^\s*(DELETE|INSERT)\s+/im);
    // Единственный DROP — прежний CHECK видов v2, заменяемый v3 (новое имя — проба не срабатывает до применения).
    expect(sql.match(/\bDROP\b/gi)).toHaveLength(1);
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_onec_documents_kind_v2;');
  });

  it('probes the new objects before recording the ledger', () => {
    expect(runner).toContain('227_onec_customer_documents*) probe_all');
    expect(runner).toContain('q_con_on onec_documents chk_onec_documents_kind_v3');
    expect(runner).toContain('q_tbl onec_document_audit_refs');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/227_onec_customer_documents\*\)\s+probe_file "\$f" \|\| die/);
  });
});
