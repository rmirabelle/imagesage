import { invoke } from "@tauri-apps/api/core";
import type { Rect } from "../editor/types";
import { runWithProgress, type AiProgress } from "./ai";

/** One click of click to select, in image pixels. `include` false removes the area under it. */
export interface SamPoint {
  x: number;
  y: number;
  include: boolean;
}

export interface SamMask {
  /** A PNG data URL at the image size: white, with the selected area as its alpha. */
  maskDataUrl: string;
  /** The selected area, or null when nothing is selected. */
  bounds: Rect | null;
}

/** Prepares an image for click to select (the slow step); `key` names it, and preparing the same key again does nothing. */
export const samEncode = (requestId: string, imagePng: string, key: string, onProgress: (progress: AiProgress) => void) =>
  runWithProgress<void>("sam_encode", requestId, { imagePng, key }, onProgress);

/** The mask for the clicks so far, on the prepared image `key` (fast). */
export const samMask = (key: string, points: SamPoint[]) => invoke<SamMask>("sam_mask", { request: { key, points } });
