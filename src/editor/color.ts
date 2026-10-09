/** A color as hue (0 to 360 degrees), saturation and brightness (0 to 100). */
export interface Hsb {
  h: number;
  s: number;
  b: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Red, green and blue (0 to 255) of an HSB color. */
export const hsbToRgb = ({ h, s, b }: Hsb): [number, number, number] => {
  const saturation = clamp(s, 0, 100) / 100;
  const value = clamp(b, 0, 100) / 100;
  const at = (n: number) => {
    const k = (n + (((h % 360) + 360) % 360) / 60) % 6;
    return value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [at(5), at(3), at(1)].map((channel) => Math.round(channel * 255)) as [number, number, number];
};

/** The HSB color of red, green and blue (0 to 255). A gray keeps hue 0. */
export const rgbToHsb = (r: number, g: number, b: number): Hsb => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let h = 0;
  if (delta > 0) {
    if (max === red) h = ((green - blue) / delta) % 6;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : (delta / max) * 100, b: max * 100 };
};

export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0")).join("")}`;

/** Red, green and blue of "#rrggbb" or "#rgb" (the # is optional), or null for other text. */
export const hexToRgb = (hex: string): [number, number, number] | null => {
  let text = hex.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(text)) text = text.split("").map((digit) => digit + digit).join("");
  if (!/^[0-9a-f]{6}$/.test(text)) return null;
  return [0, 2, 4].map((at) => parseInt(text.slice(at, at + 2), 16)) as [number, number, number];
};

export const hsbToHex = (hsb: Hsb) => rgbToHex(...hsbToRgb(hsb));

export const hexToHsb = (hex: string): Hsb | null => {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsb(...rgb) : null;
};
