import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dropdown = vi.hoisted(() => ({ props: undefined as Record<string, any> | undefined }));
vi.mock('@ant-design/icons', () => ({ ClockCircleOutlined: () => null }));
vi.mock('antd/es/config-provider/DisabledContext', () => {
  const React = require('react') as typeof import('react');
  return { default: React.createContext(false) };
});
vi.mock('antd', () => {
  const React = require('react') as typeof import('react');
  return {
    theme: { useToken: () => ({ token: {
      colorPrimary: '#1677ff', colorText: '#000', colorTextSecondary: '#666', colorFillSecondary: '#eee',
      colorTextLightSolid: '#fff', borderRadius: 6, borderRadiusLG: 8, colorBgElevated: '#fff', boxShadowSecondary: 'none',
    } }) },
    Button: (props: Record<string, any>) => React.createElement('button', { onClick: props.onClick }, props.children),
    Input: React.forwardRef((props: Record<string, any>, ref: React.Ref<HTMLInputElement>) => React.createElement('input', {
      ref,
      id: props.id, value: props.value, disabled: props.disabled, onChange: props.onChange,
      onBlur: props.onBlur, onKeyDown: props.onKeyDown, onPressEnter: props.onPressEnter,
      'aria-invalid': props['aria-invalid'], 'aria-describedby': props['aria-describedby'], 'aria-required': props['aria-required'],
    })),
    Dropdown: (props: Record<string, any>) => {
      dropdown.props = props;
      return React.createElement(React.Fragment, null, props.children, props.open ? props.dropdownRender() : null);
    },
  };
});

import DisabledContext from 'antd/es/config-provider/DisabledContext';
import { ClockDialPanel, ClockTimePicker } from './ClockTimePicker';

let tree: ReactTestRenderer | undefined;
afterEach(() => { if (tree) act(() => tree!.unmount()); tree = undefined; vi.useRealTimers(); });

const render = (el: React.ReactElement) => { act(() => { tree = create(el); }); return tree!; };
const input = () => tree!.root.findByType('input');
const label = (text: string): ReactTestInstance =>
  tree!.root.findAll((n) => (n.type as unknown) === 'g' && n.props['aria-label'] === text)[0];
const key = (n: ReactTestInstance, k = 'Enter') => act(() => { n.props.onKeyDown({ key: k, preventDefault() {} }); });
const svgLabel = () => tree!.root.findByType('svg').props['aria-label'];
const t = (s: string) => dayjs(`2026-09-29T${s}:00`);

