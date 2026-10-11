/**
 * Sharpening after an enlargement, without DOM code, like the "sharper"
 * step of bicubic resampling: each color moves away from the average of the
 * 3 × 3 pixels around it by `amount` (0.5 is light). Alpha does not change,
 * so edges and transparent areas keep their shape.
 */
export function sharpenPixels(data: Uint8ClampedArray, width: number, height: number, amount: number) {
  const source = data.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (!source[at + 3]) continue;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        let count = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny >= height) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox;
            if (nx < 0 || nx >= width) continue;
            sum += source[(ny * width + nx) * 4 + channel];
            count++;
          }
        }
        const value = source[at + channel];
        data[at + channel] = value + (value - sum / count) * amount;
      }
    }
  }
}
