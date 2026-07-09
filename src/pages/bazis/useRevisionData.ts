// Общие данные ревизии для вкладок viewer-страницы: полное дерево узлов
// (один запрос tree?all=true) + смета (материалы/операции из raw_json).

import { useEffect, useMemo, useState } from 'react';
import { bazisApi } from '../../api/bazisApi';
import type { BazisRevisionEstimate, BazisTreeNode } from '../../api/types/bazisApi.types';

export interface RevisionData {
  nodes: BazisTreeNode[];
  byId: Map<number, BazisTreeNode>;
  /** Предки от ближайшего родителя к корню изделия */
  ancestorsOf: (nodeId: number) => BazisTreeNode[];
  estimate: BazisRevisionEstimate | null;
  loading: boolean;
  errorText: string | null;
}

export function useRevisionData(revisionId: number): RevisionData {
  const [nodes, setNodes] = useState<BazisTreeNode[]>([]);
  const [estimate, setEstimate] = useState<BazisRevisionEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isInteger(revisionId) || revisionId <= 0) {
      setNodes([]);
      setEstimate(null);
      setLoading(false);
      setErrorText(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrorText(null);
    setNodes([]);
    setEstimate(null);

    Promise.all([bazisApi.getFullTree(revisionId), bazisApi.getRevisionEstimate(revisionId)])
      .then(([treeNodes, revisionEstimate]) => {
        if (!cancelled) {
          setNodes(treeNodes);
          setEstimate(revisionEstimate);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'Не удалось загрузить данные ревизии');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [revisionId]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.bazisNodeId, node])), [nodes]);

  const ancestorsOf = useMemo(() => {
    return (nodeId: number): BazisTreeNode[] => {
      const chain: BazisTreeNode[] = [];
      let current = byId.get(nodeId);
      const guard = new Set<number>();
      while (current?.parentNodeId != null && !guard.has(current.parentNodeId)) {
        guard.add(current.parentNodeId);
        const parent = byId.get(current.parentNodeId);
        if (!parent) break;
        chain.push(parent);
        current = parent;
      }
      return chain;
    };
  }, [byId]);

  return { nodes, byId, ancestorsOf, estimate, loading, errorText };
}

export const NODE_KIND_LABELS_RU: Record<string, string> = {
  product: 'Изделие',
  assembly: 'Сборка',
  block: 'Блок',
  object: 'Объект',
};

export function nodePathTitle(ancestors: BazisTreeNode[]): string {
  return ancestors
    .map((ancestor) => ancestor.name?.trim() || NODE_KIND_LABELS_RU[ancestor.nodeKind] || ancestor.nodeKind)
    .reverse()
    .join(' / ');
}

export interface SubtreeSummary {
  panels: string[];
  hardware: string[];
  materials: string[];
}

/**
 * Пост-ордер агрегация по поддеревьям: для каждого узла — имена панелей,
 * фурнитуры и уникальные материалы (основные + сопутствующие из сметы),
 * входящие в узел на любой глубине.
 */
export function buildSubtreeSummaries(
  nodes: BazisTreeNode[],
  estimate: BazisRevisionEstimate | null,
): Map<number, SubtreeSummary> {
  const childrenOf = new Map<number, BazisTreeNode[]>();
  const roots: BazisTreeNode[] = [];
  for (const node of nodes) {
    if (node.parentNodeId == null) {
      roots.push(node);
      continue;
    }
    const bucket = childrenOf.get(node.parentNodeId);
    if (bucket) bucket.push(node);
    else childrenOf.set(node.parentNodeId, [node]);
  }

  const materialsByNode = new Map<number, string[]>();
  for (const material of estimate?.materials ?? []) {
    const bucket = materialsByNode.get(material.nodeId);
    if (bucket) bucket.push(material.name);
    else materialsByNode.set(material.nodeId, [material.name]);
  }

  const result = new Map<number, SubtreeSummary>();

  const visit = (node: BazisTreeNode): { panels: string[]; hardware: string[]; materials: Set<string> } => {
    const panels: string[] = [];
    const hardware: string[] = [];
    const materials = new Set<string>(materialsByNode.get(node.bazisNodeId) ?? []);

    const title = node.name?.trim() || node.objectType || node.nodeKind;
    if (node.objectType === 'Панель') panels.push(title);
    if (node.objectType === 'Фурнитура') hardware.push(title);

    for (const child of childrenOf.get(node.bazisNodeId) ?? []) {
      const childAgg = visit(child);
      panels.push(...childAgg.panels);
      hardware.push(...childAgg.hardware);
      for (const material of childAgg.materials) materials.add(material);
    }

    result.set(node.bazisNodeId, { panels, hardware, materials: [...materials] });
    return { panels, hardware, materials };
  };

  for (const root of roots) visit(root);
  return result;
}
