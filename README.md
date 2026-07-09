# LocalCaptions

**Your Google Meet transcripts, saved on your own machine. No cloud. No account. No bot in your call.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4.svg)](manifest.json)
[![No runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-28%20passing-brightgreen.svg)](test/)
[![Privacy](https://img.shields.io/badge/data-100%25%20local-brightgreen.svg)](PRIVACY.md)

LocalCaptions is a Chrome extension that shows your Google Meet transcript **in real time**,
lets you **copy any part instantly**, and **auto-saves every meeting** to a searchable history
you can revisit anytime.

Unlike cloud transcription tools, LocalCaptions **never sends your conversations anywhere**. It
reads Google Meet's *own built-in captions* (you turn on CC, Google does the speech-to-text) and
cleans them into a proper speaker-by-speaker transcript that lives only in your browser. It makes
**zero network requests** - you own your data, full stop.

---

## Why LocalCaptions?

| | LocalCaptions | Typical cloud note-taker |
|---|---|---|
| Where your transcript lives | Your browser only | A company's servers |
| Network requests | **None** | Uploads audio/transcript |
| Account / sign-up | None | Required |
| Bot joins your meeting | No | Often |
| Cost | Free & open source | Freemium / subscription |
| Works offline-ish | Yes (only needs Meet itself online) | No |

---

## Features

- **Real-time overlay panel** inside the Meet tab - draggable, resizable, minimizable.
- **Copy anything, live** - select text directly, copy a single line, or copy the whole transcript.
- **Auto-saved history** - every meeting is stored locally (IndexedDB) as it happens, so you never lose a transcript even if the tab crashes.
- **Searchable history page** - browse, full-text search, view, and re-export any past meeting.
- **Export** to `.txt` or Markdown `.md`.
- **Smart de-duplication** - Meet's captions constantly rewrite themselves word-by-word; LocalCaptions stabilizes them into one clean line per utterance (no repeated/garbled text).
- **Resilient capture** - layered DOM selectors with structural fallbacks survive Google's frequent UI changes.
- **Private by design** - no network calls, no analytics, no API keys, no telemetry. See [PRIVACY.md](PRIVACY.md).

---

## Install (Load Unpacked)

LocalCaptions isn't on the Chrome Web Store - you load it directly as an unpacked extension.

1. **Download the code** - either:
   - `git clone https://github.com/Obaid51/LocalCaptions.git`, or
   - download the ZIP from the GitHub page (**Code → Download ZIP**) and unzip it.
2. Open **`chrome://extensions`** in Chrome (or any Chromium browser: Edge, Brave, Arc, etc.).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder (the one containing **`manifest.json`**).
5. LocalCaptions appears in your toolbar. Pin it for quick access (puzzle-piece icon → pin).

A welcome tab (the history page) opens on first install. To update later, `git pull` (or re-download)
and click the **Reload** ↻ icon on the extension card.

---

## Usage

1. Join any **Google Meet** call.
2. Turn on **captions**: click the **CC** button in Meet's toolbar (or press **`c`**).
   - If you forget, the LocalCaptions panel shows a **"Turn on captions"** button that does it for you.
3. The **LocalCaptions panel** appears (top-right) and fills with the transcript in real time.
   - **Drag** the header to move it; drag the bottom-right corner to resize.
   - **Select text** and `Ctrl/Cmd+C` to copy any portion, or hover a line and click **⧉**.
   - Header buttons: **search**, **copy all**, **download `.txt`**, **open history**, **minimize**, **hide**.
4. When the meeting ends, the transcript is already saved.
5. Click the toolbar icon → **Open full history** (or the panel's history button) to browse, search, view, and export past meetings anytime.

> **Note:** LocalCaptions captures whatever Google Meet's captions produce. Captions must be
> **on** for capture to work - Google only generates caption text while CC is enabled.

---

## How it works

```
Google Meet captions (DOM)
        |  MutationObserver + 1s poll  (meet-scraper.js)
        v
  Transcript engine  (transcript-engine.js)   <- dedupe + stabilize utterances
        |  update -> live panel   |   persist -> save
        v                                      v
   In-page panel                       Service worker -> IndexedDB
   (panel.js, Shadow DOM)              (service-worker.js, lib/storage.js)
                                              ^
                              Popup & History pages read the same DB
```

- **`meet-scraper.js`** - finds the captions region (`[role="region"][aria-label="Captions"]`, with fallbacks), extracts each speaker turn, filters out Meet's own UI controls, and assigns every caption row a stable key. Throttled `MutationObserver` + a 1-second polling safety net.
- **`transcript-engine.js`** - pure, unit-tested logic. Meet rewrites captions live ("mic, so" -> "microphones only"); the engine tracks each turn by a stable id and only commits stabilized text, so you get one clean line per utterance. It also merges a turn that Google re-renders under a fresh DOM node mid-sentence (so it doesn't duplicate), while never merging two genuinely separate utterances.
- **`panel.js`** - the overlay, rendered in a **Shadow DOM** so Meet's CSS can't interfere.
- **`service-worker.js` + `lib/storage.js`** - persist every turn to IndexedDB as it's finalized. The content script (meet.google.com origin) streams turns to the worker (extension origin), which owns the database.
- **`popup/` and `history/`** - read that same database directly.

---

## Development

Requirements: Node 18+ (only for the test suite and icon generation - the extension itself has **no runtime dependencies** and no build step).

```bash
npm install        # installs jsdom (test-only dependency)
npm test           # runs the engine + scraper + integration suites (node --test)
npm run gen-icons  # regenerates icons/*.png from tools/gen-icons.mjs (no deps)
```

- Tests live in `test/` (28 cases, via jsdom) and cover:
  - the deduplication engine - growth, stabilization, element-replacement merge,
    id-collision safety, same-batch merge eligibility, separate-turn detection, flush;
  - the DOM scraper - region detection, class-based + structural extraction, stable
    keying, teardown safety, participants-panel rejection, UI-control filtering;
  - an **end-to-end integration test** that runs the real scraper + engine against a
    scripted, mutating Meet caption DOM and asserts a clean, merged, lossless transcript.
- No build step - the extension loads the source directly.

### Project layout

```
manifest.json                 MV3 manifest
src/
  content/
    transcript-engine.js      pure dedup/stabilize logic (UMD, tested)
    meet-scraper.js           Meet DOM selectors + observers (UMD, tested)
    panel.js                  Shadow-DOM real-time overlay
    panel.css                 host anchor styles
    content.js                entry: wires scraper -> engine -> panel -> storage
  background/
    service-worker.js         IndexedDB writer + history tab opener
  lib/
    storage.js                IndexedDB layer (shared by SW/popup/history)
  popup/                      toolbar popup (status, copy, open history)
  history/                    full transcript browser (search/view/export/delete)
icons/                        generated PNG icons
tools/gen-icons.mjs           zero-dependency PNG icon generator
test/                         node:test suites (jsdom)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to help - especially keeping the Meet selectors working.

---

## Maintenance: if capture ever stops working

Google Meet changes its HTML often. If transcripts stop appearing, the selectors are the
single place to update: **`src/content/meet-scraper.js` -> `SELECTORS`**. The scraper already
falls back to structure (avatar-anchored blocks, largest text node) when class names change,
so most Meet updates won't break it - but a major redesign might need a selector refresh.
Please [open an issue](../../issues/new/choose) if you hit this.

---

## Privacy

LocalCaptions makes **zero network requests**. Transcripts are stored only in your browser's
local IndexedDB and never leave your device. Uninstalling the extension or using **Clear all**
in the history page removes the data. Full details in [PRIVACY.md](PRIVACY.md).

## Limitations

- Captures only what Google Meet's captions emit; accuracy is Google's, not ours.
- Google Meet only (by design). Zoom/Teams are not supported.
- Captions must be turned on during the meeting.
- Live captions self-correct, so very short utterances spoken in the last moment before an
  abrupt tab close may occasionally be truncated.

## Contributing

Contributions are welcome - bug reports, selector fixes, and features. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm test` before opening a PR.

## License

[MIT](LICENSE) © LocalCaptions contributors. Do whatever you want with it - it's your data and your code.
