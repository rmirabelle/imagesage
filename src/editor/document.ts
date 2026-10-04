import type { Adjustment, DocumentOrigin, EditStep, LayerAdjust, MaskStroke, SentRegion, SquareSelection } from "./types";

export const IMAGESAGE_DOCUMENT_FORMAT = "imagesage-document";
/** Version 2 stores steps as layers; version 1 (before/after tiles) still opens. */
export const IMAGESAGE_DOCUMENT_VERSION = 2;
const OLDEST_DOCUMENT_VERSION = 1;

type ManifestStep = EditStep;

export interface ImageSageManifest {
  format: typeof IMAGESAGE_DOCUMENT_FORMAT;
  formatVersion: number;
  createdAt: string;
  modifiedAt: string;
  image: { path: "image.png"; width: number; height: number };
  origin: DocumentOrigin;
  /** The tile path of the original image (the bottom layer). */
  base?: string;
  baseAdjust?: LayerAdjust;
  history: ManifestStep[];
  historyIndex: number;
  /** Present only in automatic-recovery copies: the tab name and the file the image belongs to. */
  recovery?: RecoveryInfo;
}

export interface RecoveryInfo {
  name: string;
  path: string | null;
}

export interface HistoryTile {
  path: string;
  dataUrl: string;
}

const tilePath = (index: number, kind: "before" | "after" | "layer" | "mask" | `adjust-${number}-mask`) =>
  `history/${String(index + 1).padStart(4, "0")}-${kind}.png`;
const BASE_PATH = "history/base.png";
/** The tile path of the mask of the original image's adjustment number `index` (from 0). */
const baseAdjustMaskPath = (index: number) => `history/base-adjust-${index + 1}-mask.png`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requiredString = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`The document has an invalid ${key} value.`);
  return value;
};

const requiredNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`The document has an invalid ${key} value.`);
  }
  return value;
};

const requiredRecord = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`The document has an invalid ${key} value.`);
  return value;
};

const parseSelection = (value: Record<string, unknown>): SquareSelection => ({
  x: requiredNumber(value, "x"),
  y: requiredNumber(value, "y"),
  size: requiredNumber(value, "size")
});

const parseSent = (value: Record<string, unknown>): SentRegion => ({
  x: requiredNumber(value, "x"),
  y: requiredNumber(value, "y"),
  width: requiredNumber(value, "width"),
  height: requiredNumber(value, "height"),
  margin: requiredNumber(value, "margin"),
  requestWidth: requiredNumber(value, "requestWidth"),
  requestHeight: requiredNumber(value, "requestHeight"),
  ...(typeof value.resolution === "string" ? { resolution: value.resolution } : {})
});

const optionalStrings = (value: Record<string, unknown>, keys: ("before" | "after" | "layer" | "layerMask")[]) =>
  Object.fromEntries(keys.flatMap((key) => typeof value[key] === "string" ? [[key, value[key]]] : [])) as Pick<EditStep, "before" | "after" | "layer" | "layerMask">;

const clampAdjustValue = (value: number, limit = 100) => Math.max(-limit, Math.min(limit, Math.round(value)));
/** An optional saved number: clamped, or absent when malformed. */
const optionalAdjustNumber = (value: unknown, limit: number) => typeof value === "number" && Number.isFinite(value) ? clampAdjustValue(value, limit) : undefined;

/**
 * Reads one saved adjustment. Older documents store one brightness only: as a
 * plain number (0 there meant none), or as an object without an id or kind.
 */
const parseAdjustment = (value: unknown, fallbackId: string): Adjustment | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0 ? { id: fallbackId, kind: "brightness", value: clampAdjustValue(value) } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" && value.id && value.id !== "mask" ? value.id : fallbackId;
  const flags = {
    ...(value.off === true ? { off: true } : {}),
    ...(value.off === true && value.offByAll === true ? { offByAll: true } : {}),
    ...(typeof value.mask === "string" && value.mask ? { mask: value.mask } : {}),
    ...(value.maskHides === true ? { maskHides: true } : {}),
    ...(value.maskOff === true ? { maskOff: true } : {})
  };
  if (value.kind === "opacity") {
    const percent = optionalAdjustNumber(value.value, 100);
    return { id, kind: "opacity", value: percent === undefined ? 100 : Math.max(0, percent), ...flags };
  }
  if (value.kind === "hueSaturation") {
    return { id, kind: "hueSaturation", value: 0, hue: optionalAdjustNumber(value.hue, 180) ?? 0, saturation: optionalAdjustNumber(value.saturation, 100) ?? 0, ...flags };
  }
  if (typeof value.value !== "number" || !Number.isFinite(value.value)) return undefined;
  if (value.kind !== undefined && value.kind !== "brightness") return undefined;
  return {
    id,
    kind: "brightness",
    value: clampAdjustValue(value.value),
    ...flags
  };
};

