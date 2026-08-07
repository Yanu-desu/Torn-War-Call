# Changelog

All notable changes to this project are documented here.

## 2.2.2 — 2026-08-08

- Rolled back the travel feature for now.
- Removed the travel UI and Torn v1 travel polling from the userscript.
- Bundled the state, debug, and history modules into the Tampermonkey release so Greasy Fork does not need external `@require` scripts.
- Removed the unused travel module from the release source.

## [1.1.0] - 2026-08-07
### Added
- Tampermonkey in-page panel for live ally/enemy hospital timers on torn.com.

## [1.0.0] - 2026-08-06
### Added
- Initial release: Node.js bot polling Torn API for faction hospital status.
- Auto-detects active ranked war, or manual ENEMY_FACTION_ID override.
- Discord webhook alerts ~60s before hospital release.
- Per-hospital-stay de-dupe.
