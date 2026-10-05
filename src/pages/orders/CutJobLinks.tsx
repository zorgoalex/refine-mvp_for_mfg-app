import { Fragment } from 'react';
import { Space } from 'antd';
import { Tooltip } from '../../ui/tooltipDelay';
import { Link } from 'react-router-dom';
import { cutJobDeepLink } from './cutColumnHelpers';

interface CutJobNameSource {
  cutJobId: number;
  name?: string | null;
}

interface CutJobLinksProps {
  cutJobIds: readonly number[];
  cutJobNameById: ReadonlyMap<number, string>;
  fontSize?: number;
  /** Одна строка с обрезкой до «…»; полный список — в подсказке при наведении. */
  compact?: boolean;
}

export function buildCutJobNameById(jobs: ReadonlyArray<CutJobNameSource>): Map<number, string> {
  return new Map(
    jobs.map((job) => [
      job.cutJobId,
      job.name?.trim() || `#${job.cutJobId}`,
    ]),
  );
}

export function CutJobLinks({ cutJobIds, cutJobNameById, fontSize = 12, compact = false }: CutJobLinksProps) {
  if (cutJobIds.length === 0) return <>—</>;

  if (compact) {
    const names = cutJobIds.map((cutJobId) => cutJobNameById.get(cutJobId) ?? `#${cutJobId}`);
    return (
      <Tooltip title={<>{names.map((name, index) => <div key={cutJobIds[index]}>{name}</div>)}</>}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize, lineHeight: 1.3 }}>
          {cutJobIds.map((cutJobId, index) => (
            <Fragment key={cutJobId}>
              {index > 0 && ', '}
              <Link to={cutJobDeepLink(cutJobId)}>{names[index]}</Link>
            </Fragment>
          ))}
        </div>
      </Tooltip>
    );
  }

  return (
    <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
      {cutJobIds.map((cutJobId) => (
        <Link
          key={cutJobId}
          to={cutJobDeepLink(cutJobId)}
          style={{ fontSize, lineHeight: 1.3, whiteSpace: 'normal' }}
        >
          {cutJobNameById.get(cutJobId) ?? `#${cutJobId}`}
        </Link>
      ))}
    </Space>
  );
}
