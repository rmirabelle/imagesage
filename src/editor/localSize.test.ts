import { describe, expect, it } from "vitest";
import { LOCAL_MAX_PIXELS, LOCAL_MIN_PIXELS, localImageSize } from "./localSize";

describe("local engine sizes", () => {
  it("keeps sizes near one megapixel", () => {
    expect(localImageSize(1024, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(localImageSize(1536, 1024)).toEqual({ width: 1536, height: 1024 });
  });

  it("scales large and small images to the limits with the same shape", () => {
    const large = localImageSize(2560, 1440)!;
    expect(large.width * large.height).toBeLessThanOrEqual(LOCAL_MAX_PIXELS);
    expect(large.width / large.height).toBeCloseTo(16 / 9, 1);
    const small = localImageSize(400, 300)!;
    expect(small.width * small.height).toBeGreaterThanOrEqual(LOCAL_MIN_PIXELS);
    expect(small.width / small.height).toBeCloseTo(4 / 3, 1);
  });

  it("uses multiples of 32", () => {
    for (const [width, height] of [[1000, 700], [3000, 2000], [513, 999]]) {
      const size = localImageSize(width, height)!;
      expect(size.width % 32).toBe(0);
      expect(size.height % 32).toBe(0);
    }
  });

  it("rejects shapes wider or taller than 4:1", () => {
    expect(localImageSize(4100, 1000)).toBeNull();
    expect(localImageSize(0, 1000)).toBeNull();
    expect(localImageSize(4000, 1000)).not.toBeNull();
  });
});
