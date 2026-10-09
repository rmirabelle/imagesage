import { colorizeFilterUrl } from "./colorize";
import { contrastFilterUrl, type ContrastParams } from "./contrast";
import { sharpenFilterUrl } from "./sharpen";
import type { Adjustment, AdjustmentKind, LayerAdjust } from "./types";

/**
 * Moves the layer at node `from` so it sits directly above (or below) the
 * layer at node `to`. Node 0 is the original image: it stays at the bottom,
 * so a layer dropped on it goes directly above it. Returns the new history and
 * the moved layer's new node.
 */
export function moveLayer<T>(history: T[], from: number, to: number, above: boolean): { history: T[]; node: number } {
  if (from < 1 || from > history.length || to < 0 || to > history.length || from === to) return { history, node: from };
  const moved = history[from - 1];
  const rest = history.filter((_, index) => index !== from - 1);
  const target = to > from ? to - 1 : to;
  const index = above || target === 0 ? target : target - 1;
  rest.splice(index, 0, moved);
  return { history: rest, node: index + 1 };
}

/**
 * Moves the layers at `nodes` together, in their own order, so they sit
 * directly above (or below) the layer at node `to`; layers between them close
 * up. A drop on one of the moved layers, or on node 0 below, changes nothing
 * or puts them at the bottom. Returns the new history and the moved layers'
 * new nodes, in the order of `nodes`.
 */
export function moveLayers<T>(history: T[], nodes: number[], to: number, above: boolean): { history: T[]; nodes: number[] } {
  const moving = [...new Set(nodes)].filter((node) => node >= 1 && node <= history.length).sort((a, b) => a - b);
  if (!moving.length || moving.includes(to) || to < 0 || to > history.length) return { history, nodes };
  const rest = history.map((_, index) => index).filter((index) => !moving.includes(index + 1));
  const at = to === 0 ? 0 : rest.indexOf(to - 1) + (above ? 1 : 0);
  const order = [...rest.slice(0, at), ...moving.map((node) => node - 1), ...rest.slice(at)];
  if (order.every((index, position) => index === position)) return { history, nodes };
  return {
    history: order.map((index) => history[index]),
    nodes: nodes.map((node) => order.indexOf(node - 1) + 1)
  };
}

/**
 * The adjustments as a list. Documents that were open before adjustments
 * became a list can still hold the older single-brightness object; it counts as none.
 */
export const adjustList = (adjust: LayerAdjust | undefined): LayerAdjust => Array.isArray(adjust) ? adjust : [];

/** The name of each kind of adjustment, for chips and menus. */
export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = { brightness: "Brightness", contrast: "Contrast", hueSaturation: "Hue/Saturation", opacity: "Opacity", blur: "Blur", sharpen: "Sharpen" };

/** A number an adjustment keeps. */
export type AdjustmentField = "value" | "hue" | "saturation" | "lightness" | "pivot" | "curve" | "color" | "radius";

/**
 * The sliders of each kind of adjustment: which number, its name, its range,
 * its unit, the value that changes nothing (`neutral`), and whether it shows
 * with a sign. With `decimals`, the stored whole number is shown divided by
 * 10 to that power, such as 12 shown as 1.2. With `log`, the slider moves on
 * a log scale: fine steps at the low end, large steps at the high end.
 */
export const ADJUSTMENT_FIELDS: Record<AdjustmentKind, { field: AdjustmentField; label: string; min: number; max: number; unit: string; neutral: number; signed: boolean; decimals?: number; log?: boolean }[]> = {
  brightness: [{ field: "value", label: "Brightness", min: -100, max: 100, unit: "", neutral: 0, signed: true }],
  /** Only Amount changes the image by itself; the other three shape how it does. */
  contrast: [
    { field: "value", label: "Amount", min: -100, max: 100, unit: "", neutral: 0, signed: true },
    { field: "pivot", label: "Middle", min: 0, max: 100, unit: "%", neutral: 50, signed: false },
    { field: "curve", label: "Soft ends", min: 0, max: 100, unit: "%", neutral: 50, signed: false },
    { field: "color", label: "Color", min: 0, max: 100, unit: "%", neutral: 100, signed: false }
  ],
  hueSaturation: [
    { field: "hue", label: "Hue", min: -180, max: 180, unit: "°", neutral: 0, signed: true },
    { field: "saturation", label: "Saturation", min: -100, max: 100, unit: "", neutral: 0, signed: true },
    { field: "lightness", label: "Lightness", min: -100, max: 100, unit: "", neutral: 0, signed: true }
  ],
  opacity: [{ field: "value", label: "Opacity", min: 0, max: 100, unit: "%", neutral: 100, signed: false }],
  blur: [{ field: "value", label: "Radius", min: 0, max: 100, unit: " px", neutral: 0, signed: false }],
  /** Only Amount changes the image by itself; Radius sets the size of the edges it works on. */
  sharpen: [
    { field: "value", label: "Amount", min: 0, max: 500, unit: "%", neutral: 0, signed: false },
    { field: "radius", label: "Radius", min: 1, max: 3000, unit: " px", neutral: 10, signed: false, decimals: 1, log: true }
  ]
};

