import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createOrderEditLegacyPrimaryIdentity } from '../../../query/orderEditPrimaryResource';

// Exercise the production header mapping, not a duplicate implementation or
// a full mount of the editor and its unrelated queries.
const source = readFileSync(new URL('./OrderForm.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('OrderForm.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const statements: string[] = [];
const names = new Set(['dowelingLinks', 'firstLink', 'headerWithDoweling']);
function visit(node: ts.Node) {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && ((ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
        || declaration.name.getText(ast).includes('orderDataWithoutRelationship'))) {
      statements.push(node.getText(ast));
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (statements.length !== 4) throw new Error('Expected four production header mapping statements');
const body = ts.transpileModule(`${statements.join('\n')}\nreturn headerWithDoweling;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const mapHeader = new Function('orderData', 'headerNameData', body);

describe('OrderForm loaded header contract', () => {
  it('requests required Order fields and complete doweling link identities', () => {
    const identity = createOrderEditLegacyPrimaryIdentity({ orderId: 42, projectsEnabled: true, authCacheNamespace: 'test' });
    expect(identity.meta.fields).toEqual(expect.arrayContaining([
      'order_name', 'client_id', 'order_date', 'priority', 'order_status_id',
      'payment_status_id', 'discount', 'paid_amount', 'project_id',
      { order_doweling_links: ['order_doweling_link_id', 'order_id', 'doweling_order_id',
        { doweling_order: ['doweling_order_id', 'doweling_order_name', 'design_engineer_id'] }] },
    ]));
  });

  it('preserves loaded fields and links while deriving the first doweling name', () => {
    const links = [{ order_id: 42, doweling_order_id: 7, doweling_order: { doweling_order_id: 7, doweling_order_name: 'Тест присадка' } }];
    const record = { order_id: 42, client_id: 3, notes: 'Тест', total_amount: 123, project_id: 8, order_doweling_links: links };
    const header = mapHeader({ data: record }, { data: { project_id: 9, project_code: 'Тест P', order_full_number: 'Тест N', material_name: 'Тест материал' } });
    expect(header).toMatchObject({ order_id: 42, client_id: 3, notes: 'Тест', total_amount: 123,
      project_id: 8, project_code: 'Тест P', order_full_number: 'Тест N', material_name_resolved: 'Тест материал',
      doweling_order_id: 7, doweling_order_name: 'Тест присадка' });
    expect(header.doweling_links).toBe(links);
    expect(header).not.toHaveProperty('order_doweling_links');
    expect(record.order_doweling_links).toBe(links);
  });

  it.each([undefined, null, []])('preserves empty-link and missing-view fallbacks: %j', (links) => {
    expect(mapHeader({ data: { order_id: 42, order_doweling_links: links } }, undefined)).toEqual({
      order_id: 42, doweling_order_id: null, doweling_order_name: null, doweling_links: [],
      material_name_resolved: undefined, project_id: null, project_code: null, order_full_number: null,
    });
  });
});
