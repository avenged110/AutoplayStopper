/*
 * Autoplay Stopper — shared site helpers.
 * Loaded by the service worker (importScripts), the popup, and the isolated content script.
 *
 * Storage (chrome.storage.local):
 *   whitelist:    [{ domain: "example.com", added: <epoch ms> }, ...]
 *   tempDisabled: ["example.com", ...]   (cleared every time the browser starts)
 */
(function (root) {
  "use strict";

  const SITES = {};

  const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  /** Lowercase, drop a trailing dot and a single leading "www." */
  SITES.normalizeHost = function normalizeHost(host) {
    let h = String(host || "").trim().toLowerCase().replace(/\.+$/, "");
    if (h.startsWith("www.")) h = h.slice(4);
    return h;
  };

  /** True when `host` is `domain` or one of its subdomains. IP addresses only match exactly. */
  SITES.hostMatches = function hostMatches(host, domain) {
    const h = SITES.normalizeHost(host);
    const d = SITES.normalizeHost(domain);
    if (!h || !d) return false;
    if (h === d) return true;
    return h.endsWith("." + d) && !IPV4.test(h);
  };

  /** The most specific whitelist entry that covers `host`, or null. */
  SITES.findWhitelistEntry = function findWhitelistEntry(whitelist, host) {
    let best = null;
    for (const entry of whitelist || []) {
      if (entry && SITES.hostMatches(host, entry.domain)) {
        if (!best || entry.domain.length > best.domain.length) best = entry;
      }
    }
    return best;
  };

  SITES.findTempDisabled = function findTempDisabled(tempDisabled, host) {
    let best = null;
    for (const domain of tempDisabled || []) {
      if (SITES.hostMatches(host, domain)) {
        if (!best || domain.length > best.length) best = domain;
      }
    }
    return best;
  };

  /** Whether blocking should be active for a page whose top-level host is `host`. */
  SITES.isBlockingActive = function isBlockingActive(state, host) {
    if (!host) return true;
    if (SITES.findWhitelistEntry(state && state.whitelist, host)) return false;
    if (SITES.findTempDisabled(state && state.tempDisabled, host)) return false;
    return true;
  };

  const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

  /** True for a syntactically valid domain name with at least two labels and a real-looking TLD. */
  SITES.isValidDomain = function isValidDomain(host) {
    const h = String(host || "").toLowerCase().replace(/\.$/, "");
    if (!h || h.length > 253) return false;
    const labels = h.split(".");
    if (labels.length < 2) return false;
    if (!labels.every((l) => LABEL.test(l))) return false;
    return TLD.test(labels[labels.length - 1]);
  };

  /**
   * Anything the whitelist can legitimately hold: a domain name, a single-label host (e.g. "localhost",
   * added from the main view), an IPv4 address, or a bracketed IPv6 address. Used when importing files.
   */
  SITES.isValidHost = function isValidHost(host) {
    const h = String(host || "").toLowerCase();
    if (!h || h.length > 253) return false;
    if (IPV4.test(h)) return true;
    if (/^\[[0-9a-f:.]+\]$/.test(h)) {
      try {
        return new URL(`http://${h}/`).hostname === h;
      } catch (e) {
        return false;
      }
    }
    return h.split(".").every((l) => LABEL.test(l));
  };

  /**
   * Parse what the user typed in the whitelist editor.
   * Must start with http:// or https:// and contain a valid domain name.
   * Returns { domain } or null.
   */
  SITES.parseUserUrl = function parseUserUrl(text) {
    const t = String(text || "").trim();
    if (!/^https?:\/\/[^\s/?#]/i.test(t) || /\s/.test(t)) return null;
    let url;
    try {
      url = new URL(t);
    } catch (e) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!SITES.isValidDomain(url.hostname)) return null;
    const domain = SITES.normalizeHost(url.hostname);
    if (!SITES.isValidDomain(domain)) return null;
    return { domain };
  };

  /** Pages where Chromium never lets extensions run content scripts. */
  const RESTRICTED = [
    (u) => u.hostname === "chromewebstore.google.com",
    (u) => u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"),
  ];

  /** Returns the URL object if Autoplay Stopper can operate on this tab URL, else null. */
  SITES.eligibleUrl = function eligibleUrl(rawUrl) {
    if (!rawUrl) return null;
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    if (RESTRICTED.some((test) => test(u))) return null;
    return u;
  };

  root.APS_SITES = SITES;
})(typeof globalThis !== "undefined" ? globalThis : self);