/** Slider steps of a log-scale slider, from its minimum to its maximum. */
export const LOG_SLIDER_STEPS = 1000;
/** The slider place (0 to `LOG_SLIDER_STEPS`) of a value on a log-scale slider, and back. */
export const logSliderPosition = (value: number, min: number, max: number) =>
  Math.round(LOG_SLIDER_STEPS * Math.log(Math.max(min, value) / min) / Math.log(max / min));
export const logSliderValue = (position: number, min: number, max: number) =>
  Math.round(min * (max / min) ** (position / LOG_SLIDER_STEPS));

/** A slider number as text: whole, or with its decimals (12 with one decimal is "1.2"). */
export const formatAdjustNumber = (value: number, decimals = 0) => decimals ? (value / 10 ** decimals).toFixed(decimals) : String(value);

/** Hue/Saturation with Colorize on: one hue for every pixel, at a strength (Photoshop starts at 0° and 25). */
export const COLORIZE_FIELDS: typeof ADJUSTMENT_FIELDS[AdjustmentKind] = [
  { field: "hue", label: "Hue", min: 0, max: 360, unit: "°", neutral: 0, signed: false },
  { field: "saturation", label: "Saturation", min: 0, max: 100, unit: "", neutral: 25, signed: false },
  { field: "lightness", label: "Lightness", min: -100, max: 100, unit: "", neutral: 0, signed: true }
];

/** The sliders of one adjustment; Colorize changes the ranges of Hue/Saturation. */
export const adjustmentFields = (adjustment: Pick<Adjustment, "kind" | "colorize">) =>
  adjustment.kind === "hueSaturation" && adjustment.colorize ? COLORIZE_FIELDS : ADJUSTMENT_FIELDS[adjustment.kind];

/** One number of an adjustment; a number it does not keep is its neutral value, or 0. */
export const adjustmentNumber = (adjustment: Adjustment, field: AdjustmentField) =>
  adjustment[field] ?? adjustmentFields(adjustment).find((item) => item.field === field)?.neutral ?? 0;

/** The settings of a contrast adjustment, each from 0 to 1 (the amount from -1 to 1). */
export const contrastParams = (adjustment: Adjustment): ContrastParams => ({
  amount: adjustmentNumber(adjustment, "value") / 100,
  pivot: adjustmentNumber(adjustment, "pivot") / 100,
  curve: adjustmentNumber(adjustment, "curve") / 100,
  color: adjustmentNumber(adjustment, "color") / 100
});

/** A new adjustment of a kind, with no change yet; a new blur starts at 5 px, so it shows at once. */
export const newAdjustment = (kind: AdjustmentKind): Adjustment => {
  const added = resetAdjustment({ id: newAdjustmentId(), kind, value: 0 });
  return kind === "blur" ? { ...added, value: 5 } : added;
};

/** The adjustment with every number back at the value that changes nothing. */
export const resetAdjustment = (adjustment: Adjustment): Adjustment => {
  const reset: Adjustment = { ...adjustment, value: 0 };
  for (const { field, neutral } of adjustmentFields(adjustment)) reset[field] = neutral;
  return reset;
};

/**
 * Hue/Saturation with Colorize turned on or off. Each mode starts from its own
 * neutral numbers, because the same numbers mean different things in each.
 */
export const setColorize = (adjustment: Adjustment, colorize: boolean): Adjustment => {
  const { colorize: _colorize, ...rest } = adjustment;
  return resetAdjustment(colorize ? { ...rest, colorize: true } : rest);
};

/** How opaque an opacity adjustment leaves the layer (0 to 1), or null when it changes nothing (absent, off, other kinds, or 100%). */
export function adjustmentOpacity(adjustment?: Adjustment): number | null {
  if (!adjustment || adjustment.off || adjustment.kind !== "opacity" || adjustment.value >= 100) return null;
  return Math.max(0, adjustment.value) / 100;
}

/** A new adjustment id; it never equals "mask", the layer mask's part name. */
export const newAdjustmentId = () => `adj-${crypto.randomUUID().slice(0, 8)}`;

/**
 * The canvas filter for Hue/Saturation's Lightness, as in Photoshop: below 0
 * it moves each color toward black, above 0 toward white (inverted, darkened,
 * inverted back). Empty at 0.
 */
