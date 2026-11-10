/* Autoplay Stopper — popover. */
"use strict";

(() => {
  const SITES = globalThis.APS_SITES;
  const $ = (id) => document.getElementById(id);

  const el = {
    siteCard: $("site-card"),
    siteName: $("site-name"),
    statusText: $("status-text"),
    favicon: $("favicon"),
    faviconFallback: $("favicon-fallback"),
    blockedLine: $("blocked-line"),
    btnTemp: $("btn-temp"),
    btnTempLabel: $("btn-temp-label"),
    btnTempSub: $("btn-temp-sub"),
    btnWhitelist: $("btn-whitelist"),
    btnWhitelistLabel: $("btn-whitelist-label"),
    btnWhitelistSub: $("btn-whitelist-sub"),
    btnEdit: $("btn-edit"),
    btnEditSub: $("btn-edit-sub"),
    mainPane: $("main-pane"),
    listPane: $("list-pane"),
    list: $("list"),
    empty: $("empty"),
    listCount: $("list-count"),
    form: $("entry-form"),
    input: $("url-input"),
    hint: $("hint"),
    btnBack: $("btn-back"),
    btnAdd: $("btn-add"),
    btnExport: $("btn-export"),
    btnImport: $("btn-import"),
    listWrap: $("list-wrap"),
  };

  /** Status strip at the bottom of the list. Export results linger until the field is edited. */
  let hintSticky = false;
  function setHint(text, cls = "") {
    el.hint.textContent = text;
    el.hint.className = "hint" + (cls ? " " + cls : "");
    el.listWrap.classList.toggle("has-hint", !!text);
  }

  let tab = null;
  let pageUrl = null; // URL object when Autoplay Stopper can run on the current tab, else null
  let state = { whitelist: [], tempDisabled: [] };
  let justAdded = null;

  const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

  // ---------------------------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------------------------
  async function loadState() {
    const s = await chrome.storage.local.get(["whitelist", "tempDisabled"]);
    state = {
      whitelist: Array.isArray(s.whitelist) ? s.whitelist : [],
      tempDisabled: Array.isArray(s.tempDisabled) ? s.tempDisabled : [],
    };
  }

  async function saveState(patch) {
    Object.assign(state, patch);
    await chrome.storage.local.set(patch);
  }

  function reloadTab() {
    if (tab && tab.id !== undefined) chrome.tabs.reload(tab.id).catch(() => {});
  }

  // ---------------------------------------------------------------------------------------------
  // Main view
  // ---------------------------------------------------------------------------------------------
  function renderMain() {
    const count = state.whitelist.length;
    el.btnEditSub.textContent = count === 0 ? "No sites whitelisted" : count === 1 ? "1 site" : `${count} sites`;

    if (!pageUrl) {
      el.siteCard.dataset.state = "unavailable";
      el.siteName.textContent = describeUnavailable();
      el.statusText.textContent = "Not available on this page";
      el.blockedLine.textContent = "Extensions aren't allowed to run on this page.";
      el.favicon.hidden = true;
      el.faviconFallback.style.display = "";
      setTempButton(false, false);
      setWhitelistButton(false, false, null);
      return;
    }

    const host = pageUrl.hostname;
    const display = SITES.normalizeHost(host) || host;
    el.siteName.textContent = display;
    el.siteName.title = host;
    showFavicon();

    const entry = SITES.findWhitelistEntry(state.whitelist, host);
    const temp = SITES.findTempDisabled(state.tempDisabled, host);

    if (entry) {
      el.siteCard.dataset.state = "whitelisted";
      el.statusText.textContent =
        entry.domain === display ? "Whitelisted — autoplay allowed" : `Whitelisted via ${entry.domain}`;
      setTempButton(false, false);
      setWhitelistButton(true, true, entry);
    } else if (temp) {
      el.siteCard.dataset.state = "paused";
      el.statusText.textContent = "Temporarily disabled — autoplay allowed";
      setTempButton(true, true);
      setWhitelistButton(true, false, null);
    } else {
      el.siteCard.dataset.state = "active";
      el.statusText.textContent = "Blocking autoplay";
      setTempButton(true, false);
      setWhitelistButton(true, false, null);
    }
    renderBlockedCount();
  }

  function describeUnavailable() {
    const raw = (tab && (tab.url || tab.pendingUrl)) || "";
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" || u.protocol === "https:") return SITES.normalizeHost(u.hostname);
      if (u.protocol === "file:") return "Local file";
      if (u.protocol === "chrome-extension:") return "Extension page";
      return "Browser page";
    } catch (e) {
      return "This page";
    }
  }

  function showFavicon() {
    const src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);
    el.favicon.onload = () => {
      el.favicon.hidden = false;
      el.faviconFallback.style.display = "none";
    };
    el.favicon.onerror = () => {
      el.favicon.hidden = true;
      el.faviconFallback.style.display = "";
    };
    el.favicon.src = src;
  }

  function setTempButton(enabled, isResume) {
    el.btnTemp.disabled = !enabled;
    el.btnTemp.classList.toggle("is-resume", isResume);
    if (isResume) {
      el.btnTempLabel.textContent = "Resume blocking on this site";
      el.btnTempSub.textContent = "Stop autoplay here again";
    } else {
      el.btnTempLabel.textContent = "Disable temporarily on this site";
      el.btnTempSub.textContent = "Until you restart the browser";
    }
  }

  function setWhitelistButton(enabled, isRemove, entry) {
    el.btnWhitelist.disabled = !enabled;
    el.btnWhitelist.classList.toggle("is-remove", isRemove);
    if (isRemove) {
      el.btnWhitelistLabel.textContent = "Remove this site from whitelist";
      el.btnWhitelistSub.textContent = entry ? `Removes ${entry.domain}` : "Block autoplay here again";
    } else {
      el.btnWhitelistLabel.textContent = "Add this site to whitelist";
      el.btnWhitelistSub.textContent = "Always allow autoplay here";
    }
  }

  // Blocked counts, per frame, as reported by the page's own frames while the popover is open (nothing is
  // tracked in the background). Shown once the frames have answered, or after a short wait.
  const frameCounts = new Map();
  let countsReady = false;
  let countsTimer = 0;

  function countsArrived() {
    if (countsTimer) return;
    countsTimer = setTimeout(() => {
      countsTimer = 0;
      countsReady = true;
      renderBlockedCount();
    }, 40); // let the other frames' answers arrive too, so the number doesn't visibly count up
  }

  let countPort = null;
  function connectCounts() {
    if (!tab || tab.id === undefined || !pageUrl) return;
    if (countPort) {
      try {
        countPort.disconnect();
      } catch (e) {}
      countPort = null;
    }
    frameCounts.clear();
    let port;
    try {
      port = chrome.tabs.connect(tab.id, { name: "aps-count" });
    } catch (e) {
      countsArrived();
      return;
    }
    countPort = port;
    port.onMessage.addListener((m) => {
      if (port !== countPort || !m || typeof m.id !== "string") return;
      frameCounts.set(m.id, Math.max(0, m.count | 0));
      countsArrived();
    });
    // Every frame went away (the page reloaded or navigated), or none answered at all (e.g. the page was
    // open before Autoplay Stopper was installed or reloaded).
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== countPort) return;
      countPort = null;
      countsArrived();
    });
    setTimeout(countsArrived, 400);
  }

  // The page reloaded or navigated while the popover is open (e.g. after "Disable temporarily"): ask the
  // new page's frames.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tab && tabId === tab.id && info.status === "complete") connectCounts();
  });

  function renderBlockedCount() {
    const pageState = el.siteCard.dataset.state;
    if (!pageUrl || pageState !== "active") {
      if (pageState === "whitelisted") el.blockedLine.textContent = "Video and audio here can start on their own.";
      else if (pageState === "paused") el.blockedLine.textContent = "Blocking resumes here when you restart the browser.";
      return;
    }
    if (!countsReady) {
      el.blockedLine.textContent = "\u00a0";
      return;
    }
    let total = 0;
    for (const n of frameCounts.values()) total += n;
    el.blockedLine.textContent =
      total === 0
        ? "Nothing has tried to autoplay on this page yet."
        : total === 1
          ? "Stopped 1 video or audio element on this page."
          : `Stopped ${total} video or audio elements on this page.`;
  }

  // ---------------------------------------------------------------------------------------------
  // Main view actions
  // ---------------------------------------------------------------------------------------------
  el.btnTemp.addEventListener("click", async () => {
    if (!pageUrl) return;
    const host = pageUrl.hostname;
    if (SITES.findTempDisabled(state.tempDisabled, host)) {
      await saveState({ tempDisabled: state.tempDisabled.filter((d) => !SITES.hostMatches(host, d)) });
    } else {
      const domain = SITES.normalizeHost(host);
      await saveState({ tempDisabled: [...state.tempDisabled.filter((d) => d !== domain), domain] });
    }
    renderMain();
    reloadTab();
  });

  el.btnWhitelist.addEventListener("click", async () => {
    if (!pageUrl) return;
    const host = pageUrl.hostname;
    if (SITES.findWhitelistEntry(state.whitelist, host)) {
      await saveState({ whitelist: state.whitelist.filter((e) => !SITES.hostMatches(host, e.domain)) });
    } else {
      const domain = SITES.normalizeHost(host);
      await saveState({
        whitelist: [...state.whitelist, { domain, added: Date.now() }],
        tempDisabled: state.tempDisabled.filter((d) => !SITES.hostMatches(host, d)),
      });
    }
    renderMain();
    renderList();
    reloadTab();
  });

  el.btnEdit.addEventListener("click", () => showEditor(true));

  // ---------------------------------------------------------------------------------------------
  // Whitelist view
  // ---------------------------------------------------------------------------------------------
  function showEditor(show) {
    document.body.classList.toggle("editing", show);
    el.listPane.inert = !show;
    el.mainPane.inert = show;
    if (show) {
      renderList();
      el.list.scrollTop = 0;
      setTimeout(() => el.input.focus({ preventScroll: true }), 330);
    } else {
      el.input.value = "";
      hintSticky = false;
      validateInput();
      setTimeout(() => el.btnEdit.focus({ preventScroll: true }), 330);
    }
  }

  function sortedWhitelist() {
    return [...state.whitelist].sort((a, b) => (b.added || 0) - (a.added || 0) || a.domain.localeCompare(b.domain));
  }

  function renderList() {
    // The list lives in the hidden editor pane: build it only when that pane is shown (showEditor
    // renders it), so opening the popover never pays for a long whitelist.
    if (!document.body.classList.contains("editing")) return;
    const items = sortedWhitelist();
    el.listCount.textContent = items.length === 1 ? "1 site" : `${items.length} sites`;
    el.btnExport.disabled = items.length === 0;
    el.empty.hidden = items.length > 0;
    const currentHost = pageUrl ? pageUrl.hostname : null;

    const frag = document.createDocumentFragment();
    for (const item of items) {
      const li = document.createElement("li");
      li.dataset.domain = item.domain;

      const info = document.createElement("div");
      info.className = "entry-info";
      const name = document.createElement("div");
      name.className = "entry-domain";
      name.textContent = item.domain;
      name.title = item.domain;
      if (currentHost && SITES.hostMatches(currentHost, item.domain)) {
        const pill = document.createElement("span");
        pill.className = "this-site";
        pill.textContent = "This site";
        name.append(pill);
      }
      const date = document.createElement("div");
      date.className = "entry-date";
      date.textContent = item.added ? `Added ${dateFormat.format(new Date(item.added))}` : "Added on an unknown date";
      info.append(name, date);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.title = `Remove ${item.domain}`;
      remove.setAttribute("aria-label", `Remove ${item.domain} from whitelist`);
      remove.append(document.createElement("span"));
      remove.addEventListener("click", () => removeEntry(item.domain, li));

      li.append(info, remove);
      if (justAdded === item.domain) li.classList.add("added");
      frag.append(li);
    }
    justAdded = null;
    el.list.replaceChildren(frag);
  }

  async function removeEntry(domain, li) {
    li.classList.add("removing");
    await new Promise((r) => setTimeout(r, 160));
    await saveState({ whitelist: state.whitelist.filter((e) => e.domain !== domain) });
    renderList();
    renderMain();
    validateInput();
  }

  function validateInput() {
    const text = el.input.value.trim();
    if (!text) {
      if (!hintSticky) setHint("");
      el.btnAdd.disabled = true;
      return null;
    }
    hintSticky = false;
    const parsed = SITES.parseUserUrl(text);
    if (!parsed) {
      el.btnAdd.disabled = true;
      setHint(/^https?:\/\//i.test(text) ? "Enter a complete domain, like https://example.com" : "Start with http:// or https://");
      return null;
    }
    const exact = state.whitelist.find((e) => e.domain === parsed.domain);
    const covering = SITES.findWhitelistEntry(state.whitelist, parsed.domain);
    if (exact || covering) {
      el.btnAdd.disabled = true;
      setHint(exact ? `${parsed.domain} is already on the whitelist` : `Already covered by ${covering.domain}`, "warn");
      return null;
    }
    el.btnAdd.disabled = false;
    setHint(`Adds ${parsed.domain} and its subdomains`);
    return parsed;
  }

  el.input.addEventListener("input", validateInput);

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const parsed = validateInput();
    if (!parsed) return;
    justAdded = parsed.domain;
    await saveState({ whitelist: [...state.whitelist, { domain: parsed.domain, added: Date.now() }] });
    el.input.value = "";
    validateInput();
    renderList();
    renderMain();
    el.list.scrollTop = 0;
  });

  el.btnBack.addEventListener("click", () => showEditor(false));

  el.btnExport.addEventListener("click", async () => {
    el.btnExport.disabled = true;
    setHint("Exporting…");
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "export" });
    } catch (e) {
      result = { ok: false, error: String(e.message || e) };
    }
    hintSticky = true;
    if (result && result.ok) {
      setHint(`Exported ${result.count === 1 ? "1 site" : `${result.count} sites`} to your downloads folder`, "ok");
      el.hint.title = result.path;
    } else {
      setHint(`Export failed: ${(result && result.error) || "unknown error"}`, "err");
    }
    el.btnExport.disabled = state.whitelist.length === 0;
  });

  // On macOS the toolbar popover closes as soon as a file dialog opens, so (like TabBackup) the picker
  // lives in its own small window.
  el.btnImport.addEventListener("click", async () => {
    const url = chrome.runtime.getURL("import/import.html");
    const [existing] = await chrome.tabs.query({ url });
    if (existing) await chrome.windows.update(existing.windowId, { focused: true });
    else await chrome.windows.create({ url, type: "popup", width: 400, height: 240 });
    window.close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("editing")) {
      e.preventDefault();
      showEditor(false);
    }
  });

  // Keep in sync with changes made elsewhere (another window's popover, the import window, etc.).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.whitelist || changes.tempDisabled)) {
      if (changes.whitelist) state.whitelist = changes.whitelist.newValue || [];
      if (changes.tempDisabled) state.tempDisabled = changes.tempDisabled.newValue || [];
      renderMain();
      renderList();
      if (document.body.classList.contains("editing")) validateInput();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------
  (async () => {
    const [tabs] = await Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), loadState()]);
    tab = tabs && tabs[0];
    pageUrl = tab ? SITES.eligibleUrl(tab.url || tab.pendingUrl) : null;
    connectCounts();
    renderMain();
  })();
})();
