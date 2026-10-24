/* The printable poster (pages/poster.html): a QR code to the live site,
   drawn as SVG by the pinned qrcode-generator library. */
(function () {
  var cfg = window.DUMPY_CONFIG || {};
  var url = cfg.siteUrl || new URL("../", location.href).href;
  var box = document.getElementById("qr");

  document.getElementById("url").textContent = url.replace(/^https?:\/\//, "").replace(/\/$/, "");

  var lib = window.qrcode;
  if (lib) {
    try {
      var qr = lib(0, "M");
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {
      console.error(e);
    }
  }
  if (!box.firstChild) {
    box.classList.add("poster__qr--missing");
    box.textContent = "The QR code could not load. Check your internet connection and reload.";
  }

  document.getElementById("print").addEventListener("click", function () { window.print(); });
})();