export const lightnessFilter = (lightness: number) =>
  lightness < 0 ? `brightness(${(100 + lightness) / 100})`
    : lightness > 0 ? `invert(1) brightness(${(100 - lightness) / 100}) invert(1)`
    : "";

/** The canvas filter for an adjustment, or null when it changes nothing (absent, off, or 0). */
export function adjustmentFilter(adjustment?: Adjustment): string | null {
  if (!adjustment || adjustment.off) return null;
  if (adjustment.kind === "opacity") {
    const opacity = adjustmentOpacity(adjustment);
    return opacity === null ? null : `opacity(${opacity})`;
  }
  /** Colorize always changes the image: at saturation 0 it makes the layer gray. */
  if (adjustment.kind === "hueSaturation" && adjustment.colorize) {
    const colorize = colorizeFilterUrl({ hue: adjustmentNumber(adjustment, "hue"), saturation: adjustmentNumber(adjustment, "saturation") / 100 });
    /** As in Photoshop, Lightness comes first: white lowered to a middle gray takes the full color. */
    return [lightnessFilter(adjustmentNumber(adjustment, "lightness")), colorize].filter(Boolean).join(" ");
  }
  if (adjustment.kind === "hueSaturation") {
    const parts = [
      adjustment.hue ? `hue-rotate(${adjustment.hue}deg)` : "",
      adjustment.saturation ? `saturate(${(100 + adjustment.saturation) / 100})` : "",
      lightnessFilter(adjustment.lightness ?? 0)
    ].filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  if (adjustment.kind === "blur") return adjustment.value > 0 ? `blur(${adjustment.value}px)` : null;
  if (adjustment.kind === "sharpen") {
    return adjustment.value > 0
      ? sharpenFilterUrl({ amount: adjustment.value / 100, radius: adjustmentNumber(adjustment, "radius") / 10, brightnessOnly: !adjustment.colorSharpen })
      : null;
  }
  if (adjustment.kind === "contrast") return adjustment.value ? contrastFilterUrl(contrastParams(adjustment)) : null;
  return adjustment.value ? `brightness(${(100 + adjustment.value) / 100})` : null;
}

/** True when a layer has any adjustment that changes how it looks. */
export const hasAdjustments = (adjust?: LayerAdjust) => adjustList(adjust).some((adjustment) => Boolean(adjustmentFilter(adjustment)));

/** A short signature of a mask data URL, for cache keys; empty for no mask. */
export const maskSignature = (mask?: string) => mask ? `${mask.length}:${mask.slice(-24)}` : "";

/** A signature of everything about a layer's adjustments that changes how the layer looks. */
export const adjustSignature = (adjust?: LayerAdjust) => adjustList(adjust).flatMap((adjustment) => {
  const filter = adjustmentFilter(adjustment);
  if (!filter) return [];
  const mask = adjustment.mask && !adjustment.maskOff ? adjustment.mask : undefined;
  return [`${filter}|${maskSignature(mask)}|${adjustment.maskHides ? "hides" : "shows"}`];
}).join(";");

/**
 * The layer's "all adjustments" switch. Turning all off marks each adjustment
 * that was on, so turning all on again restores only those; adjustments turned
 * off one by one stay off.
 */
export const allAdjustmentsOff = (adjust?: LayerAdjust) => adjustList(adjust).length > 0 && adjustList(adjust).every((adjustment) => adjustment.off);
export const toggleAllAdjustments = (adjust: LayerAdjust | undefined): LayerAdjust | undefined => {
  const list = adjustList(adjust);
  if (!list.length) return adjust;
  if (allAdjustmentsOff(list) && list.some((adjustment) => adjustment.offByAll)) {
    return list.map(({ off: _off, offByAll, ...rest }) => offByAll ? rest : { ...rest, off: true });
  }
  if (allAdjustmentsOff(list)) return list.map(({ off: _off, offByAll: _by, ...rest }) => rest);
  return list.map((adjustment) => adjustment.off ? adjustment : { ...adjustment, off: true, offByAll: true });
};

/** The adjustment with an id, if the layer has it. */
export const findAdjustment = (adjust: LayerAdjust | undefined, id: string) => adjustList(adjust).find((adjustment) => adjustment.id === id);

/** The adjustments with one replaced (or, with undefined, removed); undefined when none are left. */
export const replaceAdjustment = (adjust: LayerAdjust | undefined, id: string, next: Adjustment | undefined): LayerAdjust | undefined => {
  const list = adjustList(adjust).flatMap((adjustment) => adjustment.id !== id ? [adjustment] : next ? [next] : []);
  return list.length ? list : undefined;
};
