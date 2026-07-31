import { Space } from 'antd';
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
}

export function buildCutJobNameById(jobs: ReadonlyArray<CutJobNameSource>): Map<number, string> {
  return new Map(
    jobs.map((job) => [
      job.cutJobId,
      job.name?.trim() || `#${job.cutJobId}`,
    ]),
  );
}

export function CutJobLinks({ cutJobIds, cutJobNameById, fontSize = 12 }: CutJobLinksProps) {
  if (cutJobIds.length === 0) return <>—</>;

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
