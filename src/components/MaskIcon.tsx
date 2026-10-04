/**
 * The layer mask icon: a frame with a circle in it. By default the body is
 * filled and the circle is hollow (only the painted area shows); `inverted`
 * fills the circle and leaves the body blank (the painted area hides). Both
 * keep the outer border. It uses the current text color.
 */
export function MaskIcon({ inverted = false, size = 17 }: { inverted?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {inverted ? (
        <>
          <rect x="2" y="4" width="16" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="10" cy="10" r="3.6" fill="currentColor" />
        </>
      ) : (
        <>
          <path
            fillRule="evenodd"
            fill="currentColor"
            d="M4 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm6 2.4a3.6 3.6 0 1 0 0 7.2a3.6 3.6 0 1 0 0-7.2Z"
          />
          <rect x="2" y="4" width="16" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </>
      )}
    </svg>
  );
}
