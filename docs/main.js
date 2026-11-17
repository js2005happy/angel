// Nyra website: language switch, copy buttons, flip cards, reveal, tabs,
// terminal playback and small interactive mocks. Vanilla JS, no network.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");
  var KEY = "nyra-lang";
  var X = window.NYRA_I18N || { t: {}, title: {}, ui: {} };
  X.ui = X.ui || {};
  var SUPPORTED = ["zh", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt", "ru"];
  var page = (document.body && document.body.getAttribute("data-page")) || "index";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  /* ---------- Language ---------- */
  var enEls = $$('[data-l="en"][data-k]');
  enEls.forEach(function (el) { el.setAttribute("data-o", el.innerHTML); });

  function norm(l) {
    if (!l) return null;
    l = String(l).toLowerCase();
    if (l === "zh-tw" || l === "zh-hk" || l.indexOf("zh-hant") === 0) return "zh-TW";
    if (l.indexOf("zh") === 0) return "zh";
    var base = l.split("-")[0];
    return SUPPORTED.indexOf(base) >= 0 ? base : null;
  }
  function ui(key, lang) {
    var d = X.ui[key] || {};
    return d[lang] || d.en || "";
  }
  function setLang(lang) {
    lang = norm(lang) || "zh";
    var dict = X.t[lang] || null;
    root.setAttribute("data-lang", lang === "zh" ? "zh" : "en");
    root.setAttribute("data-ui", lang);
    root.setAttribute("lang", lang === "zh" ? "zh-CN" : lang === "zh-TW" ? "zh-TW" : lang);
    enEls.forEach(function (el) {
      var k = el.getAttribute("data-k");
      el.innerHTML = dict && dict[k] ? dict[k] : el.getAttribute("data-o");
    });
    var t = (X.title[page] || {});
    if (t[lang] || t.en) document.title = t[lang] || t.en;
    var sel = document.getElementById("lang-select");
    if (sel) sel.value = lang;
    try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
  }
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  var m = /[?&#]lang=([A-Za-z-]+)/.exec(location.search + location.hash);
  setLang((m && norm(m[1])) || norm(saved) || "zh");
  var sel = document.getElementById("lang-select");
  if (sel) sel.addEventListener("change", function () { setLang(sel.value); });

  /* ---------- Nav border on scroll ---------- */
  var nav = document.querySelector(".nav");
  if (nav) {
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- Copy buttons (clipboard -> execCommand -> select text) ---------- */
  function execCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "0"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function selectText(el) {
    if (!el || !window.getSelection) return;
    var r = document.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function flash(btn, key) {
    if (btn._t) clearTimeout(btn._t); else btn._old = btn.innerHTML;
    btn.classList.add("done");
    btn.textContent = ui(key, root.getAttribute("data-ui") || "zh");
    btn._t = setTimeout(function () { btn.innerHTML = btn._old; btn.classList.remove("done"); btn._t = null; }, key === "copied" ? 1600 : 3000);
  }
  function markStep(btn) {
    var step = btn.closest(".istep");
    if (!step) return;
    step.classList.add("done");
    var block = btn.closest("[data-install-block]");
    if (block) updateProgress(block);
  }
  $$("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var row = btn.closest(".irow");
      var code = row ? row.querySelector("code") : null;
      var ok = function () { flash(btn, "copied"); markStep(btn); };
      var fail = function () {
        if (execCopy(text)) { ok(); return; }
        selectText(code); flash(btn, "selected"); markStep(btn);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(ok, fail);
      } else { fail(); }
    });
  });

  /* ---------- Install: OS tabs + progress ---------- */
  function guessOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
    if (p.indexOf("win") >= 0) return "win";
    if (p.indexOf("mac") >= 0 || p.indexOf("iphone") >= 0 || p.indexOf("ipad") >= 0) return "mac";
    if (p.indexOf("linux") >= 0 || p.indexOf("x11") >= 0 || p.indexOf("android") >= 0) return "linux";
    return "mac";
  }
  function updateProgress(block) {
    var panel = block.querySelector(".ospanel:not([hidden])") || block.querySelector(".ospanel");
    if (!panel) return;
    var all = $$(".istep", panel), done = $$(".istep.done", panel);
    var n = block.querySelector("[data-prog]"), bar = block.querySelector("[data-bar]");
    if (n) n.textContent = String(done.length);
    if (bar) bar.style.width = (all.length ? (100 * done.length / all.length) : 0) + "%";
  }
  var blocks = $$("[data-install-block]");
  function pickOS(os, focus) {
    blocks.forEach(function (block) {
      $$('[role="tab"]', block).forEach(function (t) {
        var on = t.getAttribute("data-os") === os;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        if (on && focus === block) t.focus();
      });
      $$(".ospanel", block).forEach(function (p) { p.hidden = p.getAttribute("data-os") !== os; });
      updateProgress(block);
    });
  }
  blocks.forEach(function (block) {
    var tabs = $$('[role="tab"]', block);
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { pickOS(t.getAttribute("data-os"), null); });
      t.addEventListener("keydown", function (e) {
        var n = tabs.length, j = -1;
        if (e.key === "ArrowRight") j = (i + 1) % n;
        else if (e.key === "ArrowLeft") j = (i - 1 + n) % n;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = n - 1;
        if (j >= 0) { e.preventDefault(); pickOS(tabs[j].getAttribute("data-os"), block); }
      });
    });
  });
  if (blocks.length) pickOS(guessOS(), null);

  /* ---------- Install drawer: modal, focus trap, Esc / scrim / close ---------- */
  var drawer = document.getElementById("install-drawer");
  var lastFocus = null, closeTimer = null;
  function focusables() {
    return $$('a[href],button:not([disabled]),select,textarea,input,[tabindex]:not([tabindex="-1"])', drawer)
      .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }
  function openDrawer(trigger) {
    if (!drawer) return;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    lastFocus = trigger || document.activeElement;
    drawer.hidden = false;
    root.classList.add("lock");
    void drawer.offsetWidth;
    drawer.classList.add("open");
    var x = drawer.querySelector(".xbtn");
    (x || drawer.querySelector(".sheet")).focus();
  }
  function closeDrawer() {
    if (!drawer || drawer.hidden) return;
    drawer.classList.remove("open");
    root.classList.remove("lock");
    var done = function () { drawer.hidden = true; closeTimer = null; };
    if (reduce) done(); else closeTimer = setTimeout(done, 420);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  if (drawer) {
    $$("[data-install]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); openDrawer(a); });
    });
    $$("[data-close]", drawer).forEach(function (c) { c.addEventListener("click", closeDrawer); });
    document.addEventListener("keydown", function (e) {
      if (drawer.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }
      if (e.key !== "Tab") return;
      var f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });
    if (/[?&#]install\b/.test(location.search + location.hash) && location.hash !== "#install") openDrawer(null);
  }

  /* ---------- Flip cards: hover (CSS), tap, Enter/Space ---------- */
  $$(".flip").forEach(function (card) {
    function toggle() {
      var on = !card.classList.contains("on");
      card.classList.toggle("on", on);
      card.setAttribute("aria-pressed", on ? "true" : "false");
    }
    card.addEventListener("click", function (e) {
      if (e.target.closest("a,button")) return;
      // On hover-capable pointers the hover already flips; a click pins it.
      toggle();
    });
    card.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });

  /* ---------- Scroll reveal ---------- */
  var rv = $$(".rv");
  if (!reduce && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    rv.forEach(function (el) { io.observe(el); });
  } else {
    rv.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- Tabs ---------- */
  $$("[data-tabs]").forEach(function (box) {
    var tabs = $$('[role="tab"]', box);
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute("aria-controls")); });
    function select(i, focus) {
      tabs.forEach(function (t, j) {
        var on = i === j;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        if (panels[j]) {
          panels[j].hidden = !on;
          panels[j].classList.remove("enter");
          if (on && !reduce) { void panels[j].offsetWidth; panels[j].classList.add("enter"); }
        }
      });
      if (focus) { tabs[i].focus(); tabs[i].scrollIntoView({ block: "nearest", inline: "nearest" }); }
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(i, false); });
      t.addEventListener("keydown", function (e) {
        var n = tabs.length, k = e.key;
        if (k === "ArrowRight" || k === "ArrowDown") { e.preventDefault(); select((i + 1) % n, true); }
        else if (k === "ArrowLeft" || k === "ArrowUp") { e.preventDefault(); select((i - 1 + n) % n, true); }
        else if (k === "Home") { e.preventDefault(); select(0, true); }
        else if (k === "End") { e.preventDefault(); select(n - 1, true); }
      });
    });
    select(0, false);
    panels.forEach(function (p) { if (p) p.classList.remove("enter"); });
  });

  /* ---------- Terminal playback ---------- */
  $$(".term[data-play]").forEach(function (term) {
    var lines = $$(".tl", term);
    var replay = document.querySelector('[data-replay="' + term.id + '"]');
    var timers = [];
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function showAll() { clear(); term.classList.remove("armed"); lines.forEach(function (l) { l.classList.add("show"); l.classList.remove("typing"); }); }
    function play() {
      clear();
      term.classList.add("armed");
      lines.forEach(function (l) { l.classList.remove("show", "typing"); });
      var t = 300;
      lines.forEach(function (l) {
        var typed = l.classList.contains("c");
        timers.push(setTimeout(function () {
          l.classList.add("show");
          if (typed) {
            var txt = (l.querySelector(".t") || l).textContent.length;
            l.style.setProperty("--n", Math.max(1, txt));
            l.style.setProperty("--dur", Math.min(1.6, 0.035 * txt) + "s");
            l.classList.add("typing");
          }
        }, t));
        t += typed ? Math.min(1600, 35 * (l.textContent.length)) + 450 : 260;
      });
    }
    if (reduce || !("IntersectionObserver" in window)) { showAll(); if (replay) replay.hidden = true; return; }
    term.classList.add("armed");
    var seen = false;
    var io2 = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting && !seen) { seen = true; play(); io2.disconnect(); } });
    }, { threshold: 0.35 });
    io2.observe(term);
    if (replay) replay.addEventListener("click", function () { play(); });
  });

  /* ---------- Hero approval mock ---------- */
  var hm = document.querySelector(".hero-mock");
  if (hm) {
    var state = hm.querySelector(".state");
    function setState(s) {
      hm.setAttribute("data-state", s);
      if (state) state.classList.toggle("done", s !== "wait");
      $$("[data-st]", hm).forEach(function (el) { el.hidden = el.getAttribute("data-st") !== s; });
    }
    $$("[data-act]", hm).forEach(function (b) {
      b.addEventListener("click", function () { setState(b.getAttribute("data-act")); });
    });
    $$(".replay", hm).forEach(function (b) { b.addEventListener("click", function () { setState("wait"); }); });
    setState("wait");
  }

  /* ---------- Mode switch ---------- */
  $$("[data-modes]").forEach(function (box) {
    var btns = $$("button[data-mode]", box);
    function pick(m) {
      btns.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-mode") === m ? "true" : "false"); });
      $$("[data-m]", box).forEach(function (d) { d.classList.toggle("on", d.getAttribute("data-m") === m); });
    }
    btns.forEach(function (b) { b.addEventListener("click", function () { pick(b.getAttribute("data-mode")); }); });
    pick("auto");
  });

  /* ---------- Checkpoints ---------- */
  $$("[data-cps]").forEach(function (box) {
    var btn = box.querySelector("[data-undo]");
    var items = $$("li", box);
    var n = 0;
    var msg = box.querySelector("[data-cpmsg]");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (n < items.length - 1) { items[n].classList.add("undone"); n++; }
      else { items.forEach(function (i) { i.classList.remove("undone"); }); n = 0; }
      if (msg) msg.textContent = n ? "−" + n : "";
    });
  });

  /* ---------- Plan hash ---------- */
  $$("[data-plan]").forEach(function (box) {
    var btn = box.querySelector("[data-edit]");
    var h = box.querySelector("[data-hash]");
    var A = h ? h.textContent : "", B = "4be07d1c29aa5f63e81d0c7b95f2e4a0";
    if (!btn || !h) return;
    btn.addEventListener("click", function () {
      var ed = box.getAttribute("data-edited") === "1";
      box.setAttribute("data-edited", ed ? "0" : "1");
      h.textContent = ed ? A : B;
      btn.setAttribute("aria-pressed", ed ? "false" : "true");
    });
  });

  /* ---------- Switches ---------- */
  $$(".sw").forEach(function (sw) {
    sw.addEventListener("click", function () {
      var on = sw.getAttribute("aria-pressed") !== "true";
      sw.setAttribute("aria-pressed", on ? "true" : "false");
      var li = sw.closest("li");
      if (li) li.classList.toggle("off", !on);
    });
  });
})();
