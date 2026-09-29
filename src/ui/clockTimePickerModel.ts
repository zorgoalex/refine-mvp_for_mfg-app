import dayjs, { type Dayjs } from 'dayjs';

/** Pure geometry / parsing helpers for ClockTimePicker (no React). */

export interface Point { x: number; y: number }
export type ClockRing = 'outer' | 'inner';

export const DIAL_SIZE = 240;
export const DIAL_CENTER: Point = { x: DIAL_SIZE / 2, y: DIAL_SIZE / 2 };
export const OUTER_RADIUS = 96;
export const INNER_RADIUS = 62;
/** Distance from centre below which a hours-mode pointer selects the inner ring. */
export const INNER_THRESHOLD = (OUTER_RADIUS + INNER_RADIUS) / 2;

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export const formatTime = (value: Dayjs | null | undefined): string =>
  value && value.isValid() ? `${pad2(value.hour())}:${pad2(value.minute())}` : '';

/** Point on a circle; angle in degrees clockwise from 12 o'clock. */
export function polarPoint(angleDeg: number, radius: number, center: Point = DIAL_CENTER): Point {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: center.x + radius * Math.sin(rad), y: center.y - radius * Math.cos(rad) };
}

/** Clockwise angle from 12 o'clock in [0, 360). */
export function pointAngle(x: number, y: number, center: Point = DIAL_CENTER): number {
  const deg = (Math.atan2(x - center.x, center.y - y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export const hourRing = (hour: number): ClockRing => (hour === 0 || hour >= 13 ? 'inner' : 'outer');
export const hourAngle = (hour: number): number => (hour % 12) * 30;
export const minuteAngle = (minute: number): number => minute * 6;

export interface HourLabel { hour: number; text: string; ring: ClockRing; angle: number; x: number; y: number }

/** 24h double ring: outer 12,1..11 (12 on top); inner 00,13..23 (00 on top). */
export function hourLabels(): HourLabel[] {
  const labels: HourLabel[] = [];
  for (let p = 0; p < 12; p += 1) {
    const outerHour = p === 0 ? 12 : p;
    const innerHour = p === 0 ? 0 : 12 + p;
    const angle = p * 30;
    labels.push({ hour: outerHour, text: pad2(outerHour), ring: 'outer', angle, ...polarPoint(angle, OUTER_RADIUS) });
    labels.push({ hour: innerHour, text: pad2(innerHour), ring: 'inner', angle, ...polarPoint(angle, INNER_RADIUS) });
  }
  return labels;
}

export interface MinuteLabel { minute: number; text: string; angle: number; x: number; y: number }

/** Labels are always every 5 minutes, independent of the step. */
export function minuteLabels(): MinuteLabel[] {
  return Array.from({ length: 12 }, (_, i) => {
    const minute = i * 5;
    const angle = minuteAngle(minute);
    return { minute, text: pad2(minute), angle, ...polarPoint(angle, OUTER_RADIUS) };
  });
}

export function hourHandPoint(hour: number): Point {
  return polarPoint(hourAngle(hour), hourRing(hour) === 'inner' ? INNER_RADIUS : OUTER_RADIUS);
}

export function minuteHandPoint(minute: number): Point {
  return polarPoint(minuteAngle(minute), OUTER_RADIUS);
}

/** Hour 0..23 under the pointer: ring by distance from centre, position by angle. */
export function pointToHour(x: number, y: number, center: Point = DIAL_CENTER, innerThreshold: number = INNER_THRESHOLD): number {
  const p = Math.round(pointAngle(x, y, center) / 30) % 12;
  const inner = Math.hypot(x - center.x, y - center.y) < innerThreshold;
  if (inner) return p === 0 ? 0 : 12 + p;
  return p === 0 ? 12 : p;
}

export function snapMinute(minute: number, step: number): number {
  const s = Number.isFinite(step) && step >= 1 ? Math.floor(step) : 1;
  return (Math.round(minute / s) * s) % 60;
}

export function pointToMinute(x: number, y: number, center: Point = DIAL_CENTER, step = 5): number {
  return snapMinute(Math.round(pointAngle(x, y, center) / 6) % 60, step);
}

/** Accepts H:mm, HH:mm, H.mm, HH.mm, Hmm, HHmm. */
export function parseTypedTime(text: string): { hour: number; minute: number } | null {
  const t = text.trim();
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(t) ?? /^(\d{1,2})(\d{2})$/.exec(t);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function withTime(base: Dayjs | null | undefined, hour: number, minute: number): Dayjs {
  const start = base && base.isValid() ? base : dayjs();
  return start.hour(hour).minute(minute).second(0).millisecond(0);
}

/** Rounds to the nearest step within the same day (23:58 -> 00:00 is avoided by clamping to the last step). */
export function roundToStep(value: Dayjs, step: number): Dayjs {
  const s = Number.isFinite(step) && step >= 1 ? Math.floor(step) : 1;
  const total = value.hour() * 60 + value.minute();
  let rounded = Math.round(total / s) * s;
  if (rounded >= 1440) rounded = Math.floor(1439 / s) * s;
  return withTime(value, Math.floor(rounded / 60), rounded % 60);
}
