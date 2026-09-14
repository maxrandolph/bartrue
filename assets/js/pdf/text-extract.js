/*
  Best-effort text extraction: walks each page's content stream and decodes
  shown glyphs to Unicode using /ToUnicode when present (covers the huge
  majority of real-world PDFs, including Chrome/LibreOffice "print to PDF"
  output which uses Identity-H composite fonts), falling back to a Latin1/
  WinAnsi guess for simple fonts that don't carry one.
*/
(function (root) {
  "use strict";
  var Content = root.PDFContent;
  var FM = root.PDFFontMetrics;

  async function extractPageText(doc, pageEntry) {
    var bytes = await doc.getPageContentBytes(pageEntry);
    var resources = await doc.getPageResources(pageEntry);
    var ops = Content.tokenizeContent(bytes);
    var fontInfoCache = new Map();
    var out = [];
    var lastY = null;
    var lastEndX = null;
    var sawUnmapped = false;

    async function onText(run) {
      var font = run.font;
      var key = run.fontKey || "?";
      var info = fontInfoCache.get(key);
      if (!info) {
        info = await FM.resolveFontInfo(doc, font);
        fontInfoCache.set(key, info);
      }
      var origin = Content.applyMat(run.trm, 0, 0);
      var y = Math.round(origin[1]);
      if (lastY !== null && Math.abs(y - lastY) > 1.5) {
        out.push("\n");
      } else if (lastEndX !== null && origin[0] - lastEndX > (run.fontSize || 10) * 0.2) {
        out.push(" ");
      }
      lastY = y;

      var totalAdvance = 0;
      var runText = "";
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
          var ch = info.toUnicode(code);
          if (ch === "") sawUnmapped = true;
          runText += ch || "�";
          var w0 = info.widthOf(code);
          var isSpace = info.bytesPerCode === 1 && code === 32;
          totalAdvance += ((w0 / 1000) * run.fontSize + run.charSpace + (isSpace ? run.wordSpace : 0)) * run.hscale;
        }
      }
      out.push(runText);
      var endPoint = Content.applyMat(run.trm, totalAdvance / (run.fontSize || 1), 0);
      lastEndX = endPoint[0];
      return Content.advanceTm(run.tm, totalAdvance);
    }

    await Content.walkContent(doc, ops, resources, onText, null);
    return { text: out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), hadUnmappedGlyphs: sawUnmapped };
  }

  async function extractDocumentText(doc, opts) {
    opts = opts || {};
    var pages = await doc.getPages();
    var chunks = [];
    var anyUnmapped = false;
    for (var i = 0; i < pages.length; i++) {
      var r = await extractPageText(doc, pages[i]);
      if (r.hadUnmappedGlyphs) anyUnmapped = true;
      if (opts.pageBreaks && i > 0) chunks.push("\n\n——— Page " + (i + 1) + " ———\n\n");
      else if (i > 0) chunks.push("\n\n");
      chunks.push(r.text);
    }
    return { text: chunks.join(""), hadUnmappedGlyphs: anyUnmapped, pageCount: pages.length };
  }

  root.PDFTextExtract = { extractPageText: extractPageText, extractDocumentText: extractDocumentText };
})(typeof window !== "undefined" ? window : global);
