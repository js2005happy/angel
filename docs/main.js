// Nyra website: languages + copy buttons. No dependencies, no network.
(function () {
  var root = document.documentElement;
  var KEY = "nyra-lang";
  var X = window.NYRA_I18N || { t: {}, title: {}, copied: {} };
  var SUPPORTED = ["zh", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt", "ru"];
  var TITLE = {
    zh: "Nyra — 跑在你终端里的开源 AI agent",
    en: "Nyra — an open-source AI agent that runs in your terminal"
  };
  var enSpans = Array.prototype.slice.call(document.querySelectorAll('[data-l="en"]'));
  enSpans.forEach(function (el) { el.setAttribute("data-o", el.innerHTML); });

  function norm(l) {
    if (!l) return null;
    l = String(l).toLowerCase();
    if (l === "zh-tw" || l === "zh-hk" || l === "zh-hant" || l.indexOf("zh-hant") === 0) return "zh-TW";
    if (l.indexOf("zh") === 0) return "zh";
    var base = l.split("-")[0];
    return SUPPORTED.indexOf(base) >= 0 ? base : null;
  }

  function setLang(lang) {
    lang = norm(lang) || "en";
    var dict = X.t[lang] || null;
    root.setAttribute("data-lang", lang === "zh" ? "zh" : "en");
    root.setAttribute("data-ui", lang);
    root.setAttribute("lang", lang === "zh" ? "zh-CN" : lang);
    enSpans.forEach(function (el) {
      var o = el.getAttribute("data-o");
      el.innerHTML = dict && dict[o] ? dict[o] : o;
    });
    document.title = X.title[lang] || TITLE[lang] || TITLE.en;
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

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var done = function () {
        var ui = root.getAttribute("data-ui") || "en";
        var old = btn.innerHTML;
        btn.classList.add("done");
        btn.textContent = ui === "zh" ? "已复制" : (X.copied[ui] || "Copied");
        setTimeout(function () { btn.innerHTML = old; btn.classList.remove("done"); }, 1400);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else {
        fallbackCopy(text);
        done();
      }
    });
  });
})();