describe('ClockTimePicker input', () => {
  it('commits typed 9:30 on blur as a Dayjs', () => {
    const onChange = vi.fn();
    render(<ClockTimePicker onChange={onChange} />);
    act(() => { input().props.onChange({ target: { value: '9:30' } }); });
    act(() => { input().props.onBlur(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const [value, text] = onChange.mock.calls[0];
    expect(text).toBe('09:30');
    expect(value.hour()).toBe(9);
    expect(value.minute()).toBe(30);
    expect(input().props.value).toBe('09:30');
  });

  it('accepts typed minutes that are not a multiple of the step, on Enter', () => {
    const onChange = vi.fn();
    render(<ClockTimePicker value={t('08:00')} onChange={onChange} minuteStep={5} />);
    act(() => { input().props.onChange({ target: { value: '0847' } }); });
    act(() => { input().props.onPressEnter({ preventDefault() {} }); });
    expect(onChange.mock.calls[0][1]).toBe('08:47');
  });

  it('reverts invalid text on blur without calling onChange', () => {
    const onChange = vi.fn();
    render(<ClockTimePicker value={t('08:45')} onChange={onChange} />);
    act(() => { input().props.onChange({ target: { value: '25:99' } }); });
    act(() => { input().props.onBlur(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(input().props.value).toBe('08:45');
  });

  it('does not open when disabled', () => {
    render(<ClockTimePicker disabled />);
    act(() => { dropdown.props!.onOpenChange(true); });
    expect(dropdown.props!.open).toBe(false);
    expect(input().props.disabled).toBe(true);
  });

  it('opens the dial and commits an hour then a minute through the dropdown', () => {
    const onChange = vi.fn();
    render(<ClockTimePicker value={t('08:45')} onChange={onChange} />);
    act(() => { dropdown.props!.onOpenChange(true); });
    expect(dropdown.props!.open).toBe(true);
    expect(svgLabel()).toBe('Выбор часов');
    key(label('13 ч'));
    expect(onChange.mock.calls[0][1]).toBe('13:45');
    expect(svgLabel()).toBe('Выбор минут');
    key(label('30 мин'), ' ');
    expect(onChange.mock.calls[1][1]).toBe('13:30');
    expect(dropdown.props!.open).toBe(false);
  });

  it('Escape in the field closes the dropdown', () => {
    render(<ClockTimePicker />);
    act(() => { dropdown.props!.onOpenChange(true); });
    act(() => { input().props.onKeyDown({ key: 'Escape' }); });
    expect(dropdown.props!.open).toBe(false);
  });
});

describe('ClockDialPanel', () => {
  it('hour 13 (inner ring) keeps minutes and switches to minutes mode', () => {
    const onChange = vi.fn(); const onClose = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={onChange} onClose={onClose} />);
    expect(svgLabel()).toBe('Выбор часов');
    act(() => { label('13 ч').props.onClick({ detail: 0 }); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const v = onChange.mock.calls[0][0];
    expect([v.hour(), v.minute()]).toEqual([13, 45]);
    expect(svgLabel()).toBe('Выбор минут');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores the click that follows a pointer gesture (detail >= 1)', () => {
    const onChange = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={onChange} onClose={() => {}} />);
    act(() => { label('13 ч').props.onClick({ detail: 1 }); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('activating 45 in minutes mode commits HH:45 and closes', () => {
    const onChange = vi.fn(); const onClose = vi.fn();
    render(<ClockDialPanel value={t('08:10')} initialMode="minutes" onChange={onChange} onClose={onClose} />);
    key(label('45 мин'));
    const v = onChange.mock.calls[0][0];
    expect([v.hour(), v.minute()]).toEqual([8, 45]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps a label to the step (15) in minutes mode', () => {
    const onChange = vi.fn();
    render(<ClockDialPanel value={t('08:00')} minuteStep={15} initialMode="minutes" onChange={onChange} onClose={() => {}} />);
    key(label('20 мин'));
    expect(onChange.mock.calls[0][0].minute()).toBe(15);
  });

  it('"Сейчас" commits a time rounded to the step and closes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 10, 43, 20));
    const onChange = vi.fn(); const onClose = vi.fn();
    render(<ClockDialPanel value={t('08:00')} onChange={onChange} onClose={onClose} />);
    const now = tree!.root.findAllByType('button').find((b) => b.children.join('') === 'Сейчас')!;
    act(() => { now.props.onClick(); });
    const v = onChange.mock.calls[0][0];
    expect([v.hour(), v.minute()]).toEqual([10, 45]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Готово" only closes; header buttons switch mode', () => {
    const onChange = vi.fn(); const onClose = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={onChange} onClose={onClose} />);
    const buttons = tree!.root.findAllByType('button');
    act(() => { buttons.find((b) => b.children.join('') === '45')!.props.onClick(); });
    expect(svgLabel()).toBe('Выбор минут');
    act(() => { tree!.root.findAllByType('button').find((b) => b.children.join('') === 'Готово')!.props.onClick(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('with no value starts from the rounded current time without committing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 14, 2, 0));
    const onChange = vi.fn();
    render(<ClockDialPanel onChange={onChange} onClose={() => {}} />);
    const texts = tree!.root.findAllByType('button').map((b) => b.children.join(''));
    expect(texts.slice(0, 2)).toEqual(['14', '00']);
    expect(onChange).not.toHaveBeenCalled();
  });
});

function ControlledPicker({ onValue }: { onValue?: (text: string) => void }) {
  const [value, setValue] = React.useState<dayjs.Dayjs | null>(t('08:45'));
  return <ClockTimePicker value={value} onChange={(v, text) => { setValue(v); onValue?.(text); }} />;
}

describe('controlled parent', () => {
  it('a typed and blurred time is the base for the next dial selection (09:30 -> hour 10 = 10:30)', () => {
    const seen: string[] = [];
    render(<ControlledPicker onValue={(x) => seen.push(x)} />);
    act(() => { dropdown.props!.onOpenChange(true); });
    act(() => { input().props.onChange({ target: { value: '9:30' } }); });
    act(() => { input().props.onBlur(); });
    key(label('10 ч'));
    expect(seen).toEqual(['09:30', '10:30']);
    expect(input().props.value).toBe('10:30');
  });
});

describe('disabled', () => {
  it('honours the antd DisabledContext (Form disabled) and guards typing and commits', () => {
    const onChange = vi.fn();
    render(<DisabledContext.Provider value={true}><ClockTimePicker value={t('08:45')} onChange={onChange} /></DisabledContext.Provider>);
    expect(dropdown.props!.disabled).toBe(true);
    expect(input().props.disabled).toBe(true);
    act(() => { dropdown.props!.onOpenChange(true); });
    expect(dropdown.props!.open).toBe(false);
    act(() => { input().props.onChange({ target: { value: '10:00' } }); });
    act(() => { input().props.onBlur(); });
    act(() => { input().props.onPressEnter({ preventDefault() {} }); });
    expect(onChange).not.toHaveBeenCalled();
    expect(input().props.value).toBe('08:45');
  });

  it('a panel that becomes disabled commits nothing', () => {
    const onChange = vi.fn();
    render(<ClockDialPanel value={t('08:45')} disabled onChange={onChange} onClose={() => {}} />);
    key(label('13 ч'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes an open dial when it becomes disabled', () => {
    const el = (d: boolean) => <ClockTimePicker value={t('08:45')} disabled={d} />;
    render(el(false));
    act(() => { dropdown.props!.onOpenChange(true); });
    expect(dropdown.props!.open).toBe(true);
    act(() => { tree!.update(el(true)); });
    expect(dropdown.props!.open).toBe(false);
  });
});

describe('form integration', () => {
  it('Enter in the field is always default-prevented (no implicit form submit), in every branch', () => {
    const prevent = vi.fn();
    render(<ClockTimePicker value={t('08:45')} onChange={() => {}} />);
    act(() => { input().props.onPressEnter({ preventDefault: prevent }); });   // opens
    act(() => { input().props.onChange({ target: { value: '1010' } }); });
    act(() => { input().props.onPressEnter({ preventDefault: prevent }); });   // commits
    expect(prevent).toHaveBeenCalledTimes(2);
    act(() => { tree!.update(<ClockTimePicker disabled />); });
    act(() => { input().props.onPressEnter({ preventDefault: prevent }); });   // disabled
    expect(prevent).toHaveBeenCalledTimes(3);
  });

  it('forwards Form.Item aria-* props and id to the input', () => {
    render(<ClockTimePicker id="sendTime" aria-invalid aria-required aria-describedby="sendTime_help" />);
    expect(input().props).toMatchObject({ id: 'sendTime', 'aria-invalid': true, 'aria-required': true, 'aria-describedby': 'sendTime_help' });
  });
});

describe('Tab from the field', () => {
  it('closes the dropdown, stops rc-dropdown from hijacking Tab and does not prevent the native focus move', () => {
    render(<ClockTimePicker value={t('08:45')} />);
    act(() => { dropdown.props!.onOpenChange(true); });
    const stop = vi.fn(); const prevent = vi.fn();
    act(() => { input().props.onKeyDown({ key: 'Tab', shiftKey: true, stopPropagation: stop, preventDefault: prevent }); });
    expect(stop).toHaveBeenCalled();
    expect(prevent).not.toHaveBeenCalled();
    expect(dropdown.props!.open).toBe(false);
  });
});

describe('keyboard', () => {
  it('ArrowDown on the field opens the dial and Enter on a closed unchanged field opens it too', () => {
    render(<ClockTimePicker value={t('08:45')} />);
    const prevented = vi.fn();
    act(() => { input().props.onKeyDown({ key: 'ArrowDown', preventDefault: prevented }); });
    expect(dropdown.props!.open).toBe(true);
    expect(prevented).toHaveBeenCalled();
    act(() => { dropdown.props!.onOpenChange(false); });
    expect(dropdown.props!.open).toBe(false);
    act(() => { input().props.onPressEnter({ preventDefault() {} }); });
    expect(dropdown.props!.open).toBe(true);
  });

  it('Enter with a changed valid text commits it without opening', () => {
    const onChange = vi.fn();
    render(<ClockTimePicker value={t('08:45')} onChange={onChange} />);
    act(() => { input().props.onChange({ target: { value: '1010' } }); });
    act(() => { input().props.onPressEnter({ preventDefault() {} }); });
    expect(onChange.mock.calls[0][1]).toBe('10:10');
    expect(dropdown.props!.open).toBe(false);
  });

  const dialKey = (k: string) => act(() => {
    const svg = tree!.root.findByType('svg');
    svg.props.onKeyDown({ key: k, target: 'dial', currentTarget: 'dial', preventDefault() {} });
  });

  it('dial is the focusable element, labels are tabIndex -1; arrows move hours and Enter commits then goes to minutes', () => {
    const onChange = vi.fn(); const onClose = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={onChange} onClose={onClose} />);
    expect(tree!.root.findByType('svg').props.tabIndex).toBe(0);
    expect(label('13 ч').props.tabIndex).toBe(-1);
    dialKey('ArrowRight'); dialKey('ArrowRight');
    expect(onChange).not.toHaveBeenCalled();
    dialKey('Enter');
    expect(onChange.mock.calls[0][0].hour()).toBe(10);
    expect(svgLabel()).toBe('Выбор минут');
    dialKey('ArrowLeft');
    dialKey(' ');
    const v = onChange.mock.calls[1][0];
    expect([v.hour(), v.minute()]).toEqual([10, 40]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('arrows wrap (hours 0 <-> 23, minutes 55 -> 00) and ignore events from labels', () => {
    const onChange = vi.fn();
    render(<ClockDialPanel value={t('00:55')} onChange={onChange} onClose={() => {}} />);
    dialKey('ArrowLeft');
    dialKey('Enter');
    expect(onChange.mock.calls[0][0].hour()).toBe(23);
    dialKey('ArrowRight');
    dialKey('Enter');
    expect(onChange.mock.calls[1][0].minute()).toBe(0);
    act(() => { tree!.root.findByType('svg').props.onKeyDown({ key: 'Enter', target: 'label', currentTarget: 'dial', preventDefault() {} }); });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('Escape in the panel closes it', () => {
    const onClose = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={() => {}} onClose={onClose} />);
    act(() => { tree!.root.findAll((n) => (n.type as unknown) === 'div')[0].props.onKeyDown({ key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('pointer interaction', () => {
  const rect = { left: 0, top: 0, width: 240, height: 240 };
  const calls = { capture: 0, release: 0 };
  const ev = (x: number, y: number) => ({
    clientX: x, clientY: y, pointerId: 1,
    currentTarget: { getBoundingClientRect: () => rect, setPointerCapture: () => { calls.capture += 1; }, releasePointerCapture: () => { calls.release += 1; } },
  });
  const svg = () => tree!.root.findByType('svg');
  const hint = () => tree!.root.findAllByType('button').slice(0, 2).map((b) => b.children.join(''));

  it('hours drag previews on the hand, commits once on up, then minutes commits once and closes', () => {
    const onChange = vi.fn(); const onClose = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={onChange} onClose={onClose} />);
    act(() => { svg().props.onPointerDown(ev(120, 24)); });     // 12 o'clock outer = 12
    expect(onChange).not.toHaveBeenCalled();
    act(() => { svg().props.onPointerMove(ev(216, 120)); });    // 3 outer
    expect(onChange).not.toHaveBeenCalled();
    const label3 = label('03 ч');
    expect(label3.findAllByType('text')[0].props.fill).toBe('#fff'); // provisional selection highlighted
    act(() => { svg().props.onPointerUp(ev(216, 120)); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].hour()).toBe(3);
    expect(onChange.mock.calls[0][0].minute()).toBe(45);
    expect(svgLabel()).toBe('Выбор минут');
    expect(hint()[0]).toBe('03');
    // the click that follows the pointer gesture must not commit again
    act(() => { label('15 мин').props.onClick({ detail: 1 }); });
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => { svg().props.onPointerDown(ev(24, 120)); });     // 45 min
    act(() => { svg().props.onPointerUp(ev(24, 120)); });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0].minute()).toBe(45);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls.capture).toBeGreaterThan(0);
  });

  it('inner ring is chosen by distance from the centre', () => {
    const onChange = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={onChange} onClose={() => {}} />);
    act(() => { svg().props.onPointerDown(ev(182, 120)); });    // 3 o'clock, radius 62 -> 15
    act(() => { svg().props.onPointerUp(ev(182, 120)); });
    expect(onChange.mock.calls[0][0].hour()).toBe(15);
  });

  it('pointercancel discards the gesture, pointermove without a press does nothing', () => {
    const onChange = vi.fn();
    render(<ClockDialPanel value={t('08:45')} onChange={onChange} onClose={() => {}} />);
    act(() => { svg().props.onPointerMove(ev(216, 120)); });
    act(() => { svg().props.onPointerUp(ev(216, 120)); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { svg().props.onPointerDown(ev(216, 120)); });
    act(() => { svg().props.onPointerCancel(); });
    act(() => { svg().props.onPointerUp(ev(216, 120)); });
    expect(onChange).not.toHaveBeenCalled();
    expect(svgLabel()).toBe('Выбор часов');
  });
});

describe('DailyOrderDigestConfig time fields', () => {
  it('use ClockTimePicker for both fields and no antd TimePicker', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../pages/configuration/components/DailyOrderDigestConfig.tsx'), 'utf8');
    expect(source.match(/<ClockTimePicker/g)).toHaveLength(2);
    expect(source).not.toMatch(/<TimePicker/);
    expect(source).not.toMatch(/<CommitOnSelectTimePicker/);
  });
});
