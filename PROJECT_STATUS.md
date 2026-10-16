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

## Known issues and blockers
1. Android SDK / Android Studio not installed; `JAVA_HOME` points to JDK 11 (needs 21; JDK 21 exists at `C:\Program Files\Java\jdk-21`).
2. Gradle distribution download failed in this environment.
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
- 2026-10-16: replaced category list with 3-column card grid + category view.

## Git commits
See `git log`. Initial scaffold commit: `de74278`.
