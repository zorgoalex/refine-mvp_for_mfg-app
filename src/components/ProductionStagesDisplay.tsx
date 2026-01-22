// Production Stages Display Component
// Displays passed production stages as letters separated by slash
// Format: Н/О/П/Р/С/Ш/К/З/У/В

import React from 'react';
import { Tooltip } from 'antd';
import { PRODUCTION_STATUS_CODE_LETTERS, PRODUCTION_STATUS_DISPLAY_ORDER } from '../types/orders';

// Full mapping with names for tooltips
const PRODUCTION_STATUS_NAMES: Record<string, string> = {
  new: 'Новый',
  drawn: 'Отрисован',
  film_purchase: 'Закуп пленки',
  cut: 'Распилен',
  drilled: 'Присажен',
  sanded: 'Отшлифован',
  stocked: 'Закромлен',
  laminated: 'Закатан',
  packed: 'Упакован',
  issued: 'Выдан',
};

interface ProductionStagesDisplayProps {
  /** Array of production_status_code values that have been passed */
  passedCodes?: string[];
  /** Current production_status_id (alternative to passedCodes - shows stages up to current) */
  currentStatusId?: number | null;
  /** Map of status_id to status_code (required if using currentStatusId) */
  statusIdToCode?: Map<number, string>;
  /** Map of status_id to sort_order (required if using currentStatusId for cumulative display) */
  statusIdToSortOrder?: Map<number, number>;
  /** Separator between letters (default: '/') */
  separator?: string;
  /** Style for the container */
  style?: React.CSSProperties;
  /** Show tooltip with full names */
  showTooltip?: boolean;
  /** Font size for letters */
  fontSize?: number;
  /** Color for passed stages */
  passedColor?: string;
  /** Color for not passed stages (if showAll is true) */
  notPassedColor?: string;
  /** Show all stages (passed and not passed) */
  showAll?: boolean;
  /** Max width for wrapping (enables flex-wrap) */
  maxWidth?: number;
}

/**
 * Component to display production stages as letters
 *
 * Usage:
 * 1. With passedCodes: <ProductionStagesDisplay passedCodes={['new', 'drawn', 'cut']} />
 * 2. With currentStatusId (cumulative): <ProductionStagesDisplay currentStatusId={3} statusIdToCode={map} statusIdToSortOrder={sortMap} />
 */
export const ProductionStagesDisplay: React.FC<ProductionStagesDisplayProps> = ({
  passedCodes,
  currentStatusId,
  statusIdToCode,
  statusIdToSortOrder,
  separator = '/',
  style,
  showTooltip = true,
  fontSize = 12,
  passedColor = '#52c41a',
  notPassedColor = '#d9d9d9',
  showAll = false,
  maxWidth,
}) => {
  // Determine which codes are passed
  let passedSet: Set<string>;

  if (passedCodes) {
    // Use provided passedCodes directly
    passedSet = new Set(passedCodes);
  } else if (currentStatusId && statusIdToCode && statusIdToSortOrder) {
    // Calculate passed stages based on current status (cumulative logic)
    const currentCode = statusIdToCode.get(currentStatusId);
    const currentSortOrder = statusIdToSortOrder.get(currentStatusId);

    if (currentCode && currentSortOrder !== undefined) {
      passedSet = new Set<string>();
      // All stages with sort_order <= current are considered passed
      for (const [id, code] of statusIdToCode) {
        const sortOrder = statusIdToSortOrder.get(id);
        if (sortOrder !== undefined && sortOrder <= currentSortOrder) {
          passedSet.add(code);
        }
      }
    } else {
      passedSet = new Set<string>();
    }
  } else {
    passedSet = new Set<string>();
  }

  // Build display based on PRODUCTION_STATUS_DISPLAY_ORDER
  const stages = PRODUCTION_STATUS_DISPLAY_ORDER.map((code) => {
    const letter = PRODUCTION_STATUS_CODE_LETTERS[code];
    const name = PRODUCTION_STATUS_NAMES[code];
    const isPassed = passedSet.has(code);

    return { code, letter, name, isPassed };
  });

  // Filter to only passed stages unless showAll is true
  const stagesToShow = showAll ? stages : stages.filter((s) => s.isPassed);

  if (stagesToShow.length === 0) {
    return <span style={{ color: notPassedColor, fontSize, ...style }}>—</span>;
  }

  // Container style with optional maxWidth for wrapping
  const containerStyle: React.CSSProperties = {
    fontSize,
    ...(maxWidth && {
      display: 'inline-flex',
      flexWrap: 'wrap',
      maxWidth,
      lineHeight: 1.3,
    }),
    ...style,
  };

  const content = (
    <span style={containerStyle}>
      {stagesToShow.map((stage, index) => (
        <React.Fragment key={stage.code}>
          <span
            style={{
              color: stage.isPassed ? passedColor : notPassedColor,
              fontWeight: stage.isPassed ? 600 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            {stage.letter}
          </span>
          {index < stagesToShow.length - 1 && (
            <span style={{ color: '#8c8c8c', margin: '0 1px' }}>{separator}</span>
          )}
        </React.Fragment>
      ))}
    </span>
  );

  if (showTooltip && stagesToShow.some((s) => s.isPassed)) {
    const tooltipText = stagesToShow
      .filter((s) => s.isPassed)
      .map((s) => `${s.letter} — ${s.name}`)
      .join('\n');

    return (
      <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tooltipText}</span>}>
        {content}
      </Tooltip>
    );
  }

  return content;
};

/**
 * Helper function to convert status name to letter (for legacy compatibility)
 */
export const getStatusLetterFromName = (statusName: string): string | null => {
  const lowerName = statusName.toLowerCase();

  // Map based on partial name matching (legacy approach)
  const nameToCode: Record<string, string> = {
    'новый': 'new',
    'отрисован': 'drawn',
    'закуп': 'film_purchase',
    'распил': 'cut',
    'присаж': 'drilled',
    'шлиф': 'sanded',
    'закромл': 'stocked',
    'закат': 'laminated',
    'упаков': 'packed',
    'выдан': 'issued',
  };

  for (const [namePart, code] of Object.entries(nameToCode)) {
    if (lowerName.includes(namePart)) {
      return PRODUCTION_STATUS_CODE_LETTERS[code] || null;
    }
  }

  return null;
};

/**
 * Convert status name to array of passed codes
 * Returns only the CURRENT stage code (independent stages logic)
 *
 * Independent stages (can be set in any order): О, П, Р, С, Ш, К, З
 * When production_status_events is enabled, all recorded events will be shown.
 * Without events, only the current status is displayed.
 */
export const getPassedCodesFromStatusName = (statusName: string): string[] => {
  const lowerName = statusName.toLowerCase();

  // Map status name parts to codes
  const nameToCode: Record<string, string> = {
    'новый': 'new',
    'отрисован': 'drawn',
    'закуп': 'film_purchase',
    'распил': 'cut',
    'присаж': 'drilled',
    'шлиф': 'sanded',
    'закромл': 'stocked',
    'закат': 'laminated',
    'упаков': 'packed',
    'выдан': 'issued',
  };

  // Find matching code for current status name
  for (const [namePart, code] of Object.entries(nameToCode)) {
    if (lowerName.includes(namePart)) {
      return [code]; // Return only the current stage
    }
  }

  return [];
};

export default ProductionStagesDisplay;
