/**
 * The current MASTER PAY Android app release, served to installed apps so they
 * can prompt to update. There is no Play Store — the APK is sideloaded — so the
 * app learns about a new version by asking the backend on the poll it already
 * makes, not through any push service.
 *
 * BUMP THIS ON EVERY APK RELEASE, in step with mobile/app.json:
 *   latestVersionCode  = android.versionCode of the build published to
 *                        frontend/public/masterpay.apk
 *   latestVersionName  = the human version shown in the banner
 *
 * minSupportedVersionCode is the FORCE-UPDATE floor. An app older than this is
 * blocked until it updates, rather than merely nudged. Raise it only for a
 * release everyone must take — e.g. a security fix. Leaving it well below
 * latest means updates are a dismissible suggestion.
 *
 * Env vars override each value so a release can be announced without a redeploy
 * (set them and restart), but the defaults here are the source of truth and
 * should be kept current regardless.
 */
const n = (v, d) => {
  const x = parseInt(v, 10);
  return Number.isFinite(x) ? x : d;
};

module.exports = {
  latestVersionCode: n(process.env.APP_LATEST_VERSION_CODE, 7),
  latestVersionName: process.env.APP_LATEST_VERSION_NAME || '0.3.4',

  // 0.1.x/0.2.x (codes 1–2) shipped the fail-open SMS sender check. Anyone on
  // those must update — but note only builds that CONTAIN the update check
  // (0.3.2+, code 5+) can act on this floor, so it bites future releases, not
  // the pre-0.3.2 apps that have no checker.
  minSupportedVersionCode: n(process.env.APP_MIN_VERSION_CODE, 3),

  // Absolute URL the update button opens. The APK is served by the FRONTEND
  // origin (masterpay.it.com), not the API origin (checkout.masterpay.it.com),
  // so the app can't derive it — we hand it the full URL.
  apkUrl: process.env.APP_APK_URL || 'https://masterpay.it.com/masterpay.apk',
};
