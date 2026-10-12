/**
 * Motion Blur, as in Photoshop: each pixel becomes the average of the pixels
 * on a line through it, `distance` image pixels long, at `angle` degrees
 * (0 is level, 90 is straight up). The SVG filter is built in `canvas.ts`.
 */
export interface MotionBlurParams {
  /** The length of the line in image pixels. */
  distance: number;
  /** -90 to 90 degrees; a line at 90 is the same as one at -90. */
  angle: number;
}

const FILTER_PREFIX = "mob_";

/** The id of the SVG filter for these settings; equal settings share one filter. The angle is stored plus 90, so the id has no minus sign. */
export const motionBlurFilterId = (params: MotionBlurParams) =>
  `${FILTER_PREFIX}${Math.round(params.distance)}_${Math.round(params.angle) + 90}`;

export const motionBlurFilterUrl = (params: MotionBlurParams) => `url(#${motionBlurFilterId(params)})`;

/** The settings in a motion blur filter id; null when the id is not one. */
export function parseMotionBlurFilterId(id: string): MotionBlurParams | null {
  if (!id.startsWith(FILTER_PREFIX)) return null;
  const numbers = id.slice(FILTER_PREFIX.length).split("_").map(Number);
  if (numbers.length !== 2 || numbers.some((number) => !Number.isFinite(number))) return null;
  return { distance: numbers[0], angle: numbers[1] - 90 };
}

/** The motion blur filter ids used in a canvas filter string. */
export const motionBlurFilterIds = (filter: string) =>
  Array.from(filter.matchAll(/url\(#(mob_[\d_]+)\)/g), (match) => match[1]);

/**
 * The steps of the filter. Each step averages the image with a copy of
 * itself moved along the line, and each move is twice the one before, so
 * `steps.length` steps average 2^steps copies, evenly spaced at most one
 * pixel apart along `distance`. `center` then moves the result back by half
 * its length, so the blur spreads to both sides of each pixel.
 */
export function motionBlurSteps({ distance, angle }: MotionBlurParams) {
  const count = Math.max(1, Math.ceil(Math.log2(Math.max(1, distance))));
  const spacing = distance / 2 ** count;
  const radians = (angle * Math.PI) / 180;
  /** Screen y grows downward, so a positive angle moves up. */
  const unitX = Math.cos(radians);
  const unitY = -Math.sin(radians);
  const steps = Array.from({ length: count }, (_, index) => ({ dx: unitX * spacing * 2 ** index, dy: unitY * spacing * 2 ** index }));
  const half = ((2 ** count - 1) * spacing) / 2;
  return { steps, center: { dx: -unitX * half, dy: -unitY * half } };
}
