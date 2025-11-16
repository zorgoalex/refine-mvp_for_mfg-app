// Order Production Block (Read-only for show page)
// Minimalist design with orange border

import React, { useMemo } from 'react';
import { Typography } from 'antd';

const { Text } = Typography;

interface OrderProductionBlockProps {
  record: any;
  details: any[];
  millingTypesMap?: Map<number, string>;
  edgeTypesMap?: Map<number, string>;
  filmsMap?: Map<number, string>;
}

export const OrderProductionBlock: React.FC<OrderProductionBlockProps> = ({ 
  record, 
  details,
  millingTypesMap = new Map(),
  edgeTypesMap = new Map(),
  filmsMap = new Map(),
}) => {
  // Вычисляем общие значения для всех деталей
  const commonValues = useMemo(() => {
    if (!details || details.length === 0) {
      return {
        millingTypeName: '—',
        edgeTypeName: '—',
        filmName: '—',
      };
    }

    // Проверяем milling_type_id
    const millingTypeIds = details.map(d => d.milling_type_id).filter(id => id !== null && id !== undefined);
    const uniqueMillingTypeIds = [...new Set(millingTypeIds)];
    const millingTypeName = uniqueMillingTypeIds.length === 1 && uniqueMillingTypeIds[0] 
      ? millingTypesMap.get(uniqueMillingTypeIds[0]) || '—'
      : '—';

    // Проверяем edge_type_id
    const edgeTypeIds = details.map(d => d.edge_type_id).filter(id => id !== null && id !== undefined);
    const uniqueEdgeTypeIds = [...new Set(edgeTypeIds)];
    const edgeTypeName = uniqueEdgeTypeIds.length === 1 && uniqueEdgeTypeIds[0]
      ? edgeTypesMap.get(uniqueEdgeTypeIds[0]) || '—'
      : '—';

    // Проверяем film_id
    const filmIds = details.map(d => d.film_id).filter(id => id !== null && id !== undefined);
    const uniqueFilmIds = [...new Set(filmIds)];
    const filmName = uniqueFilmIds.length === 1 && uniqueFilmIds[0]
      ? filmsMap.get(uniqueFilmIds[0]) || '—'
      : '—';

    return {
      millingTypeName,
      edgeTypeName,
      filmName,
    };
  }, [details, millingTypesMap, edgeTypesMap, filmsMap]);

  return (
    <div style={{ padding: '10px 16px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 16,
        }}
      >
        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Фрезеровка
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {commonValues.millingTypeName}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Обкат
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {commonValues.edgeTypeName}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Плёнка
          </Text>
          <Text style={{ fontSize: 13, color: '#262626' }}>
            {commonValues.filmName}
          </Text>
        </div>
      </div>
    </div>
  );
};
