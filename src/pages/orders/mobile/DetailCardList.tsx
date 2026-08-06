import React, { useEffect, useRef } from 'react';
import { Card, Checkbox, Space, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { buildDetailCardModel } from './detailCardModel';
import type { DetailCardLookups } from './detailCardModel';
import { BasisProjectLink } from '../components/BasisProjectLink';

export const DetailCardList: React.FC<{
  rows: readonly Record<string, unknown>[];
  lookups: DetailCardLookups;
  /** detail_id to highlight (from ?highlightDetail=) and scroll into view on mount. */
  highlightDetailId?: number | null;
  selectionEnabled?: boolean;
  selectedIds?: readonly number[];
  onSelectionChange?: (ids: number[]) => void;
  bazisCutLinkEnabled?: boolean;
  bazisProjectLinkEnabled?: boolean;
}> = ({ rows, lookups, highlightDetailId = null, selectionEnabled = false, selectedIds = [], onSelectionChange, bazisCutLinkEnabled = false, bazisProjectLinkEnabled = false }) => {
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (highlightDetailId != null) {
      highlightRef.current?.scrollIntoView({ block: 'center' });
    }
    // Only run once on mount for the current highlight target — rows can
    // re-render frequently and we don't want to keep re-scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {rows.map((row, i) => {
        const m = buildDetailCardModel(row, lookups);
        const detailId = Number(row.detail_id);
        const selected = selectedIds.includes(detailId);
        const isHighlighted = highlightDetailId != null && Number(row.detail_id) === highlightDetailId;
        const bazisCutSets = Array.isArray(row.bazis_cut_sets)
          ? row.bazis_cut_sets.flatMap((entry) => {
              if (entry == null || typeof entry !== 'object') return [];
              const ref = entry as Record<string, unknown>;
              const bazisCutSetId = Number(ref.bazisCutSetId);
              if (!Number.isInteger(bazisCutSetId) || bazisCutSetId <= 0) return [];
              return [{ bazisCutSetId, name: typeof ref.name === 'string' ? ref.name : '' }];
            })
          : [];
        const bazisProjects = Array.isArray(row.bazis_projects)
          ? row.bazis_projects.flatMap((entry) => {
              if (entry == null || typeof entry !== 'object') return [];
              const ref = entry as Record<string, unknown>;
              const bazisProjectId = Number(ref.bazisProjectId);
              const bazisRevisionId = Number(ref.bazisRevisionId);
              const revisionNo = Number(ref.revisionNo);
              if (!Number.isInteger(bazisProjectId) || bazisProjectId <= 0 || !Number.isInteger(bazisRevisionId) || bazisRevisionId <= 0) return [];
              return [{ bazisProjectId, bazisRevisionId, revisionNo, name: typeof ref.name === 'string' ? ref.name : '' }];
            })
          : [];
        const primaryBazisProject = bazisProjects[0];
        const basisProjectValue = row.basis_project ?? row.basisProject ?? primaryBazisProject?.name;
        const bazisProjectId = row.bazis_project_id ?? row.bazisProjectId ?? primaryBazisProject?.bazisProjectId;
        const hasBasisProjectValue =
          (typeof basisProjectValue === 'string' || typeof basisProjectValue === 'number') &&
          String(basisProjectValue).trim().length > 0;
        return (
          <Card
            key={i}
            ref={isHighlighted ? highlightRef : undefined}
            size="small"
            style={{
              marginBottom: 8,
              ...(isHighlighted
                ? { border: '2px solid var(--ant-color-primary, #1677ff)', background: 'var(--app-highlight)' }
                : {}),
            }}
          >
            <Space align="start">
              {selectionEnabled && Number.isFinite(detailId) && <Checkbox
                aria-label={`Выбрать деталь ${m.num}`}
                checked={selected}
                onChange={(event) => onSelectionChange?.(event.target.checked
                  ? [...selectedIds, detailId]
                  : selectedIds.filter((id) => id !== detailId))}
                style={{ minWidth: 40, minHeight: 40, display: 'inline-flex', alignItems: 'center' }}
              />}
              <Typography.Text strong style={{ display: 'block' }}>{m.num} · {m.size}</Typography.Text>
            </Space>
            <Typography.Text style={{ display: 'block' }}>{m.material}</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>{m.milling}</Typography.Text>
            {hasBasisProjectValue && (
              <Space wrap size={4}>
                <Typography.Text type="secondary">Базис-проект:</Typography.Text>
                <BasisProjectLink
                  value={basisProjectValue}
                  bazisProjectId={bazisProjectId}
                  enabled={bazisProjectLinkEnabled}
                />
              </Space>
            )}
            {bazisCutSets.length > 0 && (
              <Space wrap size={4}>
                <Typography.Text type="secondary">Базис-раскрой:</Typography.Text>
                {bazisCutSets.map((cutSet) =>
                  bazisCutLinkEnabled ? (
                    <Link key={cutSet.bazisCutSetId} to={`/bazis-cut/${cutSet.bazisCutSetId}`} title={cutSet.name}>
                      {`БР-${cutSet.bazisCutSetId}`}
                    </Link>
                  ) : (
                    <Typography.Text key={cutSet.bazisCutSetId} title={cutSet.name}>
                      {`БР-${cutSet.bazisCutSetId}`}
                    </Typography.Text>
                  ),
                )}
              </Space>
            )}
            {m.note && <Typography.Text type="secondary" style={{ display: 'block' }}>{m.note}</Typography.Text>}
          </Card>
        );
      })}
    </div>
  );
};
