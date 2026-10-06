import type { DocumentOrigin, EditStep, LayerAdjust } from "./types";

/**
 * One open tab. `surface` is the full-resolution working image; it is mutated
 * in place, and `revision` changes whenever its pixels or history change.
 */
export interface ImageDocument {
  id: string;
  name: string;
  path: string | null;
  /** Where the save dialog starts for a document never saved: beside the image it was imported from. */
  suggestedPath?: string;
  createdAt: string;
  origin: DocumentOrigin;
  surface: HTMLCanvasElement;
  /** The original image, the bottom layer (a PNG data URL); the editor sets it when it first opens the document. */
  base?: string;
  /** Adjustments of the original image (the bottom layer). */
  baseAdjust?: LayerAdjust;
  history: EditStep[];
  /** The selected layer: 0 is the original image, n is history[n - 1]. */
  historyIndex: number;
  revision: number;
  savedRevision: number;
  saving: boolean;
  busy: boolean;
  /** A new image from a prompt: the editor generates it as the first layer when the tab opens. Not saved. */
  startGeneration?: { prompt: string; model: string; quality: string };
}

export const isDocumentDirty = (document: ImageDocument) => document.revision !== document.savedRevision;

/** Charged so far for the image: its creation and every saved edit. */
export const documentSpend = (document: ImageDocument) =>
  document.history.reduce((sum, step) => sum + (step.cost ?? 0), 0)
  + (document.origin.kind === "generated" ? document.origin.cost ?? 0 : 0);
