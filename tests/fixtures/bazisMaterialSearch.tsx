import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { PanelsTab } from '../../src/pages/bazis/PanelsTab';
import type { BazisTreeNode } from '../../src/api/types/bazisApi.types';
import type { RevisionData } from '../../src/pages/bazis/useRevisionData';

const nodes: BazisTreeNode[] = ['Дуб Северный', 'Белый', null].map((mainMaterialName, index) => ({
  bazisNodeId: index + 1, parentNodeId: null, seq: index + 1, nodeKind: 'object',
  objectType: 'Панель', name: `Панель ${index + 1}`, detailCode: null, position: null,
  designation: `Обозначение-${index + 1}`, productOrderNo: null, quantity: 1,
  cumulativeQuantity: 1, lengthMm: 1000, widthMm: 500, thicknessMm: 16,
  mainMaterialName, edgeCount: 0, hasDrilling: false, notes: null,
  childrenCount: 0, orders: [], orderIds: [],
}));
if (new URLSearchParams(location.search).has('empty')) nodes.length = 0;
const data: RevisionData = {
  nodes, byId: new Map(nodes.map(node => [node.bazisNodeId, node])),
  ancestorsOf: () => [], estimate: null, loading: false, errorText: null,
};
function Fixture() {
  const [selection, setSelection] = useState<number[]>([]);
  return <MemoryRouter>
    <output data-testid="selection">{JSON.stringify(selection)}</output>
    <PanelsTab revisionId={1} data={data} bazisOrderNo={null} canManage={false}
      selectedId={null} focusToken={0} onSelect={() => {}} onGoToTree={() => {}}
      onSelectionChange={setSelection} />
  </MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
