/** Sanitized milling geometry from the 2026-09-01 CNC#2_2866.svg incident. */
export const cnc2866MillingLayout = {
  sheet: { widthMm: 2070.2, heightMm: 2800.2 },
  items: [{
    orderName: 'TEST-ORDER',
    detailNumber: 1,
    widthMm: 726,
    heightMm: 276,
    xMm: 1517.6,
    yMm: 2064.1,
    placedWidthMm: 276,
    placedHeightMm: 726,
    rotated: true,
    sourceSvg: {
      viewBox: { xMm: 1517.6, yMm: 2064.1, widthMm: 276, heightMm: 726 },
      body: [
        '<g transform="matrix(0.01 0 0 0.01 -1517.600007 -2064.100033)">',
        '<rect x="151752.67" y="206400.03" width="27598.67" height="72596.49" fill="none" stroke="#111827" stroke-width="1.5" vector-effect="non-scaling-stroke"/>',
        '<rect x="159752.28" y="214399.64" width="11599.44" height="56597.27" fill="none" stroke="#111827" stroke-width="1.5" vector-effect="non-scaling-stroke"/>',
        '<rect x="157752.38" y="212399.74" width="15599.25" height="60597.07" fill="none" stroke="#111827" stroke-width="1.5" vector-effect="non-scaling-stroke"/>',
        '<rect x="156752.43" y="211399.79" width="17599.15" height="62596.98" fill="none" stroke="#111827" stroke-width="1.5" vector-effect="non-scaling-stroke"/>',
        '</g>',
      ].join(''),
    },
  }],
} as const;
