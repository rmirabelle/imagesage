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
  /** The image file this document was imported from; opening that file again selects this document. */
  sourcePath?: string;
  createdAt: string;
  origin: DocumentOrigin;
  surface: HTMLCanvasElement;
  /**
   * A separate original image below the layers (a PNG data URL), from older
   * documents. The editor moves it into the history as the bottom layer and
   * then sets this to "", which means every layer is in the history.
   * Undefined until the editor has prepared the document.
   */
  base?: string;
  /** Adjustments of the separate original image, from older documents. */
  baseAdjust?: LayerAdjust;
  history: EditStep[];
  /** The selected layer: n is history[n - 1]; 0 is the separate original image, or no layer when there is none. */
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
