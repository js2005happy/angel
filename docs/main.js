// Nyra website: language switch, copy buttons, install + download tabs, terminal language toggle,
// localized screenshots and scroll reveal. Vanilla JS, no network, no cookies.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");
  var KEY = "nyra-lang";
  var X = window.NYRA_I18N || { t: {}, title: {}, ui: {} };
  X.ui = X.ui || {};
  var SUPPORTED = ["zh", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt", "ru"];
  var page = (document.body && document.body.getAttribute("data-page")) || "index";
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var reduce = !!(mq && mq.matches);
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
  function ui(key, lang) { var d = X.ui[key] || {}; return d[lang] || d.en || ""; }
  var tuiChosen = null;
  function setTui(l) {
    $$(".tui-demo").forEach(function (im) { im.src = "assets/site/tui-" + l + ".webp"; im.alt = l === "zh" ? "Nyra 终端会话（中文界面）" : "Nyra terminal session (English)"; });
    $$("[data-tui]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-tui") === l ? "true" : "false"); });
  }
  function setLang(lang) {
    lang = norm(lang) || "zh";
    var dict = X.t[lang] || null;
    root.setAttribute("data-lang", lang === "zh" ? "zh" : "en");
    root.setAttribute("data-ui", lang);
    root.setAttribute("lang", lang === "zh" ? "zh-CN" : lang);
    enEls.forEach(function (el) {
      var k = el.getAttribute("data-k");
      el.innerHTML = dict && dict[k] ? dict[k] : el.getAttribute("data-o");
    });
    var t = X.title[page] || {};
    if (t[lang] || t.en) document.title = t[lang] || t.en;
    var s = document.getElementById("lang-select");
    if (s) s.value = lang;
    // Screenshots: Chinese UI shots for Simplified Chinese, English for everything else.
    $$("img[data-zh]").forEach(function (im) {
      var want = im.getAttribute(lang === "zh" ? "data-zh" : "data-en");
      if (want && im.getAttribute("src") !== want) im.setAttribute("src", want);
    });
    if (!tuiChosen) setTui(lang === "zh" ? "zh" : "en");
    try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
  }
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  var m = /[?&#]lang=([A-Za-z-]+)/.exec(location.search + location.hash);
  setLang((m && norm(m[1])) || norm(saved) || "zh");
  var sel = document.getElementById("lang-select");
  if (sel) sel.addEventListener("change", function () { setLang(sel.value); });
  $$("[data-tui]").forEach(function (b) {
    b.addEventListener("click", function () { tuiChosen = b.getAttribute("data-tui"); setTui(tuiChosen); });
  });

  /* ---------- Nav state on scroll ---------- */
  var nav = document.querySelector(".nav");
  if (nav) {
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- Copy (clipboard -> execCommand -> select) ---------- */
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
    var lbl = btn.querySelector(".ct") || btn;
    if (btn._t) clearTimeout(btn._t); else btn._old = lbl.innerHTML;
    btn.classList.add("done");
    lbl.textContent = ui(key, root.getAttribute("data-ui") || "zh");
    btn._t = setTimeout(function () { lbl.innerHTML = btn._old; btn.classList.remove("done"); btn._t = null; }, key === "copied" ? 1600 : 3000);
  }
  $$("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var code = btn.parentNode ? btn.parentNode.querySelector("code") : null;
      var ok = function () { flash(btn, "copied"); };
      var fail = function () { if (execCopy(text)) { ok(); return; } selectText(code); flash(btn, "selected"); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fail);
      else fail();
    });
  });

  /* ---------- Platform tabs (hero + drawer) ---------- */
  function guessOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
    var ua = (navigator.userAgent || "").toLowerCase();
    if (/iphone|ipad|android/.test(ua)) return "phone";
    if (p.indexOf("win") >= 0) return "win";
    if (p.indexOf("linux") >= 0 || p.indexOf("x11") >= 0) return "linux";
    return "mac";
  }
  function pick(group, os, focus) {
    var tabs = $$('[role="tab"]', group);
    if (!tabs.some(function (t) { return t.getAttribute("data-os") === os; })) os = tabs[0].getAttribute("data-os");
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-os") === os;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
      var p = document.getElementById(t.getAttribute("aria-controls"));
      if (p) p.hidden = !on;
    });
  }
  var groups = $$('[data-tabs]');
  groups.forEach(function (g) {
    var tabs = $$('[role="tab"]', g);
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { pick(g, t.getAttribute("data-os")); });
      t.addEventListener("keydown", function (e) {
        var n = null;
        if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") n = tabs[0];
        else if (e.key === "End") n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); pick(g, n.getAttribute("data-os"), true); }
      });
    });
  });
  var os0 = guessOS();
  groups.forEach(function (g) { pick(g, g.getAttribute("data-tabs") === "hero" && os0 === "phone" ? "mac" : os0); });

  /* ---------- Download section: links pick the platform, then scroll ---------- */
  var dlGroup = document.querySelector('[data-tabs="dl"]');
  var dlSec = document.getElementById("download");
  function goDownload(os) {
    if (!dlSec) return;
    if (dlGroup && os) pick(dlGroup, os);
    dlSec.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    if (history.replaceState) history.replaceState(null, "", "#download");
  }
  $$("[data-dl]").forEach(function (a) {
    a.addEventListener("click", function (e) { if (!dlSec) return; e.preventDefault(); goDownload(a.getAttribute("data-dl")); });
  });
  // Old links (#install, #platforms) land on the download section.
  if (dlSec && /^#(install|platforms)\b/.test(location.hash)) {
    if (history.replaceState) history.replaceState(null, "", "#download");
    var jump = function () { root.style.scrollBehavior = "auto"; dlSec.scrollIntoView({ block: "start" }); root.style.scrollBehavior = ""; };
    if (document.readyState === "complete") jump(); else window.addEventListener("load", jump);
  }

  /* ---------- Install drawer ---------- */
  var drawer = document.getElementById("install-drawer");
  var lastFocus = null;
  function focusables() {
    return $$('a[href],button:not([disabled]),select,[tabindex]:not([tabindex="-1"])', drawer).filter(function (el) {
      return el.offsetParent !== null;
    });
  }
  function openDrawer(os) {
    if (!drawer) return;
    lastFocus = document.activeElement;
    var g = drawer.querySelector("[data-tabs]");
    if (g) pick(g, os || os0);
    drawer.hidden = false;
    root.classList.add("lock");
    requestAnimationFrame(function () { drawer.classList.add("open"); });
    var sheet = drawer.querySelector(".sheet");
    if (sheet) sheet.focus();
  }
  function closeDrawer() {
    if (!drawer || drawer.hidden) return;
    drawer.classList.remove("open");
    root.classList.remove("lock");
    setTimeout(function () { drawer.hidden = true; }, reduce ? 0 : 260);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $$("[data-install]").forEach(function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); openDrawer(a.getAttribute("data-install") || null); });
  });
  if (drawer) {
    $$("[data-close]", drawer).forEach(function (b) { b.addEventListener("click", closeDrawer); });
    drawer.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }
      if (e.key !== "Tab") return;
      var f = focusables(); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer.querySelector(".sheet"))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  if (/[#&]install\b/.test(location.hash) && page === "index") openDrawer(null);

  /* ---------- Reveal on scroll ---------- */
  var rv = $$(".rv");
  if (reduce || !("IntersectionObserver" in window)) {
    rv.forEach(function (el) { el.classList.add("in"); });
  } else {
    root.classList.add("rv-on");
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    rv.forEach(function (el) { io.observe(el); });
  }
})();
