import { describe, expect, it, vi } from 'vitest';
import { collectProvenanceNodes, draftToFormSeed } from './bazisOrderDraft';

describe('bazisOrderDraft', () => {
  it('maps a Bazis draft into order-form seed data', () => {
    const seed = draftToFormSeed({
      revisionId: 17,
      projectId: 91,
      clientId: 33,
      clientName: 'Acme',
      bazisProjectName: 'Kitchen',
      bazisOrderNo: 'B-44',
      duplicates: [],
      details: [
        {
          bazisNodeId: 701,
          clientKey: 'ignored-draft-key',
          detailName: 'Facade',
          height: 500,
          width: 300,
          quantity: 2,
          sheetMaterialTypeId: 9,
          filmId: 4,
          millingTypeId: 5,
          edgeTypeId: 6,
          priority: 80,
          basisProject: 'Kitchen',
          basisProduct: 'Upper',
          basisDesignation: 'F-1',
          basisData: 'raw',
        },
      ],
    });

    expect(seed).toEqual({
      header: {
        clientId: 33,
        projectId: 91,
      },
      details: [
        expect.objectContaining({
          bazisNodeId: 701,
          detail_number: 1,
          detail_name: 'Facade',
          height: 500,
          width: 300,
          quantity: 2,
          area: 0.3,
          material_id: null,
          sheet_material_type_id: 9,
          film_id: 4,
          milling_type_id: 5,
          edge_type_id: 6,
          detail_cost: 0,
          milling_cost_per_sqm: 0,
          priority: 80,
          basis_project: 'Kitchen',
          basis_product: 'Upper',
          basis_designation: 'F-1',
          basis_data: 'raw',
          delete_flag: false,
        }),
      ],
      meta: {
        revisionId: 17,
        clientId: 33,
      },
    });
  });

  it('collects unique provenance nodes using the same client key as the save dto', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const nodes = collectProvenanceNodes(
      [
        { bazisNodeId: 10, temp_id: 101 },
        { bazisNodeId: 10, temp_id: 102 },
        { bazisNodeId: 11, temp_id: 103 },
        { bazisNodeId: null, temp_id: 104 },
        { bazisNodeId: 12, temp_id: undefined },
      ],
      (row) => (row.temp_id != null ? String(row.temp_id) : undefined),
    );

    expect(nodes).toEqual([
      { clientKey: '101', bazisNodeId: 10 },
      { clientKey: '103', bazisNodeId: 11 },
    ]);
    expect(warn).toHaveBeenCalledWith(
      '[bazisOrderDraft] Duplicate bazisNodeId in order details, keeping first occurrence',
      10,
    );
  });
});
