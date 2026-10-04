export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The square the user draws, in image pixels. */
export interface SquareSelection {
  x: number;
  y: number;
  size: number;
}

/**
 * What is really sent to the model: a square around the selection with a
 * context margin, the size it is uploaded at, and the output size asked for.
 */
export interface SentRegion extends Rect {
  margin: number;
  requestWidth: number;
  requestHeight: number;
  resolution?: string;
}

export type DocumentOrigin =
  | { kind: "generated"; prompt: string; model: string; quality: string; size: string; cost?: number }
  | { kind: "imported"; fileName: string };

/** One brush stroke of a painted mask, in image pixels. Erase strokes remove paint. */
export interface MaskStroke {
  radius: number;
  erase: boolean;
  points: [number, number][];
}

/**
 * One AI edit, shown as one layer. `layer` is the full image after the edit
 * (a PNG data URL); it covers the layers below it. `layerMask` is a PNG of the
 * painted mask area (its alpha): with `maskHides` the painted area is hidden,
 * otherwise only the painted area shows. `maskOff` turns the mask off for a
 * while, so the raw layer shows. `hidden` turns the whole layer off. `selection` is
 * the square the edit targeted. `cost` is the charged amount in US dollars.
 * Documents from before layers have `before` and `after` tiles of `selection`
 * instead; the editor turns them into layers when it opens them.
 */
export interface EditStep {
  id: string;
  prompt: string;
  model: string;
  quality: string;
  createdAt: string;
  selection: SquareSelection;
  sent: SentRegion;
  before?: string;
  after?: string;
  layer?: string;
  layerMask?: string;
  maskHides?: boolean;
  hidden?: boolean;
  /** The mask is kept but not used, so the whole layer shows. */
  maskOff?: boolean;
  /** A name the user gave the layer; the layers list shows it instead of the prompt. */
  name?: string;
  /** Tone changes drawn on top of the layer's own pixels; the layer image itself does not change. */
  adjust?: LayerAdjust;
  mask?: MaskStroke[];
  /** The user's square when the tiles cover a larger square (a GPT Image square edit). */
  target?: SquareSelection;
  /** The node this step was made from (0 is the original image, n is history[n - 1]); absent means the previous step. */
  parent?: number;
  cost?: number;
  /** The area the tiles cover when it is not the selection square; a whole-image edit covers the whole image. */
  area?: Rect;
}

/** The kinds of layer adjustment. */
export type AdjustmentKind = "brightness" | "hueSaturation" | "opacity";

/**
 * One adjustment of a layer. A layer can have several, even of the same kind;
 * they apply in order. Brightness uses `value` (-100 to 100); Hue/Saturation
 * uses `hue` (-180 to 180 degrees) and `saturation` (-100 to 100), and keeps
 * `value` at 0. Opacity uses `value` as a percent (0 to 100); 100 is no change.
 * For the others, 0 is no change. `off` keeps it
 * but does not use it. `mask` is a PNG whose alpha is where the adjustment
 * applies (with `maskHides`, where it does not); no mask means it applies to
 * the whole layer. `maskOff` keeps the mask but does not use it.
 */
export interface Adjustment {
  id: string;
  kind: AdjustmentKind;
  value: number;
  hue?: number;
  saturation?: number;
  off?: boolean;
  /** `off` was set by the layer's "all adjustments" switch, so that switch turns it back on. */
  offByAll?: boolean;
  mask?: string;
  maskHides?: boolean;
  maskOff?: boolean;
}

/** A layer's adjustments, in the order they apply. */
export type LayerAdjust = Adjustment[];

/** A part of a layer that has a mask: "mask" is the layer mask; any other value is the id of an adjustment. */
export type LayerPart = string;

/** An element FLUX must keep unchanged; `bbox` is `[top, left, bottom, right]` on a 0–1000 scale. */
export interface SceneAnchor {
  id: string;
  bbox: number[];
  desc: string;
}

/** A description of the sent region, written by a vision model for the FLUX layout prompt. */
export interface SceneDescription {
  caption: string;
  anchors: SceneAnchor[];
}
