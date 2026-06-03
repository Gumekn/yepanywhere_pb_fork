/**
 * BuildInfo - compact version + build-timestamp stamp for the login screens.
 *
 * Shown on the pre-login screens (host picker / direct login) so you can
 * verify *which build* is installed on a device before connecting. This is
 * especially useful for the APK: it embeds a frozen frontend bundle, so the
 * only way to know whether a phone is running the latest code is to read the
 * build stamp baked in at `vite build` time.
 *
 * Both values are injected via Vite `define` (see vite.config*.ts):
 *   __APP_VERSION__  → git describe (e.g. "0.4.28-3-gabcdef")
 *   __BUILD_DATE__   → ISO wall-clock time of the build
 *   __BUILD_PROFILE__→ "debug" | "release" (APK) or "dev" (web)
 */

/** Format the injected ISO build timestamp as a compact local date-time. */
function formatBuildDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function BuildInfo() {
  return (
    <p className="login-build-info" data-testid="build-info">
      v{__APP_VERSION__} · {formatBuildDate(__BUILD_DATE__)} ·{" "}
      <span
        className={`login-build-profile login-build-profile-${__BUILD_PROFILE__}`}
        data-testid="build-profile"
      >
        {__BUILD_PROFILE__}
      </span>
    </p>
  );
}
