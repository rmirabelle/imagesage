/**
 * Which confirmations the app asks before it changes your work. A
 * confirmation is on until "Don't show again" turns it off; Settings turns
 * it on or off again. The choice is kept in this PC's local storage.
 */
const SKIP_KEYS = {
  delete: "imagesage.skip-delete-confirm",
  regenerate: "imagesage.skip-regenerate-confirm"
} as const;

export type Confirmation = keyof typeof SKIP_KEYS;

/** True when the app asks first. */
export function confirms(which: Confirmation) {
  try {
    return localStorage.getItem(SKIP_KEYS[which]) !== "1";
  } catch {
    return true;
  }
}

export function setConfirms(which: Confirmation, on: boolean) {
  try {
    if (on) localStorage.removeItem(SKIP_KEYS[which]);
    else localStorage.setItem(SKIP_KEYS[which], "1");
  } catch {
    /* Remembering the choice is a convenience only; the question comes back next time. */
  }
}
