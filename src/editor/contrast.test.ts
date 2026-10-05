import { describe, expect, it } from "vitest";
import { contrastCurve, contrastFilterId, contrastFilterIds, contrastSlope, contrastTable, parseContrastFilterId } from "./contrast";

describe("contrast", () => {
  it("changes nothing at amount 0, for any curve and middle", () => {
    for (const x of [0, 0.2, 0.5, 0.9, 1]) {
      expect(contrastCurve(x, { amount: 0, pivot: 0.5, curve: 0 })).toBeCloseTo(x, 6);
      expect(contrastCurve(x, { amount: 0, pivot: 0.3, curve: 1 })).toBeCloseTo(x, 6);
    }
  });

  it("keeps the middle gray and pushes other values away from it", () => {
    const params = { amount: 0.5, pivot: 0.4, curve: 0.5 };
    expect(contrastCurve(0.4, params)).toBeCloseTo(0.4, 6);
    expect(contrastCurve(0.3, params)).toBeLessThan(0.3);
    expect(contrastCurve(0.6, params)).toBeGreaterThan(0.6);
  });

  it("clips with a straight line but not with the smooth curve", () => {
    expect(contrastCurve(0.9, { amount: 1, pivot: 0.5, curve: 0 })).toBe(1);
    const smooth = contrastCurve(0.9, { amount: 1, pivot: 0.5, curve: 1 });
    expect(smooth).toBeGreaterThan(0.9);
    expect(smooth).toBeLessThan(1);
  });

  it("goes flat gray at amount -1", () => {
    expect(contrastSlope(-1)).toBe(0);
    expect(contrastCurve(0.1, { amount: -1, pivot: 0.5, curve: 0 })).toBeCloseTo(0.5, 6);
  });

  it("makes a rising table from black to white", () => {
    const table = contrastTable({ amount: 0.6, pivot: 0.5, curve: 0.5, color: 1 });
    expect(table).toHaveLength(256);
    expect(table.every((value, index) => index === 0 || value >= table[index - 1])).toBe(true);
  });

  it("names a filter by its settings and reads them back", () => {
    const params = { amount: -0.25, pivot: 0.5, curve: 0.75, color: 1 };
    const id = contrastFilterId(params);
    expect(id).toBe("ctr_-25_50_75_100");
    expect(parseContrastFilterId(id)).toEqual(params);
    expect(parseContrastFilterId("other")).toBeNull();
    expect(contrastFilterIds(`brightness(1.2) url(#${id}) opacity(0.5)`)).toEqual([id]);
  });
});
