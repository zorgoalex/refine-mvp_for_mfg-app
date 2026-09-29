import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

dayjs.extend(customParseFormat);
const captured = vi.hoisted(() => ({ props: undefined as Record<string, any> | undefined }));
vi.mock('antd', () => ({
  TimePicker: (props: Record<string, unknown>) => { captured.props = props; return null; },
}));

import { CommitOnSelectTimePicker } from './CommitOnSelectTimePicker';

describe('CommitOnSelectTimePicker', () => {
  it('commits a clicked cell through onChange', () => {
    const onChange = vi.fn();
    create(<CommitOnSelectTimePicker format="HH:mm" onChange={onChange} />);
    const picked = dayjs('09:30', 'HH:mm');
    captured.props!.onSelect(picked);
    expect(onChange).toHaveBeenCalledWith(picked, '09:30');
  });

  it('still calls an outer onSelect', () => {
    const onSelect = vi.fn();
    const onChange = vi.fn();
    create(<CommitOnSelectTimePicker onSelect={onSelect} onChange={onChange} />);
    const picked = dayjs('10:05', 'HH:mm');
    captured.props!.onSelect(picked);
    expect(onSelect).toHaveBeenCalledWith(picked);
    expect(onChange).toHaveBeenCalledWith(picked, '10:05');
  });

  it('forwards other props and tolerates missing onChange', () => {
    const value = dayjs('08:00', 'HH:mm');
    create(<CommitOnSelectTimePicker format="HH:mm" minuteStep={5} value={value} disabled />);
    expect(captured.props).toMatchObject({ format: 'HH:mm', minuteStep: 5, value, disabled: true });
    expect(() => captured.props!.onSelect(dayjs())).not.toThrow();
  });
});

describe('DailyOrderDigestConfig time fields', () => {
  it('use CommitOnSelectTimePicker and no bare TimePicker', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../pages/configuration/components/DailyOrderDigestConfig.tsx'), 'utf8');
    expect(source.match(/<CommitOnSelectTimePicker/g)).toHaveLength(2);
    expect(source).not.toMatch(/<TimePicker/);
  });
});
