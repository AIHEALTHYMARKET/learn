/* 淺色／深色主題：預設跟隨裝置，使用者可手動切換（自動 → 淺色 → 深色），選擇會記在這個瀏覽器。
   放在 <head> 內同步載入，避免畫面先閃一下淺色再變深色。 */
(function () {
  var KEY = "unfinished_theme";
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var LABEL = { auto: ["◐", "自動"], light: ["☀", "淺色"], dark: ["☾", "深色"] };
  function pref() { try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "auto"; } catch (e) { return "auto"; } }
  function resolve(p) { return p === "auto" ? (mq && mq.matches ? "dark" : "light") : p; }
  function apply() {
    var p = pref(), t = resolve(p), root = document.documentElement;
    root.setAttribute("data-theme", t); root.setAttribute("data-theme-pref", p); root.style.colorScheme = t;
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t === "dark" ? "#0e1522" : "#f4f6fa");
    var tip = "外觀：" + LABEL[p][1] + "（點一下切換：自動 → 淺色 → 深色）";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      var ti = b.querySelector(".ti"), tl = b.querySelector(".tl");
      if (ti) ti.textContent = LABEL[p][0]; if (tl) tl.textContent = LABEL[p][1];
      b.title = tip; b.setAttribute("aria-label", tip);
    });
  }
  function cycle() {
    var next = { auto: "light", light: "dark", dark: "auto" }[pref()];
    try { localStorage.setItem(KEY, next); } catch (e) { /* 無痕模式：只在本次有效 */ }
    apply();
  }
  apply();
  var onSys = function () { if (pref() === "auto") apply(); };
  if (mq) { if (mq.addEventListener) mq.addEventListener("change", onSys); else if (mq.addListener) mq.addListener(onSys); }
  document.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest("[data-theme-toggle]"); if (b) cycle(); });
  document.addEventListener("DOMContentLoaded", apply);
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(); });
})();
