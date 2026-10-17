# MyDocs - Project Status

## Project overview
Lightweight, mobile-responsive document manager. Vanilla HTML/CSS/ES modules, SQLite metadata, files in app-private storage, packaged with Capacitor for Android (iOS later).

## Technology stack and architecture decisions
- Capacitor 8.5.3 (core, cli, android); no frontend framework, no bundler (plugins reached through `Capacitor.Plugins`).
- `@capacitor-community/sqlite` 8.1.1, `@capacitor/filesystem` 8.1.5, `@capawesome/capacitor-file-picker` 8.1.0, `@capacitor/file-viewer` 2.0.4 (all peer `@capacitor/core >= 8`).
- `database.js` takes an injected driver; `documents.js` takes injected storage/picker/viewer adapters. This lets the same logic run on Node SQLite in tests and on native plugins on device.
- App ID `com.alichade.mydocs` (placeholder derived from the GitHub account; owner should confirm).
- Files stored as `documents/<uuid>.<ext>` in `Directory.Data`; DB holds only metadata. Not encrypted by the app.
- Picker returns base64 (`readData`), capped at 25 MB, to avoid depending on content-URI copy behaviour (unverified on device).

## Current development phase
Phases 1-6 code written. Phase 7 (Android build/verification) **blocked** by environment. Phase 8 in progress.
Dashboard v2 (12 categories + demo data) implemented 2026-10-16; see "Dashboard v2" below.

## Dashboard v2: 12 categories and demo data
- Categories (stable slug IDs, in order): personal-documents, educational-documents, identity-documents, work-career, financial-documents, medical-health, insurance-documents, property-real-estate, vehicle-documents, bills-receipts, legal-documents, travel-documents. Defined in `www/js/seed.js` with icon key and sort order; rendered dynamically by `app.js`.
- 58 demo documents (4-5 per category, exactly the names requested) are metadata only: `is_demo = 1`, `file_path`/`file_size` NULL, unique `seed_key`. No files are created. Clicking a demo card shows "This is sample document data. Import a real document to preview it."; demo records can be renamed/removed.
- SQLite schema v2 (migration from v1): categories gain `slug` (unique), `icon`, `sort_order`; documents rebuilt with nullable `file_path`/`file_size`, `is_demo`, `seed_key`, and a CHECK that real documents have a file path. v1 rows are kept; v1 categories "IDs" and "Work Related Documents" are adopted as Identity Documents / Work & Career.
- Seeding: categories are upserted by slug on each launch (idempotent). Demo documents are inserted once inside the v2 migration with `INSERT OR IGNORE` on `seed_key`, so relaunching never duplicates them and demo docs the user deletes stay deleted.
- Browser preview uses `www/js/mock.js`, an in-memory repository built from the same seed (temporary, not persistent, shown with a banner).
- UI: categories built once; toggling only changes `aria-expanded`, a class and `inert` on that category; only the changed category's grid is re-rendered after rename/delete/import. Multiple categories can be open. Grid is 2 columns on phones, 3/4/5 at 560/820/1080px. Header has logo and a disabled search placeholder.

## Feature checklist (verified = actually exercised)
| Feature | Code | Verified |
|---|---|---|
| Project structure, Capacitor config, Android platform generated | yes | `cap sync android` succeeded |
| Dashboard, 4 collapsible categories, card grid, empty state | yes | browser preview at 375px width: no horizontal overflow, toggling works |
| SQLite schema, migrations, default categories without duplicates | yes | Node tests (node:sqlite) |
| Import with validation, unique stored names, rollback on failure | yes | Node tests (in-memory file store) |
| List/filter, rename, delete, missing-file handling, reconcile | yes | Node tests |
| Native SQLite via CapacitorSQLite | yes | **NOT verified** (no device/emulator) |
| Native file write/picker/viewer | yes | **NOT verified** |
| Debug APK | n/a | **NOT built** |

