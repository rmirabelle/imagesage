/**
 * The polygon lasso icon: a loop of straight edges with a knot and a short
 * rope, as in Photoshop. The picture (`public/lasso-poly.png`) is used as a
 * mask, so the icon takes the current text color.
 */
export function PolygonLassoIcon({ size = 16 }: { size?: number }) {
  return <span className="polygon-lasso-icon" style={{ width: size, height: size }} aria-hidden="true" />;
}
