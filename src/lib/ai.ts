import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** OpenAI creates new images and makes every edit. */
export type Provider = "openai";

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

/** Layers made before FLUX support was removed keep their model name. */
const LEGACY_MODEL_LABELS: Record<string, string> = { "flux-3-image": "FLUX 3 Image" };

export const modelLabel = (id: string) =>
  IMAGE_MODELS.find((model) => model.id === id)?.label ?? LEGACY_MODEL_LABELS[id] ?? id;
export const qualitiesFor = (id: string) => IMAGE_MODELS.find((model) => model.id === id)?.qualities ?? EXTENDED_QUALITIES;

export interface AiSettings {
  generateModel: string;
  quality: string;
  /** GPT Image model and quality for whole-image edits. */
  wholeModel: string;
  wholeQuality: string;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  generateModel: "gpt-image-2.5-sunburst",
  quality: "high",
  wholeModel: "gpt-image-2.5-sunburst",
  wholeQuality: "high"
};

const SETTINGS_KEY = "imagesage.ai-settings";
/** Settings stored before version 3 keep only the model and quality for new images. */
const SETTINGS_VERSION = 3;

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
      wholeQuality: typeof merged.wholeQuality === "string" ? merged.wholeQuality : DEFAULT_AI_SETTINGS.wholeQuality
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
/** Returns a short success message. */
export const testApiKey = (provider: Provider, key: string | null, model: string) =>
  invoke<string>("test_api_key", { provider, key, model });
/** Opens the OpenAI API keys page in the default browser. */
export const openApiKeysPage = () => invoke<void>("open_api_keys_page");

export type AiStage = "sending" | "generating" | "partial" | "finishing" | "downloading" | "loading" | "preparing" | "encoding";

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



export interface WholeEditPayload extends GeneratePayload {
  imagePng: string;
}

export const CANCELLED_MESSAGE = "The request was cancelled.";

export async function runWithProgress<T = AiImage>(
  command: "ai_generate" | "ai_edit_whole" | "model_download" | "music_download" | "sam_encode",
  requestId: string,
  payload: GeneratePayload | WholeEditPayload | Record<string, unknown>,
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

/** Edits the whole image with GPT Image (OpenAI Images API edit endpoint, no mask). */
export const editWholeImage = (requestId: string, payload: WholeEditPayload, onProgress: (progress: AiProgress) => void) =>
  runWithProgress("ai_edit_whole", requestId, payload, onProgress);

/**
 * A request can be cancelled only before the service accepts it. From
 * "generating" on, the service finishes and charges whether or not Image Sage waits.
 * Local work, such as preparing click to select, can always be cancelled.
 */
const CANCELLABLE: (AiStage | null)[] = [null, "sending", "downloading", "loading", "preparing"];
export const canCancel = (stage: AiStage | null) => CANCELLABLE.includes(stage);

export const cancelAiRequest = (requestId: string) => invoke<void>("ai_cancel", { requestId });

export const stageLabel = (stage: AiStage | null, service = "OpenAI") => {
  switch (stage) {
    case "sending": return `Sending to ${service}…`;
    case "generating": return "Generating…";
    case "partial": return "Refining…";
    case "finishing": return "Stitching…";
    case "downloading": return "Downloading the model…";
    case "loading": return "Loading the model…";
    case "preparing": return "Preparing the image…";
    case "encoding": return "Making the video…";
    default: return "Preparing…";
  }
};
