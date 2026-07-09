# Privacy Policy

**Short version: LocalCaptions collects nothing, sends nothing, and stores everything on your
own device. There is no server, no account, and no telemetry.**

## What data LocalCaptions handles

- **Meeting transcripts** - the caption text Google Meet produces while you have captions (CC)
  turned on, plus speaker names, timestamps, the meeting code, and the meeting title.

## Where it is stored

- Entirely in your browser's local **IndexedDB**, under the extension's own origin on your
  computer. Nothing is uploaded anywhere.

## What LocalCaptions sends over the network

- **Nothing.** The extension makes **zero network requests**. It has no analytics, no crash
  reporting, no remote configuration, and no external scripts or fonts. You can verify this in
  Chrome DevTools (Network tab) or by reading the source - there are no `fetch`, `XMLHttpRequest`,
  `WebSocket`, or external-URL calls anywhere in the code.

## Permissions and why they are needed

- `storage`, `unlimitedStorage` - save transcripts locally (and allow long transcripts to exceed
  the default quota).
- `tabs` - let the toolbar popup detect whether the active tab is a Google Meet call and message
  the in-page panel.
- `host_permissions: https://meet.google.com/*` - run only on Google Meet pages, nowhere else.

LocalCaptions runs **only** on `https://meet.google.com/*`. It does not run on, read, or access any
other website.

## Third parties

- **None.** LocalCaptions does not share data with anyone because it never transmits data at all.

## Your control over your data

- Delete a single meeting from the history page (**Delete**), or wipe everything with **Clear all**.
- Uninstalling the extension removes all stored transcripts.

## Changes

Because there is no server, this policy is simply a description of how the code behaves. If the
behavior ever changes, this file and the source will change with it - and the change will be
visible in the commit history.

_Questions? Open an issue on the GitHub repository._
