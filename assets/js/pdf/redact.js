/*
  "Find & redact": searches extracted text for one or more terms and, for
  every text-showing operator whose decoded text contains a match, (a)
  removes that operator from the content stream entirely (so the
  underlying characters are gone, not just covered — verified by re-running
  text extraction on the output, see redact-pdf's test) and (b) paints an
  opaque black rectangle over its bounding box. This is a from-scratch
  from-scratch heuristic (no font hinting/kerning-perfect layout), so it
  redacts the *entire run* containing a match, which for most real PDFs is
  a word, line fragment, or short phrase.
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;
  var Content = root.PDFContent;
  var FM = root.PDFFontMetrics;
  var Build = root.PDFBuild;

  async function redactPage(doc, pageEntry, terms, opts) {
    opts = opts || {};
    var caseSensitive = !!opts.caseSensitive;
    var needles = terms.map(function (t) {
      return caseSensitive ? t : t.toLowerCase();
    }).filter(Boolean);
    if (!needles.length) return { matches: 0 };

    var bytes = await doc.getPageContentBytes(pageEntry);
    var resources = await doc.getPageResources(pageEntry);
    var ops = Content.tokenizeContent(bytes);
    var fontInfoCache = new Map();
    var skipSet = new Set();
    var boxes = [];

    async function onText(run) {
      var key = run.fontKey || "?";
      var info = fontInfoCache.get(key);
      if (!info) {
        info = await FM.resolveFontInfo(doc, run.font);
        fontInfoCache.set(key, info);
      }
      var runText = "";
      var totalAdvance = 0;
      for (var i = 0; i < run.items.length; i++) {
        var item = run.items[i];
        if (item.adjust !== undefined) {
          var gap = (-item.adjust / 1000) * run.fontSize * run.hscale;
          if (gap > run.fontSize * 0.15) runText += " ";
          totalAdvance += (-item.adjust / 1000) * run.fontSize * run.hscale;
          continue;
        }
        var codes = FM.splitCodes(item.bytes, info.bytesPerCode);
        for (var c = 0; c < codes.length; c++) {
          var code = codes[c];
          runText += info.toUnicode(code) || "�";
          var w0 = info.widthOf(code);
          var isSpace = info.bytesPerCode === 1 && code === 32;
          totalAdvance += ((w0 / 1000) * run.fontSize + run.charSpace + (isSpace ? run.wordSpace : 0)) * run.hscale;
        }
      }
      var hay = caseSensitive ? runText : runText.toLowerCase();
      var matched = needles.some(function (n) {
        return hay.indexOf(n) !== -1;
      });
      if (matched) {
        skipSet.add(run.opIndex);
        var xEnd = totalAdvance / (run.fontSize || 1);
        var corners = [
          Content.applyMat(run.trm, 0, -0.25),
          Content.applyMat(run.trm, xEnd, -0.25),
          Content.applyMat(run.trm, 0, 0.85),
          Content.applyMat(run.trm, xEnd, 0.85)
        ];
        var xs = corners.map(function (p) { return p[0]; });
        var ys = corners.map(function (p) { return p[1]; });
        boxes.push([Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)]);
      }
      return Content.advanceTm(run.tm, totalAdvance);
    }

    await Content.walkContent(doc, ops, resources, onText, null);
    if (!boxes.length) return { matches: 0 };

    var rectOps = boxes.map(function (b) {
      var x = b[0], y = b[1], w = b[2] - b[0], h = b[3] - b[1];
      var pad = 1;
      return "q 0 0 0 rg " + (x - pad).toFixed(2) + " " + (y - pad).toFixed(2) + " " + (w + pad * 2).toFixed(2) + " " + (h + pad * 2).toFixed(2) + " re f Q";
    });

    var newBytes = Content.serializeOps(ops, skipSet);
    // Wrap the original (edited) content in its own q/Q: a content stream
    // always starts at an identity CTM by spec, so closing that Q
    // guarantees identity again before we draw the redaction boxes, even
    // if the original left an unbalanced `cm`/graphics state active
    // (common in real-world generators).
    var withBoxes = new TextEncoder().encode("q\n" + new TextDecoder().decode(newBytes) + "\nQ\n" + rectOps.join("\n") + "\n");
    await Build.setPageContent(doc, pageEntry, withBoxes);
    return { matches: boxes.length };
  }

  async function redactDocument(doc, terms, opts) {
    var pages = await doc.getPages();
    var total = 0;
    var perPage = [];
    for (var i = 0; i < pages.length; i++) {
      var r = await redactPage(doc, pages[i], terms, opts);
      perPage.push(r.matches);
      total += r.matches;
    }
    return { total: total, perPage: perPage };
  }

  root.PDFRedact = { redactDocument: redactDocument, redactPage: redactPage };
})(typeof window !== "undefined" ? window : global);
