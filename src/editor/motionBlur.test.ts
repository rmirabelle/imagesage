import { describe, expect, it } from "vitest";
import { motionBlurFilterId, motionBlurFilterIds, motionBlurSteps, parseMotionBlurFilterId } from "./motionBlur";
import { adjustmentFields, adjustmentFilter } from "./layers";

describe("motion blur", () => {
  it("round-trips its filter id, negative angles included", () => {
    const id = motionBlurFilterId({ distance: 20, angle: -45 });
    expect(id).toBe("mob_20_45");
    expect(parseMotionBlurFilterId(id)).toEqual({ distance: 20, angle: -45 });
    expect(parseMotionBlurFilterId("shp_1_2_3")).toBeNull();
    expect(motionBlurFilterIds("blur(2px) url(#mob_20_45) url(#shp_1_2_1)")).toEqual(["mob_20_45"]);
  });

  it("averages enough copies to be at most one pixel apart, centered on each pixel", () => {
    const { steps, center } = motionBlurSteps({ distance: 100, angle: 0 });
    expect(steps.length).toBe(7);
    expect(steps[0].dx).toBeLessThanOrEqual(1);
    expect(steps[6].dx).toBeCloseTo(50, 5);
    expect(center.dx).toBeCloseTo(-(127 * (100 / 128)) / 2, 5);
    /** 90 degrees is straight up: screen y goes down. */
    const up = motionBlurSteps({ distance: 8, angle: 90 });
    expect(up.steps[0].dx).toBeCloseTo(0, 5);
    expect(up.steps[0].dy).toBeLessThan(0);
  });

  it("is the blur's filter only with Motion on, where Radius becomes Distance", () => {
    expect(adjustmentFilter({ id: "a", kind: "blur", value: 10 })).toBe("blur(10px)");
    expect(adjustmentFilter({ id: "a", kind: "blur", value: 10, motion: true, angle: 30 })).toBe("url(#mob_10_120)");
    expect(adjustmentFilter({ id: "a", kind: "blur", value: 0, motion: true })).toBeNull();
    expect(adjustmentFields({ kind: "blur", motion: true }).map(({ label }) => label)).toEqual(["Distance", "Angle"]);
    expect(adjustmentFields({ kind: "blur" }).map(({ label }) => label)).toEqual(["Radius"]);
  });
});
