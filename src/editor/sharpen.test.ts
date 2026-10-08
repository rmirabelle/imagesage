import { describe, expect, it } from "vitest";
import { parseSharpenFilterId, sharpenFilterId, sharpenFilterIds } from "./sharpen";

describe("sharpen", () => {
  it("round-trips its filter id", () => {
    const id = sharpenFilterId({ amount: 1.5, radius: 1.2, brightnessOnly: true });
    expect(id).toBe("shp_150_12_1");
    expect(parseSharpenFilterId(id)).toEqual({ amount: 1.5, radius: 1.2, brightnessOnly: true });
    expect(parseSharpenFilterId("shp_80_5_0")).toEqual({ amount: 0.8, radius: 0.5, brightnessOnly: false });
    expect(parseSharpenFilterId("clz_10_20")).toBeNull();
  });

  it("finds its ids in a filter string", () => {
    expect(sharpenFilterIds("brightness(1.2) url(#shp_150_12_1) url(#ctr_1_2_3_4)")).toEqual(["shp_150_12_1"]);
  });
});
