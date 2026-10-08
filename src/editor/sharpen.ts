/**
 * Sharpen, as an unsharp mask: the image minus a blurred copy of itself is the
 * detail at edges, and `amount` times that detail is added back. `radius` is
 * the blur in image pixels: small for fine detail, large for broad punch.
 * With `brightnessOnly`, only the brightness detail is added, the same to each
 * color, so edges get no color fringes. The SVG filter is built in `canvas.ts`.
 */
export interface SharpenParams {
  /** 0 and up; 1 adds the detail once. */
  amount: number;
  /** The blur radius in image pixels. */
  radius: number;
  brightnessOnly: boolean;
}

const FILTER_PREFIX = "shp_";

/** The id of the SVG filter for these settings; equal settings share one filter. */
export const sharpenFilterId = (params: SharpenParams) =>
  `${FILTER_PREFIX}${Math.round(params.amount * 100)}_${Math.round(params.radius * 10)}_${params.brightnessOnly ? 1 : 0}`;

export const sharpenFilterUrl = (params: SharpenParams) => `url(#${sharpenFilterId(params)})`;

/** The settings in a sharpen filter id; null when the id is not one. */
export function parseSharpenFilterId(id: string): SharpenParams | null {
  if (!id.startsWith(FILTER_PREFIX)) return null;
  const numbers = id.slice(FILTER_PREFIX.length).split("_").map(Number);
  if (numbers.length !== 3 || numbers.some((number) => !Number.isFinite(number))) return null;
  return { amount: numbers[0] / 100, radius: numbers[1] / 10, brightnessOnly: numbers[2] === 1 };
}

/** The sharpen filter ids used in a canvas filter string. */
export const sharpenFilterIds = (filter: string) =>
  Array.from(filter.matchAll(/url\(#(shp_[\d_]+)\)/g), (match) => match[1]);
