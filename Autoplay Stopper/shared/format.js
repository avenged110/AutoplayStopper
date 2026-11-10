/*
 * Autoplay Stopper — whitelist export file format.
 * Shared by the exporter (background.js) and the importer (import/import.js). Requires shared/sites.js.
 *
 *   APSWL1-7c2e94b0d815a3f6
 *
 *   Autoplay Stopper Whitelist
 *   Exported 2026-11-08 at 14.03.11
 *   ––––––––––––––––––––––––––––––––––––––––
 *   apple.com    added 2026-11-08 at 14.03.11
 *   chewy.com    added 2026-10-02 at 09.15.00
 */
(function (root) {
  "use strict";

  const SITES = root.APS_SITES;
  const SIGNATURE = "APSWL1-7c2e94b0d815a3f6";
  const TITLE = "Autoplay Stopper Whitelist";
  const RULE = "–".repeat(40);
  const MAX_ENTRIES = 10000;

  const pad = (n) => String(n).padStart(2, "0");

  /** Local date/time as "2026-11-08 at 14.03.11" (same style as TabBackup's filenames). */
  function stamp(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  }

  function buildText(whitelist, now = new Date()) {
    const entries = [...whitelist].sort((a, b) => (b.added || 0) - (a.added || 0) || a.domain.localeCompare(b.domain));
    const width = Math.max(0, ...entries.map((e) => e.domain.length));
    const lines = entries.map((e) =>
      e.added ? `${e.domain.padEnd(width)}    added ${stamp(new Date(e.added))}` : e.domain
    );
    return [SIGNATURE, "", TITLE, `Exported ${stamp(now)}`, RULE, ...lines].join("\n") + "\n";
  }

  const ENTRY = /^(\S+)(?:\s+added\s+(\d{4})-(\d{2})-(\d{2})\s+at\s+(\d{2})\.(\d{2})\.(\d{2}))?$/i;

  /**
   * Parse an export file. Returns [{ domain, added }]. Throws an Error with a user-facing message
   * if the file isn't a well-formed Autoplay Stopper whitelist.
   */
  function parseText(text, now = Date.now()) {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
    if (lines[0].trim() !== SIGNATURE) throw new Error("This isn't an Autoplay Stopper whitelist file.");
    const ruleAt = lines.findIndex((l, i) => i > 0 && /^[–-]{10,}$/.test(l.trim()));
    if (ruleAt < 0 || !lines.slice(1, ruleAt).some((l) => l.trim() === TITLE)) {
      throw new Error("This whitelist file is incomplete or has been altered.");
    }
    const out = [];
    const seen = new Set();
    for (let i = ruleAt + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const m = ENTRY.exec(line);
      const domain = m && SITES.normalizeHost(m[1]);
      if (!m || !SITES.isValidHost(domain)) {
        const shown = line.length > 40 ? line.slice(0, 40) + "…" : line;
        throw new Error(`Line ${i + 1} isn't a valid site: “${shown}”`);
      }
      let added = now;
      if (m[2]) {
        const d = new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]);
        if (isNaN(d.getTime()) || d.getMonth() !== +m[3] - 1 || d.getDate() !== +m[4]) {
          throw new Error(`Line ${i + 1} has an invalid date.`);
        }
        added = d.getTime();
      }
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({ domain, added });
      if (out.length > MAX_ENTRIES) throw new Error("This file has too many entries to be a whitelist.");
    }
    return out;
  }

  root.APS_FORMAT = { SIGNATURE, buildText, parseText, stamp };
})(typeof globalThis !== "undefined" ? globalThis : self);
