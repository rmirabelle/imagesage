import { invoke } from "@tauri-apps/api/core";
import { runWithProgress, type AiProgress } from "./ai";

/**
 * Local AI models. Each one runs on this PC; the app downloads it once, on
 * first use, after the user agrees.
 */
export type ModelId = "sam2";

export interface ModelStatus {
  installed: boolean;
  sizeBytes: number;
}

/** What the download dialog says about each model. */
export const MODEL_INFO: Record<ModelId, { name: string; uses: string }> = {
  sam2: { name: "click-to-select model", uses: "Click to select uses" }
};

export const modelStatus = (model: ModelId) => invoke<ModelStatus>("model_status", { model });

export const downloadModel = (model: ModelId, requestId: string, onProgress: (progress: AiProgress) => void) =>
  runWithProgress<void>("model_download", requestId, { model }, onProgress);

export const formatMegabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
