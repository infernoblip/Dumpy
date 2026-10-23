/* Shrinks a photo in the browser before it is uploaded.

   Phone photos are often 3 to 8 MB. Each one is redrawn on a canvas at most
   1280 px on its long edge and saved as WebP (or JPEG where the browser can't
   make WebP), aiming for about 200 KB. Redrawing also drops the photo's hidden
   details, such as the GPS location the camera saved in it.

   Dumpy.shrinkPhoto(file) -> Promise<Blob> */
(function () {
  var Dumpy = (window.Dumpy = window.Dumpy || {});

  var MAX_EDGE = 1280;
  var TARGET = 220 * 1024;   // aim for about 200 KB
  var LIMIT = 450 * 1024;    // accept up to this before making the picture smaller
  var QUALITIES = [0.82, 0.72, 0.62, 0.52];

  // Draws the file into something a canvas can use, turned the right way up.
  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (e) {
        try { return await createImageBitmap(file); } catch (e2) { /* fall back to <img> */ }
      }
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("unreadable")); };
      img.src = url;
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }

  // Does this browser's canvas make WebP? (Older iPhones make PNG instead.)
  var webp = null;
  async function canWebp() {
    if (webp === null) {
      var c = document.createElement("canvas");
      c.width = c.height = 2;
      var b = await toBlob(c, "image/webp", 0.8);
      webp = !!b && b.type === "image/webp";
    }
    return webp;
  }

  async function encode(source, w, h, type) {
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // see-through parts of a PNG become white, not black
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    var best = null;
    for (var i = 0; i < QUALITIES.length; i++) {
      var blob = await toBlob(canvas, type, QUALITIES[i]);
      if (!blob) break;
      best = blob;
      if (blob.size <= TARGET) break;
    }
    canvas.width = canvas.height = 0; // free the memory on low-end phones
    return best;
  }

  Dumpy.shrinkPhoto = async function (file) {
    if (!file || !/^image\//.test(file.type || "image/")) throw new Error("not-image");
    var source;
    try { source = await decode(file); }
    catch (e) { throw new Error("unreadable"); }

    var w0 = source.width || source.naturalWidth;
    var h0 = source.height || source.naturalHeight;
    if (!w0 || !h0) throw new Error("unreadable");
    var type = (await canWebp()) ? "image/webp" : "image/jpeg";

    var scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
    var blob = null;
    // A very detailed photo can still be big at low quality: make it smaller.
    for (var round = 0; round < 4; round++) {
      var w = Math.max(1, Math.round(w0 * scale));
      var h = Math.max(1, Math.round(h0 * scale));
      blob = await encode(source, w, h, type);
      if (!blob || blob.size <= LIMIT) break;
      scale *= 0.8;
    }
    if (source.close) source.close();
    if (source.src && /^blob:/.test(source.src)) URL.revokeObjectURL(source.src);
    if (!blob) throw new Error("unreadable");
    return blob;
  };
})();
