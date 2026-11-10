# Autoplay Stopper

A simple Chromium extension for (hopefully) automatically blocking autoplaying videos on all sites.

- Blocks autoplay at the source. The extension loads in every page and frame before any of the site's own code runs, and intercepts every way a page can start video or audio:
  - Calls to `play()`, including on hidden, detached, or script-created players (e.g., `new Audio()`).
  - The `autoplay` attribute, however it gets set, including in HTML the page inserts later.
  - Players created by cloning or copying page content, which can otherwise start playing before they're even on the page.
  - Embedded frames on the same site, so a page can't sidestep the block through a fresh frame.
  - As a last resort, anything that still manages to start playing is paused immediately.
- Lets you play what you actually choose. Playback is allowed only right after a real click or key press on that specific player (or its play button), so a page can't count a stray click or scroll elsewhere as permission. Once you start a video, it behaves normally, except that it can't roll into the next video on its own after it ends.
- Add specific sites as-needed to a permanent whitelist.
- Disable autoplay temporarily on a given URL (until the browser is restarted).

## Installation

Unzip the extension and place the folder somewhere permanent. Navigate to chrome://extensions, enable the "Developer Mode" toggle, click the "Load Unpacked" button, and select the Autoplay Stopper folder in the filesystem dialog.

## Support

If you find a bug, please report it here on GitHub and I will try to fix it. Please be as thorough in your reporting as you can.

You're welcome to request features or changes if you're so-inclined, and I will give such requests due consideration, but just know that this extension was built first and foremost for an audience of one and I consider it feature-complete at this time.

Autoplay Stopper is available in English only, by design.

## Note

I am not a software engineer; all of the code for this project was written by Anthropic's Claude models. That said, I use all of the applications under this account regularly in my daily life, so while they're not perfect, I'm confident in their efficacy and general reliability.

## License

Autoplay Stopper is free software, licensed under the GNU General Public License, version 3 only (GPL-3.0-only). Copyright © 2026 avenged110. The full license text is in `COPYING`.
