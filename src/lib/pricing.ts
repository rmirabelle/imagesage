import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/**
 * Prices come from the official pages, read live at startup and at most every
 * 12 hours: OpenAI's price page (token rates), OpenAI's image guide calculator
 * (token factors per quality, turned into tokens with OpenAI's own formula),
 * and BFL's price page (FLUX per-image prices). A built-in copy is used when
 * the pages cannot be read. For FLUX, your last real charge for a resolution
 * wins, because BFL can charge less than its list price during promotions.
 */

interface TokenRates {
  textInput: number;
  imageInput: number;
  imageOutput: number;
}

type TokenFactors = Record<string, Record<string, number>>;

interface PriceList {
  openai: Record<string, TokenRates>;
  openaiTokenFactors: TokenFactors;
  flux: Record<string, number>;
  problems: string[];
}

interface PriceBook {
  openai: Record<string, TokenRates>;
  openaiTokenFactors: TokenFactors;
  flux: Record<string, number>;
  /** When the official pages were read; null when only the built-in table is in use. */
  checkedAt: string | null;
  problems: string[];
}

interface LearnedPrices {
  /** The last real charge per FLUX resolution, in US dollars. */
  flux: Record<string, number>;
  /**
   * Input image tokens per megapixel from the last whole-image edit, by model.
   * OpenAI does not publish this count for GPT Image 2 and 2.5.
   */
  openaiInputTokensPerMegapixel: Record<string, number>;
}

export const BUILT_IN_PRICES_DATE = "2026-10-02";
const BUILT_IN: PriceBook = {
  openai: {
    "gpt-image-2.5-sunburst": { textInput: 5, imageInput: 8, imageOutput: 30 },
    "gpt-image-2.5-flare": { textInput: 5, imageInput: 8, imageOutput: 30 },
    "gpt-image-2": { textInput: 5, imageInput: 8, imageOutput: 30 }
  },
  openaiTokenFactors: {
    "gpt-image-2": { low: 16, medium: 48, high: 96 },
    "gpt-image-2.5": { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 }
  },
  flux: { "768sq": 0.041, "1k": 0.048, "2k": 0.1, "4k": 0.607 },
  checkedAt: null,
  problems: []
};

const CACHE_KEY = "imagesage.price-book";
const LEARNED_KEY = "imagesage.learned-prices";
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;
/** One BFL credit is one US cent. */
const USD_PER_FLUX_CREDIT = 0.01;

const readJson = <T,>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") as T | null;
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Cached prices are a convenience; live and built-in prices still work. */
  }
};

const cached = readJson<PriceBook>(CACHE_KEY);
let book: PriceBook = cached?.openaiTokenFactors ? cached : BUILT_IN;
const storedLearned = readJson<Partial<LearnedPrices>>(LEARNED_KEY);
let learned: LearnedPrices = {
  flux: storedLearned?.flux ?? {},
  openaiInputTokensPerMegapixel: storedLearned?.openaiInputTokensPerMegapixel ?? {}
};
let version = 0;
const listeners = new Set<() => void>();

const changed = () => {
  version++;
  listeners.forEach((listener) => listener());
};

/** Re-renders the caller when prices change. */
export function usePrices() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version
  );
}

/** Reads the official price pages, unless a reading from the last 12 hours is cached. */
export async function refreshPrices(force = false) {
  if (!isTauri()) return;
  const age = book.checkedAt ? Date.now() - Date.parse(book.checkedAt) : Infinity;
  if (!force && age < REFRESH_AFTER_MS && !book.problems.length) return;
  try {
    const live = await invoke<PriceList>("fetch_prices");
    book = {
      openai: { ...BUILT_IN.openai, ...book.openai, ...live.openai },
      openaiTokenFactors: Object.keys(live.openaiTokenFactors).length ? live.openaiTokenFactors : book.openaiTokenFactors,
      flux: { ...BUILT_IN.flux, ...book.flux, ...live.flux },
      checkedAt: Object.keys(live.openai).length || Object.keys(live.flux).length ? new Date().toISOString() : book.checkedAt,
      problems: live.problems
    };
  } catch (error) {
    book = { ...book, problems: [String(error)] };
  }
  writeJson(CACHE_KEY, book);
  changed();
}

