/**
 * The linear gradient icon: a rounded square that fades from the current
 * text color at the left to clear at the right, with a 1px outline of the
 * same color. It is a CSS box, so the outline snaps to whole screen pixels.
 */
export function LinearGradientIcon({ size = 16 }: { size?: number }) {
  return (
    <span className="linear-gradient-icon" style={{ width: size, height: size }} aria-hidden="true">
      <span />
    </span>
  );
}
