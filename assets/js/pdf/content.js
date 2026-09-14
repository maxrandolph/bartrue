/*
  Content-stream tokenizer + a minimal graphics/text-state walker. Shared by
  pdf-to-text, redact-pdf and pdf-grayscale — anything that needs to know
  "what text is where" or "what color is being painted" inside a page's
  drawing instructions.
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;

  // ---- 2D affine matrix helpers: [a b c d e f] maps (x,y) -> (a*x+c*y+e, b*x+d*y+f)
  function matMul(m1, m2) {
    // returns m1 * m2 (apply m1 first, then m2) matching PDF's "new = old x m" convention
    return [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
      m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
    ];
  }
  function applyMat(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  var IDENTITY = [1, 0, 0, 1, 0, 0];

  // ---- Tokenizer: turns decoded content-stream bytes into a flat op list.
  function tokenizeContent(buf) {
    var lex = new C.Lexer(buf, 0);
    var parser = new C.ObjParser(buf, 0);
    parser.lex = lex;
    var ops = [];
    var stack = [];
    while (true) {
      lex.skipWhitespaceAndComments();
      if (lex.pos >= lex.len) break;
      var startPos = lex.pos;
      var tok = lex.next();
      if (!tok) break;
      if (tok.type === "kw") {
        if (tok.value === "true") { stack.push(true); continue; }
        if (tok.value === "false") { stack.push(false); continue; }
        if (tok.value === "BI") {
          // inline image: skip to "EI" defensively (binary-safe heuristic)
          skipInlineImage(lex);
          continue;
        }
        ops.push({ op: tok.value, args: stack, pos: startPos });
        stack = [];
      } else {
        stack.push(parser.parseValue(tok));
      }
    }
    return ops;
  }

  function skipInlineImage(lex) {
    // Find "ID" keyword marking start of binary data, then scan for "EI"
    // preceded by whitespace (a reasonable, widely-used heuristic).
    var buf = lex.buf;
    var p = lex.pos;
    var idPos = -1;
    while (p < buf.length - 1) {
      if (buf[p] === 0x49 && buf[p + 1] === 0x44 && (p === 0 || isWs(buf[p - 1]))) {
        idPos = p;
        break;
      }
      p++;
    }
    if (idPos === -1) {
      lex.pos = buf.length;
      return;
    }
    var dataStart = idPos + 2;
    if (isWs(buf[dataStart])) dataStart++;
    var q = dataStart;
    while (q < buf.length - 1) {
      if (buf[q] === 0x45 && buf[q + 1] === 0x49 && isWs(buf[q - 1]) && (q + 2 >= buf.length || isWs(buf[q + 2]) || buf[q+2] === undefined)) {
        lex.pos = q + 2;
        return;
      }
      q++;
    }
    lex.pos = buf.length;
  }
  function isWs(b) {
    return b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
  }

  // ---- Text-run walker: invokes onText(run) for each text-showing op, and
  // onOther(op) for everything else (so callers can rewrite non-text ops
  // verbatim, e.g. for grayscale color rewriting).
  //
  // run = { op, tm (matrix at time of draw, text space -> page space,
  //         already includes font size scaling for a unit glyph-space box),
  //         font (resolved font dict), fontKey, fontSize, items (array of
  //         {bytes:Uint8Array} | {adjust:number} for TJ), argsIndex }
  async function walkContent(doc, ops, resources, onText, onOther) {
    var gsStack = [];
    var ctm = IDENTITY;
    var tm = IDENTITY,
      tlm = IDENTITY;
    var fontKey = null,
      fontSize = 1,
      charSpace = 0,
      wordSpace = 0,
      hscale = 1,
      leading = 0,
      rise = 0;
    var fontCache = new Map();

    async function getFont(key) {
      if (!key) return null;
      if (fontCache.has(key)) return fontCache.get(key);
      var fontsDict = (await doc.resolve(resources.Font)) || {};
      var fontRef = fontsDict[key];
      var font = fontRef !== undefined ? await doc.resolve(fontRef) : null;
      fontCache.set(key, font);
      return font;
    }

    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      switch (o.op) {
        case "q":
          gsStack.push({ ctm: ctm });
          break;
        case "Q":
          var s = gsStack.pop();
          if (s) ctm = s.ctm;
          break;
        case "cm":
          ctm = matMul(numArgs(o.args), ctm);
          break;
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "ET":
          break;
        case "Tf":
          fontKey = o.args[0] instanceof C.PDFName ? o.args[0].name : String(o.args[0]);
          fontSize = num(o.args[1]);
          break;
        case "Tc":
          charSpace = num(o.args[0]);
          break;
        case "Tw":
          wordSpace = num(o.args[0]);
          break;
        case "Tz":
          hscale = num(o.args[0]) / 100;
          break;
        case "TL":
          leading = num(o.args[0]);
          break;
        case "Ts":
          rise = num(o.args[0]);
          break;
        case "Td": {
          var tx = num(o.args[0]), ty = num(o.args[1]);
          tlm = matMul([1, 0, 0, 1, tx, ty], tlm);
          tm = tlm;
          break;
        }
        case "TD": {
          var tx2 = num(o.args[0]), ty2 = num(o.args[1]);
          leading = -ty2;
          tlm = matMul([1, 0, 0, 1, tx2, ty2], tlm);
          tm = tlm;
          break;
        }
        case "Tm":
          tlm = numArgs(o.args);
          tm = tlm;
          break;
        case "T*":
          tlm = matMul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
          break;
        case "Tj":
        case "'":
        case '"': {
          if (o.op !== "Tj") {
            if (o.op === "'") {
              tlm = matMul([1, 0, 0, 1, 0, -leading], tlm);
              tm = tlm;
            } else {
              wordSpace = num(o.args[0]);
              charSpace = num(o.args[1]);
              tlm = matMul([1, 0, 0, 1, 0, -leading], tlm);
              tm = tlm;
            }
          }
          var strArg = o.args[o.args.length - 1];
          var font = await getFont(fontKey);
          var trm = matMul([fontSize * hscale, 0, 0, fontSize, 0, rise], matMul(tm, ctm));
          var newTm = await onText({
            op: o.op,
            items: [{ bytes: strArg instanceof C.PDFString ? strArg.bytes : new Uint8Array(0) }],
            font: font,
            fontKey: fontKey,
            fontSize: fontSize,
            charSpace: charSpace,
            wordSpace: wordSpace,
            hscale: hscale,
            tm: tm,
            ctm: ctm,
            trm: trm,
            opIndex: i
          });
          if (newTm) tm = newTm;
          break;
        }
        case "TJ": {
          var arr = o.args[0] || [];
          var items = arr.map(function (el) {
            return el instanceof C.PDFString ? { bytes: el.bytes } : { adjust: num(el) };
          });
          var font2 = await getFont(fontKey);
          var trm2 = matMul([fontSize * hscale, 0, 0, fontSize, 0, rise], matMul(tm, ctm));
          var newTm2 = await onText({
            op: "TJ",
            items: items,
            font: font2,
            fontKey: fontKey,
            fontSize: fontSize,
            charSpace: charSpace,
            wordSpace: wordSpace,
            hscale: hscale,
            tm: tm,
            ctm: ctm,
            trm: trm2,
            opIndex: i
          });
          if (newTm2) tm = newTm2;
          break;
        }
        default:
          if (onOther) onOther(o, { ctm: ctm });
      }
    }
  }

  function num(v) {
    return typeof v === "number" ? v : 0;
  }
  function numArgs(args) {
    return [num(args[0]), num(args[1]), num(args[2]), num(args[3]), num(args[4]), num(args[5])];
  }

  // Advances a text matrix the way PDF does after showing glyphs with a
  // known total "unscaled" width (in glyph-space/1000 units, already summed
  // across the run including spacing), returning the new text matrix.
  function advanceTm(tm, widthTextSpace) {
    return matMul([1, 0, 0, 1, widthTextSpace, 0], tm);
  }

  function serializeContentValue(value) {
    if (value === null || value === undefined) return "null";
    if (value === true) return "true";
    if (value === false) return "false";
    if (typeof value === "number") {
      if (Number.isInteger(value)) return String(value);
      var s = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
      return s === "" || s === "-" ? "0" : s;
    }
    if (value instanceof C.PDFName) return "/" + value.name;
    if (value instanceof C.PDFString) {
      var hex = "<";
      for (var i = 0; i < value.bytes.length; i++) hex += value.bytes[i].toString(16).padStart(2, "0");
      return hex + ">";
    }
    if (Array.isArray(value)) {
      return "[" + value.map(serializeContentValue).join(" ") + "]";
    }
    return "";
  }

  // Rebuilds content-stream bytes from a tokenized op list, dropping any
  // op whose index is in `skipSet` (used by redact to remove text-showing
  // operators) and otherwise honoring possibly-mutated `op.args`.
  function serializeOps(ops, skipSet) {
    var lines = [];
    for (var i = 0; i < ops.length; i++) {
      if (skipSet && skipSet.has(i)) continue;
      var o = ops[i];
      var argStrs = o.args.map(serializeContentValue);
      lines.push(argStrs.concat([o.op]).join(" "));
    }
    return new TextEncoder().encode(lines.join("\n") + "\n");
  }

  root.PDFContent = {
    tokenizeContent: tokenizeContent,
    walkContent: walkContent,
    matMul: matMul,
    applyMat: applyMat,
    IDENTITY: IDENTITY,
    advanceTm: advanceTm,
    serializeOps: serializeOps
  };
})(typeof window !== "undefined" ? window : global);
