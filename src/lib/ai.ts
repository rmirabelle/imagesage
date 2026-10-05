import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FLUX_RESOLUTIONS, type FluxResolution } from "../editor/region";
import type { SceneDescription } from "../editor/types";

/** OpenAI creates new images and edits; FLUX 3 Image can also edit selections. */
export type Provider = "openai" | "flux";
/** The service that edits a square or a painted mask. */
export type RegionEngine = "openai" | "flux";

export interface ImageModel {
  id: string;
  label: string;
  note: string;
  qualities: string[];
}

const BASIC_QUALITIES = ["auto", "low", "medium", "high"];
const EXTENDED_QUALITIES = [...BASIC_QUALITIES, "xhigh", "max"];

export const IMAGE_MODELS: ImageModel[] = [
  { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", note: "Most precise", qualities: EXTENDED_QUALITIES },
  { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", note: "Fast, high quality", qualities: EXTENDED_QUALITIES },
  { id: "gpt-image-2", label: "GPT Image 2", note: "Previous generation", qualities: BASIC_QUALITIES }
];

export const EDIT_MODEL_ID = "flux-3-image";
export const EDIT_MODEL_LABEL = "FLUX 3 Image";

export const modelLabel = (id: string) =>
  id === EDIT_MODEL_ID ? EDIT_MODEL_LABEL : IMAGE_MODELS.find((model) => model.id === id)?.label ?? id;
export const qualitiesFor = (id: string) => IMAGE_MODELS.find((model) => model.id === id)?.qualities ?? EXTENDED_QUALITIES;

export interface AiSettings {
  generateModel: string;
  quality: string;
  /** GPT Image model and quality for edits: the whole image, and squares or masks when `regionEngine` is a GPT engine. */
  wholeModel: string;
  wholeQuality: string;
  regionEngine: RegionEngine;
  /** GPT square edits return only the new content on a transparent background, laid over the original. */
  transparentEdit: boolean;
  maxResolution: FluxResolution;
  minMargin: number;
  marginRatio: number;
  feather: number;
  driftCorrection: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  generateModel: "gpt-image-2.5-sunburst",
  quality: "high",
  wholeModel: "gpt-image-2.5-sunburst",
  wholeQuality: "high",
  regionEngine: "flux",
  transparentEdit: false,
  maxResolution: "2k",
  minMargin: 64,
  marginRatio: 0.5,
  feather: 6,
  driftCorrection: true
};

const SETTINGS_KEY = "imagesage.ai-settings";
/** Version 3 moved edits to FLUX 3 Image, which reads the whole square and wants a wide context margin. */
const SETTINGS_VERSION = 3;

const clampNumber = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
};

export function loadAiSettings(): AiSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") as (Partial<AiSettings> & { version?: number }) | null;
    if (!stored || typeof stored !== "object") return { ...DEFAULT_AI_SETTINGS };
    const current = stored.version === SETTINGS_VERSION
      ? stored
      : { generateModel: stored.generateModel, quality: stored.quality };
    const merged = { ...DEFAULT_AI_SETTINGS, ...current };
    return {
      generateModel: IMAGE_MODELS.some((model) => model.id === merged.generateModel) ? merged.generateModel : DEFAULT_AI_SETTINGS.generateModel,
      quality: typeof merged.quality === "string" ? merged.quality : DEFAULT_AI_SETTINGS.quality,
      wholeModel: IMAGE_MODELS.some((model) => model.id === merged.wholeModel) ? merged.wholeModel : DEFAULT_AI_SETTINGS.wholeModel,
      wholeQuality: typeof merged.wholeQuality === "string" ? merged.wholeQuality : DEFAULT_AI_SETTINGS.wholeQuality,
      /** "openai-whole" was an earlier GPT mode; it now means "openai". */
      regionEngine: merged.regionEngine === "flux" ? "flux" : String(merged.regionEngine).startsWith("openai") ? "openai" : DEFAULT_AI_SETTINGS.regionEngine,
      transparentEdit: merged.transparentEdit === true,
      maxResolution: FLUX_RESOLUTIONS.some((resolution) => resolution.id === merged.maxResolution)
        ? merged.maxResolution
        : DEFAULT_AI_SETTINGS.maxResolution,
      minMargin: Math.round(clampNumber(merged.minMargin, 0, 512, DEFAULT_AI_SETTINGS.minMargin)),
      marginRatio: clampNumber(merged.marginRatio, 0, 0.5, DEFAULT_AI_SETTINGS.marginRatio),
      feather: Math.round(clampNumber(merged.feather, 0, 64, DEFAULT_AI_SETTINGS.feather)),
      driftCorrection: merged.driftCorrection !== false
    };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function storeAiSettings(settings: AiSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
  } catch {
    /* Settings are a convenience; the defaults still work. */
  }
}

export interface ApiKeyStatus {
  connected: boolean;
  hint: string | null;
}

