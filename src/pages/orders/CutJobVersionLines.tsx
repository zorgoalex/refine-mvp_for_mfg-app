import type { CSSProperties, ReactNode } from 'react';
import type { CutDetailLastReadyJobRef } from '../../api/types/cutApi.types';
import { cutJobVersionLabel } from './cutColumnHelpers';

type CutJobVersionLinesJob = Pick<CutDetailLastReadyJobRef, 'cutJobId' | 'resultNo' | 'cutNumber' | 'name'>;

const containerStyle: CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  maxWidth: '100%',
  lineHeight: 1.16,
  whiteSpace: 'normal',
  verticalAlign: 'top',
};

const versionStyle: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
};

const nameStyle: CSSProperties = {
  color: 'var(--app-text-muted)',
  fontSize: 11,
  lineHeight: 1.2,
  overflowWrap: 'anywhere',
};

export function CutJobVersionLines({
  job,
  nameSuffix = null,
}: {
  job: CutJobVersionLinesJob;
  nameSuffix?: ReactNode;
}) {
  const name = job.name.trim();

  return (
    <span style={containerStyle}>
      <span style={versionStyle}>{cutJobVersionLabel(job)}</span>
      {name ? (
        <span style={nameStyle}>
          {name}
          {nameSuffix}
        </span>
      ) : null}
    </span>
  );
}
