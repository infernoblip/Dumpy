/* Dumpy motion: two small touches that make the design feel fluid.

   1. Page changes. css/style.css asks the browser to animate between pages
      (a "view transition"): the new page spreads out like ink from the spot
      the visitor tapped, and going back settles in softly instead. This
      script remembers where the tap was and tells the next page.
   2. Buttons. Pressing a .btn sends a ripple of ink out from the finger.

   It runs in the <head>, before the page is first shown, because the page
   change is set up at that moment. It is decoration only: if a browser lacks
   a feature, or this file fails to load, every page works the same, just
   with plainer motion. It sends nothing anywhere and keeps only the last tap
   position, for a few seconds, in this tab's sessionStorage. */
(function () {
  "use strict";

  var root = document.documentElement;
  var KEY = "dumpy.tap";
  var FRESH_MS = 4000;
  var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function remember(x, y) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        x: Math.round((x / window.innerWidth) * 1000) / 10,
        y: Math.round((y / window.innerHeight) * 1000) / 10,
        t: Date.now()
      }));
    } catch (e) { /* storage blocked: the bloom starts from the middle */ }
  }

  function recall() {
    try {
      var tap = JSON.parse(sessionStorage.getItem(KEY) || "null");
      sessionStorage.removeItem(KEY);
      if (tap && Date.now() - tap.t < FRESH_MS && isFinite(tap.x) && isFinite(tap.y)) return tap;
    } catch (e) { /* ignore */ }
    return null;
  }

  // 1a. Before leaving: note where a link or button was tapped. A keyboard
  // "click" has no position, so use the middle of what was pressed.
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest && e.target.closest("a[href], button, [role='button']");
    if (!el) return;
    var x = e.clientX;
    var y = e.clientY;
    if (!x && !y) {
      var r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    remember(x, y);
  }, true);

  // 1b. On arrival, just before the page change animates.
  window.addEventListener("pagereveal", function (e) {
    var vt = e.viewTransition;
    if (!vt) return;
    var tap = recall();
    if (tap) {
      root.style.setProperty("--vt-x", tap.x + "%");
      root.style.setProperty("--vt-y", tap.y + "%");
      // How far the ink must spread to cover the screen: to the farthest
      // corner, plus its soft 48 px edge.
      var w = window.innerWidth;
      var h = window.innerHeight;
      var x = (tap.x / 100) * w;
      var y = (tap.y / 100) * h;
      var reach = Math.sqrt(Math.pow(Math.max(x, w - x), 2) + Math.pow(Math.max(y, h - y), 2)) + 56;
      root.style.setProperty("--vt-end", Math.round(reach) + "px");
    }
    // Going back through history gets the softer "back" animation.
    try {
      var act = window.navigation && window.navigation.activation;
      if (act && act.navigationType === "traverse" && act.from && act.entry &&
          act.entry.index < act.from.index && vt.types) {
        vt.types.add("back");
      }
    } catch (err) { /* older browsers: same animation both ways */ }
    var tidy = function () {
      root.style.removeProperty("--vt-x");
      root.style.removeProperty("--vt-y");
      root.style.removeProperty("--vt-end");
    };
    vt.finished.then(tidy, tidy);
  });

  // 2. Ink ripple inside buttons, from the point that was pressed.
  if (calm) return;
  document.addEventListener("pointerdown", function (e) {
    var b = e.target && e.target.closest && e.target.closest(".btn");
    if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return;
    var r = b.getBoundingClientRect();
    b.style.setProperty("--ink-x", Math.round(e.clientX - r.left) + "px");
    b.style.setProperty("--ink-y", Math.round(e.clientY - r.top) + "px");
    b.classList.remove("is-inked");
    void b.offsetWidth; // restart the ripple if it is still running
    b.classList.add("is-inked");
  }, { passive: true });

  function settle(e) {
    if (e.animationName === "ink" && e.target.classList) e.target.classList.remove("is-inked");
  }
  document.addEventListener("animationend", settle);
  document.addEventListener("animationcancel", settle);
})();
