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

const nameEllipsisStyle: CSSProperties = {
  display: 'block',
  maxWidth: '100%',
  overflow: 'hidden',
  overflowWrap: 'normal',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  width: '100%',
};

export function CutJobVersionLines({
  job,
  nameSuffix = null,
  nameFontSize,
  nameEllipsis = false,
}: {
  job: CutJobVersionLinesJob;
  nameSuffix?: ReactNode;
  nameFontSize?: CSSProperties['fontSize'];
  nameEllipsis?: boolean;
}) {
  const name = job.name.trim();
  const resolvedContainerStyle = nameEllipsis ? { ...containerStyle, width: '100%', minWidth: 0 } : containerStyle;
  const resolvedNameStyle: CSSProperties = nameEllipsis
    ? { ...nameStyle, ...nameEllipsisStyle }
    : { ...nameStyle };
  if (nameFontSize != null) resolvedNameStyle.fontSize = nameFontSize;

  return (
    <span style={resolvedContainerStyle}>
      <span style={versionStyle}>{cutJobVersionLabel(job)}</span>
      {name ? (
        <span style={resolvedNameStyle} title={nameEllipsis ? name : undefined}>
          {name}
          {nameSuffix}
        </span>
      ) : null}
    </span>
  );
}
