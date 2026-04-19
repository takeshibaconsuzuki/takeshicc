import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../src/sessions/time';

const NOW = new Date('2026-04-18T12:00:00Z').getTime();

describe('formatRelativeTime', () => {
  it('future timestamps → "just now"', () => {
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe('just now');
  });

  it('under 30s → "just now"', () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 29_000, NOW)).toBe('just now');
  });

  it('30–59s → "<s>s ago"', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('30s ago');
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('59s ago');
  });

  it('1–59m → "<m>m ago"', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('1–23h → "<h>h ago"', () => {
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago');
  });

  it('~1 day → "yesterday"', () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('yesterday');
    expect(formatRelativeTime(NOW - 47 * 60 * 60_000, NOW)).toBe('yesterday');
  });

  it('2–6 days → "<d>d ago"', () => {
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago');
    expect(formatRelativeTime(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe('6d ago');
  });

  it('>=7 days → locale date', () => {
    const out = formatRelativeTime(NOW - 8 * 24 * 60 * 60_000, NOW);
    expect(out).toMatch(/\d/);
    expect(out).not.toMatch(/ago|yesterday|just now/);
  });
});