## Dashboard v3: category card grid (2026-10-16)
- Dashboard shows the 12 categories as cards built once from category data (icon in light-blue circle, name, "N documents" badge, chevron). `.category-grid`: 3 columns from 720px up (equal widths), 2 columns below, 1 column under 340px.
- Tapping a card opens a single-page category view (back button, icon, title, count, document card grid, empty state, Add document). Navigation uses `history.pushState`/`popstate`, so the Android back button returns to the dashboard; scroll position and card focus are restored.
- One delegated click listener per container (no per-card handlers re-registered). UI never touches SQLite; it uses the document service / mock repository. Data, schema and seed unchanged.
- Files changed: `www/index.html`, `www/css/styles.css`, `www/js/app.js`.
- Verified in browser preview: 12 cards, exactly 3 per row at 1100px with equal widths (335px), 2 columns at 360px, no horizontal overflow (also with a 200-char filename in the category view), correct documents per category, back and history.back return to the dashboard, sample card click shows the sample-data message. `npm test` 23/23 (logic only). Not run on Android.
- The reference screenshot mentioned in the request was not attached; existing colors/style were kept.

## Test and build results
- `npm test`: 23 passed, 0 failed, 0 skipped (logic only; mock file storage; Node's SQLite engine, not the Capacitor plugin). Covers: 12 categories in order, exact demo docs per category, v1->v2 upgrade, no duplicate seeding on relaunch, demo docs cannot open, empty category, plus all earlier tests.
- Browser preview at 320px width (DOM script): 12 headers in order with counts 4,4,5x10; expand/collapse independent, multiple open at once, `aria-expanded` correct; no horizontal overflow, even with a 200-character filename; demo card click shows the sample message; closed bodies are `inert`.
- Not run: any of the above on Android (native SQLite migration/seeding on device is unverified).
- `npx cap sync android`: passed (4 plugins detected).
- Browser preview (`npm run dev`): rendered, 4 categories, no console errors, no horizontal overflow at 375px.
- `gradlew assembleDebug` with JDK 21: **failed** - Gradle wrapper could not download `gradle-8.14.3-all.zip` (network error from this environment). Separately, no Android SDK is installed (`ANDROID_HOME` unset, no `%LOCALAPPDATA%\Android\Sdk`, no Android Studio found), so the build could not succeed regardless.
- Could not run: Android emulator/device startup, native plugin initialisation, real import/preview, iOS.

## Android emulator verification (2026-10-16, Pixel_10_Pro AVD, API 37 image)
- Bug found on device: blank dashboard, Logcat `MyDocs init failed: plugin.isConnection is not a function` (`isConnection` exists only in the plugin's JS wrapper, not natively). Fixed in `database.js` by calling `createConnection` and tolerating "already exists".
- After fix (`gradlew installDebug` succeeded, app launched): native CapacitorSQLite opened the DB, v2 migration ran, demo documents seeded (ids 1-58 returned per category), and the 2-column category grid rendered with correct counts (screenshot checked).
- Not yet verified on device: opening a category, rename/delete, real file import/preview, relaunch idempotency, v1->v2 upgrade on device.
- Note: debug builds echo SQLite query results (incl. document names) to Logcat via the plugin/Capacitor console; release builds should not.

## Upload with document name (2026-10-16)
- Flow: Add document -> native picker (`service.pickFile()`, null on cancel) -> name dialog (bottom sheet on phones) prefilled via `suggestName()` (filename minus extension) -> Save Document -> `service.importFile(categoryId, file, name)`. The category is captured when the flow starts. Rename reuses the same dialog and `validateName` rules.
- Validation: empty/whitespace name shows "Please enter a document name."; max 120 chars. Save/Cancel/input are disabled while saving and re-submits are ignored. Success and error toasts shown.
- Stored separately: `documents.name` (display) vs `original_filename`; stored file keeps its extension and content. Cards show the custom name (2-line clamp) and the upload date (`created_at`).
- Files changed: `www/index.html`, `www/css/styles.css`, `www/js/app.js`, `www/js/documents.js`, `www/js/mock.js`, `tests/documents.test.mjs`.
- Verified: `npm test` 27/27; browser preview (360px): prefill, empty-name error, cancel saves nothing, double-submit creates one record, correct category/count, survives back + reopen, rename + empty rename error, no overflow. Debug APK built, installed and launched on the emulator with no console/runtime errors.
- NOT verified on device: the real Android file picker -> name dialog -> save -> reopen. The browser preview uses a mock picker with a fixed sample file.

## Camera capture (2026-10-16)
- New plugin: `@capacitor/camera` 8.2.6 (`takePhoto`, JPEG q90, max 2400px, orientation corrected, not saved to gallery). Manifest: only `<uses-feature android.hardware.camera required=false>`. No `CAMERA` permission is declared, so the system camera app handles capture and the app never asks for permission; the plugin only requests it if the permission is declared. Denied/unavailable/capture errors map to friendly messages; leaving the camera is treated as cancel.
- Flow (every category): Capture with Camera -> system camera -> preview dialog (Retake / Continue / Cancel) -> name dialog (placeholder `e.g., Aadhaar Card Front`, default `Captured Document <date>`, mandatory) -> Save Document. Nothing is stored before Save; Cancel/Esc discards the capture. Retake that is cancelled keeps the previous photo.
- Storage: image is written to `documents/<uuid>.jpg` via the existing import path (`importFile`), display name stored separately from `original_filename` (`Captured_YYYYMMDD_HHMMSS.jpg`). Schema v3 adds `documents.thumb_path`; a ~320px JPEG thumbnail is written to `thumbnails/<uuid>.jpg` (best effort, 8 s timeout, never blocks saving). Thumbnails also apply to images uploaded from storage. Delete removes image and thumbnail; reconcile sweeps orphan thumbnails.
- UI: Add document + Capture with Camera buttons side by side; cards show the photo thumbnail in place of the icon (icon fallback); tapping an image document opens a full-screen viewer; PDFs/others keep the existing viewer. Images are served to the WebView through `Capacitor.convertFileSrc`, not base64.
- Files changed: `package.json`, `package-lock.json`, `android/app/src/main/AndroidManifest.xml`, `www/index.html`, `www/css/styles.css`, `www/js/{app,database,documents,mock}.js`, new `www/js/images.js`, `tests/documents.test.mjs`.
- Verified: `npm test` 34/34. Browser preview (360px, fake camera): button in all 12 categories, preview, retake, cancel at preview and at name dialog saves nothing, empty-name error, save with a long name, thumbnail renders, full-screen viewer, reopen category persists, rename, delete, no horizontal overflow. Android emulator: debug APK built and installed; app upgraded v2 -> v3 with existing data intact; Capture with Camera opens the system camera app; leaving the camera returns to the category with no crash, no preview and nothing saved.
- NOT verified on device: taking a real photo through preview -> name -> save, thumbnail and full-screen view of a real photo, restart persistence of a captured photo. The emulator's camera app showed a black screen and could not be driven from adb, so these need a real device or a working virtual camera.
- Browser-preview note: `Image.decode()` hung in a background pane, so thumbnails use onload/onerror and the service times out thumbnailing after 8 s.

## Category open/close animation (2026-10-17)
- Architecture: single-page WebView (vanilla JS), so the transition is built with the Web Animations API in new `www/js/transitions.js` (no libraries). Technique: container transform. The category view becomes a fixed overlay and its `clip-path: inset(... round 16px)` animates between the tapped card's rectangle and the full screen (380 ms, Material emphasized-decelerate), so content is revealed rather than scaled. The card's icon and name travel to the heading (FLIP shared elements); back arrow, count, buttons and grid fade/slide in with 50 ms stagger; the dashboard dims slightly. Tap feedback is a 90 ms card scale-down. Back reverses it: the view collapses into the originating card (300 ms) while the dashboard returns at its saved scroll position (dashboard DOM is never rebuilt, no data reloads), focus returns to the card.
- Robustness: taps during a transition are ignored; a Back request during a transition is queued; `settled()` has a safety timeout so navigation can't stick; `prefers-reduced-motion` or missing WAAPI or no origin card (history-forward) -> instant switch; overlay padding is computed to line up with the in-flow layout so there is no jump at the end.
- New dependency: `@capacitor/app` 8.1.2. Capacitor 8 no longer handles the system Back button, so before this the Android Back button closed the app from a category. Back now: closes open dialog/viewer, else category -> dashboard (animated), else exits.
- Files changed: `www/js/transitions.js` (new), `www/js/app.js`, `www/css/styles.css`, `package.json`, `package-lock.json`, Android sync files.
- Verified: `npm test` 34/34 (logic only). Browser preview (360px): mid-transition frames show the card region expanding and the icon/title moving; end state has no overlay or leftover animations; back arrow and history.back restore scroll 300 and card focus; rapid clicks open only one category; queued back works. Emulator (Pixel_10_Pro AVD): open frames captured mid-transition and final state correct; Android Back from a category returns to the dashboard (animated), Back on the dashboard exits; no runtime errors.
- Not verified: frame rate/jank on low-end hardware; reduced-motion path on a real device ("Remove animations" mapping to the CSS media query varies by WebView version); rotation mid-transition.
- Emulator note: disturbing the emulator's camera app left its graphics/camera HAL crashing (black screen) until `adb reboot`; unrelated to MyDocs.

## Fixed header (2026-10-17)
- Problem: the blue header scrolled away. The header was `position: sticky`, but `html, body { overflow-x: hidden }` turned `body` into a scroll container, which silently disables sticky positioning.
- Fix: the page never scrolls (`html, body { height: 100%; overflow: hidden }`). `body` is a flex column (`100dvh`): `.app-bar` is `flex: none` (header stays put, keeps its status-bar inset padding) and the new `#scroller` wrapper around `<main>` is `flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain`. Only the categories/documents scroll, underneath the header; nothing renders over it. Bottom inset (`env(safe-area-inset-bottom)`) moved to the scroller's padding.
- Scroll code ported from `window` to the scroller: `app.js` (save/restore dashboard position, reset on opening a category) and `transitions.js` (collapse restores `scroller.scrollTop`). The category open/close animation is unchanged (its overlay is `position: fixed` below the header).
- Files changed: `www/index.html`, `www/css/styles.css`, `www/js/app.js`, `www/js/transitions.js`.
- Verified: browser preview 360px: header top 0 / bottom 56 after scrolling 500px, first card scrolled under it, document not scrollable, no horizontal overflow; open category from scrollTop 300 and back restores 300 and card focus, no leftover animations. Emulator: swiped to the bottom with the header fixed and all 12 cards reachable; opened Identity Documents and pressed Back: identical scroll position restored. `npm test` 34/34. Debug APK builds and installs.
- Not verified: very fast fling on a physical device; landscape/tablet on device; the header's search field is still a disabled placeholder (no search functionality exists yet).

## Document sharing (2026-10-17)
- UI: every document card now has icon actions Rename (pencil), Share, Delete (accessible labels, 44px targets; three fit in a 2-column card at 320px). Sample documents show a "no file to share" message.
- Mechanism: new plugin `@capacitor/share` 8.0.3. `service.shareDocument(id)` checks the record and that the stored file exists, then stages ONE temporary copy named after the document (`cache/share/My_Document.pdf`, replacing any previous copy; cleared on app start) and calls the plugin, which builds an `ACTION_SEND` intent with a FileProvider `content://com.alichade.mydocs.fileprovider/...` URI, `FLAG_GRANT_READ_URI_PERMISSION`, MIME from the extension (`*/*` only if unknown), subject = document name, and shows `Intent.createChooser` (the native Android Sharesheet). No `file://` URIs, no storage permissions, no hard-coded app list; the user completes the send in the target app. The stored original is never moved or modified.
- Existing FileProvider config reused (`${applicationId}.fileprovider`, `res/xml/file_paths.xml` with `cache-path`). Note: the Capacitor template's `external-path "."` entry is still present (the camera plugin also uses this provider); only URIs the app explicitly generates are ever exposed.
- Errors mapped to friendly messages: missing file, no app can receive the file, FileProvider misconfiguration, sheet failed to open, staging failed; cancelling the sheet is a silent no-op.
- Files changed: `www/js/documents.js`, `www/js/app.js`, `www/js/mock.js`, `www/css/styles.css`, `tests/documents.test.mjs`, `package.json`, `package-lock.json`, Android sync files.
- Verified: `npm test` 38/38 (share file naming, staged copy, single temp copy, cancel, missing file, demo, no sharer, failures, original untouched). Browser preview: three icons fit at 320px without overlap; sample share message. Emulator (Pixel_10_Pro AVD): Share on an uploaded JPG and on a real PDF opened the native Sharesheet (preview "Sharing image" / "Sharing 1 file: Lease_Agreement.pdf") listing Quick Share, Gmail, Drive, Bluetooth, Messages, Maps, Photos, Print; `dumpsys` showed `content://com.alichade.mydocs.fileprovider/my_cache_images/share/Aadhaar_Card.jpg` and `.../Lease_Agreement.pdf` with a read grant; the shared copies were byte-identical (SHA-1) to the stored originals and the originals were unchanged; Google Messages accepted the file (recipient picker opened); backing out of the sheet is clean; with the stored file removed, Share shows "missing from storage"; Rename dialog and Delete (including a record whose file was missing) work; fixed header, scrolling and animations unaffected.
- NOT verified: WhatsApp (not installable on this emulator); Gmail compose with the attachment (Gmail needs a Google account sign-in, which was not done); Drive upload; Bluetooth/Quick Share transfers; a camera-captured photo through the share path (the emulator camera cannot be driven; captured photos are stored as ordinary `.jpg` documents and use the same code path as the uploaded JPG); the "no compatible app" path on a device (unit-tested mapping only); a physical device.

## Known issues and blockers
1. (Resolved) Android SDK/emulator now installed; build with `JAVA_HOME` = JDK 21 and `ANDROID_HOME` set works.
3. Unverified assumptions to check on device: FilePicker `readData` result, `Filesystem.getUri` path accepted by `FileViewer.openDocumentFromLocalPath`, CapacitorSQLite `isConnection`/transaction calls with `transaction:false`, and `Capacitor.Plugins.<Name>` proxies without a bundler.
4. `npm audit` reports vulnerabilities in dependencies; not yet reviewed.
5. Expiry date column exists but has no UI yet.
6. Requested path `...\Mydocs` / repo `alichade2/MyDocs` do not exist; work was done in the existing `MyDocuments` project and pushed to `alichade2/MyDocuments`.
7. Search field is a disabled placeholder.

## Files created or modified
`package.json`, `package-lock.json`, `capacitor.config.json`, `.gitignore`, `README.md`, `PROJECT_STATUS.md`, `scripts/dev-server.mjs`, `www/index.html`, `www/css/styles.css`, `www/js/{app,database,documents,mock,seed}.js`, `tests/documents.test.mjs`, `android/` (generated by Capacitor).

## Latest development session (2026-10-16)
Inspected environment, initialised Capacitor/Android, built dashboard, database and document services, tests, docs.

## Next steps
0. On device: verify v2 migration + seeding with native CapacitorSQLite (fresh install and upgrade from a v1 install).
1. Install Android Studio + SDK Platform 36, set `ANDROID_HOME`, `JAVA_HOME` = JDK 21.
2. `npm run apk:debug`; run on emulator/device; verify the unverified items above and update this file.
3. Add instrumented/manual device test checklist results; review `npm audit`.
4. Add expiry-date UI and category filtering/search.

## Change history
- 2026-10-16: initial implementation (see Git history).
- 2026-10-16: 12-category dashboard, demo data, schema v2, tests 15 -> 23.
- 2026-10-17: document sharing via the native Sharesheet, icon actions on cards, tests 34 -> 38.
- 2026-10-17: fixed header with an independent scroll container.
- 2026-10-17: animated category open/close (container transform), Android Back handling via @capacitor/app.
- 2026-10-16: camera capture with preview, thumbnails, full-screen viewer, schema v3, tests 27 -> 34.
- 2026-10-16: upload asks for a document name (shared with rename), tests 23 -> 27.
- 2026-10-16: replaced category list with 3-column card grid + category view.

## Git commits
See `git log`. Initial scaffold commit: `de74278`.
