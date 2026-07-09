# Changelog

All notable changes to LocalCaptions are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-07-09

Initial public release.

### Added
- Real-time Google Meet transcript overlay (Shadow-DOM panel): draggable, resizable, minimizable.
- Copy any part live - text selection, per-line copy, and copy-all.
- Automatic local saving of every meeting to IndexedDB as it happens.
- Searchable history page: browse, full-text search, view, export (`.txt` / `.md`), and delete.
- Toolbar popup with live status, show/hide panel, quick copy, and recent meetings.
- Deduplication engine that stabilizes Meet's self-rewriting captions into one clean line per
  utterance, including element-replacement merge handling.
- Resilient Meet scraper with layered selectors and structural fallbacks, plus filtering of
  non-caption UI controls (e.g. the "jump to bottom" button).
- 28 automated tests (engine, scraper, and an end-to-end integration test) via `node --test` + jsdom.
- Zero-dependency PNG icon generator.

### Privacy
- No network requests, no accounts, no telemetry. All data stays in local IndexedDB.
