import { describe, expect, it } from "vitest";
import { adjustmentFilter, adjustmentOpacity, adjustSignature, LOG_SLIDER_STEPS, logSliderPosition, logSliderValue, resetAdjustment, allAdjustmentsOff, findAdjustment, hasAdjustments, moveLayer, moveLayers, replaceAdjustment, toggleAllAdjustments } from "./layers";
import type { Adjustment } from "./types";

/** Nodes 1, 2, 3 are A, B, C from the bottom up; node 0 is the original image. */
const stack = ["A", "B", "C"];

describe("moveLayer", () => {
  it("moves a layer directly above or below another", () => {
    expect(moveLayer(stack, 3, 1, true)).toEqual({ history: ["A", "C", "B"], node: 2 });
    expect(moveLayer(stack, 1, 3, true)).toEqual({ history: ["B", "C", "A"], node: 3 });
    expect(moveLayer(stack, 1, 3, false)).toEqual({ history: ["B", "A", "C"], node: 2 });
    expect(moveLayer(stack, 3, 2, false)).toEqual({ history: ["A", "C", "B"], node: 2 });
  });

  it("keeps the original image at the bottom", () => {
    expect(moveLayer(stack, 3, 0, false)).toEqual({ history: ["C", "A", "B"], node: 1 });
    expect(moveLayer(stack, 2, 0, true)).toEqual({ history: ["B", "A", "C"], node: 1 });
  });

  it("ignores moves onto itself and moves of the original image", () => {
    expect(moveLayer(stack, 2, 2, true).history).toBe(stack);
    expect(moveLayer(stack, 0, 2, true).history).toBe(stack);
  });
});

describe("moveLayers", () => {
  const five = ["A", "B", "C", "D", "E"];
  it("moves several layers together, in their own order, above or below another", () => {
    expect(moveLayers(five, [1, 3], 5, true)).toEqual({ history: ["B", "D", "E", "A", "C"], nodes: [4, 5] });
    expect(moveLayers(five, [5, 2], 1, false)).toEqual({ history: ["B", "E", "A", "C", "D"], nodes: [2, 1] });
    expect(moveLayers(five, [4, 5], 2, true)).toEqual({ history: ["A", "B", "D", "E", "C"], nodes: [3, 4] });
  });

  it("puts them at the bottom when dropped on the original image", () => {
    expect(moveLayers(five, [3, 4], 0, true)).toEqual({ history: ["C", "D", "A", "B", "E"], nodes: [1, 2] });
  });

  it("changes nothing when dropped on one of them or where they already are", () => {
    expect(moveLayers(five, [2, 4], 4, true).history).toBe(five);
    expect(moveLayers(five, [2, 3], 1, true).history).toBe(five);
  });
});

const bright = (id: string, value: number, extra: Partial<Adjustment> = {}): Adjustment => ({ id, kind: "brightness", value, ...extra });

