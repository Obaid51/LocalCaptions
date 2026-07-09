/**
 * Loads a UMD content-script module (transcript-engine.js / meet-scraper.js) and
 * returns its exported API. Evaluated in the *current* realm (via `new Function`)
 * so objects it produces share this file's prototypes and compare cleanly with
 * node:assert's deep-equality.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export function loadUMD(relPath, extraGlobals = {}) {
  const file = path.join(ROOT, relPath);
  const code = fs.readFileSync(file, 'utf8');
  const module = { exports: {} };

  const names = ['module', 'exports', ...Object.keys(extraGlobals)];
  const values = [module, module.exports, ...Object.values(extraGlobals)];
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${code}\n//# sourceURL=${file}`);
  fn(...values);

  if (module.exports && Object.keys(module.exports).length) return module.exports;
  return globalThis.LocalCaptionsEngine || globalThis.LocalCaptionsScraper || globalThis.LocalCaptionsPanel;
}
