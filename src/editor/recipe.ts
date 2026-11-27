import type { EditStep, LocalRecipe } from "./types";

/** One labeled value of the Inspect Layer dialog; `wide` values (prompts, file paths) get a row of their own. */
export interface SettingRow {
  label: string;
  value: string;
  wide?: boolean;
}

export interface SettingSection {
  title: string;
  rows: SettingRow[];
}

/** What the Inspect Layer dialog shows, and the same settings as JSON to copy. */
export interface LayerSettings {
  sections: SettingSection[];
  /** A short line under the title: whether the settings are enough to make the same image again. */
  note: string;
  json: Record<string, unknown>;
  /** A local layer's recipe, with its model id, for Use These Settings; none when the layer has no full recipe. */
  recipe?: LocalRecipe;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Reads a saved recipe; anything that is not a valid recipe gives undefined, so the layer opens without it. */
export function parseRecipe(value: unknown): LocalRecipe | undefined {
  if (!isRecord(value)) return undefined;
  const seed = number(value.seed);
  const steps = number(value.steps);
  const width = number(value.width);
  const height = number(value.height);
  if (seed === null || steps === null || width === null || height === null || typeof value.prompt !== "string") return undefined;
  const files = isRecord(value.files) ? value.files : {};
  const loras = Array.isArray(value.loras)
    ? value.loras.flatMap((lora) => {
      if (!isRecord(lora) || typeof lora.file !== "string" || number(lora.strength) === null) return [];
      return [{ file: lora.file, strength: lora.strength as number, ...(lora.highNoise === true ? { highNoise: true } : {}) }];
    })
    : [];
  return {
    engine: text(value.engine),
    model: text(value.model),
    ...(typeof value.modelId === "string" && value.modelId ? { modelId: value.modelId } : {}),
    files: { diffusionModel: text(files.diffusionModel), textEncoder: text(files.textEncoder), vae: text(files.vae) },
    loras,
    prompt: value.prompt,
    negativePrompt: text(value.negativePrompt),
    seed,
    sampler: text(value.sampler),
    scheduler: text(value.scheduler),
    steps,
    cfgScale: number(value.cfgScale) ?? 0,
    flowShift: number(value.flowShift),
    modelArgs: typeof value.modelArgs === "string" ? value.modelArgs : null,
    width,
    height,
    edit: value.edit === true
  };
}

/**
 * Reads settings that the user pasted (Copy JSON of Inspect Layer). The
 * model id comes from the JSON, or else from the model's name, such as
 * "Chroma1-HD"; `models` are the local models (id and label).
 */
export function pastedRecipe(json: string, models: { id: string; label: string }[]): { recipe: LocalRecipe } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { error: "This is not JSON. Paste the text that Copy JSON in Inspect Layer makes." };
  }
  const recipe = parseRecipe(value);
  if (!recipe || !recipe.files.diffusionModel) return { error: "This JSON has no full local settings: it needs the prompt, the seed, the steps, the size and the model files." };
  const named = recipe.model.trim().toLowerCase();
  const modelId = models.find((model) => model.id === recipe.modelId)?.id
    ?? models.find((model) => named && model.label.toLowerCase().startsWith(named))?.id;
  if (!modelId) return { error: `Image Sage has no local model named ${recipe.modelId ?? recipe.model ?? "in these settings"}.` };
  return { recipe: { ...recipe, modelId } };
}