describe("layer adjustments", () => {
  it("turns brightness into a canvas filter", () => {
    expect(adjustmentFilter(bright("a", 25))).toBe("brightness(1.25)");
    expect(adjustmentFilter(bright("a", -40))).toBe("brightness(0.6)");
    expect(adjustmentFilter(bright("a", 0))).toBeNull();
    expect(adjustmentFilter(bright("a", 30, { off: true }))).toBeNull();
    expect(hasAdjustments(undefined)).toBe(false);
    expect(hasAdjustments([bright("a", 0), bright("b", 10)])).toBe(true);
  });

  it("maps a log-scale slider place to a value and back", () => {
    expect(logSliderValue(0, 1, 3000)).toBe(1);
    expect(logSliderValue(LOG_SLIDER_STEPS, 1, 3000)).toBe(3000);
    expect(logSliderPosition(1, 1, 3000)).toBe(0);
    expect(logSliderPosition(3000, 1, 3000)).toBe(LOG_SLIDER_STEPS);
    for (const value of [1, 10, 55, 300, 2999]) expect(Math.abs(logSliderValue(logSliderPosition(value, 1, 3000), 1, 3000) - value)).toBeLessThanOrEqual(Math.ceil(value * 0.01));
  });

  it("turns sharpen into an SVG filter, and none at amount 0", () => {
    const sharpen = (values: Partial<Adjustment>): Adjustment => ({ id: "s", kind: "sharpen", value: 0, radius: 10, ...values });
    expect(adjustmentFilter(sharpen({ value: 150, radius: 12 }))).toBe("url(#shp_150_12_1)");
    expect(adjustmentFilter(sharpen({ value: 80, colorSharpen: true }))).toBe("url(#shp_80_10_0)");
    expect(adjustmentFilter(sharpen({ value: 0 }))).toBeNull();
  });

  it("turns hue and saturation into canvas filters", () => {
    const hue = (values: Partial<Adjustment>): Adjustment => ({ id: "h", kind: "hueSaturation", value: 0, ...values });
    expect(adjustmentFilter(hue({ hue: 30, saturation: -50 }))).toBe("hue-rotate(30deg) saturate(0.5)");
    expect(adjustmentFilter(hue({ saturation: 100 }))).toBe("saturate(2)");
    expect(adjustmentFilter(hue({ hue: 0, saturation: 0 }))).toBeNull();
    expect(adjustmentFilter(hue({ lightness: -40 }))).toBe("brightness(0.6)");
    expect(adjustmentFilter(hue({ lightness: 25 }))).toBe("invert(1) brightness(0.75) invert(1)");
    expect(adjustmentFilter(hue({ hue: 10, lightness: 0 }))).toBe("hue-rotate(10deg)");
    expect(adjustmentFilter(hue({ colorize: true, hue: 200, saturation: 80, lightness: -50 }))).toBe("brightness(0.5) url(#clz_200_80)");
  });

  it("turns opacity into a canvas filter and a fraction", () => {
    const opacity = (value: number): Adjustment => ({ id: "o", kind: "opacity", value });
    expect(adjustmentFilter(opacity(40))).toBe("opacity(0.4)");
    expect(adjustmentOpacity(opacity(40))).toBe(0.4);
    expect(adjustmentFilter(opacity(100))).toBeNull();
    expect(resetAdjustment(opacity(10)).value).toBe(100);
  });

  it("changes the signature when an adjustment mask changes, and ignores a mask that is off", () => {
    const plain = adjustSignature([bright("a", 10)]);
    expect(adjustSignature([bright("a", 10, { mask: "data:a" })])).not.toBe(plain);
    expect(adjustSignature([bright("a", 10, { mask: "data:a", maskOff: true })])).toBe(plain);
    expect(adjustSignature([bright("a", 0, { mask: "data:a" })])).toBe("");
    expect(adjustSignature([bright("a", 10), bright("b", -10)])).not.toBe(plain);
  });

  it("turns all adjustments off and back on, keeping the ones turned off one by one", () => {
    const list = [bright("a", 10), bright("b", 20, { off: true })];
    const off = toggleAllAdjustments(list)!;
    expect(allAdjustmentsOff(off)).toBe(true);
    expect(toggleAllAdjustments(off)).toEqual([bright("a", 10), bright("b", 20, { off: true })]);
    expect(toggleAllAdjustments([bright("a", 1, { off: true })])).toEqual([bright("a", 1)]);
  });

  it("finds, replaces, and removes one adjustment among several", () => {
    const list = [bright("a", 10), bright("b", 20)];
    expect(findAdjustment(list, "b")?.value).toBe(20);
    expect(replaceAdjustment(list, "a", bright("a", 5))).toEqual([bright("a", 5), bright("b", 20)]);
    expect(replaceAdjustment(list, "a", undefined)).toEqual([bright("b", 20)]);
    expect(replaceAdjustment([bright("a", 10)], "a", undefined)).toBeUndefined();
  });
});
