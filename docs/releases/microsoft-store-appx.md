# Microsoft Store AppX distribution (Nowen Note)

## What is implemented
- Dedicated AppX output: `electron/builder.store.config.js` to `dist-electron-store/`.
- Manually dispatched workflow: `.github/workflows/microsoft-store-appx.yml`. It **never** uploads to public GitHub Releases and does not touch existing NSIS/portable/SignPath pipelines.
- Store package runtime: Electron `process.windowsStore` on Windows, paired with `app.isPackaged`, routes updates to Microsoft Store. No `electron-updater` download/installation is attempted.
- Fixed, native-validated `ms-windows-store://downloadsandupdates` action from **Settings → About**. No arbitrary renderer-supplied URI is accepted.
- Existing GitHub Direct Windows installers, Lite channel and macOS/Linux clients keep their preexisting behavior. The Direct Windows channel currently opens the browser for manual package updates; Store publishing does not change it.

## Required Partner Center values (DO NOT invent these)
Retrieve **Product management → Product identity** for reserved `Nowen Note` from https://partner.microsoft.com/dashboard.
Configure GitHub repository **Actions Variables**:

| Variable | Description |
| --- | --- |
| `NOWEN_STORE_IDENTITY_NAME` | Exact `Package/Identity/Name` from Partner Center |
| `NOWEN_STORE_PUBLISHER` | Exact `Package/Identity/Publisher` DN, usually starting with `CN=` |
| `NOWEN_STORE_PUBLISHER_DISPLAY_NAME` | Actual publisher display name from Partner Center |
| `NOWEN_STORE_APPLICATION_ID` | Optional internal entry-point ID (default `NowenNote`); keep stable after first Store submission |

The build **fails before dependencies install** if mandatory identity metadata is absent or invalid. Do not use fake `CN=ms` or local test certificates for the formal submission.

## Build
1. Open [Microsoft Store AppX workflow](https://github.com/cropflre/nowen-note/actions/workflows/microsoft-store-appx.yml).
2. Select the branch containing these changes (initially `feat/ms-store-appx-v1-5-2`), click **Run workflow**. Subsequent official builds should use `release/v1.5.2` after code review.
3. Wait for `contracts` and `store-package` jobs. Download `nowen-note-store-appx` artifact from this run.
4. Upload the verified `.appx` to your reserved Nowen Note application's Partner Center submission. Microsoft Store signs the release as part of its publication process. An unsigned local package may not install via `Add-AppxPackage`.
5. Provide store listing description, screenshots, privacy/support policy, category, age rating, availability, and certification notes. Publish only after passing Store certification.

Local test/config: `npm run test:microsoft-store`. On a Windows host with dependencies/native modules prepared, set the above environment variables and run `npm run electron:build:store` (prepares backend/frontend and binaries, then invokes the independent Store builder).

## Mandatory real-Windows acceptance before publication
- Validate package identity, version, **full-trust execution**, launch via Start Menu, and actual Microsoft Store signing on a private Store flight. No CI test can substitute for installation.
- **Persistence**: create local SQLite notes, attachments, offline IndexedDB data, tasks, plugins, encryption secrets, and backups; quit, launch and then update from a newer Store version. Verify every item survives. The Microsoft Store package may use a different `userData` location from the NSIS install. **Do not assume automatic data migration or delete the NSIS installation first.**
- Local backend startup, embedded Electron/Node child processes, `better-sqlite3` native ABI, loopback port, NAS access, private LAN, external files, file dialogs, file associations and clipboard.
- Windows Store package's installed folder is read-only. All writes, plugin storage, logs and temporary files must use user-writable paths; never write under `process.resourcesPath` or the package install directory.
- Verify both manual menu **Check for updates** and About page's **Open Microsoft Store updates** open the Store, and never download `latest.yml`, a GitHub `.exe`, or call `quitAndInstall()`.
- Upgrade from Store vA to Store vB with identical package identity/publisher and increasing version; confirm Store-managed update with user configuration preserved.
- The Store app is a new install channel. Existing NSIS/portable installations **do not automatically migrate** into Store.
- If any packaged process, native plugin, backup or data-path behavior fails, block Store certification/publishing; fix in a separate follow-up PR.

**Release gate:** current implementation supplies an AppX submission candidate + automated contract/manifest checks. It has not been certified, Microsoft-signed, or validated on a real Store-installed Windows machine. This is **not a completed Store listing**.
