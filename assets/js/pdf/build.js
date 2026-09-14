/*
  Higher-level helpers built on top of core.js/document.js/writer.js:
  cross-document page copying (for merge/split), safe-to-mutate resource
  cloning, and content-stream text drawing (for watermark/page numbers).
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;
  var Fonts = root.PDFFonts;

  function shallowClone(dict) {
    var out = {};
    for (var k in dict) out[k] = dict[k];
    return out;
  }

  // Deep-copies a value (and everything it (transitively) references) from
  // sourceDoc into destDoc, allocating fresh object numbers. `memo` maps
  // sourceDoc object numbers -> PDFRef in destDoc, both to dedupe shared
  // objects (e.g. a font used by many pages) and to break reference cycles
  // (e.g. /Parent pointers) safely.
  async function copyObjectGraph(sourceDoc, value, destDoc, memo) {
    if (value instanceof C.PDFRef) {
      if (memo.has(value.num)) return memo.get(value.num);
      var placeholder = destDoc.addObject(null);
      memo.set(value.num, placeholder);
      var resolved = await sourceDoc.getObject(value.num);
      var copied = await copyObjectGraph(sourceDoc, resolved, destDoc, memo);
      destDoc.setObject(placeholder, copied);
      return placeholder;
    }
    if (value instanceof C.PDFStream) {
      var dict = await copyObjectGraph(sourceDoc, value.dict, destDoc, memo);
      return new C.PDFStream(dict, value.raw);
    }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(await copyObjectGraph(sourceDoc, value[i], destDoc, memo));
      return arr;
    }
    if (value instanceof C.PDFName || value instanceof C.PDFString) return value;
    if (value && typeof value === "object") {
      var out = {};
      for (var k in value) {
        if (k === "Parent") continue; // avoid climbing back into the source tree
        out[k] = await copyObjectGraph(sourceDoc, value[k], destDoc, memo);
      }
      return out;
    }
    return value;
  }

  // Copies one page (with inherited attributes resolved in) from
  // sourceDoc/pageEntry into destDoc, parenting it under destPagesRef.
  // Returns the new page's PDFRef in destDoc.
  async function copyPage(sourceDoc, pageEntry, destDoc, destPagesRef, memo) {
    var effective = shallowClone(pageEntry.dict);
    effective.Type = new C.PDFName("Page");
    if (effective.MediaBox === undefined) effective.MediaBox = pageEntry.inherited.MediaBox || [0, 0, 612, 792];
    if (effective.CropBox === undefined && pageEntry.inherited.CropBox !== undefined) effective.CropBox = pageEntry.inherited.CropBox;
    if (effective.Resources === undefined) effective.Resources = pageEntry.inherited.Resources || {};
    if (effective.Rotate === undefined && pageEntry.inherited.Rotate !== undefined) effective.Rotate = pageEntry.inherited.Rotate;
    delete effective.Parent;
    var copiedDict = await copyObjectGraph(sourceDoc, effective, destDoc, memo);
    copiedDict.Parent = destPagesRef;
    return destDoc.addObject(copiedDict);
  }

  function addPageToTree(destDoc, destPagesRef, pageRef, atIndex) {
    var pagesNode = destDoc.newObjects.get(destPagesRef.num);
    if (atIndex === undefined || atIndex < 0 || atIndex > pagesNode.Kids.length) {
      pagesNode.Kids.push(pageRef);
    } else {
      pagesNode.Kids.splice(atIndex, 0, pageRef);
    }
    pagesNode.Count = pagesNode.Kids.length;
  }

  function getRootPagesRef(destDoc) {
    var catalog = destDoc.newObjects.get(destDoc.trailer.Root.num);
    return catalog.Pages;
  }

  // Ensures the page has a Font resource entry for a Standard-14 font,
  // cloning Resources/Font dicts first so sibling pages that might share
  // the same (indirect) Resources object are never mutated by accident.
  async function ensureFontResource(doc, pageEntry, baseFont, resourceKey) {
    var resources = (await doc.getPageResources(pageEntry)) || {};
    var newResources = shallowClone(resources);
    var existingFont = newResources.Font ? await doc.resolve(newResources.Font) : {};
    var fontDict = shallowClone(existingFont || {});
    if (!fontDict[resourceKey]) {
      fontDict[resourceKey] = doc.addObject({
        Type: new C.PDFName("Font"),
        Subtype: new C.PDFName("Type1"),
        BaseFont: new C.PDFName(baseFont),
        Encoding: new C.PDFName("WinAnsiEncoding")
      });
    }
    newResources.Font = fontDict;
    pageEntry.dict.Resources = newResources;
    return resourceKey;
  }

  // Ensures an ExtGState resource exists with the given fill/stroke alpha
  // (0..1), returning its resource name for use with the `gs` operator.
  async function ensureAlphaGState(doc, pageEntry, alpha, resourceKey) {
    var resources = (await doc.getPageResources(pageEntry)) || {};
    var newResources = shallowClone(resources);
    var existing = newResources.ExtGState ? await doc.resolve(newResources.ExtGState) : {};
    var gsDict = shallowClone(existing || {});
    gsDict[resourceKey] = doc.addObject({ Type: new C.PDFName("ExtGState"), ca: alpha, CA: alpha });
    newResources.ExtGState = gsDict;
    pageEntry.dict.Resources = newResources;
    return resourceKey;
  }

  function textToHexString(text) {
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    var hex = "<";
    for (var j = 0; j < bytes.length; j++) hex += bytes[j].toString(16).padStart(2, "0");
    return hex + ">";
  }

  // Builds "BT ... ET" operators to draw one line of text with a Standard
  // font, at (x, y) in unrotated page-content space, with rgb color 0..1
  // and optional rotation (degrees, counter-clockwise) and opacity via an
  // ExtGState name (caller must have set that up in Resources if <1).
  function textOperators(opts) {
    var font = opts.font || "Helvetica";
    var size = opts.size || 24;
    var text = opts.text || "";
    var x = opts.x || 0;
    var y = opts.y || 0;
    var angle = ((opts.angle || 0) * Math.PI) / 180;
    var color = opts.color || [0, 0, 0];
    var resourceKey = opts.resourceKey || "FTHelv";
    var gsName = opts.gsName;
    var cos = Math.cos(angle).toFixed(6);
    var sin = Math.sin(angle).toFixed(6);
    var nsin = (-Math.sin(angle)).toFixed(6);
    var parts = [];
    parts.push("q");
    if (gsName) parts.push("/" + gsName + " gs");
    parts.push(color[0].toFixed(3) + " " + color[1].toFixed(3) + " " + color[2].toFixed(3) + " rg");
    parts.push("BT");
    parts.push("/" + resourceKey + " " + size + " Tf");
    parts.push(cos + " " + sin + " " + nsin + " " + cos + " " + x.toFixed(2) + " " + y.toFixed(2) + " Tm");
    parts.push(textToHexString(text) + " Tj");
    parts.push("ET");
    parts.push("Q");
    return parts.join("\n") + "\n";
  }

  // Appends raw content-stream bytes to a page, merging (not replacing)
  // its existing drawing commands. The ORIGINAL content is wrapped in its
  // own q/Q so that any unbalanced `cm`/graphics-state changes it makes
  // (very common in real-world generators, e.g. Chrome/Skia's PDF output
  // applies a top-level scale+flip `cm` that's never popped) can't leak
  // into our appended operators — a content stream always starts at an
  // identity CTM by spec, so closing that Q guarantees identity again
  // before we draw.
  async function appendPageContent(doc, pageEntry, extraOpsString) {
    var Flate = root.PDFFlate;
    var original = await doc.getPageContentBytes(pageEntry);
    var prefix = new TextEncoder().encode("q\n");
    var infix = new TextEncoder().encode("\nQ\n" + extraOpsString + "\n");
    var combined = new Uint8Array(prefix.length + original.length + infix.length);
    combined.set(prefix, 0);
    combined.set(original, prefix.length);
    combined.set(infix, prefix.length + original.length);
    var deflated = await Flate.deflate(combined);
    var streamObj = new C.PDFStream({ Filter: new C.PDFName("FlateDecode") }, deflated);
    pageEntry.dict.Contents = doc.addObject(streamObj);
  }

  // Fully replaces a page's content stream (used by grayscale rewriting).
  async function setPageContent(doc, pageEntry, newBytes) {
    var Flate = root.PDFFlate;
    var deflated = await Flate.deflate(newBytes);
    var streamObj = new C.PDFStream({ Filter: new C.PDFName("FlateDecode") }, deflated);
    pageEntry.dict.Contents = doc.addObject(streamObj);
  }

  root.PDFBuild = {
    shallowClone: shallowClone,
    copyObjectGraph: copyObjectGraph,
    copyPage: copyPage,
    addPageToTree: addPageToTree,
    getRootPagesRef: getRootPagesRef,
    ensureFontResource: ensureFontResource,
    ensureAlphaGState: ensureAlphaGState,
    textOperators: textOperators,
    textToHexString: textToHexString,
    appendPageContent: appendPageContent,
    setPageContent: setPageContent
  };
})(typeof window !== "undefined" ? window : global);