/** A short, plain description of where the prices come from. */
export function priceSourceNote() {
  const date = book.checkedAt ? new Date(book.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
  const base = date
    ? `Prices from the official OpenAI and BFL price pages, checked ${date}.`
    : `Built-in prices from ${BUILT_IN_PRICES_DATE}; the price pages could not be read.`;
  return `${base} The real charge appears after each request.`;
}

export const priceProblems = () => book.problems;

const familyOf = (model: string) => (model.startsWith("gpt-image-2.5") ? "gpt-image-2.5" : "gpt-image-2");
const ratesFor = (model: string) => book.openai[model] ?? BUILT_IN.openai[model] ?? BUILT_IN.openai["gpt-image-2"];
/** Each streamed partial image adds 100 output tokens; ImageSage asks for 2. */
const PARTIAL_IMAGE_TOKENS = 2 * 100;

/**
 * Output tokens for one image, by the formula in OpenAI's image guide
 * calculator: the factor for the quality, shrunk along the shorter side, then
 * scaled by pixel count. "auto" is estimated as the highest quality.
 */
export function outputTokens(model: string, quality: string, width: number, height: number) {
  const factors = book.openaiTokenFactors[familyOf(model)] ?? BUILT_IN.openaiTokenFactors[familyOf(model)];
  const factor = factors[quality] ?? Math.max(...Object.values(factors));
  const shorter = factor / (Math.max(width, height) / Math.min(width, height));
  const floor = Math.floor(shorter);
  const rounded = shorter - floor === 0.5 ? floor + (floor % 2) : Math.round(shorter);
  return Math.ceil((factor * rounded * (2e6 + width * height)) / 4e6);
}

/** Estimated cost of one new OpenAI image, including the prompt and streamed previews. */
export function estimateOpenAiImage(model: string, quality: string, size: string, promptLength = 0) {
  const [width, height] = size.split("x").map(Number);
  if (!(width > 0 && height > 0)) return 0;
  const rates = ratesFor(model);
  const tokens = outputTokens(model, quality, width, height) + PARTIAL_IMAGE_TOKENS;
  return (tokens * rates.imageOutput + (promptLength / 4) * rates.textInput) / 1_000_000;
}

/**
 * Estimated cost of one whole-image edit: the output by OpenAI's formula, plus
 * the input image at the token rate learned from your last whole-image edit.
 * Until then the input image is not included, and `includesInput` is false.
 */
export function estimateWholeEdit(model: string, quality: string, size: string, promptLength = 0) {
  const [width, height] = size.split("x").map(Number);
  const output = estimateOpenAiImage(model, quality, size, promptLength);
  const perMegapixel = learned.openaiInputTokensPerMegapixel[model];
  if (perMegapixel === undefined || !(width > 0 && height > 0)) return { usd: output, includesInput: false };
  const inputTokens = perMegapixel * ((width * height) / (1024 * 1024));
  return { usd: output + (inputTokens * ratesFor(model).imageInput) / 1_000_000, includesInput: true };
}

/** Remembers how many input image tokens a whole-image edit used, for the next estimate. */
export function learnWholeEditInput(usage: unknown, model: string, size: string) {
  const [width, height] = size.split("x").map(Number);
  if (!usage || typeof usage !== "object" || !(width > 0 && height > 0)) return;
  const details = ((usage as Record<string, unknown>).input_tokens_details ?? {}) as Record<string, unknown>;
  const imageTokens = typeof details.image_tokens === "number" ? details.image_tokens : 0;
  if (!imageTokens) return;
  learned = {
    ...learned,
    openaiInputTokensPerMegapixel: { ...learned.openaiInputTokensPerMegapixel, [model]: imageTokens / ((width * height) / (1024 * 1024)) }
  };
  writeJson(LEARNED_KEY, learned);
  changed();
}

/** FLUX price for one edit at a resolution: your last real charge, else the price page, else an estimate. */
export function fluxPrice(resolution: string): { usd: number; estimated: boolean } {
  const charged = learned.flux[resolution];
  if (charged !== undefined) return { usd: charged, estimated: false };
  const listed = book.flux[resolution] ?? BUILT_IN.flux[resolution];
  if (listed !== undefined) return { usd: listed, estimated: false };
  /** A size missing from the price page sits between its neighbours. */
  const known = Object.entries({ ...BUILT_IN.flux, ...book.flux });
  const edge = (id: string) => ({ "768sq": 768, "1k": 1024, "1.5k": 1536, "2k": 2048, "4k": 4096 }[id] ?? 2048);
  const target = edge(resolution);
  const below = known.filter(([id]) => edge(id) < target).sort((a, b) => edge(b[0]) - edge(a[0]))[0];
  const above = known.filter(([id]) => edge(id) > target).sort((a, b) => edge(a[0]) - edge(b[0]))[0];
  if (below && above) {
    const share = (target - edge(below[0])) / (edge(above[0]) - edge(below[0]));
    return { usd: below[1] + (above[1] - below[1]) * share, estimated: true };
  }
  return { usd: (below ?? above)?.[1] ?? 0.1, estimated: true };
}

export const estimateFluxEdit = (resolution: string) => fluxPrice(resolution).usd;

/** The real charge from OpenAI's `usage` block, or null when it is missing. */
export function openAiActualCost(usage: unknown, model = "gpt-image-2"): number | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const details = (record.input_tokens_details ?? {}) as Record<string, unknown>;
  const output = number(record.output_tokens);
  if (!output) return null;
  const rates = ratesFor(model);
  const imageInput = number(details.image_tokens);
  const textInput = number(details.text_tokens) || Math.max(0, number(record.input_tokens) - imageInput);
  return (textInput * rates.textInput + imageInput * rates.imageInput + output * rates.imageOutput) / 1_000_000;
}
/**
 * The real charge from BFL's `cost` field. BFL documents credits (one cent
 * each) but not the unit of this field, so the reading closer to the estimate
 * wins. The charge is remembered for the next estimate at this resolution.
 */
export function fluxActualCost(cost: unknown, estimate: number, resolution?: string): number | null {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  const asCredits = cost * USD_PER_FLUX_CREDIT;
  const usd = Math.abs(asCredits - estimate) <= Math.abs(cost - estimate) ? asCredits : cost;
  if (resolution) {
    learned = { ...learned, flux: { ...learned.flux, [resolution]: usd } };
    writeJson(LEARNED_KEY, learned);
    changed();
  }
  return usd;
}

export const fluxCreditsToUsd = (credits: number) => credits * USD_PER_FLUX_CREDIT;

/** "$0.048", "$0.21", "$1.35"; tiny amounts keep three decimals. */
export function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}
