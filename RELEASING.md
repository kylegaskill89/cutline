# Releasing Cutline (and how auto-update works)

Cutline ships as a Windows installer that **auto-updates**: on launch (and via the
**Check for Updates** button) the app fetches a signed `latest.json` from this
repo's GitHub Releases, and if a newer signed build exists it downloads, installs,
and relaunches. Your users never re-download manually after the first install.

## One-time setup

1. **Create the public repo** (must match the updater endpoint in
   `src-tauri/tauri.conf.json`):
   `https://github.com/kylegaskill89/cutline`

2. **Add two repository secrets** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — the **contents** of `~/.cutline-keys/cutline.key`
     (the private key generated during setup). Paste the whole file.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key's password. It was generated
     with an empty password, so set this secret to an empty string (or recreate
     the key with a password and use that).

   > Keep `~/.cutline-keys/cutline.key` safe and backed up. If it's lost, existing
   > installs can no longer verify updates and you'd have to re-key + re-distribute.

   The matching **public** key is already committed in `tauri.conf.json`
   (`plugins.updater.pubkey`) — that's what installed apps use to verify updates.

## Cutting a release

1. Bump the version in **both** places so they match:
   - `src-tauri/tauri.conf.json` → `"version"`
   - `package.json` → `"version"`
2. Commit.
3. Tag and push:
   ```
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. The **Release** workflow (`.github/workflows/release.yml`) runs on the tag:
   it downloads the ffmpeg/ffprobe sidecars, runs the tests, builds + signs the
   installer, publishes a GitHub Release, and uploads `latest.json`.
5. Existing installs pick it up on their next launch.

You can also trigger the workflow manually (Actions → Release → Run workflow), but
a real update needs a bumped version and a tag.

## Notes

- The ffmpeg/ffprobe sidecars (~400 MB) are **not** committed — they exceed
  GitHub's file-size limit. CI downloads them; locally they live in
  `src-tauri/binaries/` (gitignored).
- Auto-update only works in an **installed** build, not `tauri dev`.
- The updater is Windows-only as configured (the only bundle target). Adding
  macOS/Linux later is just more `tauri-action` matrix entries + bundle targets.