/** Reads saved layer adjustments (a list, or an older `{ brightness }` object); anything malformed is dropped. */
const parseAdjust = (value: unknown): LayerAdjust | undefined => {
  const items = Array.isArray(value) ? value : isRecord(value) && value.brightness !== undefined ? [value.brightness] : [];
  const seen = new Set<string>();
  const list = items.flatMap((item, index) => {
    const adjustment = parseAdjustment(item, `adj-${index + 1}`);
    if (!adjustment || seen.has(adjustment.id)) return [];
    seen.add(adjustment.id);
    return [adjustment];
  });
  return list.length ? list : undefined;
};

const optionalCost = (value: Record<string, unknown>) =>
  typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 ? { cost: value.cost } : {};

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number" && Number.isFinite(part));

/** Reads a saved brush mask; drops anything malformed rather than failing the whole document. */
const parseMask = (value: unknown): MaskStroke[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const strokes = value.flatMap((stroke): MaskStroke[] => {
    if (!isRecord(stroke) || !Array.isArray(stroke.points) || typeof stroke.radius !== "number") return [];
    const points = stroke.points.filter(isPoint);
    return points.length ? [{ radius: stroke.radius, erase: stroke.erase === true, points }] : [];
  });
  return strokes.length ? strokes : undefined;
};

const parseOrigin = (value: unknown): DocumentOrigin => {
  if (!isRecord(value)) return { kind: "imported", fileName: "" };
  if (value.kind === "generated") {
    return {
      kind: "generated",
      prompt: requiredString(value, "prompt"),
      model: requiredString(value, "model"),
      quality: requiredString(value, "quality"),
      size: requiredString(value, "size"),
      ...optionalCost(value)
    };
  }
  return { kind: "imported", fileName: typeof value.fileName === "string" ? value.fileName : "" };
};

const parseStep = (value: unknown): ManifestStep => {
  if (!isRecord(value)) throw new Error("The document contains an invalid edit step.");
  return {
    id: requiredString(value, "id"),
    prompt: requiredString(value, "prompt"),
    model: requiredString(value, "model"),
    quality: requiredString(value, "quality"),
    createdAt: requiredString(value, "createdAt"),
    selection: parseSelection(requiredRecord(value, "selection")),
    sent: parseSent(requiredRecord(value, "sent")),
    ...optionalStrings(value, ["before", "after", "layer", "layerMask"]),
    ...(value.maskHides === true ? { maskHides: true } : {}),
    ...(value.hidden === true ? { hidden: true } : {}),
    ...(value.maskOff === true ? { maskOff: true } : {}),
    ...(typeof value.name === "string" && value.name ? { name: value.name } : {}),
    ...(parseAdjust(value.adjust) ? { adjust: parseAdjust(value.adjust) } : {}),
    ...(parseMask(value.mask) ? { mask: parseMask(value.mask) } : {}),
    ...(isRecord(value.target) ? { target: parseSelection(value.target) } : {}),
    ...(typeof value.parent === "number" && Number.isInteger(value.parent) ? { parent: value.parent } : {}),
    ...(isRecord(value.area)
      ? {
        area: {
          x: requiredNumber(value.area, "x"),
          y: requiredNumber(value.area, "y"),
          width: requiredNumber(value.area, "width"),
          height: requiredNumber(value.area, "height")
        }
      }
      : {}),
    ...optionalCost(value)
  };
};

