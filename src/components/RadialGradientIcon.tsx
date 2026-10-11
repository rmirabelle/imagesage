/**
 * The radial gradient icon: a circle that fades from the current text color
 * in the middle to clear at its edge, with a 1px outline of the same color.
 * It is a CSS box, so the outline snaps to whole screen pixels.
 */
export function RadialGradientIcon({ size = 16 }: { size?: number }) {
  return (
    <span className="radial-gradient-icon" style={{ width: size, height: size }} aria-hidden="true">
      <span />
    </span>
  );
}
