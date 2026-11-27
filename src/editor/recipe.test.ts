import { describe, expect, it } from "vitest";
import { aspectRatio, layerSettings, parseRecipe, pastedRecipe, sameShape, settingsText } from "./recipe";
import type { EditStep } from "./types";

const recipe = {
  engine: "stable-diffusion.cpp master-1024-77b72a2",
  model: "Chroma1-HD",
  files: { diffusionModel: "D:\models\chroma.gguf", textEncoder: "D:\models\t5.gguf", vae: "D:\models\ae.safetensors" },
  loras: [{ file: "D:\loras\FineArtPhoto2.safetensors", strength: 0.75 }],
  prompt: "A photo. a cat",
  negativePrompt: "cartoon",
  seed: 123,
  sampler: "euler",
  scheduler: "beta",
  steps: 30,
  cfgScale: 3.5,
  flowShift: 1,
  modelArgs: "chroma_use_dit_mask=false",
  width: 1024,
  height: 768,
  edit: false
};

const step = (extra: Partial<EditStep> = {}): EditStep => ({
  id: "a",
  prompt: "a cat",
  model: "chroma1-hd",
  quality: "medium",
  createdAt: "2026-11-27T10:00:00.000Z",
  selection: { x: 0, y: 0, size: 768 },
  sent: { x: 0, y: 0, width: 1024, height: 768, margin: 0, requestWidth: 1024, requestHeight: 768 },
  area: { x: 0, y: 0, width: 1024, height: 768 },
  ...extra
});

describe("layer recipes", () => {
  it("reads a saved recipe and drops a broken one", () => {
    expect(parseRecipe(recipe)).toEqual(recipe);
    expect(parseRecipe({ ...recipe, seed: "x" })).toBeUndefined();
    expect(parseRecipe(null)).toBeUndefined();
    expect(parseRecipe({ ...recipe, loras: [{ file: 3 }] })?.loras).toEqual([]);
  });

  it("gives the aspect ratio as whole numbers and a decimal", () => {
    expect(aspectRatio(1024, 768)).toBe("4:3 (1.33:1)");
    expect(aspectRatio(832, 1216)).toBe("13:19 (1:1.46)");
  });

  it("shows every setting of a local layer and copies them as JSON", () => {
    const settings = layerSettings(step({ recipe }), { name: "Chroma1-HD", local: true }, { width: 1024, height: 768 });
    const text = settingsText(settings);
    for (const part of ["Seed: 123", "Sampler: euler", "Scheduler: beta", "Steps: 30", "CFG scale: 3.5", "Negative prompt: cartoon", "Positive prompt: A photo. a cat", "Your prompt: a cat", "0.75: D:\loras\FineArtPhoto2.safetensors", "Aspect ratio: 4:3", "Whole image"]) {
      expect(text).toContain(part);
    }
    expect(settings.json).toMatchObject({ seed: 123, prompt: "A photo. a cat", userPrompt: "a cat", width: 1024, height: 768 });
  });

  it("says what is missing for GPT Image and older local layers", () => {
    const gpt = layerSettings(step({ model: "gpt-image-2", cost: 0.04 }), { name: "GPT Image", local: false }, { width: 1024, height: 768 });
    expect(settingsText(gpt)).toContain("GPT Image does not report a seed");
    const old = layerSettings(step({ seed: 9 }), { name: "Chroma1-HD", local: true }, { width: 1024, height: 768 });
    expect(settingsText(old)).toContain("Seed: 9");
    expect(old.note).toContain("earlier version");
  });

  it("reads pasted JSON and finds the model by id or by name", () => {
    const models = [{ id: "chroma1-hd", label: "Chroma1-HD (local)" }, { id: "qwen-image-2.1", label: "Qwen-Image-2.1 (local)" }];
    const copied = layerSettings(step({ recipe }), { name: "Chroma1-HD", local: true }, { width: 1024, height: 768 });
    expect(copied.recipe?.modelId).toBe("chroma1-hd");
    const byName = pastedRecipe(JSON.stringify(copied.json), models);
    expect("recipe" in byName && byName.recipe.modelId).toBe("chroma1-hd");
    expect("recipe" in byName && byName.recipe.seed).toBe(123);
    const byId = pastedRecipe(JSON.stringify({ ...recipe, model: "", modelId: "qwen-image-2.1" }), models);
    expect("recipe" in byId && byId.recipe.modelId).toBe("qwen-image-2.1");
    expect(pastedRecipe("not json", models)).toHaveProperty("error");
    expect(pastedRecipe(JSON.stringify({ prompt: "x" }), models)).toHaveProperty("error");
    expect(pastedRecipe(JSON.stringify({ ...recipe, model: "Other" }), models)).toHaveProperty("error");
  });

  it("accepts a recipe size of nearly the same shape as the image", () => {
    expect(sameShape(1024, 768, 2048, 1536)).toBe(true);
    expect(sameShape(1216, 832, 1200, 820)).toBe(true);
    expect(sameShape(1024, 1024, 1024, 768)).toBe(false);
  });
});
