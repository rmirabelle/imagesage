import { describe, expect, it } from "vitest";
import { createManifest, parseManifest } from "./document";
import type { EditStep } from "./types";

const step = (index: number): EditStep => ({
  id: `step-${index}`,
  prompt: `edit ${index}`,
  model: "gpt-image-2.5-sunburst",
  quality: "high",
  createdAt: "2026-10-02T00:00:00.000Z",
  selection: { x: 10, y: 20, size: 300 },
  sent: { x: 0, y: 10, width: 320, height: 320, margin: 10, requestWidth: 816, requestHeight: 816 },
  before: `data:image/png;base64,before${index}`,
  after: `data:image/png;base64,after${index}`
});

describe("Image Sage manifest", () => {
  it("round-trips history, tiles, origin and the undo position", () => {
    const origin = { kind: "generated" as const, prompt: "a lighthouse", model: "gpt-image-2.5-flare", quality: "high", size: "1536x1024" };
    const { manifest, tiles } = createManifest(1536, 1024, origin, [step(1), step(2)], 1, "2026-10-01T00:00:00.000Z");
    expect(tiles.map((tile) => tile.path)).toEqual([
      "history/0001-before.png",
      "history/0001-after.png",
      "history/0002-before.png",
      "history/0002-after.png"
    ]);
    const restored = parseManifest(JSON.stringify(manifest), tiles);
    expect(restored.origin).toEqual(origin);
    expect(restored.historyIndex).toBe(1);
    expect(restored.history[1]).toEqual(step(2));
  });

  it("round-trips layers, masks and the original image", () => {
    const { before: _before, after: _after, ...plain } = step(1);
    const layered: EditStep = { ...plain, layer: "data:image/png;base64,layer1", layerMask: "data:image/png;base64,mask1" };
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [layered], 1, "2026-10-01T00:00:00.000Z", { base: "data:image/png;base64,base", baseAdjust: [{ id: "adj-1", kind: "brightness", value: -20 }] });
    expect(tiles.map((tile) => tile.path)).toEqual(["history/base.png", "history/0001-layer.png", "history/0001-mask.png"]);
    const restored = parseManifest(JSON.stringify(manifest), tiles);
    expect(restored.base).toBe("data:image/png;base64,base");
    expect(restored.baseAdjust).toEqual([{ id: "adj-1", kind: "brightness", value: -20 }]);
    expect(restored.history[0]).toEqual(layered);
  });

  it("writes version 3 when the original image is a normal layer", () => {
    const { before: _before, after: _after, ...plain } = step(1);
    const layered: EditStep = { ...plain, layer: "data:image/png;base64,layer1" };
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [layered], 1, "2026-10-01T00:00:00.000Z", { base: "" });
    expect(manifest.formatVersion).toBe(3);
    expect(manifest.base).toBeUndefined();
    expect(tiles.map((tile) => tile.path)).toEqual(["history/0001-layer.png"]);
    const restored = parseManifest(JSON.stringify(manifest), tiles);
    expect(restored.base).toBe("");
    expect(restored.history).toEqual([layered]);
  });

  it("stores adjustment masks as tiles", () => {
    const { before: _before, after: _after, ...plain } = step(1);
    const layered: EditStep = {
      ...plain,
      layer: "data:image/png;base64,layer1",
      adjust: [
        { id: "adj-a", kind: "brightness", value: 30, mask: "data:image/png;base64,bright1", maskHides: true },
        { id: "adj-b", kind: "brightness", value: -12 },
        { id: "adj-c", kind: "brightness", value: 8, mask: "data:image/png;base64,bright3" }
      ]
    };
    const baseAdjust = [{ id: "adj-z", kind: "brightness" as const, value: -10, off: true, mask: "data:image/png;base64,brightbase", maskOff: true }];
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [layered], 1, "2026-10-01T00:00:00.000Z", { base: "data:image/png;base64,base", baseAdjust });
    expect(tiles.map((tile) => tile.path)).toEqual([
      "history/base.png",
      "history/base-adjust-1-mask.png",
      "history/0001-adjust-1-mask.png",
      "history/0001-adjust-3-mask.png",
      "history/0001-layer.png"
    ]);
    expect(JSON.stringify(manifest)).not.toContain("base64,bright");
    const restored = parseManifest(JSON.stringify(manifest), tiles);
    expect(restored.baseAdjust).toEqual(baseAdjust);
    expect(restored.history[0]).toEqual(layered);
  });

  it("round-trips hue and saturation", () => {
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [], 0, "2026-10-01T00:00:00.000Z");
    const baseAdjust = [{ id: "adj-h", kind: "hueSaturation", value: 0, hue: -400, saturation: 35 }];
    expect(parseManifest(JSON.stringify({ ...manifest, baseAdjust }), tiles).baseAdjust).toEqual([{ id: "adj-h", kind: "hueSaturation", value: 0, hue: -180, saturation: 35 }]);
  });

  it("reads adjustment masks stored in the manifest itself", () => {
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [], 0, "2026-10-01T00:00:00.000Z");
    const baseAdjust = [{ id: "adj-1", kind: "brightness", value: 5, mask: "data:image/png;base64,inline" }];
    expect(parseManifest(JSON.stringify({ ...manifest, baseAdjust }), tiles).baseAdjust).toEqual(baseAdjust);
  });

  it("reads one brightness saved by older versions", () => {
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [], 0, "2026-10-01T00:00:00.000Z");
    const parse = (baseAdjust: unknown) => parseManifest(JSON.stringify({ ...manifest, baseAdjust }), tiles).baseAdjust;
    expect(parse({ brightness: 25 })).toEqual([{ id: "adj-1", kind: "brightness", value: 25 }]);
    expect(parse({ brightness: 0 })).toBeUndefined();
    expect(parse({ brightness: { value: 10, maskHides: true } })).toEqual([{ id: "adj-1", kind: "brightness", value: 10, maskHides: true }]);
  });

  it("rejects documents whose tiles are missing", () => {
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [step(1)], 1, "2026-10-01T00:00:00.000Z");
    expect(() => parseManifest(JSON.stringify(manifest), tiles.slice(1))).toThrow(/missing/);
  });

  it("rejects other formats", () => {
    expect(() => parseManifest(JSON.stringify({ format: "capsage-document", formatVersion: 2 }))).toThrow(/not an Image Sage/);
  });
});

describe("recovery copies", () => {
  it("remember the tab name and the file the image belongs to", () => {
    const { manifest, tiles } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [], 0, "2026-10-02T00:00:00.000Z", { recovery: { name: "Poster.imagesage", path: "D:/Art/Poster.imagesage" } });
    expect(parseManifest(JSON.stringify(manifest), tiles).recovery).toEqual({ name: "Poster.imagesage", path: "D:/Art/Poster.imagesage" });
  });

  it("are absent from ordinary saves", () => {
    const { manifest } = createManifest(10, 10, { kind: "imported", fileName: "a.png" }, [], 0, "2026-10-02T00:00:00.000Z");
    expect(parseManifest(JSON.stringify(manifest)).recovery).toBeNull();
  });
});
