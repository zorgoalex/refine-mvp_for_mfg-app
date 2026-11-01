// «NewLine», карточка Базис-проекта (мокап 17): вкладка «Изделия» — слева изделия и сборки деревом, в середине
// панели выбранного узла, справа свойства выбранной панели с чертежом кромки и присадки (та же карточка узла,
// что во вкладке «Дерево»). Только просмотр; данные — полное дерево ревизии, без новых запросов.
import React, { useEffect, useMemo, useState } from 'react';
import { Empty, Tag, Tree } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { Table } from '../../ui/tooltipDelay';
import type { BazisTreeNode } from '../../api/types/bazisApi.types';
import { NodeCard } from './NodeCard';
import { buildProductTree, panelSize, panelsUnder } from './productPanelsModel';
import './productPanelsView.css';

export const ProductPanelsView: React.FC<{ nodes: readonly BazisTreeNode[] }> = ({ nodes }) => {
  const tree = useMemo(() => buildProductTree(nodes), [nodes]);
  const [productId, setProductId] = useState<number | null>(null);
  const [panelId, setPanelId] = useState<number | null>(null);

  // новая ревизия — с первого изделия
  useEffect(() => {
    setProductId(tree[0]?.key ?? null);
    setPanelId(null);
  }, [tree]);

  const panels = useMemo(() => panelsUnder(nodes, productId), [nodes, productId]);
  useEffect(() => {
    if (panelId == null || !panels.some((panel) => panel.bazisNodeId === panelId)) setPanelId(panels[0]?.bazisNodeId ?? null);
  }, [panelId, panels]);

  if (tree.length === 0) return <Empty description="В ревизии нет панелей" />;

  const treeData = (items: typeof tree): DataNode[] => items.map((item) => ({
    key: item.key,
    title: (
      <span className="wb-bz-products__node">
        <span className="wb-bz-products__name">{item.title}</span>
        <small>{item.panelCount}</small>
      </span>
    ),
    children: item.children.length ? treeData(item.children) : undefined,
  }));

  return (
    <div className="wb-bz-products" aria-label="Изделия, панели и свойства">
      <section className="wb-bz-products__col wb-bz-products__col--tree" aria-label="Изделия проекта">
        <h3>Изделия</h3>
        <Tree
          blockNode
          defaultExpandAll
          selectedKeys={productId != null ? [productId] : []}
          onSelect={(keys) => { if (keys.length) setProductId(Number(keys[0])); }}
          treeData={treeData(tree)}
        />
      </section>
      <section className="wb-bz-products__col wb-bz-products__col--panels" aria-label="Панели выбранного изделия">
        <h3>Панели <small>{panels.length}</small></h3>
        <Table<BazisTreeNode>
          size="small"
          rowKey="bazisNodeId"
          pagination={false}
          dataSource={panels}
          rowClassName={(row) => (row.bazisNodeId === panelId ? 'ant-table-row-selected' : '')}
          onRow={(row) => ({ onClick: () => setPanelId(row.bazisNodeId) })}
          columns={[
            { key: 'position', title: 'Поз.', width: 56, render: (_, row) => row.position ?? '—' },
            { key: 'name', title: 'Панель', render: (_, row) => row.name ?? row.designation ?? '—' },
            { key: 'size', title: 'Размер, мм', width: 150, render: (_, row) => panelSize(row) },
            { key: 'material', title: 'Материал', ellipsis: true, render: (_, row) => row.mainMaterialName ?? '—' },
            {
              key: 'marks',
              title: '',
              width: 90,
              render: (_, row) => (
                <span className="wb-bz-products__marks">
                  {(row.edgeCount ?? 0) > 0 ? <Tag title="Кромка">К {row.edgeCount}</Tag> : null}
                  {row.hasDrilling ? <Tag title="Присадка">П</Tag> : null}
                </span>
              ),
            },
          ]}
        />
      </section>
      <aside className="wb-bz-products__col wb-bz-products__col--props" aria-label="Свойства панели">
        <h3>Свойства панели</h3>
        {panelId != null ? <NodeCard nodeId={panelId} /> : <Empty description="Выберите панель" />}
      </aside>
    </div>
  );
};
