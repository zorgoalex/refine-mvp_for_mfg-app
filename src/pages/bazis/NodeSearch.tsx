import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Input, List, Select, Space, Spin, Typography } from 'antd';
import { bazisApi } from '../../api/bazisApi';
import type { BazisNodeSearchItem } from '../../api/types/bazisApi.types';

const { Text } = Typography;

interface NodeSearchProps {
  revisionId: number;
  onPick: (item: BazisNodeSearchItem) => Promise<void>;
}

const SEARCH_LIMIT = 50;

export const NodeSearch: React.FC<NodeSearchProps> = ({ revisionId, onPick }) => {
  const [query, setQuery] = useState('');
  const [objectType, setObjectType] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<BazisNodeSearchItem[]>([]);
  const [totalMatched, setTotalMatched] = useState(0);
  const [loading, setLoading] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const revealingRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  // При смене ревизии сбрасываем результаты поиска и гасим текущий debounce/in-flight запрос,
  // иначе клик по устаревшему item может передать node id из прошлой ревизии в revealNode.
  useEffect(() => {
    requestIdRef.current += 1;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setItems([]);
    setTotalMatched(0);
    setErrorText(null);
    setLoading(false);
  }, [revisionId]);

  const executeSearch = useCallback(async (rawQuery: string, nextObjectType?: string) => {
    const trimmedQuery = rawQuery.trim();
    const hasType = Boolean(nextObjectType);
    const requestId = ++requestIdRef.current;

    if (trimmedQuery.length < 1 && !hasType) {
      setItems([]);
      setTotalMatched(0);
      setErrorText(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorText(null);

    try {
      const response = await bazisApi.searchNodes(revisionId, {
        q: trimmedQuery.length >= 1 ? trimmedQuery : undefined,
        objectType: nextObjectType,
        limit: SEARCH_LIMIT,
      });
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      setItems(response.items);
      setTotalMatched(response.totalMatched);
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      setItems([]);
      setTotalMatched(0);
      setErrorText(error instanceof Error ? error.message : 'Не удалось выполнить поиск');
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [revisionId]);

  useEffect(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
    }

    const trimmedQuery = query.trim();
    const hasType = Boolean(objectType);

    if (trimmedQuery.length < 1 && !hasType) {
      requestIdRef.current += 1;
      setItems([]);
      setTotalMatched(0);
      setErrorText(null);
      setLoading(false);
      return;
    }

    timerRef.current = window.setTimeout(() => {
      void executeSearch(query, objectType);
    }, 300);

    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [executeSearch, objectType, query]);

  const handleImmediateSearch = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
    }

    void executeSearch(query, objectType);
  }, [executeSearch, objectType, query]);

  const handlePick = useCallback(async (item: BazisNodeSearchItem) => {
    if (revealingRef.current) {
      return;
    }

    revealingRef.current = true;
    setRevealing(true);
    setErrorText(null);

    try {
      await onPick(item);
    } catch (error) {
      if (mountedRef.current) {
        setErrorText(error instanceof Error ? error.message : 'Не удалось перейти к узлу');
      }
    } finally {
      if (mountedRef.current) {
        revealingRef.current = false;
        setRevealing(false);
      }
    }
  }, [onPick]);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space.Compact style={{ width: '100%' }}>
        <Input.Search
          value={query}
          allowClear
          placeholder="Поиск: имя, обозначение, позиция, материал"
          onChange={(event) => setQuery(event.target.value)}
          onSearch={handleImmediateSearch}
        />
        <Select
          value={objectType}
          allowClear
          placeholder="Тип"
          style={{ width: 180 }}
          options={[
            { value: 'Панель', label: 'Панель' },
            { value: 'Фурнитура', label: 'Фурнитура' },
          ]}
          onChange={(value) => setObjectType(value)}
        />
      </Space.Compact>

      {errorText ? <Alert type="warning" showIcon message={errorText} /> : null}

      {loading ? <Spin size="small" /> : null}
      {revealing ? <Text type="secondary">Переход к узлу...</Text> : null}

      <div
        style={{
          maxHeight: 240,
          overflowY: 'auto',
          pointerEvents: revealing ? 'none' : 'auto',
          opacity: revealing ? 0.65 : 1,
        }}
      >
        <List<BazisNodeSearchItem>
          size="small"
          dataSource={items}
          locale={{ emptyText: 'Введите запрос или выберите тип' }}
          footer={totalMatched > items.length ? `Показано ${items.length} из ${totalMatched}` : null}
          renderItem={(item) => (
            <List.Item
              key={item.bazisNodeId}
              onClick={() => {
                void handlePick(item);
              }}
              style={{ cursor: revealing ? 'not-allowed' : 'pointer' }}
            >
              <List.Item.Meta
                title={item.name ?? item.objectType ?? item.nodeKind}
                description={buildDescription(item)}
              />
            </List.Item>
          )}
        />
      </div>
    </Space>
  );
};

function buildDescription(item: BazisNodeSearchItem): string {
  const path = item.pathTitles
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const metaParts = [
    item.position ? `позиция: ${item.position}` : null,
    item.designation ? `обозначение: ${item.designation}` : null,
  ].filter((part): part is string => Boolean(part));

  return [...path, ...metaParts].join(' / ') || '—';
}