/** True when a recipe's image has nearly the shape of the document, so it fills the document without a visible stretch. */
export function sameShape(recipeWidth: number, recipeHeight: number, width: number, height: number): boolean {
  if (recipeWidth <= 0 || recipeHeight <= 0 || width <= 0 || height <= 0) return false;
  const ratio = (recipeWidth / recipeHeight) / (width / height);
  return Math.abs(ratio - 1) < 0.02;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** An aspect ratio as whole numbers and as a decimal, such as "4:3 (1.33:1)". */
export function aspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "";
  const divisor = gcd(Math.round(width), Math.round(height));
  const ratio = `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
  const decimal = width >= height ? `${(width / height).toFixed(2)}:1` : `1:${(height / width).toFixed(2)}`;
  return `${ratio} (${decimal})`;
}

const size = (width: number, height: number) => `${width} × ${height} px`;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The settings of one layer for the Inspect Layer dialog. A local layer from
 * this version has its full recipe; older local layers and GPT Image layers
 * show what was saved, and the note says what is missing.
 */
export function layerSettings(step: EditStep, model: { name: string; local: boolean }, documentSize: { width: number; height: number }): LayerSettings {
  const modelName = model.name;
  const recipe = step.recipe;
  const area = step.area ?? { x: step.sent.x, y: step.sent.y, width: step.sent.width, height: step.sent.height };
  const whole = area.x === 0 && area.y === 0 && area.width === documentSize.width && area.height === documentSize.height;
  const placement = whole ? `Whole image, ${size(area.width, area.height)}` : `${size(area.width, area.height)} at x ${area.x}, y ${area.y}`;
  const layerRows: SettingRow[] = [
    ...(step.name ? [{ label: "Name", value: step.name }] : []),
    { label: "Made", value: new Date(step.createdAt).toLocaleString() },
    { label: "Model", value: modelName },
    { label: "Quality", value: step.quality },
    ...(step.cost !== undefined ? [{ label: "Cost", value: `$${step.cost.toFixed(3)}` }] : [])
  ];

  if (recipe) {
    const userPromptDiffers = recipe.prompt !== step.prompt;
    const sections: SettingSection[] = [
      { title: "Layer", rows: layerRows },
      {
        title: "Prompts",
        rows: [
          { label: "Positive prompt", value: recipe.prompt, wide: true },
          ...(userPromptDiffers ? [{ label: "Your prompt", value: step.prompt, wide: true }] : []),
          { label: "Negative prompt", value: recipe.negativePrompt || "(none)", wide: true }
        ]
      },
      {
        title: "Sampling",
        rows: [
          { label: "Seed", value: String(recipe.seed) },
          { label: "Sampler", value: recipe.sampler },
          { label: "Scheduler", value: recipe.scheduler },
          { label: "Steps", value: String(recipe.steps) },
          { label: "CFG scale", value: String(recipe.cfgScale) },
          { label: "Flow shift", value: recipe.flowShift === null ? "Engine default for the size" : String(recipe.flowShift) }
        ]
      },
      {
        title: "Size",
        rows: [
          { label: "Resolution", value: size(recipe.width, recipe.height) },
          { label: "Aspect ratio", value: aspectRatio(recipe.width, recipe.height) },
          { label: "Placed as", value: placement }
        ]
      },
      {
        title: "LoRAs",
        rows: recipe.loras.length
          ? recipe.loras.map((lora) => ({ label: `${lora.highNoise ? "High noise " : ""}${lora.strength}`, value: lora.file, wide: true }))
          : [{ label: "LoRAs", value: "None" }]
      },
      {
        title: "Model files",
        rows: [
          { label: "Diffusion model", value: recipe.files.diffusionModel, wide: true },
          { label: "Text encoder", value: recipe.files.textEncoder, wide: true },
          { label: "VAE", value: recipe.files.vae, wide: true },
          ...(recipe.modelArgs ? [{ label: "Model options", value: recipe.modelArgs }] : []),
          { label: "Engine", value: recipe.engine }
        ]
      }
    ];
    return {
      sections,
      note: recipe.edit
        ? "An edit of the layer below it. To make it again, use the same settings on the same source image."
        : "These settings make the same image again with the same model files and engine.",
      json: {
        layer: step.name ?? step.prompt,
        createdAt: step.createdAt,
        quality: step.quality,
        ...(userPromptDiffers ? { userPrompt: step.prompt } : {}),
        ...recipe,
        aspectRatio: aspectRatio(recipe.width, recipe.height),
        loras: recipe.loras.map((lora) => ({ ...lora, name: fileName(lora.file) }))
      },
      ...(model.local ? { recipe: { ...recipe, modelId: recipe.modelId ?? step.model } } : {})
    };
  }

  const local = model.local;
  const width = step.sent.requestWidth;
  const height = step.sent.requestHeight;
  return {
    sections: [
      { title: "Layer", rows: layerRows },
      { title: "Prompts", rows: [{ label: "Prompt", value: step.prompt, wide: true }] },
      {
        title: "Sampling",
        rows: [{ label: "Seed", value: step.seed !== undefined ? String(step.seed) : local ? "Not saved" : "GPT Image does not report a seed" }]
      },
      {
        title: "Size",
        rows: [
          { label: "Resolution", value: size(width, height) },
          { label: "Aspect ratio", value: aspectRatio(width, height) },
          { label: "Placed as", value: placement }
        ]
      }
    ],
    note: local
      ? "An earlier version of Image Sage made this layer and did not save its full settings."
      : "GPT Image does not report its seed or sampling settings, so the same prompt gives a different image.",
    json: {
      layer: step.name ?? step.prompt,
      createdAt: step.createdAt,
      model: modelName,
      quality: step.quality,
      prompt: step.prompt,
      ...(step.seed !== undefined ? { seed: step.seed } : {}),
      width,
      height,
      aspectRatio: aspectRatio(width, height)
    }
  };
}

/** The settings as plain text, one "label: value" line each, for pasting into notes or another program. */
export function settingsText(settings: LayerSettings): string {
  return settings.sections
    .map((section) => [`${section.title}`, ...section.rows.map((row) => `  ${row.label}: ${row.value}`)].join("\n"))
    .join("\n\n");
}
