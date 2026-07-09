# Contributing to LocalCaptions

Thanks for helping out! LocalCaptions is a small, dependency-free Chrome extension, so getting
started is quick.

## Ground rules

- **Privacy is the whole point.** Contributions must not add network requests, analytics,
  telemetry, external scripts/fonts, or anything that sends user data off-device. PRs that do will
  be declined. See [PRIVACY.md](PRIVACY.md).
- Keep it dependency-free at runtime. The extension ships plain JS/CSS/HTML with no build step.
  `jsdom` is the only dev dependency (for tests).

## Getting set up

```bash
git clone https://github.com/Obaid51/LocalCaptions.git
cd localcaptions
npm install        # dev-only: installs jsdom for the tests
npm test           # should print all tests passing
```

Load the extension in Chrome via `chrome://extensions` -> **Developer mode** -> **Load unpacked**
-> select the repo folder. After editing, click the **Reload** icon on the extension card.

## Running tests

```bash
npm test           # node --test over test/*.test.mjs
```

Please add or update tests for any behavior change, and make sure `npm test` is green before
opening a PR. The core capture logic is intentionally split so it can be tested without a browser:

- `src/content/transcript-engine.js` - pure dedup/stabilize logic (no DOM).
- `src/content/meet-scraper.js` - DOM parsing; tested with `jsdom`.

## The most valuable contribution: keeping selectors working

Google changes Meet's HTML frequently, which is the main thing that can break capture. If
transcripts stop appearing:

1. Join a Meet, turn on captions, and inspect the captions container in DevTools.
2. Update **`src/content/meet-scraper.js` -> `SELECTORS`** (region / block / name / text / avatar).
3. Add a jsdom test in `test/scraper.test.mjs` that reproduces the new structure so it doesn't
   regress.

The scraper is deliberately layered (precise selectors -> avatar-anchored structure -> generic
fallback) and filters out non-caption UI (buttons, Material-icon controls), so prefer extending
those layers over hard-coding a single class.

## Style

- Match the surrounding code: 2-space indent, semicolons, small focused functions, comments that
  explain *why*.
- No em dashes in code or docs (project convention - use a hyphen).

## Submitting

1. Fork and branch from `main`.
2. Make your change with tests.
3. Run `npm test`.
4. Open a PR describing what changed and why. If it's a selector fix, mention which Meet UI version
   you tested against.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
