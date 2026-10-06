import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/**
 * Prices come from the official pages, read live at startup and at most every
 * 12 hours: OpenAI's price page (token rates), OpenAI's image guide calculator
 * (token factors per quality, turned into tokens with OpenAI's own formula).
 * A built-in copy is used when the pages cannot be read.
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
  problems: string[];
}

interface PriceBook {
  openai: Record<string, TokenRates>;
  openaiTokenFactors: TokenFactors;
  /** When the official pages were read; null when only the built-in table is in use. */
  checkedAt: string | null;
  problems: string[];
}

interface LearnedPrices {
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
  checkedAt: null,
  problems: []
};

const CACHE_KEY = "imagesage.price-book";
const LEARNED_KEY = "imagesage.learned-prices";
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;
/** What Image Sage was charged, per local day ("2026-10-05": dollars). */
const SPEND_KEY = "imagesage.spend-by-day";
/** Days kept in the spend record: enough for this month and the month before. */
const SPEND_DAYS_KEPT = 62;

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
  openaiInputTokensPerMegapixel: storedLearned?.openaiInputTokensPerMegapixel ?? {}
};
const storedSpend = readJson<Record<string, unknown>>(SPEND_KEY);
let spendByDay: Record<string, number> = Object.fromEntries(
  Object.entries(storedSpend && typeof storedSpend === "object" ? storedSpend : {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
);
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
      checkedAt: Object.keys(live.openai).length ? new Date().toISOString() : book.checkedAt,
      problems: live.problems
    };
  } catch (error) {
    book = { ...book, problems: [String(error)] };
  }
  writeJson(CACHE_KEY, book);
  changed();
}

export const priceProblems = () => book.problems;

const familyOf = (model: string) => (model.startsWith("gpt-image-2.5") ? "gpt-image-2.5" : "gpt-image-2");
const ratesFor = (model: string) => book.openai[model] ?? BUILT_IN.openai[model] ?? BUILT_IN.openai["gpt-image-2"];
/** Each streamed partial image adds 100 output tokens; Image Sage asks for 3. */
const PARTIAL_IMAGE_TOKENS = 3 * 100;

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
/** A local date as "2026-10-05". */
const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const oldestSpendDay = () => dayKey(new Date(Date.now() - SPEND_DAYS_KEPT * 24 * 60 * 60 * 1000));
/** The spend record now lives in the app's data folder; until then, charges stay in this web view's storage. */
let spendShared = false;

/**
 * Loads the spend record from the app's data folder, which the dev app and
 * the installed app share. Charges kept in this web view's storage by older
 * versions move into it once, so nothing is counted twice.
 */
export async function loadSpend() {
  if (!isTauri() || spendShared) return;
  try {
    spendByDay = await invoke<Record<string, number>>("spend_record", { add: spendByDay, oldest: oldestSpendDay() });
    spendShared = true;
    try { localStorage.removeItem(SPEND_KEY); } catch { /* The record is already in the shared file. */ }
    changed();
  } catch {
    /* The totals stay in this web view's storage and move on the next start. */
  }
}

/** Adds a real charge to today's spend; days older than `SPEND_DAYS_KEPT` are dropped. */
export function recordSpend(usd: number | null) {
  if (usd === null || !(usd > 0)) return;
  const today = dayKey(new Date());
  const oldest = oldestSpendDay();
  const next = { ...spendByDay, [today]: (spendByDay[today] ?? 0) + usd };
  spendByDay = Object.fromEntries(Object.entries(next).filter(([day]) => day >= oldest));
  changed();
  if (!spendShared) {
    writeJson(SPEND_KEY, spendByDay);
    return;
  }
  invoke<Record<string, number>>("spend_record", { add: { [today]: usd }, oldest })
    .then((record) => { spendByDay = record; changed(); })
    .catch(() => {
      /** Not saved: it waits in this web view's storage and moves into the shared file on the next start. */
      const waiting = readJson<Record<string, number>>(SPEND_KEY) ?? {};
      writeJson(SPEND_KEY, { ...waiting, [today]: (Number(waiting[today]) || 0) + usd });
    });
}

/** What Image Sage was charged today and this month (local time). Re-render with `usePrices`. */
export function spendTotals() {
  const today = dayKey(new Date());
  const month = today.slice(0, 7);
  const monthTotal = Object.entries(spendByDay).reduce((sum, [day, usd]) => day.startsWith(month) ? sum + usd : sum, 0);
  return { today: spendByDay[today] ?? 0, month: monthTotal };
}

/** "$0.048", "$0.21", "$1.35"; tiny amounts keep three decimals. */
export function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value < 0.1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}