export type KeyStatuses = Record<Provider, ApiKeyStatus>;
export const DISCONNECTED: ApiKeyStatus = { connected: false, hint: null };

export const apiKeyStatus = (provider: Provider) => invoke<ApiKeyStatus>("api_key_status", { provider });
export const saveApiKey = (provider: Provider, key: string) => invoke<ApiKeyStatus>("set_api_key", { provider, key });
export const clearApiKey = (provider: Provider) => invoke<void>("clear_api_key", { provider });
/** Returns a short success message, such as the remaining FLUX credits. */
export const testApiKey = (provider: Provider, key: string | null, model: string) =>
  invoke<string>("test_api_key", { provider, key, model });

export type AiStage = "describing" | "sending" | "generating" | "partial" | "finishing" | "downloading" | "loading" | "detecting" | "preparing" | "encoding";

export interface AiProgress {
  requestId: string;
  stage: AiStage;
  progress: number | null;
  partialIndex: number | null;
  partialDataUrl: string | null;
}

export interface AiImage {
  dataUrl: string;
  usage: unknown;
}

export interface GeneratePayload {
  prompt: string;
  model: string;
  quality: string;
  size: string;
}



export interface EditPayload {
  prompt: string;
  imagePng: string;
  resolution: string;
}

export interface WholeEditPayload extends GeneratePayload {
  imagePng: string;
  /** "transparent" asks for a PNG with a see-through background. */
  background?: "transparent";
}

export interface MaskedEditPayload extends WholeEditPayload {
  maskPng: string;
}

export interface DescribePayload {
  instruction: string;
  /** The edit box as `[top, left, bottom, right]` on a 0–1000 scale. */
  editBox: [number, number, number, number];
  imagePng: string;
}

export const CANCELLED_MESSAGE = "The request was cancelled.";

export async function runWithProgress<T = AiImage>(
  command: "ai_generate" | "flux_edit" | "ai_edit_whole" | "ai_edit_masked" | "describe_scene" | "model_download" | "subject_mask" | "sam_encode",
  requestId: string,
  payload: GeneratePayload | EditPayload | WholeEditPayload | MaskedEditPayload | DescribePayload | Record<string, unknown>,
  onProgress: (progress: AiProgress) => void
) {
  const stop = await listen<AiProgress>("ai-progress", (event) => {
    if (event.payload.requestId === requestId) onProgress(event.payload);
  });
  try {
    return await invoke<T>(command, { request: { ...payload, requestId } });
  } finally {
    stop();
  }
}

export const generateImage = (requestId: string, payload: GeneratePayload, onProgress: (progress: AiProgress) => void) =>
  runWithProgress("ai_generate", requestId, payload, onProgress);

export const editRegion = (requestId: string, payload: EditPayload, onProgress: (progress: AiProgress) => void) =>
  runWithProgress("flux_edit", requestId, payload, onProgress);

/** Edits the whole image with GPT Image (OpenAI Images API edit endpoint, no mask). */
export const editWholeImage = (requestId: string, payload: WholeEditPayload, onProgress: (progress: AiProgress) => void) =>
  runWithProgress("ai_edit_whole", requestId, payload, onProgress);

/** Edits a square region with GPT Image; the mask marks the area that may change. */
export const editMaskedRegion = (requestId: string, payload: MaskedEditPayload, onProgress: (progress: AiProgress) => void) =>
  runWithProgress("ai_edit_masked", requestId, payload, onProgress);

/** Asks an OpenAI vision model to describe the region and the elements around the edit box, for a FLUX prompt. */
export const describeScene = (requestId: string, payload: DescribePayload, onProgress: (progress: AiProgress) => void) =>
  runWithProgress<SceneDescription>("describe_scene", requestId, payload, onProgress);

/**
 * A request can be cancelled only before the service accepts it. From
 * "generating" on, the service finishes and charges whether or not ImageSage waits.
 * Local subject work can always be cancelled.
 */
const CANCELLABLE: (AiStage | null)[] = [null, "describing", "sending", "downloading", "loading", "detecting", "preparing"];
export const canCancel = (stage: AiStage | null) => CANCELLABLE.includes(stage);

export const cancelAiRequest = (requestId: string) => invoke<void>("ai_cancel", { requestId });

/** The FLUX account balance in credits (one credit is one US cent). */
export const fluxCredits = () => invoke<number>("flux_credits");

export const stageLabel = (stage: AiStage | null, service = "OpenAI") => {
  switch (stage) {
    case "describing": return "Describing the scene…";
    case "sending": return `Sending to ${service}…`;
    case "generating": return "Generating…";
    case "partial": return "Refining…";
    case "finishing": return "Stitching…";
    case "downloading": return "Downloading the model…";
    case "loading": return "Loading the model…";
    case "preparing": return "Preparing the image…";
    case "encoding": return "Making the video…";
    case "detecting": return "Finding the subject…";
    default: return "Preparing…";
  }
};
