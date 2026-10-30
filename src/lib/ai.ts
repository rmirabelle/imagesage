import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** OpenAI creates new images and makes every edit. */
export type Provider = "openai";

export interface ImageModel {
  id: string;
  label: string;
  note: string;
  qualities: string[];
  /** Runs on this computer through the local engine. */
  local?: boolean;
  /** A local model that also edits the whole image, so it can regenerate a layer. */
  edits?: boolean;
}

const BASIC_QUALITIES = ["auto", "low", "medium", "high"];
const EXTENDED_QUALITIES = [...BASIC_QUALITIES, "xhigh", "max"];

export const IMAGE_MODELS: ImageModel[] = [
  { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", note: "Most precise", qualities: EXTENDED_QUALITIES },
  { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare", note: "Fast, high quality", qualities: EXTENDED_QUALITIES },
  { id: "gpt-image-2", label: "GPT Image 2", note: "Previous generation", qualities: BASIC_QUALITIES }
];

/**
 * Models that the optional local engine runs. Chroma creates new images from
 * a prompt only; Qwen-Image-2.1 (or a merge of it, such as Noct Q) also edits.
 */
export const LOCAL_MODELS: ImageModel[] = [
  { id: "chroma1-hd", label: "Chroma1-HD (local)", note: "Free, on this computer; new images only", qualities: ["low", "medium", "high"], local: true },
  { id: "qwen-image-2.1", label: "Qwen-Image-2.1 (local)", note: "Free, on this computer; new images and edits", qualities: ["low", "medium", "high"], local: true, edits: true }
];
/** Sampling steps for each local model and quality (the Rust side uses the same values). */
export const LOCAL_STEPS: Record<string, Record<string, number>> = {
  "chroma1-hd": { low: 20, medium: 30, high: 40 },
  "qwen-image-2.1": { low: 16, medium: 25, high: 35 }
};

const ALL_MODELS = [...IMAGE_MODELS, ...LOCAL_MODELS];
export const isLocalModel = (id: string) => LOCAL_MODELS.some((model) => model.id === id);
/** A local model that edits the whole image, as GPT Image does. */
export const localEdits = (id: string) => LOCAL_MODELS.some((model) => model.id === id && model.edits);

/** Layers made before FLUX support was removed keep their model name. */
const LEGACY_MODEL_LABELS: Record<string, string> = { "flux-3-image": "FLUX 3 Image" };

export const modelLabel = (id: string) =>
  ALL_MODELS.find((model) => model.id === id)?.label ?? LEGACY_MODEL_LABELS[id] ?? id;
export const qualitiesFor = (id: string) => ALL_MODELS.find((model) => model.id === id)?.qualities ?? EXTENDED_QUALITIES;

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
      wholeModel: ALL_MODELS.some((model) => model.id === merged.wholeModel) ? merged.wholeModel : DEFAULT_AI_SETTINGS.wholeModel,
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
  command: "ai_generate" | "ai_edit_whole" | "model_download" | "music_download" | "sam_encode" | "local_generate" | "local_engine_download" | "local_load",
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

/** A new image from a prompt, with GPT Image or, for a local model, the local engine. */
export const generateImage = (requestId: string, payload: GeneratePayload, onProgress: (progress: AiProgress) => void) =>
  isLocalModel(payload.model)
    ? runWithProgress("local_generate", requestId, { model: payload.model, prompt: payload.prompt, quality: payload.quality, size: payload.size }, onProgress)
    : runWithProgress("ai_generate", requestId, payload, onProgress);

/**
 * Edits the whole image with GPT Image (OpenAI Images API edit endpoint, no
 * mask), or with a local model that edits.
 */
export const editWholeImage = (requestId: string, payload: WholeEditPayload, onProgress: (progress: AiProgress) => void) =>
  isLocalModel(payload.model)
    ? runWithProgress("local_generate", requestId, { model: payload.model, prompt: payload.prompt, quality: payload.quality, size: payload.size, image: payload.imagePng }, onProgress)
    : runWithProgress("ai_edit_whole", requestId, payload, onProgress);

/**
 * A request can be cancelled only before the service accepts it. From
 * "generating" on, the service finishes and charges whether or not Image Sage waits.
 * Local work, such as preparing click to select, can always be cancelled.
 */
const CANCELLABLE: (AiStage | null)[] = [null, "sending", "downloading", "loading", "preparing"];
export const canCancel = (stage: AiStage | null) => CANCELLABLE.includes(stage);
/** After that point, Abort stops waiting for the image; the service still charges for it. */
const ABORTABLE: (AiStage | null)[] = ["generating", "partial", "finishing"];
export const canAbort = (stage: AiStage | null) => ABORTABLE.includes(stage);
/** A job on the local engine costs nothing and stops at once, so it can always be cancelled. */
export const jobCanCancel = (stage: AiStage | null, service: string) => service === "Local" || canCancel(stage);

export const cancelAiRequest = (requestId: string) => invoke<void>("ai_cancel", { requestId });

/** One local model's files and image settings, as saved on this computer. */
export interface LocalModelConfig {
  diffusionModel: string;
  textEncoder: string;
  vae: string;
  /** What every image avoids. */
  negativePrompt: string;
  /** The words before each new image's prompt, such as "A photo." */
  promptPrefix: string;
  /** The engine's sampler name, such as "euler". */
  sampler: string;
  /** The engine's scheduler name, such as "beta". */
  scheduler: string;
}

export interface LocalConfig {
  /** Minutes without a job before the engine stops and frees the GPU memory. */
  idleMinutes: number;
  /** By local model id. */
  models: Record<string, LocalModelConfig>;
}

export interface LocalStatus {
  engineInstalled: boolean;
  engineSizeBytes: number;
  config: LocalConfig;
  /** Each local model's files that are not set or not found, by name. */
  missing: Record<string, string[]>;
  /** The local model the engine has loaded, if any. */
  running: string | null;
  /** The negative prompt a new config starts with. */
  defaultNegativePrompt: string;
  /** Each local model's prompt start in a new config, by local model id. */
  defaultPromptPrefixes: Record<string, string>;
}

export const localModelReady = (status: LocalStatus | null, model: string) =>
  Boolean(status?.engineInstalled && status.missing[model]?.length === 0);
/** The local models whose files are all set. */
export const readyLocalModels = (status: LocalStatus | null) =>
  LOCAL_MODELS.filter((model) => localModelReady(status, model.id)).map((model) => model.id);
export const localReady = (status: LocalStatus | null) => readyLocalModels(status).length > 0;

export const localStatus = () => invoke<LocalStatus>("local_status");
export const saveLocalConfig = (config: LocalConfig) => invoke<void>("local_config_set", { config });
export const findLocalModels = (folder: string, model: string) =>
  invoke<{ diffusionModel: string | null; textEncoder: string | null; vae: string | null }>("local_find_models", { folder, model });
export const downloadLocalEngine = (requestId: string, onProgress: (progress: AiProgress) => void) =>
  runWithProgress<void>("local_engine_download", requestId, {}, onProgress);
/** Starts the engine and loads the model; returns a short success message. */
export const loadLocalModel = (requestId: string, model: string, onProgress: (progress: AiProgress) => void) =>
  runWithProgress<string>("local_load", requestId, { model }, onProgress);

export const stageLabel = (stage: AiStage | null, service = "OpenAI") => {
  switch (stage) {
    case "sending": return `Sending to ${service}…`;
    case "generating": return "Generating…";
    case "partial": return "Refining…";
    case "finishing": return "Stitching…";
    case "downloading": return service === "Local" ? "Downloading the engine…" : "Downloading the model…";
    case "loading": return "Loading the model…";
    case "preparing": return "Preparing the image…";
    case "encoding": return "Making the video…";
    default: return "Preparing…";
  }
};
