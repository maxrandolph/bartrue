/*
  Shrinks a PDF's file size by recompressing its embedded raster images
  (the dominant cost in most "large PDF" cases) as JPEG at a lower quality,
  optionally downscaling oversized images. Vector content, text and fonts
  are untouched. Browser-only (needs createImageBitmap + OffscreenCanvas);
  images that can't be decoded are left as-is rather than dropped.
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;

  async function compressImageXObject(doc, streamObj, opts) {
    var dict = streamObj.dict;
    if (C.isName(dict.ImageMask, "true") || dict.ImageMask === true) return { changed: false };
    var filters = dict.Filter;
    var filterList = Array.isArray(filters) ? filters : filters ? [filters] : [];
    var filterNames = filterList.map(function (f) { return f instanceof C.PDFName ? f.name : f; });
    if (filterNames.indexOf("CCITTFaxDecode") !== -1 || filterNames.indexOf("JBIG2Decode") !== -1) {
      return { changed: false }; // already tiny 1-bit fax images
    }

    var width = await doc.resolve(dict.Width);
    var height = await doc.resolve(dict.Height);
    if (!width || !height) return { changed: false };

    var isJpeg = filterNames.indexOf("DCTDecode") !== -1;
    var bitmap;
    var beforeSize = streamObj.raw.length;
    try {
      if (isJpeg) {
        bitmap = await createImageBitmap(new Blob([streamObj.raw], { type: "image/jpeg" }));
      } else {
        // Decode raw samples ourselves into an ImageData-compatible buffer.
        var bpc = (await doc.resolve(dict.BitsPerComponent)) || 8;
        if (bpc !== 8) return { changed: false };
        var cs = await doc.resolve(dict.ColorSpace);
        var csName = cs instanceof C.PDFName ? cs.name : Array.isArray(cs) && cs[0] instanceof C.PDFName ? cs[0].name : "";
        var comps = csName === "DeviceGray" || csName === "CalGray" ? 1 : csName === "DeviceCMYK" ? 4 : 3;
        var data = await doc.getStreamBytes(streamObj);
        if (data.length < width * height * comps) return { changed: false };
        var rgba = new Uint8ClampedArray(width * height * 4);
        for (var p = 0; p < width * height; p++) {
          var base = p * comps;
          var r, g, b;
          if (comps === 1) { r = g = b = data[base]; }
          else if (comps === 4) {
            var c = data[base] / 255, m = data[base + 1] / 255, y = data[base + 2] / 255, k = data[base + 3] / 255;
            r = 255 * (1 - Math.min(1, c + k)); g = 255 * (1 - Math.min(1, m + k)); b = 255 * (1 - Math.min(1, y + k));
          } else { r = data[base]; g = data[base + 1]; b = data[base + 2]; }
          var o = p * 4;
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
        }
        var tmpCanvas = new OffscreenCanvas(width, height);
        tmpCanvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
        bitmap = await createImageBitmap(tmpCanvas);
      }
    } catch (e) {
      return { changed: false };
    }

    var targetW = bitmap.width, targetH = bitmap.height;
    var maxDim = opts.maxDim || 0;
    if (maxDim && Math.max(targetW, targetH) > maxDim) {
      var scale = maxDim / Math.max(targetW, targetH);
      targetW = Math.max(1, Math.round(targetW * scale));
      targetH = Math.max(1, Math.round(targetH * scale));
    }

    var canvas = new OffscreenCanvas(targetW, targetH);
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    var blob = await canvas.convertToBlob({ type: "image/jpeg", quality: opts.quality });
    var newBytes = new Uint8Array(await blob.arrayBuffer());

    if (newBytes.length >= beforeSize && targetW === bitmap.width) {
      return { changed: false }; // recompression didn't actually help; keep original
    }

    dict.Filter = new C.PDFName("DCTDecode");
    delete dict.DecodeParms;
    delete dict.DP;
    delete dict.Decode;
    dict.Width = targetW;
    dict.Height = targetH;
    dict.ColorSpace = new C.PDFName("DeviceRGB");
    dict.BitsPerComponent = 8;
    streamObj.raw = newBytes;
    return { changed: true, before: beforeSize, after: newBytes.length };
  }

  async function compressDocument(doc, opts) {
    opts = Object.assign({ quality: 0.6, maxDim: 0 }, opts || {});
    var pages = await doc.getPages();
    var totalBefore = 0, totalAfter = 0, imagesTouched = 0;
    var seen = new Set();
    for (var i = 0; i < pages.length; i++) {
      var resources = await doc.getPageResources(pages[i]);
      var xobjectsDict = resources.XObject ? await doc.resolve(resources.XObject) : null;
      if (!xobjectsDict) continue;
      var keys = Object.keys(xobjectsDict);
      for (var k = 0; k < keys.length; k++) {
        var ref = xobjectsDict[keys[k]];
        var cacheKey = ref instanceof C.PDFRef ? ref.key() : null;
        if (cacheKey && seen.has(cacheKey)) continue;
        if (cacheKey) seen.add(cacheKey);
        var xobj = await doc.resolve(ref);
        if (xobj instanceof C.PDFStream && C.isName(xobj.dict.Subtype, "Image")) {
          try {
            var r = await compressImageXObject(doc, xobj, opts);
            if (r.changed) {
              imagesTouched++;
              totalBefore += r.before;
              totalAfter += r.after;
            }
          } catch (e) {
            /* leave this image untouched */
          }
        }
      }
    }
    return { imagesTouched: imagesTouched, totalBefore: totalBefore, totalAfter: totalAfter };
  }

  root.PDFCompress = { compressDocument: compressDocument };
})(typeof window !== "undefined" ? window : global);
