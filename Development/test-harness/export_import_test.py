"""Export / Import end-to-end tests. Usage: export_import_test.py <ext> <test-site>  (SHOTS=<dir> for screenshots)"""
import base64
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402

OUT = os.environ.get("SHOTS")
results = []


def check(name, cond, detail=""):
    results.append(bool(cond))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"), flush=True)


servers = rt.start_servers()
proc, profile = rt.launch()
try:
    s = rt.Session(rt.PORT)
    sw_t = rt.ext_sw(s)
    ext_id = sw_t["url"].split("/")[2]
    sw = s.attach(sw_t["targetId"])
    time.sleep(1.0)  # let the one-time legacy import finish before we set our own list
    original = [
        {"domain": "apple.com", "added": 1730000000000},
        {"domain": "news.example.org", "added": 1759400000000},
        {"domain": "10.0.2.12", "added": 1760000000000},
        {"domain": "localhost", "added": 1761000000000},
    ]
    s.evaluate(sw, f"chrome.storage.local.set({{whitelist: {json.dumps(original)}}})")

    def open_page(path, w=340, h=392, stub=None):
        tid = s.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sid = s.attach(tid)
        s.call("Page.enable", session=sid)
        s.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 2, "mobile": False}, session=sid)
        if stub:
            s.call("Page.addScriptToEvaluateOnNewDocument", {"source": stub}, session=sid)
        s.call("Page.navigate", {"url": f"chrome-extension://{ext_id}/{path}"}, session=sid)
        time.sleep(1.0)
        return tid, sid

    def click(sid, sel):
        r = s.evaluate(sid, f"(() => {{ const r = document.querySelector({json.dumps(sel)}).getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; }})()")
        for t in ("mouseMoved", "mousePressed", "mouseReleased"):
            s.call("Input.dispatchMouseEvent", {"type": t, "x": r[0], "y": r[1], "button": "none" if t == "mouseMoved" else "left", "clickCount": 1}, session=sid)

    # ---------- popover layout ----------
    tid, sid = open_page("popup/popup.html")
    labels = s.evaluate(sid, "[...document.querySelectorAll('.action-row .action-label')].map(e => e.textContent)")
    check("main view: Import left of Edit whitelist", labels == ["Import", "Edit whitelist"], labels)
    s.evaluate(sid, "document.getElementById('btn-edit').click()")
    time.sleep(0.5)
    gaps = s.evaluate(sid, """(() => { const l = document.getElementById('list-wrap').getBoundingClientRect(),
        i = document.getElementById('url-input').getBoundingClientRect(), b = document.getElementById('btn-back').getBoundingClientRect();
        return [i.top - l.bottom, b.top - i.bottom]; })()""")
    check("list->field gap equals field->buttons gap", abs(gaps[0] - gaps[1]) < 0.5, gaps)
    order = s.evaluate(sid, "[...document.querySelectorAll('.entry-buttons .btn')].map(b => [b.textContent, Math.round(b.getBoundingClientRect().left)])")
    check("buttons are Back | Export | Add", [o[0] for o in order] == ["Back", "Export", "Add"] and order[0][1] < order[1][1] < order[2][1], order)
    if OUT:
        with open(f"{OUT}/popup-11-editor-export.png", "wb") as f:
            f.write(base64.b64decode(s.call("Page.captureScreenshot", {"format": "png"}, session=sid)["data"]))

    # ---------- export ----------
    click(sid, "#btn-export")
    time.sleep(1.5)
    hint = s.evaluate(sid, "document.getElementById('hint').textContent")
    files = glob.glob(os.path.join(rt.launch.downloads, "Autoplay Stopper Whitelist *.txt"))
    check("export reports success", hint == "Exported 4 sites to your downloads folder", hint)
    check("file saved to the default download folder", len(files) == 1, files)
    text = open(files[0], encoding="utf-8").read() if files else ""
    print("----- exported file -----\n" + text + "-------------------------")
    check("file starts with signature", text.startswith("APSWL1-7c2e94b0d815a3f6\n"))
    if OUT:
        with open(f"{OUT}/popup-12-exported.png", "wb") as f:
            f.write(base64.b64decode(s.call("Page.captureScreenshot", {"format": "png"}, session=sid)["data"]))
    # export disabled on empty list
    s.evaluate(sw, "chrome.storage.local.set({whitelist: []})")
    time.sleep(0.4)
    check("Export disabled when whitelist is empty", s.evaluate(sid, "document.getElementById('btn-export').disabled") is True)
    s.evaluate(sw, f"chrome.storage.local.set({{whitelist: {json.dumps(original)}}})")
    time.sleep(0.3)

    # ---------- Import button opens the import window ----------
    click(sid, "#btn-back")
    time.sleep(0.5)
    click(sid, "#btn-import")
    time.sleep(1.0)
    wins = [t for t in s.targets() if t["url"].endswith("/import/import.html")]
    check("Import opens the import window", len(wins) == 1, [t["url"] for t in s.targets()])

    # ---------- import validation (picker stubbed with a chosen file) ----------
    def run_import(name, content, mime="text/plain", raw=None):
        payload = json.dumps({"name": name, "content": content, "mime": mime, "raw": raw})
        stub = f"""window.__pickerArgs = null; window.showOpenFilePicker = async (opts) => {{
            window.__pickerArgs = opts; const p = {payload};
            const data = p.raw ? new Uint8Array(p.raw) : p.content;
            return [{{ getFile: async () => new File([data], p.name, {{ type: p.mime }}) }}]; }};"""
        tid2, sid2 = open_page("import/import.html", 400, 240, stub)
        click(sid2, "#choose")
        time.sleep(0.8)
        msg = s.evaluate(sid2, "document.getElementById('msg').textContent")
        args = s.evaluate(sid2, "window.__pickerArgs")
        try:
            s.call("Target.closeTarget", {"targetId": tid2})
        except Exception:
            pass
        return msg, args

    s.evaluate(sw, "chrome.storage.local.set({whitelist: [{domain: 'will-be-replaced.com', added: 1}]})")
    msg, args = run_import(os.path.basename(files[0]), text)
    check("picker starts on Desktop, .txt only", args and args.get("startIn") == "desktop" and args.get("excludeAcceptAllOption") is True
          and args["types"][0]["accept"] == {"text/plain": [".txt"]}, args)
    wl = s.evaluate(sw, "chrome.storage.local.get('whitelist').then(r => r.whitelist)")
    check("round trip restores every domain and date", sorted((e["domain"], e["added"] // 1000) for e in wl) == sorted((e["domain"], e["added"] // 1000) for e in original), wl)
    check("import overwrites existing entries", not any(e["domain"] == "will-be-replaced.com" for e in wl))
    check("success message", msg.startswith("Restored 4 sites from"), msg)

    before = s.evaluate(sw, "chrome.storage.local.get('whitelist').then(r => r.whitelist.length)")
    bad = [
        ("wrong extension", "list.csv", text, "text/plain", None, "Please choose a .txt file."),
        ("not text", "list.txt", text, "application/octet-stream", None, "That isn't a plain text file."),
        ("empty", "list.txt", "", "text/plain", None, "That file is empty."),
        ("invalid UTF-8", "list.txt", None, "text/plain", [0x41, 0xFF, 0xFE, 0x0A], "That file isn't readable plain text."),
        ("no signature", "list.txt", "apple.com\n", "text/plain", None, "This isn't an Autoplay Stopper whitelist file."),
        ("TabBackup file", "Tab URLs.txt", "TUE1-5f3c9a7e2b81d046\n\nWindow 1\n" + "–" * 40 + "\nhttps://a.com\n", "text/plain", None, "This isn't an Autoplay Stopper whitelist file."),
        ("tampered header", "list.txt", "APSWL1-7c2e94b0d815a3f6\n\napple.com\n", "text/plain", None, "This whitelist file is incomplete or has been altered."),
        ("bad entry line", "list.txt", text + "not a domain!!\n", "text/plain", None, "isn't a valid site"),
        ("bad date", "list.txt", text.replace("added 20", "added 1999-13-40 at 99.99.99 x", 1), "text/plain", None, "isn't a valid site"),
        ("too large", "list.txt", "x" * (1024 * 1024 + 5), "text/plain", None, "That file is too large to be a whitelist."),
    ]
    for label, name, content, mime, raw, expect in bad:
        msg, _ = run_import(name, content or "", mime, raw)
        check(f"rejects {label}", expect in msg, msg)
    after = s.evaluate(sw, "chrome.storage.local.get('whitelist').then(r => r.whitelist.length)")
    check("rejected files leave the whitelist untouched", before == after == 4, (before, after))

    print(f"\n{sum(results)}/{len(results)} passed")
finally:
    proc.terminate()
    for p in servers:
        p.terminate()
