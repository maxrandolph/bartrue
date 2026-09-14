/*
  A from-scratch PDF object model + parser, written for this project because
  we have no npm/CDN access to a library like pdf-lib or pdf.js. Supports
  enough of ISO 32000-1 to load, edit and re-save typical PDFs: classic xref
  tables, cross-reference streams (1.5+) with object streams, FlateDecode
  (with PNG/TIFF predictors), and encrypted documents (see crypto.js) when
  unlocked with the right password.

  Object representation:
    number, boolean, null       -> JS number/boolean/null
    name        /Foo            -> PDFName instance (.name = "Foo")
    string      (abc) or <6162> -> PDFString instance (.bytes = Uint8Array)
    array       [ ... ]         -> plain JS Array
    dictionary  << ... >>       -> plain JS Object (map of name -> value)
    stream      << >> stream .. -> PDFStream instance (.dict, .raw bytes)
    reference   N G R           -> PDFRef instance (.num, .gen)
*/
(function (root) {
  "use strict";

  function PDFName(name) {
    this.name = name;
  }
  PDFName.prototype.toString = function () {
    return "/" + this.name;
  };

  function PDFString(bytes) {
    // bytes: Uint8Array of raw (already-unescaped) byte content.
    this.bytes = bytes;
  }
  PDFString.fromText = function (text) {
    // Encode as PDFDocEncoding-ish (Latin1 subset) — good enough for ASCII
    // metadata/watermark text, which covers the overwhelming common case.
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return new PDFString(bytes);
  };
  PDFString.prototype.asLatin1 = function () {
    return Array.prototype.map
      .call(this.bytes, function (b) {
        return String.fromCharCode(b);
      })
      .join("");
  };
  // Best-effort decode assuming UTF-16BE BOM (PDF text strings) or Latin1.
  PDFString.prototype.asText = function () {
    var b = this.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      var out = "";
      for (var i = 2; i + 1 < b.length; i += 2) {
        out += String.fromCharCode((b[i] << 8) | b[i + 1]);
      }
      return out;
    }
    return this.asLatin1();
  };

  function PDFRef(num, gen) {
    this.num = num;
    this.gen = gen || 0;
  }
  PDFRef.prototype.key = function () {
    return this.num + "_" + this.gen;
  };
  PDFRef.prototype.toString = function () {
    return this.num + " " + this.gen + " R";
  };

  function PDFStream(dict, raw) {
    this.dict = dict;
    this.raw = raw; // encoded (still-filtered) bytes
  }

  function isName(o, name) {
    return o instanceof PDFName && o.name === name;
  }
  function isDict(o) {
    return o && typeof o === "object" && !(o instanceof PDFName) && !(o instanceof PDFString) &&
      !(o instanceof PDFRef) && !(o instanceof PDFStream) && !Array.isArray(o);
  }

  // ---------------------------------------------------------------------
  // Tokenizer
  // ---------------------------------------------------------------------

  var WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
  var DELIMS = new Set(
    ["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"].map(function (c) {
      return c.charCodeAt(0);
    })
  );

  function isWhite(b) {
    return WHITESPACE.has(b);
  }
  function isDelim(b) {
    return DELIMS.has(b);
  }
  function isRegular(b) {
    return !isWhite(b) && !isDelim(b);
  }

  function Lexer(buf, pos) {
    this.buf = buf;
    this.pos = pos || 0;
    this.len = buf.length;
  }

  Lexer.prototype.peekByte = function () {
    return this.pos < this.len ? this.buf[this.pos] : -1;
  };

  Lexer.prototype.skipWhitespaceAndComments = function () {
    while (this.pos < this.len) {
      var b = this.buf[this.pos];
      if (isWhite(b)) {
        this.pos++;
      } else if (b === 0x25 /* % */) {
        while (this.pos < this.len && this.buf[this.pos] !== 10 && this.buf[this.pos] !== 13) this.pos++;
      } else {
        break;
      }
    }
  };

  // Returns {type, value} or null at EOF. type in:
  // num, name, str, arrStart, arrEnd, dictStart, dictEnd, kw
  Lexer.prototype.next = function () {
    this.skipWhitespaceAndComments();
    if (this.pos >= this.len) return null;
    var b = this.buf[this.pos];

    if (b === 0x2f /* / */) return this.readName();
    if (b === 0x28 /* ( */) return this.readLiteralString();
    if (b === 0x3c /* < */) {
      if (this.buf[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { type: "dictStart" };
      }
      return this.readHexString();
    }
    if (b === 0x3e /* > */) {
      if (this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { type: "dictEnd" };
      }
      this.pos++;
      return this.next();
    }
    if (b === 0x5b /* [ */) {
      this.pos++;
      return { type: "arrStart" };
    }
    if (b === 0x5d /* ] */) {
      this.pos++;
      return { type: "arrEnd" };
    }
    if (b === 0x7b || b === 0x7d) {
      // { } — not used in normal PDF content, skip defensively
      this.pos++;
      return this.next();
    }
    if (
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2b ||
      b === 0x2d ||
      b === 0x2e
    ) {
      return this.readNumber();
    }
    return this.readKeyword();
  };

  Lexer.prototype.readName = function () {
    this.pos++; // skip '/'
    var start = this.pos;
    var out = [];
    while (this.pos < this.len && isRegular(this.buf[this.pos])) {
      var c = this.buf[this.pos];
      if (c === 0x23 /* # */ && this.pos + 2 < this.len) {
        var h = String.fromCharCode(this.buf[this.pos + 1], this.buf[this.pos + 2]);
        if (/^[0-9a-fA-F]{2}$/.test(h)) {
          out.push(parseInt(h, 16));
          this.pos += 3;
          continue;
        }
      }
      out.push(c);
      this.pos++;
    }
    var name = out.map(function (c) { return String.fromCharCode(c); }).join("");
    return { type: "name", value: name };
  };

  Lexer.prototype.readNumber = function () {
    var start = this.pos;
    if (this.buf[this.pos] === 0x2b || this.buf[this.pos] === 0x2d) this.pos++;
    while (this.pos < this.len && ((this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x39) || this.buf[this.pos] === 0x2e)) {
      this.pos++;
    }
    var s = "";
    for (var i = start; i < this.pos; i++) s += String.fromCharCode(this.buf[i]);
    var n = parseFloat(s);
    if (isNaN(n)) n = 0;
    return { type: "num", value: n };
  };

  Lexer.prototype.readKeyword = function () {
    var start = this.pos;
    while (this.pos < this.len && isRegular(this.buf[this.pos])) this.pos++;
    if (this.pos === start) {
      // stray delimiter we don't otherwise handle; skip one byte
      this.pos++;
    }
    var s = "";
    for (var i = start; i < this.pos; i++) s += String.fromCharCode(this.buf[i]);
    return { type: "kw", value: s };
  };

  Lexer.prototype.readLiteralString = function () {
    this.pos++; // (
    var depth = 1;
    var out = [];
    while (this.pos < this.len && depth > 0) {
      var c = this.buf[this.pos++];
      if (c === 0x5c /* \ */) {
        var e = this.buf[this.pos++];
        switch (e) {
          case 0x6e: out.push(10); break; // n
          case 0x72: out.push(13); break; // r
          case 0x74: out.push(9); break; // t
          case 0x62: out.push(8); break; // b
          case 0x66: out.push(12); break; // f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5c: out.push(0x5c); break;
          case 10: break; // line continuation
          case 13:
            if (this.buf[this.pos] === 10) this.pos++;
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              var oct = [e];
              for (var k = 0; k < 2 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37; k++) {
                oct.push(this.buf[this.pos++]);
              }
              var str = oct.map(function (o) { return String.fromCharCode(o); }).join("");
              out.push(parseInt(str, 8) & 0xff);
            } else {
              out.push(e);
            }
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth > 0) out.push(c);
      } else {
        out.push(c);
      }
    }
    return { type: "str", value: new Uint8Array(out) };
  };

  Lexer.prototype.readHexString = function () {
    this.pos++; // <
    var hex = "";
    while (this.pos < this.len && this.buf[this.pos] !== 0x3e) {
      var c = this.buf[this.pos++];
      if (!isWhite(c)) hex += String.fromCharCode(c);
    }
    this.pos++; // >
    if (hex.length % 2 === 1) hex += "0";
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    return { type: "str", value: bytes };
  };

  // ---------------------------------------------------------------------
  // Object parser (operates on a Lexer, produces PDF object graph values)
  // ---------------------------------------------------------------------

  function ObjParser(buf, pos) {
    this.lex = new Lexer(buf, pos);
    this.buf = buf;
  }

  // Parses a single value at the lexer's current position. Handles the
  // "N G R" reference lookahead and dict-vs-stream lookahead.
  ObjParser.prototype.parseValue = function (tok) {
    tok = tok || this.lex.next();
    if (tok === null) return undefined;
    switch (tok.type) {
      case "num":
        return this.maybeReference(tok.value);
      case "name":
        return new PDFName(tok.value);
      case "str":
        return new PDFString(tok.value);
      case "arrStart":
        return this.parseArray();
      case "dictStart":
        return this.parseDictOrStream();
      case "kw":
        if (tok.value === "true") return true;
        if (tok.value === "false") return false;
        if (tok.value === "null") return null;
        return new PDFName("##kw:" + tok.value); // shouldn't normally happen
      default:
        return null;
    }
  };

  ObjParser.prototype.maybeReference = function (firstNum) {
    if (firstNum === Math.floor(firstNum) && firstNum >= 0) {
      var save = this.lex.pos;
      var t2 = this.lex.next();
      if (t2 && t2.type === "num" && t2.value === Math.floor(t2.value) && t2.value >= 0) {
        var save2 = this.lex.pos;
        var t3 = this.lex.next();
        if (t3 && t3.type === "kw" && t3.value === "R") {
          return new PDFRef(firstNum, t2.value);
        }
        this.lex.pos = save2;
        // could be "N G obj" handled elsewhere; restore fully
      }
      this.lex.pos = save;
    }
    return firstNum;
  };

  ObjParser.prototype.parseArray = function () {
    var arr = [];
    while (true) {
      var save = this.lex.pos;
      var tok = this.lex.next();
      if (tok === null || tok.type === "arrEnd") break;
      arr.push(this.parseValue(tok));
    }
    return arr;
  };

  ObjParser.prototype.parseDictOrStream = function () {
    var dict = {};
    while (true) {
      var tok = this.lex.next();
      if (tok === null || tok.type === "dictEnd") break;
      if (tok.type !== "name") continue; // malformed; skip
      var key = tok.value;
      var val = this.parseValue();
      dict[key] = val;
    }
    // Look ahead for "stream" keyword
    var save = this.lex.pos;
    var tok2 = this.lex.next();
    if (tok2 && tok2.type === "kw" && tok2.value === "stream") {
      var p = this.lex.pos;
      // Per spec: stream keyword followed by CRLF or LF (not bare CR)
      if (this.buf[p] === 13 && this.buf[p + 1] === 10) p += 2;
      else if (this.buf[p] === 10) p += 1;
      else if (this.buf[p] === 13) p += 1;
      var length = dict.Length;
      var start = p;
      var end;
      if (typeof length === "number") {
        end = start + length;
      } else {
        end = this.findEndstream(start);
      }
      var raw = this.buf.subarray(start, end);
      this.lex.pos = end;
      var t3 = this.lex.next(); // endstream keyword (best effort)
      if (!(t3 && t3.value === "endstream")) {
        // Length ref was bad or missing; fall back to scanning
        var altEnd = this.findEndstream(start);
        raw = this.buf.subarray(start, altEnd);
        this.lex.pos = altEnd;
        this.lex.next();
      }
      return new PDFStream(dict, raw);
    }
    this.lex.pos = save;
    return dict;
  };

  ObjParser.prototype.findEndstream = function (start) {
    var needle = "endstream";
    var nb = [];
    for (var i = 0; i < needle.length; i++) nb.push(needle.charCodeAt(i));
    for (var p = start; p < this.buf.length - nb.length; p++) {
      var match = true;
      for (var j = 0; j < nb.length; j++) {
        if (this.buf[p + j] !== nb[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        var end = p;
        // trim trailing EOL before "endstream"
        if (this.buf[end - 1] === 10) end--;
        if (this.buf[end - 1] === 13) end--;
        return end;
      }
    }
    return this.buf.length;
  };

  // Parses "N G obj ... endobj" at a given offset, returns the object value.
  ObjParser.prototype.parseIndirectObjectAt = function (offset) {
    this.lex.pos = offset;
    var t1 = this.lex.next(); // num
    var t2 = this.lex.next(); // gen
    var t3 = this.lex.next(); // 'obj'
    if (!t3 || t3.value !== "obj") {
      // best effort: rewind and try parsing as raw value anyway
      this.lex.pos = offset;
    }
    return this.parseValue();
  };

  root.PDFCore = {
    PDFName: PDFName,
    PDFString: PDFString,
    PDFRef: PDFRef,
    PDFStream: PDFStream,
    Lexer: Lexer,
    ObjParser: ObjParser,
    isName: isName,
    isDict: isDict
  };
})(typeof window !== "undefined" ? window : global);
