/**
 * Contrast as a curve. Each value moves away from the middle gray `pivot` (or
 * toward it, for a negative amount). `curve` blends a straight line, which
 * clips at black and white, with a smooth S-curve that rolls off before it
 * gets there. `color` blends contrast on brightness only (0) with contrast on
 * each color (1), which also makes colors stronger. Pure math; the SVG filter
 * that applies it is built in `canvas.ts`.
 */
export interface ContrastParams {
  /** -1 to 1; 0 changes nothing. */
  amount: number;
  /** 0 to 1. */
  pivot: number;
  /** 0 to 1. */
  curve: number;
  /** 0 to 1. */
  color: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The slope at the middle gray: 0 (flat gray) at -1, 1 (no change) at 0, 4 at 1. */
export const contrastSlope = (amount: number) => amount >= 0 ? 1 + amount * 3 : 1 + amount;

/** One value (0 to 1) after contrast. */
export function contrastCurve(x: number, params: Pick<ContrastParams, "amount" | "pivot" | "curve">) {
  const slope = contrastSlope(params.amount);
  const pivot = Math.min(0.99, Math.max(0.01, params.pivot));
  const straight = clamp01((x - pivot) * slope + pivot);
  const smooth = x <= pivot
    ? pivot * Math.pow(Math.max(0, x) / pivot, slope)
    : 1 - (1 - pivot) * Math.pow(Math.max(0, 1 - x) / (1 - pivot), slope);
  return clamp01(straight * (1 - params.curve) + smooth * params.curve);
}

/** The curve as a lookup table of `size` values, for an SVG `feComponentTransfer`. */
export const contrastTable = (params: ContrastParams, size = 256) =>
  Array.from({ length: size }, (_, index) => contrastCurve(index / (size - 1), params));

const FILTER_PREFIX = "ctr_";
const toPercent = (value: number) => Math.round(value * 100);

/** The id of the SVG filter for these settings; equal settings share one filter. */
export const contrastFilterId = (params: ContrastParams) =>
  `${FILTER_PREFIX}${[params.amount, params.pivot, params.curve, params.color].map(toPercent).join("_")}`;

export const contrastFilterUrl = (params: ContrastParams) => `url(#${contrastFilterId(params)})`;

/** The settings in a contrast filter id; null when the id is not one. */
export function parseContrastFilterId(id: string): ContrastParams | null {
  if (!id.startsWith(FILTER_PREFIX)) return null;
  const numbers = id.slice(FILTER_PREFIX.length).split("_").map(Number);
  if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number))) return null;
  const [amount, pivot, curve, color] = numbers.map((number) => number / 100);
  return { amount, pivot, curve, color };
}

/** The contrast filter ids used in a canvas filter string. */
export const contrastFilterIds = (filter: string) =>
  Array.from(filter.matchAll(/url\(#(ctr_[-\d_]+)\)/g), (match) => match[1]);
