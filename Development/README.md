# Autoplay Stopper — development files

The extension itself is in `../Autoplay Stopper` (load it via chrome://extensions → Load unpacked).

## tools/
- `make_icons.py` — renders the toolbar/store icons (stdlib only):
  `python3 tools/make_icons.py "../Autoplay Stopper/icons"`
- `read_leveldb_log.py` — dumps the latest values from a Chromium extension-storage LevelDB `.log`
  (used to recover the original extension's whitelist).

## test-harness/ (Python 3 stdlib only; drives /Applications/Chromium.app over the DevTools Protocol)
Run from `test-harness/`, passing absolute paths:
- `run_tests.py <ext> <test-site>` — 32 blocking tests (add `--no-ext` for a baseline without the extension)
- `popup_test.py <ext> <test-site>` — 47 popover UI tests (needs `SHOTS=<dir>` for screenshots)
- `audit_tests.py <ext> <test-site>` — 12 adversarial tests from the code audit (unlock-on-first-click
  listeners, keyboard/wheel scrolling, closed declarative shadow DOM, pristine-realm bypasses, data:/
  sandboxed/srcdoc/media-document frames, forged click relays, "autoplay next" after a video ends, …)
- `export_import_test.py <ext> <test-site>` — 23 Export/Import tests (round trip, overwrite, picker options,
  10 kinds of rejected file, layout); downloads stay inside the throwaway profile
- `import_test.py <ext> <test-site>` — one-time legacy whitelist import test (needs `SHOTS=<dir>`)
- `realsites.py <ext> <test-site> <url>...` — media state on live sites, every frame
- `realclick.py <ext> <test-site> '<json jobs>'` — click a live player and screenshot (needs `SHOTS=<dir>`)

Each run uses a throwaway Chromium profile, headless, and local test servers on ports 8765/8766
(`site-a.test` / `site-b.test` are mapped to 127.0.0.1).

## test-site/
Local pages covering each autoplay technique (markup, script play(), detached audio, shadow DOM,
about:blank frames, cross-origin frames, click-to-play placeholders, bypass attempts).
