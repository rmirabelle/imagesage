/**
 * Colorize, as in Photoshop's Hue/Saturation: every pixel takes one hue and
 * saturation and keeps its own lightness, so black stays black, white stays
 * white, and the middle grays get the full color. Pure math; the SVG filter
 * that applies it is built in `canvas.ts`.
 */
export interface ColorizeParams {
  /** 0 to 360 degrees. */
  hue: number;
  /** 0 to 1. */
  saturation: number;
}

/** One color (each channel 0 to 1) from hue (degrees), saturation and lightness (0 to 1). */
export function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    return lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

/** The lookup tables, from lightness 0 to 1, for an SVG `feComponentTransfer`: one per channel. */
export function colorizeTables(params: ColorizeParams, size = 65): [number[], number[], number[]] {
  const tables: [number[], number[], number[]] = [[], [], []];
  for (let index = 0; index < size; index += 1) {
    const color = hslToRgb(params.hue, params.saturation, index / (size - 1));
    color.forEach((value, channel) => tables[channel].push(value));
  }
  return tables;
}

const FILTER_PREFIX = "clz_";

/** The id of the SVG filter for these settings; equal settings share one filter. */
export const colorizeFilterId = (params: ColorizeParams) =>
  `${FILTER_PREFIX}${Math.round(params.hue)}_${Math.round(params.saturation * 100)}`;

export const colorizeFilterUrl = (params: ColorizeParams) => `url(#${colorizeFilterId(params)})`;

/** The settings in a colorize filter id; null when the id is not one. */
export function parseColorizeFilterId(id: string): ColorizeParams | null {
  if (!id.startsWith(FILTER_PREFIX)) return null;
  const numbers = id.slice(FILTER_PREFIX.length).split("_").map(Number);
  if (numbers.length !== 2 || numbers.some((number) => !Number.isFinite(number))) return null;
  return { hue: numbers[0], saturation: numbers[1] / 100 };
}

/** The colorize filter ids used in a canvas filter string. */
export const colorizeFilterIds = (filter: string) =>
  Array.from(filter.matchAll(/url\(#(clz_[\d_]+)\)/g), (match) => match[1]);
