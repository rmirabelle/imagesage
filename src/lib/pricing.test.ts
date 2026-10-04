import { describe, expect, it } from "vitest";
import { estimateFluxEdit, estimateOpenAiImage, fluxActualCost, fluxPrice, formatUsd, openAiActualCost, outputTokens } from "./pricing";

describe("pricing", () => {
  it("matches the token counts and prices OpenAI publishes", () => {
    expect(outputTokens("gpt-image-2", "high", 1024, 1024)).toBe(7024);
    expect(outputTokens("gpt-image-2.5-sunburst", "high", 1024, 1024)).toBe(1756);
    /** OpenAI's price table: GPT Image 2 is $0.211, $0.165, $0.053, $0.041 for these. */
    expect((outputTokens("gpt-image-2", "high", 1024, 1024) * 30) / 1e6).toBeCloseTo(0.211, 3);
    expect((outputTokens("gpt-image-2", "high", 1536, 1024) * 30) / 1e6).toBeCloseTo(0.165, 3);
    expect((outputTokens("gpt-image-2", "medium", 1024, 1024) * 30) / 1e6).toBeCloseTo(0.053, 3);
    expect((outputTokens("gpt-image-2", "medium", 1024, 1536) * 30) / 1e6).toBeCloseTo(0.041, 3);
  });

  it("adds the streamed preview tokens to the estimate", () => {
    expect(estimateOpenAiImage("gpt-image-2", "high", "1024x1024")).toBeCloseTo((7024 + 200) * 30 / 1e6, 6);
  });

  it("reads OpenAI usage into dollars", () => {
    expect(openAiActualCost({ input_tokens: 40, output_tokens: 1756, input_tokens_details: { text_tokens: 40 } })).toBeCloseTo(0.0529, 3);
    expect(openAiActualCost(null)).toBeNull();
  });

  it("reads the FLUX cost field as credits or dollars, whichever fits the estimate", () => {
    expect(fluxActualCost(4.8, estimateFluxEdit("1k"))).toBeCloseTo(0.048, 4);
    expect(fluxActualCost(0.05, estimateFluxEdit("2k"))).toBeCloseTo(0.05, 4);
    expect(fluxActualCost("x", 0.05)).toBeNull();
  });

  it("formats small and large amounts", () => {
    expect(formatUsd(0.048)).toBe("$0.048");
    expect(formatUsd(1.349)).toBe("$1.35");
  });
});

describe("FLUX prices", () => {
  it("uses the listed price, and estimates sizes missing from the price page", () => {
    expect(fluxPrice("2k")).toEqual({ usd: 0.1, estimated: false });
    const between = fluxPrice("1.5k");
    expect(between.estimated).toBe(true);
    expect(between.usd).toBeCloseTo(0.074, 3);
  });
});
