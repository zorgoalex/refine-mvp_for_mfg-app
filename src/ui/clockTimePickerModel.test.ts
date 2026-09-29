import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
  DIAL_CENTER, INNER_RADIUS, INNER_THRESHOLD, OUTER_RADIUS,
  formatTime, hourLabels, minuteLabels, parseTypedTime, pointToHour, pointToMinute, polarPoint, roundToStep,
} from './clockTimePickerModel';

const c = DIAL_CENTER;
const at = (angle: number, r: number) => polarPoint(angle, r);
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('hour labels', () => {
  const labels = hourLabels();
  const byHour = (h: number) => labels.find((l) => l.hour === h)!;
  it('has 24 unique hours', () => {
    expect(new Set(labels.map((l) => l.hour)).size).toBe(24);
  });
  it('12 is top of the outer ring, 00 top of the inner ring', () => {
    near(byHour(12).x, c.x); near(byHour(12).y, c.y - OUTER_RADIUS);
    near(byHour(0).x, c.x); near(byHour(0).y, c.y - INNER_RADIUS);
    expect(byHour(12).ring).toBe('outer');
    expect(byHour(0).ring).toBe('inner');
    expect(byHour(0).text).toBe('00');
  });
  it('3 and 15 are on the right, 6 and 18 at the bottom', () => {
    near(byHour(3).x, c.x + OUTER_RADIUS); near(byHour(3).y, c.y);
    near(byHour(15).x, c.x + INNER_RADIUS); near(byHour(15).y, c.y);
    near(byHour(6).y, c.y + OUTER_RADIUS);
    near(byHour(18).y, c.y + INNER_RADIUS);
  });
  it('13 sits at 1 o clock and 23 at 11', () => {
    expect(byHour(13).angle).toBe(30);
    expect(byHour(23).angle).toBe(330);
    expect(byHour(1).angle).toBe(30);
  });
  it('minute labels are every five minutes', () => {
    const m = minuteLabels();
    expect(m.map((l) => l.text)).toEqual(['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']);
    near(m[3].x, c.x + OUTER_RADIUS);
  });
});

describe('pointToHour', () => {
  it('outer ring', () => {
    expect(pointToHour(...xy(at(0, OUTER_RADIUS)))).toBe(12);
    expect(pointToHour(...xy(at(30, OUTER_RADIUS)))).toBe(1);
    expect(pointToHour(...xy(at(90, OUTER_RADIUS)))).toBe(3);
    expect(pointToHour(...xy(at(180, OUTER_RADIUS)))).toBe(6);
    expect(pointToHour(...xy(at(270, OUTER_RADIUS)))).toBe(9);
    expect(pointToHour(...xy(at(330, OUTER_RADIUS)))).toBe(11);
  });
  it('inner ring', () => {
    expect(pointToHour(...xy(at(0, INNER_RADIUS)))).toBe(0);
    expect(pointToHour(...xy(at(30, INNER_RADIUS)))).toBe(13);
    expect(pointToHour(...xy(at(90, INNER_RADIUS)))).toBe(15);
    expect(pointToHour(...xy(at(330, INNER_RADIUS)))).toBe(23);
  });
  it('angle boundaries round to the nearest position and wrap at the top', () => {
    expect(pointToHour(...xy(at(14, OUTER_RADIUS)))).toBe(12);
    expect(pointToHour(...xy(at(16, OUTER_RADIUS)))).toBe(1);
    expect(pointToHour(...xy(at(346, OUTER_RADIUS)))).toBe(12);
    expect(pointToHour(...xy(at(344, OUTER_RADIUS)))).toBe(11);
    expect(pointToHour(...xy(at(359, INNER_RADIUS)))).toBe(0);
  });
  it('ring boundary is the threshold distance', () => {
    expect(pointToHour(...xy(at(90, INNER_THRESHOLD - 1)))).toBe(15);
    expect(pointToHour(...xy(at(90, INNER_THRESHOLD + 1)))).toBe(3);
  });
  it('the centre selects an inner hour deterministically', () => {
    expect(pointToHour(c.x, c.y)).toBe(0);
  });
});

describe('pointToMinute', () => {
  it('snaps to 5 minutes', () => {
    expect(pointToMinute(...xy(at(0, 90)), c, 5)).toBe(0);
    expect(pointToMinute(...xy(at(90, 90)), c, 5)).toBe(15);
    expect(pointToMinute(...xy(at(272, 90)), c, 5)).toBe(45);
    expect(pointToMinute(...xy(at(13 * 6, 90)), c, 5)).toBe(15);
    expect(pointToMinute(...xy(at(12 * 6, 90)), c, 5)).toBe(10);
  });
  it('wraps the last positions to 00', () => {
    expect(pointToMinute(...xy(at(57 * 6, 90)), c, 5)).toBe(55);
    expect(pointToMinute(...xy(at(55 * 6, 90)), c, 5)).toBe(55);
    expect(pointToMinute(...xy(at(58 * 6, 90)), c, 5)).toBe(0);
  });
  it('snaps to 15 minutes', () => {
    expect(pointToMinute(...xy(at(6 * 6, 90)), c, 15)).toBe(0);
    expect(pointToMinute(...xy(at(8 * 6, 90)), c, 15)).toBe(15);
    expect(pointToMinute(...xy(at(52 * 6, 90)), c, 15)).toBe(45);
    expect(pointToMinute(...xy(at(53 * 6, 90)), c, 15)).toBe(0);
    expect(pointToMinute(...xy(at(54 * 6, 90)), c, 15)).toBe(0);
  });
});

function xy(p: { x: number; y: number }): [number, number] { return [p.x, p.y]; }

describe('parseTypedTime', () => {
  it('accepts the supported forms', () => {
    expect(parseTypedTime('9:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseTypedTime('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseTypedTime('0930')).toEqual({ hour: 9, minute: 30 });
    expect(parseTypedTime('930')).toEqual({ hour: 9, minute: 30 });
    expect(parseTypedTime('9.30')).toEqual({ hour: 9, minute: 30 });
    expect(parseTypedTime(' 23:59 ')).toEqual({ hour: 23, minute: 59 });
    expect(parseTypedTime('00:07')).toEqual({ hour: 0, minute: 7 });
  });
  it('rejects the rest', () => {
    for (const bad of ['', '24:00', '12:60', '9:3', '9-30', 'ab:cd', '12345', '1', '12:345', '-1:30']) {
      expect(parseTypedTime(bad), bad).toBeNull();
    }
  });
});

describe('roundToStep / formatTime', () => {
  const t = (s: string) => dayjs(`2026-09-29T${s}:00`);
  it('rounds to the nearest step', () => {
    expect(formatTime(roundToStep(t('08:42'), 5))).toBe('08:40');
    expect(formatTime(roundToStep(t('08:43'), 5))).toBe('08:45');
    expect(formatTime(roundToStep(t('08:52'), 15))).toBe('08:45');
    expect(formatTime(roundToStep(t('08:53'), 15))).toBe('09:00');
  });
  it('never rolls over to the next day', () => {
    expect(formatTime(roundToStep(t('23:58'), 5))).toBe('23:55');
    expect(roundToStep(t('23:58'), 5).date()).toBe(29);
  });
  it('formats HH:mm and empty', () => {
    expect(formatTime(t('07:05'))).toBe('07:05');
    expect(formatTime(null)).toBe('');
  });
});
