/*
  Resolves a PDF font dictionary (simple or Type0/composite) into a small
  interface: how many bytes per character code, each code's glyph width
  (for layout/redaction bounding boxes), and a best-effort code->Unicode
  mapping (for text extraction), using /ToUnicode when present.
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;
  var Content = root.PDFContent;

  // Minimal WinAnsi-ish fallback: codes 32-126 are plain ASCII, a handful
  // of high bytes map to common punctuation people actually hit (curly
  // quotes, dashes, bullet). Anything else decodes as U+FFFD.
  var WINANSI_HIGH = {
    0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
    0x96: 0x2013, 0x97: 0x2014, 0xa0: 0x00a0, 0xad: 0x00ad
  };
  function winAnsiFallback(code) {
    if (code >= 32 && code <= 126) return String.fromCharCode(code);
    if (WINANSI_HIGH[code]) return String.fromCharCode(WINANSI_HIGH[code]);
    if (code >= 0xa0 && code <= 0xff) return String.fromCharCode(code); // Latin-1 supplement overlap
    return "";
  }

  function parseToUnicodeCMap(bytes) {
    var ops = Content.tokenizeContent(bytes); // reuse tokenizer; CMaps are token-compatible enough
    // tokenizeContent groups by keyword ops, but bf sections aren't single
    // "operators" with a fixed arg count — re-scan with the raw lexer instead.
    var lex = new C.Lexer(bytes, 0);
    var parser = new C.ObjParser(bytes, 0);
    parser.lex = lex;
    var map = new Map();
    var mode = null;
    var pending = [];
    while (true) {
      var save = lex.pos;
      var tok = lex.next();
      if (!tok) break;
      if (tok.type === "kw") {
        if (tok.value === "beginbfchar") { mode = "char"; pending = []; continue; }
        if (tok.value === "endbfchar") { mode = null; continue; }
        if (tok.value === "beginbfrange") { mode = "range"; pending = []; continue; }
        if (tok.value === "endbfrange") { mode = null; continue; }
        continue;
      }
      if (!mode) continue;
      lex.pos = save;
      var val = parser.parseValue();
      pending.push(val);
      if (mode === "char" && pending.length === 2) {
        addBfChar(map, pending[0], pending[1]);
        pending = [];
      } else if (mode === "range" && pending.length === 3) {
        addBfRange(map, pending[0], pending[1], pending[2]);
        pending = [];
      }
    }
    return map;
  }

  function bytesToInt(bytes) {
    var n = 0;
    for (var i = 0; i < bytes.length; i++) n = n * 256 + bytes[i];
    return n;
  }
  function bytesToUtf16Str(bytes) {
    var out = "";
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
    return out;
  }
  function addBfChar(map, srcObj, dstObj) {
    if (!(srcObj instanceof C.PDFString) || !(dstObj instanceof C.PDFString)) return;
    map.set(bytesToInt(srcObj.bytes), bytesToUtf16Str(dstObj.bytes));
  }
  function addBfRange(map, loObj, hiObj, dstObj) {
    if (!(loObj instanceof C.PDFString) || !(hiObj instanceof C.PDFString)) return;
    var lo = bytesToInt(loObj.bytes);
    var hi = bytesToInt(hiObj.bytes);
    if (Array.isArray(dstObj)) {
      for (var i = 0; i <= hi - lo && i < dstObj.length; i++) {
        if (dstObj[i] instanceof C.PDFString) map.set(lo + i, bytesToUtf16Str(dstObj[i].bytes));
      }
    } else if (dstObj instanceof C.PDFString) {
      var baseStr = bytesToUtf16Str(dstObj.bytes);
      var baseCode = baseStr.length ? baseStr.charCodeAt(baseStr.length - 1) : 0;
      for (var c = lo; c <= hi; c++) {
        var suffix = baseStr.slice(0, -1) + String.fromCharCode(baseCode + (c - lo));
        map.set(c, suffix);
      }
    }
  }

  function parseCidWidths(dwDefault, wArray, doc) {
    var widths = new Map();
    var i = 0;
    while (i < wArray.length) {
      var c1 = wArray[i++];
      var next = wArray[i];
      if (Array.isArray(next)) {
        for (var k = 0; k < next.length; k++) widths.set(c1 + k, next[k]);
        i++;
      } else {
        var c2 = wArray[i++];
        var w = wArray[i++];
        for (var c = c1; c <= c2; c++) widths.set(c, w);
      }
    }
    return widths;
  }

  async function resolveFontInfo(doc, fontDict) {
    if (!fontDict) {
      return { bytesPerCode: 1, widthOf: function () { return 500; }, toUnicode: winAnsiFallback, isComposite: false };
    }
    var subtype = fontDict.Subtype instanceof C.PDFName ? fontDict.Subtype.name : "";
    var toUnicodeMap = null;
    var toUnicodeStream = fontDict.ToUnicode ? await doc.resolve(fontDict.ToUnicode) : null;
    if (toUnicodeStream instanceof C.PDFStream) {
      try {
        var bytes = await doc.getStreamBytes(toUnicodeStream);
        toUnicodeMap = parseToUnicodeCMap(bytes);
      } catch (e) {}
    }

    if (subtype === "Type0") {
      var descendants = (await doc.resolve(fontDict.DescendantFonts)) || [];
      var cidFont = descendants.length ? await doc.resolve(descendants[0]) : {};
      var dw = cidFont.DW !== undefined ? await doc.resolve(cidFont.DW) : 1000;
      var wArrayRaw = cidFont.W ? await doc.resolve(cidFont.W) : [];
      var wArray = [];
      for (var i = 0; i < wArrayRaw.length; i++) wArray.push(await doc.resolve(wArrayRaw[i]));
      var cidWidths = parseCidWidths(dw, wArray, doc);
      return {
        bytesPerCode: 2,
        isComposite: true,
        widthOf: function (code) {
          return cidWidths.has(code) ? cidWidths.get(code) : dw;
        },
        toUnicode: function (code) {
          if (toUnicodeMap && toUnicodeMap.has(code)) return toUnicodeMap.get(code);
          return "";
        }
      };
    }

    // Simple font (Type1 / TrueType / MMType1 / Type3)
    var firstChar = fontDict.FirstChar !== undefined ? await doc.resolve(fontDict.FirstChar) : 0;
    var widthsArr = fontDict.Widths ? await doc.resolve(fontDict.Widths) : null;
    var resolvedWidths = null;
    if (widthsArr) {
      resolvedWidths = [];
      for (var j = 0; j < widthsArr.length; j++) resolvedWidths.push(await doc.resolve(widthsArr[j]));
    }
    var baseFontName = fontDict.BaseFont instanceof C.PDFName ? fontDict.BaseFont.name : "";
    var stdMetrics = root.PDFFonts && /Helvetica|Arial/i.test(baseFontName) ? "Helvetica" : null;

    return {
      bytesPerCode: 1,
      isComposite: false,
      widthOf: function (code) {
        if (resolvedWidths && code >= firstChar && code - firstChar < resolvedWidths.length) {
          var w = resolvedWidths[code - firstChar];
          if (typeof w === "number") return w;
        }
        if (stdMetrics) return root.PDFFonts.widthOfChar(stdMetrics, code);
        return 500;
      },
      toUnicode: function (code) {
        if (toUnicodeMap && toUnicodeMap.has(code)) return toUnicodeMap.get(code);
        return winAnsiFallback(code);
      }
    };
  }

  // Splits raw string bytes into an array of character codes according to
  // bytesPerCode (1 or 2, big-endian for 2).
  function splitCodes(bytes, bytesPerCode) {
    var codes = [];
    if (bytesPerCode === 2) {
      for (var i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
    } else {
      for (var j = 0; j < bytes.length; j++) codes.push(bytes[j]);
    }
    return codes;
  }

  root.PDFFontMetrics = { resolveFontInfo: resolveFontInfo, splitCodes: splitCodes };
})(typeof window !== "undefined" ? window : global);
