(function () {
  window.addEventListener("hashchange", function () { location.reload(); });
  var info = { state: "starting", detail: "", python: "" };
  try {
    var raw = decodeURIComponent((location.hash || "").slice(1).replace(/\+/g, " "));
    if (raw) info = Object.assign(info, JSON.parse(raw));
  } catch (e) {}
  var ua = navigator.userAgent || "";
  document.documentElement.setAttribute("data-os", /Windows/i.test(ua) ? "win" : /Mac/i.test(ua) ? "mac" : "other");

  var shown = null;
  document.querySelectorAll("section[data-state]").forEach(function (s) {
    var on = s.getAttribute("data-state") === info.state;
    s.hidden = !on;
    if (on) shown = s;
  });
  if (!shown) {
    shown = document.querySelector('section[data-state="failed"]');
    shown.hidden = false;
  }
  shown.querySelectorAll(".python").forEach(function (c) { c.textContent = info.python || "—"; });
  var d = shown.querySelector(".detail");
  if (d && info.detail) { d.textContent = info.detail; d.hidden = false; }

  var actions = document.querySelector(".actions");
  var retry = document.getElementById("retry");
  if (info.state !== "starting") {
    actions.hidden = false;
    if (info.state === "exited") retry.textContent = "重新启动";
  }
  retry.addEventListener("click", function () {
    retry.disabled = true;
    var t = window.__TAURI__ && window.__TAURI__.core;
    if (t) t.invoke("retry_start");
  });
})();
