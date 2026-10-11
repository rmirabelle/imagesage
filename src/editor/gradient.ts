import type { Point } from "./types";

/**
 * Gradient stops, without DOM code. A gradient runs from its start point
 * (offset 0) to its end point (offset 1). The first stop is always at 0 and
 * the last at 1; the stops between them can be in any order.
 *
 * A paint gradient uses colors; a stop with `alpha` 0 is transparent. A mask
 * gradient uses only grays: white shows the layer (or applies the
 * adjustment), black hides it.
 */
export interface GradientStop {
  offset: number;
  /** "#rrggbb". */
  color: string;
  /** 0 is transparent, 1 is solid. */
  alpha: number;
}

/** The mask gradient before the user changes it: shows at the start, hides at the end. */
export const DEFAULT_MASK_STOPS: GradientStop[] = [
  { offset: 0, color: "#ffffff", alpha: 1 },
  { offset: 1, color: "#000000", alpha: 1 }
];

/**
 * The paint gradient before the user changes it: the paint color at the
 * start, fading to transparent. The end's color is white, so it is white
 * when Transparent is turned off.
 */
export const DEFAULT_PAINT_STOPS: GradientStop[] = [
  { offset: 0, color: "#000000", alpha: 1 },
  { offset: 1, color: "#ffffff", alpha: 0 }
];

/** Middle stops never sit exactly on an end, so the ends stay the ends. */
const MIN_OFFSET = 0.001;
export const clampMiddleOffset = (offset: number) => Math.min(1 - MIN_OFFSET, Math.max(MIN_OFFSET, offset));

const channels = (hex: string) => {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "000000";
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
};
const toHex = (values: number[]) => `#${values.map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0")).join("")}`;

/** How light a color is, 0 (black) to 1 (white). */
export function grayLevel(hex: string) {
  const [r, g, b] = channels(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** The gray with the same lightness as `hex`. */
export const toGray = (hex: string) => {
  const level = grayLevel(hex) * 255;
  return toHex([level, level, level]);
};

/** The stops sorted by offset, for drawing. */
export const sortedStops = (stops: GradientStop[]) => [...stops].sort((a, b) => a.offset - b.offset);

/**
 * The stops, sorted, with each transparent stop in the color of the nearest
 * solid stop. A transparent stop's own color cannot be seen, but the canvas
 * mixes it into the fade; this way a fade to transparent keeps its color.
 */
export function resolveClearStops(stops: GradientStop[]): GradientStop[] {
  const sorted = sortedStops(stops);
  const solid = sorted.filter((stop) => stop.alpha > 0);
  if (!solid.length) return sorted;
  return sorted.map((stop) => {
    if (stop.alpha > 0) return stop;
    const nearest = solid.reduce((best, candidate) => Math.abs(candidate.offset - stop.offset) < Math.abs(best.offset - stop.offset) ? candidate : best);
    return { ...stop, color: nearest.color };
  });
}

/** The color and alpha of the gradient at `offset`, mixed from the stops on each side. */
export function stopAt(stops: GradientStop[], offset: number): GradientStop {
  const sorted = sortedStops(stops);
  const after = sorted.findIndex((stop) => stop.offset >= offset);
  if (after <= 0) return { ...sorted[Math.max(0, after)], offset };
  const left = sorted[after - 1];
  const right = sorted[after];
  const t = right.offset === left.offset ? 0 : (offset - left.offset) / (right.offset - left.offset);
  const a = channels(left.color);
  const b = channels(right.color);
  return { offset, color: toHex(a.map((value, index) => value + (b[index] - value) * t)), alpha: left.alpha + (right.alpha - left.alpha) * t };
}

/**
 * Where `point` falls along the line from `from` to `to`: `offset` is 0 at
 * `from` and 1 at `to` (not clamped), and `distance` is how far the point is
 * from the line, in the same units as the points.
 */
export function projectOnLine(from: Point, to: Point, point: Point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { offset: 0, distance: Math.hypot(point.x - from.x, point.y - from.y) };
  const offset = ((point.x - from.x) * dx + (point.y - from.y) * dy) / (length * length);
  const distance = Math.abs((point.x - from.x) * dy - (point.y - from.y) * dx) / length;
  return { offset, distance };
}

/** The point at `offset` along the line from `from` to `to`. */
export const pointOnLine = (from: Point, to: Point, offset: number): Point => ({ x: from.x + (to.x - from.x) * offset, y: from.y + (to.y - from.y) * offset });

/** A stop as a CSS color. */
export const stopCss = (stop: GradientStop) => {
  const [r, g, b] = channels(stop.color);
  return `rgba(${r}, ${g}, ${b}, ${stop.alpha})`;
};

/**
 * The gradient with its start and end swapped: the stops change places, and
 * each middle stop moves to the same distance from the other end.
 */
export function reverseStops(stops: GradientStop[]): GradientStop[] {
  const first = stops[0];
  const last = stops[stops.length - 1];
  return [
    { ...last, offset: 0 },
    ...stops.slice(1, -1).map((stop) => ({ ...stop, offset: clampMiddleOffset(1 - stop.offset) })),
    { ...first, offset: 1 }
  ];
}
