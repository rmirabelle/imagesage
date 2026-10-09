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
 * context margin, and the size it is uploaded at.
 */
export interface SentRegion extends Rect {
  margin: number;
  requestWidth: number;
  requestHeight: number;
}

export type DocumentOrigin =
  | { kind: "generated"; prompt: string; model: string; quality: string; size: string; cost?: number }
  | { kind: "imported"; fileName: string };

/** A selected area used as a mask stroke: a PNG data URL at the image size whose alpha is the area, and its bounds. */
export interface MaskImage {
  src: string;
  bounds: Rect;
}

/**
 * One brush stroke of a painted mask, in image pixels. Erase strokes remove
 * paint. A stroke with `image` paints that picture's alpha instead of a brush
 * path; its `points` are empty.
 */
export interface MaskStroke {
  radius: number;
  erase: boolean;
  points: [number, number][];
  image?: MaskImage;
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
  /** Masks with the same link id are linked copies: a change to one changes them all. */
  maskLink?: string;
  hidden?: boolean;
  /** How the layer mixes with the layers below it; absent is Normal. */
  blend?: BlendMode;
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
/** The blend modes a layer can use besides Normal. */
export type BlendMode = "screen" | "overlay";

export type AdjustmentKind = "brightness" | "contrast" | "hueSaturation" | "opacity" | "blur" | "sharpen";

/**
 * One adjustment of a layer. A layer can have several, even of the same kind;
 * they apply in order. Brightness uses `value` (-100 to 100); Hue/Saturation
 * uses `hue` (-180 to 180 degrees), `saturation` (-100 to 100) and
 * `lightness` (-100 to 100: toward black, or toward white), and keeps
 * `value` at 0. With `colorize`, Hue/Saturation instead gives every pixel one
 * color: `hue` is that hue (0 to 360 degrees) and `saturation` its strength
 * (0 to 100), and each pixel keeps its lightness; `lightness` changes that
 * lightness first, so white lowered toward a middle gray takes the full color. Opacity uses `value` as a percent (0 to 100); 100 is no change.
 * Contrast uses `value` as its amount (-100 to 100), `pivot` as the middle
 * gray it pushes away from (0 to 100), `curve` as how much the change rolls off
 * near black and white instead of clipping (0 to 100), and `color` as how much
 * it works on each color instead of on brightness only (0 to 100). Blur uses
 * `value` as its radius in image pixels (0 to 100).
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
  lightness?: number;
  colorize?: boolean;
  /**
   * Sharpen uses `value` as its amount in percent (0 to 500) and `radius` in
   * tenths of an image pixel (1 to 3000). It sharpens brightness only, unless
   * `colorSharpen` is set; then it sharpens each color.
   */
  radius?: number;
  colorSharpen?: boolean;
  /** A name the user gave the adjustment; its chip shows it in place of the numbers. */
  label?: string;
  pivot?: number;
  curve?: number;
  color?: number;
  off?: boolean;
  /** `off` was set by the layer's "all adjustments" switch, so that switch turns it back on. */
  offByAll?: boolean;
  mask?: string;
  maskHides?: boolean;
  maskOff?: boolean;
  /** Masks with the same link id are linked copies: a change to one changes them all. */
  maskLink?: string;
}

/** A layer's adjustments, in the order they apply. */
export type LayerAdjust = Adjustment[];

/** A part of a layer that has a mask: "mask" is the layer mask; any other value is the id of an adjustment. */
export type LayerPart = string;
