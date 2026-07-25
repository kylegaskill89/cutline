/**
 * In-app auto-update check. Talks to the Tauri updater plugin, which fetches the
 * signed `latest.json` manifest from the GitHub Releases endpoint configured in
 * tauri.conf.json, verifies the signature against the bundled public key, and
 * (on user consent) downloads + installs the new version, then relaunches.
 *
 * `silent` runs (on launch) stay quiet unless an update is actually available;
 * manual runs (the toolbar button) always report their result.
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message, confirm } from "@tauri-apps/plugin-dialog";

let checking = false;

export async function runUpdateCheck(opts: { silent: boolean }): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const update = await check();
    if (!update) {
      if (!opts.silent) {
        await message("You're on the latest version of Cutline.", { title: "No updates" });
      }
      return;
    }

    const notes = update.body?.trim();
    const ok = await confirm(
      `Cutline ${update.version} is available` +
        (update.currentVersion ? ` (you have ${update.currentVersion}).` : ".") +
        (notes ? `\n\nWhat's new:\n${notes}` : "") +
        `\n\nDownload and install now? The app will restart to finish.`,
      { title: "Update available", kind: "info", okLabel: "Install", cancelLabel: "Later" },
    );
    if (!ok) return;

    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          break;
        case "Progress":
          received += event.data.chunkLength;
          void total; // (progress UI could be surfaced here later)
          break;
        case "Finished":
          break;
      }
    });

    // Installed — relaunch into the new version.
    await relaunch();
  } catch (e) {
    // In dev, or when the release endpoint isn't reachable yet, `check()` throws.
    if (!opts.silent) {
      await message(`Could not check for updates:\n${e}`, {
        title: "Update check failed",
        kind: "error",
      });
    } else {
      console.warn("Update check failed:", e);
    }
  } finally {
    checking = false;
  }
}
