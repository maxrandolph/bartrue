/*
  Converts a PDF to grayscale: rewrites color-setting content-stream
  operators (rg/RG/k/K/sc/SC/scn/SCN with plain numeric operands) to their
  DeviceGray equivalents, and desaturates raster image XObjects in place.
  Pattern fills and Form XObjects are left untouched (documented
  limitation) rather than risk corrupting content we can't safely parse.
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;
  var Content = root.PDFContent;
  var Flate = root.PDFFlate;

  function luminance(r, g, b) {
    return 0.3 * r + 0.59 * g + 0.11 * b;
  }

  function rewriteColorOps(ops) {
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      var a = o.args;
      switch (o.op) {
        case "rg":
        case "RG": {
          var gray = luminance(num(a[0]), num(a[1]), num(a[2]));
          o.args = [gray];
          o.op = o.op === "rg" ? "g" : "G";
          break;
        }
        case "k":
        case "K": {
          var c = num(a[0]), m = num(a[1]), y = num(a[2]), k = num(a[3]);
          var r = 1 - Math.min(1, c + k),
            g2 = 1 - Math.min(1, m + k),
            b = 1 - Math.min(1, y + k);
          o.args = [luminance(r, g2, b)];
          o.op = o.op === "k" ? "g" : "G";
          break;
        }
        case "sc":
        case "SC":
        case "scn":
        case "SCN": {
          var nums = a.filter(function (v) { return typeof v === "number"; });
          if (nums.length !== a.length) break; // has a Name (pattern) operand — leave untouched
          var grayVal;
          if (nums.length === 1) grayVal = nums[0];
          else if (nums.length === 3) grayVal = luminance(nums[0], nums[1], nums[2]);
          else if (nums.length === 4) {
            var rr = 1 - Math.min(1, nums[0] + nums[3]),
              gg = 1 - Math.min(1, nums[1] + nums[3]),
              bb = 1 - Math.min(1, nums[2] + nums[3]);
            grayVal = luminance(rr, gg, bb);
          } else break;
          o.args = [grayVal];
          o.op = o.op[0] === "s" ? "g" : "G";
          break;
        }
      }
    }
    return ops;
  }

  function num(v) {
    return typeof v === "number" ? v : 0;
  }

  // Resolves an Indexed color space's base samples for `index`, returning
  // an array of component values 0-255 in the base space.
  async function readIndexedPalette(doc, csArray) {
    // [ /Indexed base hival lookup ]
    var base = await doc.resolve(csArray[1]);
    var hival = await doc.resolve(csArray[2]);
    var lookupObj = await doc.resolve(csArray[3]);
    var bytes;
    if (lookupObj instanceof C.PDFStream) bytes = await doc.getStreamBytes(lookupObj);
    else if (lookupObj instanceof C.PDFString) bytes = lookupObj.bytes;
    else bytes = new Uint8Array(0);
    var baseComponents = colorSpaceComponents(base);
    return { bytes: bytes, hival: hival, components: baseComponents };
  }

  function colorSpaceComponents(cs) {
    if (cs instanceof C.PDFName) {
      if (cs.name === "DeviceGray" || cs.name === "CalGray" || cs.name === "G") return 1;
      if (cs.name === "DeviceCMYK") return 4;
      return 3; // DeviceRGB and most others we'll encounter
    }
    if (Array.isArray(cs)) {
      var kind = cs[0] instanceof C.PDFName ? cs[0].name : "";
      if (kind === "ICCBased") return 3; // best-effort default; N is on the stream dict, resolved by caller if needed
      if (kind === "Indexed") return 1; // caller must special-case
      if (kind === "CalRGB" || kind === "Lab") return 3;
      if (kind === "CalGray") return 1;
      if (kind === "DeviceN") return (cs[1] && cs[1].length) || 4;
    }
    return 3;
  }

  async function grayscaleImageXObject(doc, streamObj) {
    var dict = streamObj.dict;
    var filters = dict.Filter;
    var filterList = Array.isArray(filters) ? filters : filters ? [filters] : [];
    var filterNames = filterList.map(function (f) { return f instanceof C.PDFName ? f.name : f; });

    if (filterNames.indexOf("DCTDecode") !== -1 || filterNames.indexOf("JPXDecode") !== -1) {
      if (typeof root.createImageBitmap === "function" && typeof root.OffscreenCanvas === "function") {
        try {
          await grayscaleJpegInPlace(doc, streamObj);
        } catch (e) {
          /* leave image untouched if browser decode fails */
        }
      }
      return; // Node/no-canvas environment: leave compressed photos untouched
    }
    if (filterNames.some(function (f) { return f === "CCITTFaxDecode" || f === "JBIG2Decode"; })) {
      return; // already 1-bit fax-style images; nothing to desaturate
    }

    var width = await doc.resolve(dict.Width);
    var height = await doc.resolve(dict.Height);
    var bpc = (await doc.resolve(dict.BitsPerComponent)) || 8;
    if (bpc !== 8) return; // keep scope to the common 8-bit case
    var cs = await doc.resolve(dict.ColorSpace);
    var csName = cs instanceof C.PDFName ? cs.name : Array.isArray(cs) && cs[0] instanceof C.PDFName ? cs[0].name : "";
    if (csName === "DeviceGray" || csName === "CalGray") return; // already grayscale

    var data = await doc.getStreamBytes(streamObj); // decoded raw samples

    if (csName === "Indexed") {
      var pal = await readIndexedPalette(doc, cs);
      var comps = pal.components;
      var out = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) {
        var idx = data[i];
        var off = idx * comps;
        var gray;
        if (comps === 1) gray = pal.bytes[off];
        else if (comps === 4) {
          var c = pal.bytes[off] / 255, m = pal.bytes[off + 1] / 255, y = pal.bytes[off + 2] / 255, k = pal.bytes[off + 3] / 255;
          gray = Math.round(255 * luminance(1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)));
        } else {
          gray = Math.round(luminance(pal.bytes[off] || 0, pal.bytes[off + 1] || 0, pal.bytes[off + 2] || 0));
        }
        out[i] = idx; // keep indices; instead rewrite the palette itself to gray below
      }
      // Rewrite the palette entries to grayscale-equivalent RGB triples so
      // existing indices keep working without touching the sample data.
      var newPalette = new Uint8Array(pal.bytes.length);
      for (var p = 0; p * comps < pal.bytes.length; p++) {
        var o2 = p * comps;
        var g2;
        if (comps === 1) g2 = pal.bytes[o2];
        else if (comps === 4) {
          var c2 = pal.bytes[o2] / 255, m2 = pal.bytes[o2 + 1] / 255, y2 = pal.bytes[o2 + 2] / 255, k2 = pal.bytes[o2 + 3] / 255;
          g2 = Math.round(255 * luminance(1 - Math.min(1, c2 + k2), 1 - Math.min(1, m2 + k2), 1 - Math.min(1, y2 + k2)));
        } else {
          g2 = Math.round(luminance(pal.bytes[o2] || 0, pal.bytes[o2 + 1] || 0, pal.bytes[o2 + 2] || 0));
        }
        if (comps >= 3) {
          newPalette[o2] = g2; newPalette[o2 + 1] = g2; newPalette[o2 + 2] = g2;
          if (comps === 4) newPalette[o2 + 3] = 0;
        } else {
          newPalette[o2] = g2;
        }
      }
      var newLookup = new C.PDFStream({}, await Flate.deflate(newPalette));
      newLookup.dict.Filter = new C.PDFName("FlateDecode");
      cs[3] = doc.addObject(newLookup);
      dict.ColorSpace = cs;
      return; // sample data (indices) unchanged
    }

    var comps2 = csName === "DeviceCMYK" ? 4 : 3;
    if (data.length < width * height * comps2) return; // unexpected layout; skip safely
    var outSamples = new Uint8Array(width * height);
    for (var px = 0; px < width * height; px++) {
      var base = px * comps2;
      var gv;
      if (comps2 === 4) {
        var cc = data[base] / 255, mm = data[base + 1] / 255, yy = data[base + 2] / 255, kk = data[base + 3] / 255;
        gv = Math.round(255 * luminance(1 - Math.min(1, cc + kk), 1 - Math.min(1, mm + kk), 1 - Math.min(1, yy + kk)));
      } else {
        gv = Math.round(luminance(data[base], data[base + 1], data[base + 2]));
      }
      outSamples[px] = gv;
    }
    var deflated = await Flate.deflate(outSamples);
    dict.ColorSpace = new C.PDFName("DeviceGray");
    dict.Filter = new C.PDFName("FlateDecode");
    delete dict.DecodeParms;
    delete dict.DP;
    delete dict.Decode;
    streamObj.raw = deflated;
  }

  async function grayscaleJpegInPlace(doc, streamObj) {
    var bytes = streamObj.raw; // JPEG bytes are the raw stream content (single DCTDecode filter, common case)
    var blob = new Blob([bytes], { type: "image/jpeg" });
    var bitmap = await createImageBitmap(blob);
    var canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    var imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    var d = imgData.data;
    for (var i = 0; i < d.length; i += 4) {
      var gray = luminance(d[i], d[i + 1], d[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = gray;
    }
    ctx.putImageData(imgData, 0, 0);
    var outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    var arrayBuf = await outBlob.arrayBuffer();
    streamObj.raw = new Uint8Array(arrayBuf);
    streamObj.dict.Filter = new C.PDFName("DCTDecode");
    delete streamObj.dict.DecodeParms;
    delete streamObj.dict.DP;
    streamObj.dict.ColorSpace = new C.PDFName("DeviceGray");
  }

  async function grayscaleDocument(doc) {
    var pages = await doc.getPages();
    for (var i = 0; i < pages.length; i++) {
      var pageEntry = pages[i];
      var bytes = await doc.getPageContentBytes(pageEntry);
      var ops = Content.tokenizeContent(bytes);
      rewriteColorOps(ops);
      var newBytes = Content.serializeOps(ops, new Set());
      await root.PDFBuild.setPageContent(doc, pageEntry, newBytes);

      var resources = await doc.getPageResources(pageEntry);
      var xobjectsDict = resources.XObject ? await doc.resolve(resources.XObject) : null;
      if (xobjectsDict) {
        var keys = Object.keys(xobjectsDict);
        for (var k = 0; k < keys.length; k++) {
          var xobj = await doc.resolve(xobjectsDict[keys[k]]);
          if (xobj instanceof C.PDFStream && C.isName(xobj.dict.Subtype, "Image")) {
            try {
              await grayscaleImageXObject(doc, xobj);
            } catch (e) {
              /* skip images we can't safely convert */
            }
          }
        }
      }
    }
  }

  root.PDFGrayscale = { grayscaleDocument: grayscaleDocument, rewriteColorOps: rewriteColorOps };
})(typeof window !== "undefined" ? window : global);
