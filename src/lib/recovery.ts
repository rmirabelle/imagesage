import { invoke } from "@tauri-apps/api/core";
import { createManifest } from "../editor/document";
import type { ImageDocument } from "../editor/imageDocument";

/**
 * Automatic recovery: a copy of each image with unsaved changes is kept in the
 * app's local data folder, so a crash or restart does not lose work. The copy
 * is an ordinary .imagesage document with a `recovery` block that remembers
 * the tab name and the file the image belongs to.
 *
 * Layer images and masks are large, so each one is sent to the app's tile
 * store only once, under a key that changes only when its content changes.
 * A recovery save then sends just the manifest and the tile keys, and the
 * document is written on a worker thread. Nothing is encoded here.
 */

/** Tile keys already in each document's tile store. */
const storedKeys = new Map<string, Set<string>>();
/**
 * Tile versions by name (a layer image, a mask, or the base), so a tile whose
 * content changed gets a new key and is sent again. A layer image changes too,
 * for example after Transform; a key by step id alone kept the old image.
 */
const tileVersions = new Map<string, { src: string; version: number }>();

const tileKey = (name: string, src: string) => {
  const known = tileVersions.get(name);
  if (known?.src === src) return `${name}-${known.version}`;
  const version = (known?.version ?? 0) + 1;
  tileVersions.set(name, { src, version });
  return `${name}-${version}`;
};
const layerKey = (stepId: string, src: string) => tileKey(`${stepId}-layer`, src);

/** Saves for one document run one after another, so a save never removes tiles another save still needs. */
const queues = new Map<string, Promise<void>>();

/** Writes the recovery copy of one document. Documents still being turned into layers are skipped. */
export function saveRecovery(document: ImageDocument) {
  const run = (queues.get(document.id) ?? Promise.resolve()).catch(() => {}).then(() => writeRecovery(document));
  queues.set(document.id, run);
  return run.catch((error) => {
    /** After a failure, the store's content is unknown, so every tile is sent again next time. */
    storedKeys.delete(document.id);
    throw error;
  });
}

/**
 * Builds the manifest and sends each tile (layer image or mask) the tile store
 * of the document does not have yet, one per call, so no single message is
 * large. Returns the manifest and each tile's path and key.
 */
async function storeTiles(document: ImageDocument, recovery: boolean) {
  const { base, history } = document;
  const { manifest, tiles } = createManifest(
    document.surface.width,
    document.surface.height,
    document.origin,
    history,
    document.historyIndex,
    document.createdAt,
    { base, baseAdjust: document.baseAdjust, ...(recovery ? { recovery: { name: document.name, path: document.path } } : {}) }
  );
  /**
   * Each manifest tile path maps to a key by its owner and the version of its
   * content: the base, a layer image, or a mask (a layer mask or an adjustment mask).
   */
  const keyed = tiles.map((tile) => {
    const baseMatch = /^history\/base-adjust-(\d+)-mask\.png$/.exec(tile.path);
    if (baseMatch) return { ...tile, key: tileKey(`${document.id}-base-${document.baseAdjust?.[Number(baseMatch[1]) - 1]?.id}-mask`, tile.dataUrl) };
    const match = /^history\/(\d{4})-(layer|mask|adjust-(\d+)-mask)\.png$/.exec(tile.path);
    if (!match) return { ...tile, key: tileKey(`${document.id}-base`, tile.dataUrl) };
    const step = history[Number(match[1]) - 1];
    if (match[2] === "layer") return { ...tile, key: layerKey(step.id, tile.dataUrl) };
    if (match[2] === "mask") return { ...tile, key: tileKey(`${step.id}-mask`, tile.dataUrl) };
    return { ...tile, key: tileKey(`${step.id}-${step.adjust?.[Number(match[3]) - 1]?.id}-mask`, tile.dataUrl) };
  });
  const stored = storedKeys.get(document.id) ?? new Set<string>();
  storedKeys.set(document.id, stored);
  for (const tile of keyed) {
    if (stored.has(tile.key)) continue;
    await invoke("recovery_put_tiles", { id: document.id, tiles: [{ key: tile.key, dataUrl: tile.dataUrl }] });
    stored.add(tile.key);
  }
  return { manifest, keyed };
}

async function writeRecovery(document: ImageDocument) {
  const { base, history } = document;
  if (base === undefined || history.some((step) => !step.layer)) return;
  /** The preview image is the top visible layer, or the original image; with neither, there is no image yet. */
  const top = [...history].reverse().find((step) => !step.hidden) ?? (base ? undefined : history[history.length - 1]);
  if (!top && !base) return;
  const { manifest, keyed } = await storeTiles(document, true);
  await invoke("recovery_save", {
    id: document.id,
    manifestJson: JSON.stringify(manifest),
    imageKey: top?.layer ? layerKey(top.id, top.layer) : tileKey(`${document.id}-base`, base),
    tiles: keyed.map(({ path, key }) => ({ path, key }))
  });
  /** The app removes stored tiles the document no longer uses. */
  storedKeys.set(document.id, new Set(keyed.map((tile) => tile.key)));
}

/**
 * Saves a document to the user's file. Layers and masks go to the tile store
 * one per call (only the new ones), then the app writes the file from the
 * store; one call with every layer at once can stall on large documents.
 * It runs in the same queue as recovery copies, so neither removes tiles the
 * other needs. `imageDataUrl` is the combined image, for previews. False when
 * the document is not all layers yet; the caller then saves it the older way.
 */
export function saveDocumentFile(document: ImageDocument, path: string, imageDataUrl: string) {
  if (document.base === undefined || document.history.some((step) => !step.layer)) return Promise.resolve(false);
  const run = (queues.get(document.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const { manifest, keyed } = await storeTiles(document, false);
    await invoke("save_document_from_tiles", {
      id: document.id,
      path,
      manifestJson: JSON.stringify(manifest),
      dataUrl: imageDataUrl,
      tiles: keyed.map(({ path: tilePath, key }) => ({ path: tilePath, key }))
    });
    return true;
  });
  queues.set(document.id, run.then(() => undefined));
  return run.catch((error) => {
    storedKeys.delete(document.id);
    throw error;
  });
}

export const removeRecovery = (id: string) => {
  storedKeys.delete(id);
  return invoke<void>("recovery_remove", { id });
};
export const listRecovery = () => invoke<string[]>("recovery_list");
export const removeRecoveryPath = (path: string) => invoke<void>("recovery_remove_path", { path });
