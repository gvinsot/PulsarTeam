// ── Colors and bucketing for the Analytics charts ───────────────────────────
//
// Categorical palette validated for both themes (lightness band, chroma, CVD
// and normal-vision separation, contrast): each mode has its own steps of the
// same eight hues. Hues are assigned in FIXED order and follow the entity —
// a task type always gets the same color, whatever its rank or which types are
// present — so filtering never repaints the survivors.

import type { AnalyticsCountBucket } from '../types';
import { TASK_TYPES } from './tasks/taskConstants';

export const SERIES_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
];

export const SERIES_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];

/** Muted gray for the folded "Other" slice — never a generated 9th hue. */
export const OTHER_COLOR = { light: '#9ca3af', dark: '#6b7280' };

/** Reserved status color for "critical" (errors); never used for a series. */
export const CRITICAL_COLOR = { light: '#c62828', dark: '#ef5350' };

export const OTHER_KEY = 'Other';

export function seriesPalette(theme: string) {
  return theme === 'light' ? SERIES_LIGHT : SERIES_DARK;
}

/**
 * Stable slot per task type, chosen to echo the type badges on task cards
 * (bug red, feature green, technical blue, …). Unknown (free-form) types fall
 * back to a hash so they are still stable across renders.
 */
const TYPE_SLOTS: Record<string, number> = {
  technical: 0, // blue
  feature: 2, // aqua-green
  documentation: 3, // yellow
  other: 4, // magenta
  improvement: 6, // violet
  bug: 7, // red
};

/**
 * Fixed slice order for type charts. A doughnut makes neighbours of whatever
 * sits next to each other, so the order is chosen so that every adjacent pair
 * of hues stays distinguishable (validated, both themes, incl. color-vision
 * deficiencies). Unknown types follow, then the folded "Other" bucket.
 */
export const TYPE_ORDER = [
  'bug',
  'technical',
  'feature',
  'improvement',
  'documentation',
  'other',
  'untyped',
];

export function orderByType(buckets: AnalyticsCountBucket[]): AnalyticsCountBucket[] {
  const rank = (k: string) => {
    if (k === OTHER_KEY) return Number.MAX_SAFE_INTEGER;
    const i = TYPE_ORDER.indexOf(k);
    return i >= 0 ? i : TYPE_ORDER.length;
  };
  return [...buckets].sort((a, b) => rank(a.key) - rank(b.key) || b.count - a.count);
}

export function slotForKey(key: string): number {
  if (key in TYPE_SLOTS) return TYPE_SLOTS[key];
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % SERIES_LIGHT.length;
}

export function colorForKey(key: string, theme: string) {
  // "Untyped" is the absence of a type: neutral, like the folded bucket.
  if (key === OTHER_KEY || key === 'untyped')
    return theme === 'light' ? OTHER_COLOR.light : OTHER_COLOR.dark;
  return seriesPalette(theme)[slotForKey(key)];
}

/**
 * Keep the `max - 1` largest buckets and fold the rest into one "Other"
 * bucket, so a chart never needs more hues than the palette has.
 */
export function foldOther(buckets: AnalyticsCountBucket[], max = 8): AnalyticsCountBucket[] {
  const sorted = [...buckets].sort((a, b) => b.count - a.count);
  if (sorted.length <= max) return sorted;
  const head = sorted.slice(0, max - 1);
  const rest = sorted.slice(max - 1).reduce((s, b) => s + b.count, 0);
  return [...head, { key: OTHER_KEY, count: rest }];
}

/** Human label for a task type key. */
export function typeLabel(key: string) {
  if (key === 'untyped') return 'Untyped';
  return TASK_TYPES.find(t => t.value === key)?.label || key;
}

/** Share of `part` in `total` as a whole percentage string. */
export function pct(part: number, total: number) {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';
}