/** Builds the manifest and the list of tiles to store beside it. */
export function createManifest(
  width: number,
  height: number,
  origin: DocumentOrigin,
  history: EditStep[],
  historyIndex: number,
  createdAt: string,
  extras: { base?: string; baseAdjust?: LayerAdjust; recovery?: RecoveryInfo } = {}
) {
  const { base, recovery } = extras;
  const tiles: HistoryTile[] = [];
  if (base) tiles.push({ path: BASE_PATH, dataUrl: base });
  /** Each adjustment mask is stored as its own tile; the manifest keeps the tile path. */
  const storeAdjust = (adjust: LayerAdjust | undefined, pathOf: (index: number) => string) => (Array.isArray(adjust) ? adjust : undefined)?.map((adjustment, index) => {
    if (!adjustment.mask) return adjustment;
    const path = pathOf(index);
    tiles.push({ path, dataUrl: adjustment.mask });
    return { ...adjustment, mask: path };
  });
  const baseAdjust = storeAdjust(extras.baseAdjust, baseAdjustMaskPath);
  /** Layer steps store the layer and its mask; steps not yet turned into layers keep their before/after tiles. */
  const steps = history.map((step, index): ManifestStep => {
    const { before: beforeData, after: afterData, layer: layerData, layerMask: maskData, adjust: adjustData, ...stepRest } = step;
    const adjust = storeAdjust(adjustData, (at) => tilePath(index, `adjust-${at + 1}-mask`));
    const rest = adjust ? { ...stepRest, adjust } : stepRest;
    if (layerData) {
      const layer = tilePath(index, "layer");
      tiles.push({ path: layer, dataUrl: layerData });
      if (!maskData) return { ...rest, layer };
      const layerMask = tilePath(index, "mask");
      tiles.push({ path: layerMask, dataUrl: maskData });
      return { ...rest, layer, layerMask };
    }
    const before = tilePath(index, "before");
    const after = tilePath(index, "after");
    tiles.push({ path: before, dataUrl: beforeData ?? "" }, { path: after, dataUrl: afterData ?? "" });
    return { ...rest, before, after };
  });
  const manifest: ImageSageManifest = {
    format: IMAGESAGE_DOCUMENT_FORMAT,
    formatVersion: IMAGESAGE_DOCUMENT_VERSION,
    createdAt,
    modifiedAt: new Date().toISOString(),
    image: { path: "image.png", width, height },
    origin,
    ...(base ? { base: BASE_PATH } : {}),
    ...(baseAdjust ? { baseAdjust } : {}),
    history: steps,
    historyIndex,
    ...(recovery ? { recovery } : {})
  };
  return { manifest, tiles };
}

/**
 * Reads a manifest. With `tiles`, each step's tile paths are replaced by the
 * tile data; without them (previews), the paths stay as they are.
 */
export function parseManifest(manifestJson: string, tiles?: HistoryTile[]) {
  let value: unknown;
  try {
    value = JSON.parse(manifestJson);
  } catch {
    throw new Error("The ImageSage document manifest is not valid JSON.");
  }
  if (!isRecord(value) || value.format !== IMAGESAGE_DOCUMENT_FORMAT) {
    throw new Error("This is not an ImageSage document.");
  }
  if (typeof value.formatVersion !== "number" || value.formatVersion < OLDEST_DOCUMENT_VERSION || value.formatVersion > IMAGESAGE_DOCUMENT_VERSION) {
    throw new Error(`ImageSage cannot open document format version ${String(value.formatVersion)}.`);
  }
  const rawHistory = Array.isArray(value.history) ? value.history : [];
  const tileData = new Map((tiles ?? []).map((tile) => [tile.path, tile.dataUrl]));
  const tile = (path: string | undefined) => {
    if (path === undefined) return undefined;
    const data = tileData.get(path);
    if (!data) throw new Error("The ImageSage document is missing edit history tiles.");
    return data;
  };
  /** Replaces each adjustment mask's tile path with the tile data; a mask stored in the manifest itself (an earlier version) stays as it is. */
  const resolveAdjust = (adjust: LayerAdjust | undefined): LayerAdjust | undefined =>
    !tiles || !adjust ? adjust : adjust.map((adjustment) => adjustment.mask && !adjustment.mask.startsWith("data:") ? { ...adjustment, mask: tile(adjustment.mask) } : adjustment);
  const history: EditStep[] = rawHistory.map(parseStep).map((step) => {
    if (!step.layer && !(step.before && step.after)) throw new Error("The document contains an edit step without images.");
    if (!tiles) return step;
    const resolved = { ...step };
    for (const key of ["before", "after", "layer", "layerMask"] as const) {
      if (step[key] !== undefined) resolved[key] = tile(step[key]);
    }
    resolved.adjust = resolveAdjust(step.adjust);
    if (!resolved.adjust) delete resolved.adjust;
    return resolved;
  });
  const basePath = typeof value.base === "string" ? value.base : undefined;
  const historyIndex = typeof value.historyIndex === "number" ? value.historyIndex : history.length;
  return {
    createdAt: requiredString(value, "createdAt"),
    origin: parseOrigin(value.origin),
    base: tiles && basePath ? tile(basePath) : undefined,
    baseAdjust: resolveAdjust(parseAdjust(value.baseAdjust)),
    history,
    historyIndex: Math.max(0, Math.min(history.length, Math.round(historyIndex))),
    recovery: isRecord(value.recovery) && typeof value.recovery.name === "string"
      ? { name: value.recovery.name, path: typeof value.recovery.path === "string" ? value.recovery.path : null }
      : null
  };
}
