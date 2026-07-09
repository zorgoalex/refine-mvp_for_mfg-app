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
