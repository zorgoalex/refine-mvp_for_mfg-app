import { describe, expect, it } from 'vitest';
import {
  assertRenderableCustomFieldSchema,
  customExpressionFieldIds,
  evaluateCustomFieldExpression,
  findCustomFieldExpressionCycle,
  readCustomFieldExpressionV1,
} from './label-custom-field-expression';

describe('label custom field expressions', () => {
  it('parses, extracts dependencies, and evaluates nested concat and if/else nodes', () => {
    const expression = readCustomFieldExpressionV1({
      expression: {
        type: 'custom_expression',
        version: 1,
        root: {
          type: 'concat',
          parts: [
            { type: 'text', value: 'Материал: ' },
            {
              type: 'if_else',
              when: { field: 'detail.material_name', op: 'not_empty' },
              then: { type: 'field', field: 'detail.material_name' },
              else: { type: 'text', value: 'не указан' },
            },
            { type: 'empty' },
          ],
        },
      },
    });

    expect(expression).not.toBeNull();
    expect(customExpressionFieldIds(expression!)).toEqual(['detail.material_name']);
    expect(evaluateCustomFieldExpression(expression!, (fieldId) => (
      fieldId === 'detail.material_name' ? 'МДФ 16' : undefined
    ))).toBe('Материал: МДФ 16');
    expect(evaluateCustomFieldExpression(expression!, () => '')).toBe('Материал: не указан');
  });

  it('parses and evaluates aggregate nodes over a supplied detail collection', () => {
    const expression = readCustomFieldExpressionV1({
      expression: {
        type: 'custom_expression',
        version: 1,
        root: {
          type: 'aggregate',
          source: 'sheet.details',
          field: 'detail.edge_type_name',
          fn: 'unique_join',
          separator: ', ',
        },
      },
    });

    expect(expression).not.toBeNull();
    expect(customExpressionFieldIds(expression!)).toEqual(['detail.edge_type_name']);
    expect(evaluateCustomFieldExpression(expression!, () => undefined, {
      getCollectionValues: (source, fieldId) => (
        source === 'sheet.details' && fieldId === 'detail.edge_type_name'
          ? ['ПВХ 2мм', 'ABS 1мм', 'ПВХ 2мм', '']
          : undefined
      ),
    })).toBe('ПВХ 2мм, ABS 1мм');
  });

  it('supports aggregate numeric functions and count over supplied collections', () => {
    const sumExpression = readCustomFieldExpressionV1({
      expression: {
        type: 'custom_expression',
        version: 1,
        root: { type: 'aggregate', source: 'order.details', field: 'detail.quantity', fn: 'sum' },
      },
    });
    const countExpression = readCustomFieldExpressionV1({
      expression: {
        type: 'custom_expression',
        version: 1,
        root: { type: 'aggregate', source: 'order.details', field: 'detail.quantity', fn: 'count' },
      },
    });
    const context = {
      getCollectionValues: (source: 'order.details' | 'sheet.details', fieldId: string) => (
        source === 'order.details' && fieldId === 'detail.quantity'
          ? [2, 3, '', 'bad']
          : undefined
      ),
    };

    expect(evaluateCustomFieldExpression(sumExpression!, () => undefined, context)).toBe('5');
    expect(evaluateCustomFieldExpression(countExpression!, () => undefined, context)).toBe('3');
  });

  it('rejects unknown versions, extra keys, excessive depth, and excessive concat parts', () => {
    expect(readCustomFieldExpressionV1({
      expression: { type: 'custom_expression', version: 2, root: { type: 'empty' } },
    })).toBeNull();
    expect(readCustomFieldExpressionV1({
      expression: { type: 'custom_expression', version: 1, root: { type: 'empty', extra: true } },
    })).toBeNull();
    expect(readCustomFieldExpressionV1({
      expression: {
        type: 'custom_expression',
        version: 1,
        root: { type: 'concat', parts: Array.from({ length: 21 }, () => ({ type: 'empty' })) },
      },
    })).toBeNull();

    let root: Record<string, unknown> = { type: 'empty' };
    for (let index = 0; index < 8; index += 1) root = { type: 'concat', parts: [root] };
    expect(readCustomFieldExpressionV1({
      expression: { type: 'custom_expression', version: 1, root },
    })).toBeNull();
    expect(readCustomFieldExpressionV1({
      expression: {
        type: 'custom_expression',
        version: 1,
        root: { type: 'aggregate', source: 'bad.details', field: 'detail.edge_type_name', fn: 'unique_join' },
      },
    })).toBeNull();
  });

  it('finds direct and indirect custom-field dependency cycles', () => {
    const schema = {
      'custom.a': expressionOf({ type: 'field', field: 'custom.b' }),
      'custom.b': expressionOf({
        type: 'if_else',
        when: { field: 'bazis.material', op: 'not_empty' },
        then: { type: 'field', field: 'custom.c' },
        else: { type: 'empty' },
      }),
      'custom.c': expressionOf({ type: 'field', field: 'custom.a' }),
    };

    expect(findCustomFieldExpressionCycle(schema)).toEqual([
      'custom.a',
      'custom.b',
      'custom.c',
      'custom.a',
    ]);
  });

  it('fails closed for malformed stored formulas and conflicting legacy mappings', () => {
    expect(() => assertRenderableCustomFieldSchema({
      'custom.bad': { expression: { type: 'custom_expression', version: 99, root: { type: 'empty' } } },
    })).toThrowError(expect.objectContaining({ code: 'LABEL_CUSTOM_EXPRESSION_INVALID' }));
    expect(() => assertRenderableCustomFieldSchema({
      'custom.bad': {
        sourceField: 'bazis.material',
        expression: { type: 'custom_expression', version: 1, root: { type: 'empty' } },
      },
    })).toThrowError(expect.objectContaining({ code: 'LABEL_CUSTOM_EXPRESSION_INVALID' }));
  });

  it('keeps legacy expression-free schemas above the formula field limit compatible', () => {
    const legacySchema = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      `custom.legacy_${index}`,
      { type: 'string', defaultValue: String(index) },
    ]));

    expect(() => assertRenderableCustomFieldSchema(legacySchema)).not.toThrow();
  });

  it('checks a wide layered DAG with memoized dependency depth', () => {
    const schema: Record<string, unknown> = {};
    for (let layer = 0; layer < 10; layer += 1) {
      for (let branch = 0; branch < 8; branch += 1) {
        const fieldId = `custom.l${layer}_${branch}`;
        schema[fieldId] = layer === 9
          ? expressionOf({ type: 'text', value: 'leaf' })
          : expressionOf({
              type: 'concat',
              parts: Array.from({ length: 8 }, (_, dependency) => ({
                type: 'field',
                field: `custom.l${layer + 1}_${dependency}`,
              })),
            });
      }
    }

    expect(() => assertRenderableCustomFieldSchema(schema)).not.toThrow();
  });

  it('rejects formula-bearing schemas above field and aggregate AST limits', () => {
    const tooManyFields = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      `custom.formula_${index}`,
      expressionOf({ type: 'text', value: String(index) }),
    ]));
    expect(() => assertRenderableCustomFieldSchema(tooManyFields))
      .toThrowError(expect.objectContaining({ code: 'LABEL_CUSTOM_EXPRESSION_INVALID' }));

    const tooManyNodes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `custom.nodes_${index}`,
      expressionOf({
        type: 'concat',
        parts: Array.from({ length: 10 }, () => ({ type: 'empty' })),
      }),
    ]));
    expect(() => assertRenderableCustomFieldSchema(tooManyNodes))
      .toThrowError(expect.objectContaining({ code: 'LABEL_CUSTOM_EXPRESSION_INVALID' }));

    const tooMuchText = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `custom.text_${index}`,
      expressionOf({
        type: 'concat',
        parts: [
          { type: 'text', value: 'a'.repeat(1000) },
          { type: 'text', value: 'b'.repeat(1000) },
        ],
      }),
    ]));
    expect(() => assertRenderableCustomFieldSchema(tooMuchText))
      .toThrowError(expect.objectContaining({ code: 'LABEL_CUSTOM_EXPRESSION_INVALID' }));
  });

  it('rejects custom dependency chains deeper than 50 fields', () => {
    const schema: Record<string, unknown> = {};
    for (let index = 0; index < 51; index += 1) {
      schema[`custom.chain_${index}`] = expressionOf(
        index === 50
          ? { type: 'text', value: 'end' }
          : { type: 'field', field: `custom.chain_${index + 1}` },
      );
    }

    expect(() => assertRenderableCustomFieldSchema(schema))
      .toThrowError(expect.objectContaining({ code: 'LABEL_CUSTOM_EXPRESSION_INVALID' }));
  });

  it('fails instead of truncating expression results above 10,000 characters', () => {
    const expression = readCustomFieldExpressionV1({
      expression: {
        type: 'custom_expression',
        version: 1,
        root: {
          type: 'concat',
          parts: Array.from({ length: 11 }, (_, index) => ({ type: 'field', field: `detail.value_${index}` })),
        },
      },
    });

    expect(() => evaluateCustomFieldExpression(expression!, () => 'x'.repeat(1000)))
      .toThrowError(expect.objectContaining({ code: 'LABEL_CUSTOM_EXPRESSION_RESULT_TOO_LONG' }));
  });
});

function expressionOf(root: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'string',
    expression: { type: 'custom_expression', version: 1, root },
  };
}
