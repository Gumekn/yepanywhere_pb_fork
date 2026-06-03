/**
 * Base-path helper retained for call-site compatibility.
 *
 * The app is always served at its own root, so the base path is empty.
 * Kept as a hook so callers don't need to change if a base path is
 * reintroduced later.
 */

/**
 * Get the base path for navigation links.
 *
 * @returns Always an empty string (app is served at its own root).
 */
export function useRemoteBasePath(): string {
  return "";
}
