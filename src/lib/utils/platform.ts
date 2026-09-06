// Platform helpers for user-facing strings.
//
// The keyboard handlers already accept both metaKey and ctrlKey, so shortcuts
// *work* everywhere — but every label said "Cmd", which is wrong on the first
// screen a Windows or Linux user sees. Derive the label once, from the
// platform, and use it wherever a shortcut is shown.

/**
 * "Cmd" on macOS, "Ctrl" everywhere else.
 *
 * Takes the platform string as a parameter so it is unit-testable without a
 * DOM; the default reads `navigator.platform`, guarded for environments where
 * `navigator` does not exist (the same guard `stores/updater.ts` uses).
 */
export function modifierKeyLabel(
  platform: string = typeof navigator !== "undefined" ? navigator.platform : ""
): string {
  return /^mac/i.test(platform) ? "Cmd" : "Ctrl";
}

/** The label for this session's platform, resolved once at module load. */
export const MOD = modifierKeyLabel();
