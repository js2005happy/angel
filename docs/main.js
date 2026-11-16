// Angel website: language toggle + copy buttons. No dependencies.
(function () {
  var root = document.documentElement;
  var KEY = "angel-lang";

  function setLang(lang) {
    root.setAttribute("data-lang", lang);
    root.setAttribute("lang", lang === "en" ? "en" : "zh-CN");
    document.title = lang === "en"
      ? "Angel — Python Agent Core + JavaScript UI"
      : "Angel — Python Agent 核心 + JavaScript 界面";
    try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
  }

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  var fromHash = /[?&#]lang=en\b/.test(location.search + location.hash) ? "en" : null;
  setLang(fromHash || (saved === "en" ? "en" : "zh"));

  var toggle = document.getElementById("lang-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      setLang(root.getAttribute("data-lang") === "en" ? "zh" : "en");
    });
  }

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
        btn.classList.add("done");
        var en = root.getAttribute("data-lang") === "en";
        var old = btn.innerHTML;
        btn.textContent = en ? "Copied" : "已复制";
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
