"""Drive the popover UI (opened in a tab, with chrome.tabs.query pointed at a real site tab)."""
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_tests as rt  # noqa: E402

OUT = os.environ["SHOTS"]
results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"), flush=True)


def shot(s, sid, name):
    data = s.call("Page.captureScreenshot", {"format": "png"}, session=sid)["data"]
    with open(f"{OUT}/popup-{name}.png", "wb") as f:
        f.write(base64.b64decode(data))


servers = rt.start_servers()
proc, profile = rt.launch()
try:
    s = rt.Session(rt.PORT)
    sw_t = rt.ext_sw(s)
    ext_id = sw_t["url"].split("/")[2]
    sw = s.attach(sw_t["targetId"])
    s.evaluate(sw, "chrome.storage.local.set({whitelist: [{domain: 'news.example.org', added: Date.parse('2026-10-02T12:00:00')}, {domain: 'videos.example.net', added: Date.parse('2026-09-14T12:00:00')}], tempDisabled: []})")

    site = rt.Page(s, rt.A + "/t-shadow.html")
    time.sleep(2)
    tab_id = s.evaluate(sw, "chrome.tabs.query({}).then(ts => ts.find(t => (t.url||'').includes('t-shadow')).id)")

    def open_popup(target_tab, scheme="light"):
        tid = s.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sid = s.attach(tid)
        s.call("Page.enable", session=sid)
        s.call("Emulation.setDeviceMetricsOverride", {"width": 340, "height": 392, "deviceScaleFactor": 2, "mobile": False}, session=sid)
        s.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": scheme}]}, session=sid)
        stub = f"""if (globalThis.chrome && chrome.tabs) {{ const T = {json.dumps(target_tab)};
            chrome.tabs.query = async () => [typeof T === 'number' ? await chrome.tabs.get(T) : T]; }}"""
        s.call("Page.addScriptToEvaluateOnNewDocument", {"source": stub}, session=sid)
        s.call("Page.navigate", {"url": f"chrome-extension://{ext_id}/popup/popup.html"}, session=sid)
        time.sleep(1.0)
        return tid, sid

    def ev(sid, expr):
        return s.evaluate(sid, expr)

    def click_sel(sid, sel):
        r = ev(sid, f"(() => {{ const r = document.querySelector({json.dumps(sel)}).getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; }})()")
        for t in ("mouseMoved", "mousePressed", "mouseReleased"):
            s.call("Input.dispatchMouseEvent", {"type": t, "x": r[0], "y": r[1], "button": "none" if t == "mouseMoved" else "left", "clickCount": 1}, session=sid)

    def text(sid, sel):
        return ev(sid, f"document.querySelector({json.dumps(sel)}).textContent.trim()")

    def disabled(sid, sel):
        return ev(sid, f"document.querySelector({json.dumps(sel)}).disabled")

    # ---------------- main view, active site ----------------
    tid, sid = open_popup(tab_id)
    check("site name shown", text(sid, "#site-name") == "site-a.test", text(sid, "#site-name"))
    check("status: blocking", text(sid, "#status-text") == "Blocking autoplay", text(sid, "#status-text"))
    check("blocked count line", "Stopped 2" in text(sid, "#blocked-line"), text(sid, "#blocked-line"))
    check("temp button enabled", disabled(sid, "#btn-temp") is False)
    check("whitelist button enabled", disabled(sid, "#btn-whitelist") is False)
    check("edit subtitle counts sites", text(sid, "#btn-edit-sub") == "2 sites", text(sid, "#btn-edit-sub"))
    shot(s, sid, "1-main-light")

    # temp disable
    click_sel(sid, "#btn-temp")
    time.sleep(1.5)
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    check("temp disable stored", st["tempDisabled"] == ["site-a.test"], st)
    check("temp button now says resume", text(sid, "#btn-temp-label") == "Resume blocking on this site", text(sid, "#btn-temp-label"))
    site_state = site.eval("window.check()")
    check("tab reloaded and now allows autoplay", site_state["v1"]["paused"] is False, site_state)
    shot(s, sid, "2-main-temp")
    click_sel(sid, "#btn-temp")
    time.sleep(1.5)
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    check("resume clears temp", st["tempDisabled"] == [], st)

    # whitelist this site
    click_sel(sid, "#btn-whitelist")
    time.sleep(1.5)
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    check("whitelist add stored", any(e["domain"] == "site-a.test" for e in st["whitelist"]), st)
    check("status: whitelisted", text(sid, "#status-text").startswith("Whitelisted"), text(sid, "#status-text"))
    check("temp button disabled when whitelisted", disabled(sid, "#btn-temp") is True)
    check("whitelist button says remove", text(sid, "#btn-whitelist-label") == "Remove this site from whitelist")
    site_state = site.eval("window.check()")
    check("whitelisted tab plays", site_state["v1"]["paused"] is False, site_state)
    shot(s, sid, "3-main-whitelisted")

    # ---------------- editor ----------------
    click_sel(sid, "#btn-edit")
    time.sleep(0.12)
    shot(s, sid, "4-sliding")
    time.sleep(0.5)
    check("editor visible (slid left)", ev(sid, "document.body.classList.contains('editing') && document.getElementById('track').getBoundingClientRect().left") == -340)
    items = ev(sid, "[...document.querySelectorAll('#list li')].map(li => [li.querySelector('.entry-domain').firstChild.textContent, li.querySelector('.entry-date').textContent])")
    check("list newest first with dates", items[0][0] == "site-a.test" and items[1] == ["news.example.org", "Added Oct 2, 2026"] and items[2] == ["videos.example.net", "Added Sep 14, 2026"], items)
    check("Add disabled when empty", disabled(sid, "#btn-add") is True)
    shot(s, sid, "5-editor")

    def type_text(t):
        ev(sid, "(() => { const i = document.getElementById('url-input'); i.focus(); i.select(); })()")
        s.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8}, session=sid)
        s.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8}, session=sid)
        if t:
            s.call("Input.insertText", {"text": t}, session=sid)
        time.sleep(0.1)

    cases = [
        ("example.com", True), ("http://example", True), ("https://exa mple.com", True), ("ftp://example.com", True),
        ("https://", True), ("https://-bad-.com", True), ("https://192.168.1.1", True), ("https://example.c", True),
        ("https://example.com", False), ("http://Sub.Example.co.uk/path?q=1", False), ("https://www.wikipedia.org", False),
        ("https://xn--mnchen-3ya.de", False), ("https://news.example.org", True), ("https://a.news.example.org", True),
    ]
    for value, expect_disabled in cases:
        type_text(value)
        d = disabled(sid, "#btn-add")
        check(f"Add {'disabled' if expect_disabled else 'enabled'} for {value!r}", d is expect_disabled, f"got disabled={d}, hint={text(sid, '#hint')!r}")

    type_text("https://www.Example.com/some/page")
    shot(s, sid, "6-editor-valid")
    s.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r"}, session=sid)
    s.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13}, session=sid)
    time.sleep(0.5)
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    check("Enter adds normalized domain", any(e["domain"] == "example.com" for e in st["whitelist"]), st["whitelist"])
    check("field cleared after add", ev(sid, "document.getElementById('url-input').value") == "")
    check("new entry at top", ev(sid, "document.querySelector('#list li').dataset.domain") == "example.com")

    # scrolling list with many entries
    s.evaluate(sw, "chrome.storage.local.get('whitelist').then(({whitelist}) => chrome.storage.local.set({whitelist: whitelist.concat(Array.from({length: 12}, (_, i) => ({domain: 'site' + i + '.example.com', added: Date.parse('2026-08-01') - i * 864e5})))}))")
    time.sleep(0.5)
    sh = ev(sid, "(() => { const l = document.getElementById('list'); return [l.scrollHeight, l.clientHeight]; })()")
    check("list scrolls when long", sh[0] > sh[1], sh)
    shot(s, sid, "7-editor-long")

    # remove via red minus
    click_sel(sid, "#list li[data-domain='news.example.org'] .remove")
    time.sleep(0.6)
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    check("minus removes entry", not any(e["domain"] == "news.example.org" for e in st["whitelist"]), st["whitelist"])

    # Back clears uncommitted text and slides right
    type_text("https://not-committed.com")
    click_sel(sid, "#btn-back")
    time.sleep(0.5)
    check("Back slides to main", ev(sid, "!document.body.classList.contains('editing') && document.getElementById('track').getBoundingClientRect().left") == 0)
    check("Back cleared field", ev(sid, "document.getElementById('url-input').value") == "")
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    check("uncommitted text not saved", not any(e["domain"] == "not-committed.com" for e in st["whitelist"]))

    # remove this site from whitelist via main button
    click_sel(sid, "#btn-whitelist")
    time.sleep(1.5)
    st = s.evaluate(sw, "chrome.storage.local.get(null)")
    check("main remove works", not any(e["domain"] == "site-a.test" for e in st["whitelist"]), st["whitelist"])
    site_state = site.eval("window.check()")
    check("tab blocks again after removal", site_state["v1"]["paused"] is True, site_state)
    s.call("Target.closeTarget", {"targetId": tid})

    # dark mode screenshots
    s.evaluate(sw, "chrome.storage.local.set({whitelist: [{domain: 'news.example.org', added: Date.parse('2026-10-02T12:00:00')}, {domain: 'videos.example.net', added: Date.parse('2026-09-14T12:00:00')}], tempDisabled: []})")
    time.sleep(1.5)
    tid, sid = open_popup(tab_id, "dark")
    shot(s, sid, "8-main-dark")
    click_sel(sid, "#btn-edit")
    time.sleep(0.5)
    type_text("https://example.com")
    shot(s, sid, "9-editor-dark")
    s.call("Target.closeTarget", {"targetId": tid})

    # ineligible page
    tid, sid = open_popup({"id": 999999, "url": "chrome://settings/"})
    check("ineligible: temp disabled", disabled(sid, "#btn-temp") is True)
    check("ineligible: whitelist disabled", disabled(sid, "#btn-whitelist") is True)
    check("ineligible: edit enabled", disabled(sid, "#btn-edit") is False)
    shot(s, sid, "10-ineligible")
    s.call("Target.closeTarget", {"targetId": tid})
    tid, sid = open_popup({"id": 999998, "url": "https://chromewebstore.google.com/detail/x"})
    check("web store: whitelist disabled", disabled(sid, "#btn-whitelist") is True)
    s.call("Target.closeTarget", {"targetId": tid})

    # toolbar icon/title state per tab
    title = s.evaluate(sw, f"chrome.action.getTitle({{tabId: {tab_id}}})")
    check("toolbar tooltip reflects state", "blocking autoplay on site-a.test" in title, title)

    print(f"\n{sum(results)}/{len(results)} passed")
finally:
    proc.terminate()
    for p in servers:
        p.terminate()
