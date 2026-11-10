/* Autoplay Stopper — whitelist import window.
 * On macOS the toolbar popover closes as soon as a file dialog opens, so (like TabBackup) the picker
 * lives in its own small window. */
"use strict";

(() => {
  const FORMAT = globalThis.APS_FORMAT;
  const MAX_BYTES = 1024 * 1024;
  const $ = (id) => document.getElementById(id);
  const msg = $("msg");
  const choose = $("choose");
  const input = $("file");

  function say(text, cls = "") {
    msg.textContent = text;
    msg.className = "msg" + (cls ? " " + cls : "");
  }

  const plural = (n) => (n === 1 ? "1 site" : `${n} sites`);

  chrome.storage.local.get("whitelist").then(({ whitelist }) => {
    const n = Array.isArray(whitelist) ? whitelist.length : 0;
    $("lede").textContent =
      n > 0
        ? `Choose an Autoplay Stopper whitelist file (.txt). It replaces your current whitelist (${plural(n)}).`
        : "Choose an Autoplay Stopper whitelist file (.txt).";
  });

  /** Opens a picker that starts on the Desktop and only offers .txt files; falls back to <input type=file>. */
  async function pickFile() {
    if (typeof window.showOpenFilePicker === "function") {
      try {
        const [handle] = await window.showOpenFilePicker({
          id: "autoplay-stopper-import",
          startIn: "desktop",
          multiple: false,
          excludeAcceptAllOption: true,
          types: [{ description: "Plain text files", accept: { "text/plain": [".txt"] } }],
        });
        return handle ? await handle.getFile() : null;
      } catch (e) {
        if (e && e.name === "AbortError") return null; // the user canceled
        // Picker unavailable in this context; use the standard file input instead.
      }
    }
    return new Promise((resolve) => {
      input.value = "";
      input.onchange = () => resolve(input.files[0] || null);
      input.click();
    });
  }

  async function validate(file) {
    if (!/\.txt$/i.test(file.name)) throw new Error("Please choose a .txt file.");
    if (file.type && file.type !== "text/plain") throw new Error("That isn't a plain text file.");
    if (file.size === 0) throw new Error("That file is empty.");
    if (file.size > MAX_BYTES) throw new Error("That file is too large to be a whitelist.");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } catch (e) {
      throw new Error("That file isn't readable plain text.");
    }
    return FORMAT.parseText(text);
  }

  choose.addEventListener("click", async () => {
    const file = await pickFile();
    if (!file) return;
    choose.disabled = true;
    try {
      const whitelist = await validate(file);
      await chrome.storage.local.set({ whitelist });
      say(`Restored ${plural(whitelist.length)} from “${file.name}”.`, "ok");
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "show-popup" }).catch(() => {});
        window.close();
      }, 1400);
    } catch (e) {
      say(e.message || String(e), "err");
      choose.disabled = false;
    }
  });

  $("cancel").addEventListener("click", () => window.close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.close();
  });
})();
