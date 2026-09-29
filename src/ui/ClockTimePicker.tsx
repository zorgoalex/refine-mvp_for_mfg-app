import React, { useContext, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Input, theme } from 'antd';
import DisabledContext from 'antd/es/config-provider/DisabledContext';
import { ClockCircleOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  DIAL_CENTER,
  DIAL_SIZE,
  formatTime,
  hourHandPoint,
  hourLabels,
  minuteHandPoint,
  minuteLabels,
  pad2,
  parseTypedTime,
  pointToHour,
  pointToMinute,
  roundToStep,
  snapMinute,
  withTime,
} from './clockTimePickerModel';

export type ClockMode = 'hours' | 'minutes';

const LABEL_RADIUS = 16;
const HAND_DOT_RADIUS = 16;

export interface ClockDialPanelProps {
  value?: Dayjs | null;
  minuteStep?: number;
  initialMode?: ClockMode;
  disabled?: boolean;
  /** Focus the dial on mount (panel opened from the keyboard). */
  autoFocusDial?: boolean;
  /** Called on every commit (hour picked, minute picked, "Сейчас"). */
  onChange: (value: Dayjs) => void;
  onClose: () => void;
}

export const ClockDialPanel: React.FC<ClockDialPanelProps> = ({ value, minuteStep = 5, initialMode = 'hours', disabled, autoFocusDial, onChange, onClose }) => {
  const { token } = theme.useToken();
  const [mode, setMode] = useState<ClockMode>(initialMode);
  const [current, setCurrent] = useState<Dayjs>(() => (value && value.isValid() ? value : roundToStep(dayjs(), minuteStep)));
  const [preview, setPreview] = useState<{ mode: ClockMode; n: number } | null>(null);
  const dragging = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dialFocused, setDialFocused] = useState(false);

  // Keep in sync with the accepted controlled value (typed commits, external resets).
  // Adjusted during render (not in an effect) so a commit made right before a dial gesture is already the base.
  const valueText = formatTime(value);
  const [seenValueText, setSeenValueText] = useState(valueText);
  if (seenValueText !== valueText) {
    setSeenValueText(valueText);
    if (value && value.isValid() && formatTime(current) !== valueText) setCurrent(value);
  }

  // The popup can be hidden/positioning on the first frames, where focus() is a no-op: retry briefly.
  useEffect(() => {
    if (!autoFocusDial) return undefined; // mouse/touch open: never move focus off the input
    if (typeof requestAnimationFrame !== 'function') { svgRef.current?.focus?.(); return undefined; }
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const el = svgRef.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el && tries < 30) { tries += 1; frame = requestAnimationFrame(attempt); }
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [autoFocusDial]);

  const hour = preview?.mode === 'hours' && mode === 'hours' ? preview.n : current.hour();
  const minute = preview?.mode === 'minutes' && mode === 'minutes' ? preview.n : current.minute();

  const commit = (next: Dayjs) => {
    if (disabled) return;
    setCurrent(next);
    setPreview(null);
    onChange(next);
  };
  const commitHour = (h: number) => {
    commit(withTime(current, h, current.minute()));
    setMode('minutes');
  };
  const commitMinute = (m: number) => {
    commit(withTime(current, current.hour(), snapMinute(m, minuteStep)));
    onClose();
  };
  const commitCurrentMode = (n: number) => (mode === 'hours' ? commitHour(n) : commitMinute(n));

  const toDialPoint = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = rect.width > 0 ? DIAL_SIZE / rect.width : 1;
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
  };
  const valueAt = (e: React.PointerEvent<SVGSVGElement>) => {
    const { x, y } = toDialPoint(e);
    return mode === 'hours' ? pointToHour(x, y) : pointToMinute(x, y, DIAL_CENTER, minuteStep);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    dragging.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    setPreview({ mode, n: valueAt(e) });
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    setPreview({ mode, n: valueAt(e) });
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    commitCurrentMode(valueAt(e));
  };
  const onPointerCancel = () => {
    dragging.current = false;
    setPreview(null);
  };

  const selectedNow = mode === 'hours' ? hour : minute;
  const onDialKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.target !== e.currentTarget || disabled) return;
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (dir) {
      e.preventDefault();
      const next = mode === 'hours'
        ? (selectedNow + dir + 24) % 24
        : snapMinute((selectedNow + dir * Math.max(1, Math.floor(minuteStep)) + 60) % 60, minuteStep);
      setPreview({ mode, n: next });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commitCurrentMode(selectedNow);
    }
  };

  const activate = (n: number) => (e: React.KeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    commitCurrentMode(n);
  };
  // Pointer clicks (detail >= 1) are already handled by the SVG pointer events;
  // a synthetic click from assistive technology has detail 0.
  const onLabelClick = (n: number) => (e: React.MouseEvent<SVGGElement>) => {
    if (e.detail) return;
    commitCurrentMode(n);
  };

  const modeButton = (target: ClockMode): React.CSSProperties => ({
    border: 0,
    background: 'transparent',
    padding: '0 6px',
    cursor: 'pointer',
    fontSize: 36,
    lineHeight: '48px',
    fontVariantNumeric: 'tabular-nums',
    borderRadius: token.borderRadius,
    color: mode === target ? token.colorPrimary : token.colorTextSecondary,
    fontWeight: mode === target ? 600 : 400,
  });

  const hand = mode === 'hours' ? hourHandPoint(hour) : minuteHandPoint(minute);
  const handOnLabel = mode === 'hours' || minute % 5 === 0;

  return (
    <div
      style={{ width: 260 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        // rc-dropdown hijacks Tab on window; keep native tab order inside the panel.
        else if (e.key === 'Tab') e.stopPropagation();
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next)) onClose();
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: 8 }}>
        <button type="button" aria-pressed={mode === 'hours'} style={modeButton('hours')} onClick={() => setMode('hours')}>{pad2(current.hour())}</button>
        <span style={{ fontSize: 36, lineHeight: '48px', color: token.colorTextSecondary }}>:</span>
        <button type="button" aria-pressed={mode === 'minutes'} style={modeButton('minutes')} onClick={() => setMode('minutes')}>{pad2(current.minute())}</button>
      </div>
      <svg
        viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
        width="100%"
        ref={svgRef}
        role="group"
        tabIndex={disabled ? -1 : 0}
        aria-label={mode === 'hours' ? 'Выбор часов' : 'Выбор минут'}
        style={{ touchAction: 'none', display: 'block', userSelect: 'none', cursor: 'pointer', outline: 'none' }}
        onKeyDown={onDialKeyDown}
        onFocus={() => setDialFocused(true)}
        onBlur={() => setDialFocused(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <circle cx={DIAL_CENTER.x} cy={DIAL_CENTER.y} r={DIAL_SIZE / 2 - 2} fill={token.colorFillSecondary} />
        {dialFocused && (
          <circle cx={DIAL_CENTER.x} cy={DIAL_CENTER.y} r={DIAL_SIZE / 2 - 2} fill="none" stroke={token.colorPrimary} strokeWidth={2} strokeDasharray="4 3" data-focus-ring="" />
        )}
        <line x1={DIAL_CENTER.x} y1={DIAL_CENTER.y} x2={hand.x} y2={hand.y} stroke={token.colorPrimary} strokeWidth={2} />
        <circle cx={DIAL_CENTER.x} cy={DIAL_CENTER.y} r={3} fill={token.colorPrimary} />
        <circle cx={hand.x} cy={hand.y} r={handOnLabel ? HAND_DOT_RADIUS : 4} fill={token.colorPrimary} />
        {mode === 'hours'
          ? hourLabels().map((l) => {
              const selected = l.hour === hour;
              return (
                <g
                  key={l.hour}
                  role="button"
                  tabIndex={-1}
                  aria-label={`${l.text} ч`}
                  aria-pressed={selected}
                  onKeyDown={activate(l.hour)}
                  onClick={onLabelClick(l.hour)}
                >
                  <circle cx={l.x} cy={l.y} r={LABEL_RADIUS} fill="transparent" />
                  <text x={l.x} y={l.y} textAnchor="middle" dominantBaseline="central" fontSize={l.ring === 'outer' ? 14 : 12}
                    fill={selected ? token.colorTextLightSolid : l.ring === 'outer' ? token.colorText : token.colorTextSecondary}>{l.text}</text>
                </g>
              );
            })
          : minuteLabels().map((l) => {
              const selected = l.minute === minute;
              return (
                <g
                  key={l.minute}
                  role="button"
                  tabIndex={-1}
                  aria-label={`${l.text} мин`}
                  aria-pressed={selected}
                  onKeyDown={activate(l.minute)}
                  onClick={onLabelClick(l.minute)}
                >
                  <circle cx={l.x} cy={l.y} r={LABEL_RADIUS} fill="transparent" />
                  <text x={l.x} y={l.y} textAnchor="middle" dominantBaseline="central" fontSize={14}
                    fill={selected ? token.colorTextLightSolid : token.colorText}>{l.text}</text>
                </g>
              );
            })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <Button size="small" type="link" onClick={() => { commit(roundToStep(dayjs(), minuteStep)); onClose(); }}>Сейчас</Button>
        <Button size="small" type="primary" onClick={onClose}>Готово</Button>
      </div>
    </div>
  );
};

export interface ClockTimePickerProps extends React.AriaAttributes {
  value?: Dayjs | null;
  onChange?: (value: Dayjs | null, text: string) => void;
  minuteStep?: number;
  disabled?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
  allowClear?: boolean;
  id?: string;
}

export const ClockTimePicker: React.FC<ClockTimePickerProps> = ({
  value, onChange, minuteStep = 5, disabled: disabledProp, placeholder = 'чч:мм', style, allowClear = false, id, ...rest
}) => {
  // Form.Item injects aria-required / aria-invalid / aria-describedby into its child.
  const ariaProps = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('aria-')));
  const { token } = theme.useToken();
  const contextDisabled = useContext(DisabledContext);
  const disabled = Boolean(disabledProp) || Boolean(contextDisabled);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => formatTime(value));
  const valueText = formatTime(value);
  const openedByKeyboard = useRef(false);
  const inputRef = useRef<{ focus?: () => void } | null>(null);

  useEffect(() => { setText(valueText); }, [valueText]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const emit = (next: Dayjs | null) => {
    if (disabled) return;
    onChange?.(next, formatTime(next));
  };

  /** Returns true when the text was committed (changed and valid). */
  const commitText = (): boolean => {
    if (disabled) { setText(valueText); return false; }
    const trimmed = text.trim();
    if (trimmed === '') {
      if (allowClear && value) emit(null);
      else setText(valueText);
      return false;
    }
    const parsed = parseTypedTime(trimmed);
    if (!parsed) { setText(valueText); return false; }
    const next = withTime(value, parsed.hour, parsed.minute);
    setText(formatTime(next));
    if (formatTime(next) === valueText) return false;
    emit(next);
    return true;
  };

  const close = () => {
    setOpen(false);
    inputRef.current?.focus?.();
  };

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomLeft"
      disabled={disabled}
      open={disabled ? false : open}
      onOpenChange={(next) => {
        if (disabled) return;
        if (next) openedByKeyboard.current = false;
        setOpen(next);
      }}
      destroyPopupOnHide
      dropdownRender={() => (
        <div style={{
          padding: 12, background: token.colorBgElevated, borderRadius: token.borderRadiusLG, boxShadow: token.boxShadowSecondary,
        }}>
          <ClockDialPanel
            value={value}
            minuteStep={minuteStep}
            disabled={disabled}
            autoFocusDial={openedByKeyboard.current}
            onChange={(next) => { setText(formatTime(next)); emit(next); }}
            onClose={close}
          />
        </div>
      )}
    >
      <Input
        ref={inputRef as React.Ref<never>}
        {...ariaProps}
        id={id}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        style={style}
        allowClear={allowClear}
        suffix={<ClockCircleOutlined />}
        autoComplete="off"
        onChange={(e) => {
          if (disabled) return;
          setText(e.target.value);
          if (allowClear && e.target.value === '' && value) emit(null);
        }}
        onBlur={() => { commitText(); }}
        onPressEnter={(e) => {
          // Never let Enter submit the surrounding form (rc-picker cancelled it too).
          e.preventDefault();
          if (disabled) return;
          const committed = commitText();
          if (!committed && !open) { openedByKeyboard.current = true; setOpen(true); }
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'Escape') { setOpen(false); return; }
          if (e.key === 'Tab') {
            // Tab / Shift+Tab leave the field natively: rc-dropdown must not hijack it into the popup.
            // The typed text is committed by the blur handler; focus is not moved back.
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            openedByKeyboard.current = true;
            setOpen(true);
          }
        }}
      />
    </Dropdown>
  );
};

export default ClockTimePicker;
