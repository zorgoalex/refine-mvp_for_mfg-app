import React from 'react';

export interface LabelSvgPreviewFrameProps {
  svg: string;
  className?: string;
  style?: React.CSSProperties;
  contentStyle?: React.CSSProperties;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  title?: string;
}

export const LabelSvgPreviewFrame: React.FC<LabelSvgPreviewFrameProps> = ({
  svg,
  className,
  style,
  contentStyle,
  onClick,
  title,
}) => (
  <div
    className={['label-svg-preview-frame', className].filter(Boolean).join(' ')}
    onClick={onClick}
    title={title}
    style={{
      background: '#fff',
      lineHeight: 0,
      outline: '1px solid var(--label-preview-outline, rgba(0,0,0,0.1))',
      outlineOffset: -1,
      ...style,
    }}
  >
    <div
      className="label-svg-preview-frame__content"
      style={{ lineHeight: 0, ...contentStyle }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  </div>
);
