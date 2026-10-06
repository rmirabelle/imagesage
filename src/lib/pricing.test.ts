import { describe, expect, it } from "vitest";
import { estimateOpenAiImage, formatUsd, openAiActualCost, outputTokens, recordSpend, spendTotals } from "./pricing";

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
    expect(estimateOpenAiImage("gpt-image-2", "high", "1024x1024")).toBeCloseTo((7024 + 300) * 30 / 1e6, 6);
  });

  it("reads OpenAI usage into dollars", () => {
    expect(openAiActualCost({ input_tokens: 40, output_tokens: 1756, input_tokens_details: { text_tokens: 40 } })).toBeCloseTo(0.0529, 3);
    expect(openAiActualCost(null)).toBeNull();
  });

  it("formats small and large amounts", () => {
    expect(formatUsd(0.048)).toBe("$0.048");
    expect(formatUsd(1.349)).toBe("$1.35");
  });
});

describe("spend record", () => {
  it("adds real charges to today and this month, and ignores missing charges", () => {
    const before = spendTotals();
    recordSpend(0.25);
    recordSpend(null);
    recordSpend(0.1);
    const after = spendTotals();
    expect(after.today - before.today).toBeCloseTo(0.35, 6);
    expect(after.month - before.month).toBeCloseTo(0.35, 6);
  });
});
