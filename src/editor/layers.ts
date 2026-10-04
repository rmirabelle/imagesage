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
 * The adjustments as a list. Documents that were open before adjustments
 * became a list can still hold the older single-brightness object; it counts as none.
 */
export const adjustList = (adjust: LayerAdjust | undefined): LayerAdjust => Array.isArray(adjust) ? adjust : [];

/** The name of each kind of adjustment, for chips and menus. */
export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = { brightness: "Brightness", hueSaturation: "Hue/Saturation", opacity: "Opacity" };

/** A number an adjustment keeps. */
export type AdjustmentField = "value" | "hue" | "saturation";

/**
 * The sliders of each kind of adjustment: which number, its name, its range,
 * its unit, the value that changes nothing (`neutral`), and whether it shows
 * with a sign.
 */
export const ADJUSTMENT_FIELDS: Record<AdjustmentKind, { field: AdjustmentField; label: string; min: number; max: number; unit: string; neutral: number; signed: boolean }[]> = {
  brightness: [{ field: "value", label: "Brightness", min: -100, max: 100, unit: "", neutral: 0, signed: true }],
  hueSaturation: [
    { field: "hue", label: "Hue", min: -180, max: 180, unit: "°", neutral: 0, signed: true },
    { field: "saturation", label: "Saturation", min: -100, max: 100, unit: "", neutral: 0, signed: true }
  ],
  opacity: [{ field: "value", label: "Opacity", min: 0, max: 100, unit: "%", neutral: 100, signed: false }]
};

/** One number of an adjustment; a number it does not keep is 0. */
export const adjustmentNumber = (adjustment: Adjustment, field: AdjustmentField) => adjustment[field] ?? 0;

/** A new adjustment of a kind, with no change yet. */
export const newAdjustment = (kind: AdjustmentKind): Adjustment => resetAdjustment({ id: newAdjustmentId(), kind, value: 0 });

/** The adjustment with every number back at the value that changes nothing. */
export const resetAdjustment = (adjustment: Adjustment): Adjustment => {
  const reset: Adjustment = { ...adjustment, value: 0 };
  for (const { field, neutral } of ADJUSTMENT_FIELDS[adjustment.kind]) reset[field] = neutral;
  return reset;
};

/** How opaque an opacity adjustment leaves the layer (0 to 1), or null when it changes nothing (absent, off, other kinds, or 100%). */
export function adjustmentOpacity(adjustment?: Adjustment): number | null {
  if (!adjustment || adjustment.off || adjustment.kind !== "opacity" || adjustment.value >= 100) return null;
  return Math.max(0, adjustment.value) / 100;
}

/** A new adjustment id; it never equals "mask", the layer mask's part name. */
export const newAdjustmentId = () => `adj-${crypto.randomUUID().slice(0, 8)}`;

/** The canvas filter for an adjustment, or null when it changes nothing (absent, off, or 0). */
export function adjustmentFilter(adjustment?: Adjustment): string | null {
  if (!adjustment || adjustment.off) return null;
  if (adjustment.kind === "opacity") {
    const opacity = adjustmentOpacity(adjustment);
    return opacity === null ? null : `opacity(${opacity})`;
  }
  if (adjustment.kind === "hueSaturation") {
    const parts = [
      adjustment.hue ? `hue-rotate(${adjustment.hue}deg)` : "",
      adjustment.saturation ? `saturate(${(100 + adjustment.saturation) / 100})` : ""
    ].filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
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
