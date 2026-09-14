/*
  High-level PDFDocument: loads a whole PDF (xref table or xref stream,
  object streams, page tree, filters, optional decryption) into an
  in-memory object graph, and offers a small editing API. Pairs with
  writer.js which serializes a PDFDocument back to bytes.

  Everything that might touch a stream filter (FlateDecode via the native,
  Promise-based CompressionStream API) or WebCrypto decryption is async, so
  the whole loading/resolution chain uses async/await consistently.
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;
  var Flate = root.PDFFlate;

  function bytesToLatin1(bytes) {
    var s = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }

  function findLast(buf, needle) {
    var nb = [];
    for (var i = 0; i < needle.length; i++) nb.push(needle.charCodeAt(i));
    for (var p = buf.length - nb.length; p >= 0; p--) {
      var ok = true;
      for (var j = 0; j < nb.length; j++) {
        if (buf[p + j] !== nb[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return p;
    }
    return -1;
  }

  function ascii85Decode(data) {
    var str = bytesToLatin1(data).trim();
    if (str.slice(0, 2) === "<~") str = str.slice(2);
    if (str.slice(-2) === "~>") str = str.slice(0, -2);
    str = str.replace(/\s/g, "");
    var out = [];
    var chunk = [];
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (c === "z" && chunk.length === 0) {
        out.push(0, 0, 0, 0);
        continue;
      }
      chunk.push(c.charCodeAt(0) - 33);
      if (chunk.length === 5) {
        var n = 0;
        for (var k = 0; k < 5; k++) n = n * 85 + chunk[k];
        out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
        chunk = [];
      }
    }
    if (chunk.length > 0) {
      var padCount = 5 - chunk.length;
      for (var p = 0; p < padCount; p++) chunk.push(84);
      var n2 = 0;
      for (var k2 = 0; k2 < 5; k2++) n2 = n2 * 85 + chunk[k2];
      var bytes4 = [(n2 >>> 24) & 0xff, (n2 >>> 16) & 0xff, (n2 >>> 8) & 0xff, n2 & 0xff];
      out.push.apply(out, bytes4.slice(0, 4 - padCount));
    }
    return new Uint8Array(out);
  }

  function PDFDocument() {
    this.buf = null;
    this.xref = new Map(); // num -> {offset} | {inStream, index}
    this.trailer = {};
    this.cache = new Map(); // num -> parsed object
    this.objStmCache = new Map(); // stream num -> {objects: Map(num->value)}
    this.nextObjNum = 1;
    this.password = "";
    this.decryptor = null; // set by crypto.js if the doc is encrypted & unlocked
    this._pagesCache = null;
  }

  PDFDocument.load = async function (bytes, opts) {
    opts = opts || {};
    var doc = new PDFDocument();
    doc.buf = bytes;
    doc.password = opts.password || "";
    await doc._parseXref();
    doc.nextObjNum = doc._computeNextObjNum();
    if (doc.trailer.Encrypt && root.PDFCrypto) {
      doc.decryptor = await root.PDFCrypto.setup(doc, doc.password);
    } else if (doc.trailer.Encrypt) {
      throw new Error("This PDF is encrypted and the crypto module is not loaded.");
    }
    return doc;
  };

  PDFDocument.create = function () {
    var doc = new PDFDocument();
    doc.buf = new Uint8Array(0);
    doc.newObjects = new Map();
    var catalog = { Type: new C.PDFName("Catalog") };
    var pagesNode = { Type: new C.PDFName("Pages"), Kids: [], Count: 0 };
    var pagesRef = doc.addObject(pagesNode);
    catalog.Pages = pagesRef;
    var rootRef = doc.addObject(catalog);
    doc.trailer.Root = rootRef;
    return doc;
  };

  PDFDocument.prototype._computeNextObjNum = function () {
    var max = 0;
    this.xref.forEach(function (_, num) {
      if (num > max) max = num;
    });
    return max + 1;
  };

  // ---------------- xref parsing ----------------

  PDFDocument.prototype._parseXref = async function () {
    var buf = this.buf;
    var pos = findLast(buf, "startxref");
    if (pos === -1) {
      await this._reconstructXrefByScanning();
      return;
    }
    var lex = new C.Lexer(buf, pos + "startxref".length);
    var tok = lex.next();
    var offset = tok && tok.type === "num" ? tok.value : -1;
    var seen = new Set();
    try {
      while (offset >= 0 && offset < buf.length && !seen.has(offset)) {
        seen.add(offset);
        offset = await this._parseXrefSection(offset);
      }
    } catch (e) {
      /* fall through to reconstruction below */
    }
    if (this.xref.size === 0 || !this.trailer.Root) {
      await this._reconstructXrefByScanning();
    }
  };

  PDFDocument.prototype._parseXrefSection = async function (offset) {
    var buf = this.buf;
    var lex = new C.Lexer(buf, offset);
    var save = lex.pos;
    var tok = lex.next();
    if (tok && tok.type === "kw" && tok.value === "xref") {
      return this._parseClassicXref(lex);
    }
    lex.pos = save;
    var parser = new C.ObjParser(buf, offset);
    var obj = parser.parseIndirectObjectAt(offset);
    if (!(obj instanceof C.PDFStream)) throw new Error("bad xref");
    return this._parseXrefStream(obj);
  };

  PDFDocument.prototype._parseClassicXref = async function (lex) {
    while (true) {
      var save = lex.pos;
      var t = lex.next();
      if (!t) break;
      if (t.type === "kw" && t.value === "trailer") break;
      if (t.type !== "num") {
        lex.pos = save;
        break;
      }
      var startNum = t.value;
      var t2 = lex.next();
      var count = t2.value;
      for (var i = 0; i < count; i++) {
        lex.skipWhitespaceAndComments();
        var entryStr = bytesToLatin1(lex.buf.subarray(lex.pos, lex.pos + 20));
        lex.pos += 20;
        var m = /^(\d{10})\s(\d{5})\s([nf])/.exec(entryStr);
        var num = startNum + i;
        if (m) {
          if (m[3] === "n" && !this.xref.has(num)) {
            this.xref.set(num, { offset: parseInt(m[1], 10) });
          }
        }
      }
    }
    var parser = new C.ObjParser(lex.buf, lex.pos);
    var trailerDict = parser.parseValue();
    for (var k in trailerDict) {
      if (!(k in this.trailer)) this.trailer[k] = trailerDict[k];
    }
    if (trailerDict.XRefStm !== undefined) {
      try {
        await this._parseXrefSection(trailerDict.XRefStm);
      } catch (e) {}
    }
    return trailerDict.Prev !== undefined ? trailerDict.Prev : -1;
  };

  PDFDocument.prototype._parseXrefStream = async function (streamObj) {
    var dict = streamObj.dict;
    var data = await this._rawDecode(streamObj); // xref streams are never encrypted
    var W = dict.W;
    var size = dict.Size;
    var index = dict.Index ? dict.Index : [0, size];
    var recLen = W[0] + W[1] + W[2];
    var p = 0;
    for (var s = 0; s < index.length; s += 2) {
      var startNum = index[s];
      var count = index[s + 1];
      for (var i = 0; i < count; i++) {
        var rec = data.subarray(p, p + recLen);
        p += recLen;
        var fields = [];
        var off = 0;
        for (var w = 0; w < 3; w++) {
          var val = 0;
          for (var b = 0; b < W[w]; b++) val = val * 256 + rec[off + b];
          off += W[w];
          fields.push(W[w] === 0 && w === 0 ? 1 : val);
        }
        var num = startNum + i;
        if (this.xref.has(num)) continue;
        if (fields[0] === 1) {
          this.xref.set(num, { offset: fields[1] });
        } else if (fields[0] === 2) {
          this.xref.set(num, { inStream: fields[1], index: fields[2] });
        }
      }
    }
    for (var k in dict) {
      if (!(k in this.trailer) && k !== "Length" && k !== "Filter" && k !== "DecodeParms" && k !== "W" && k !== "Index") {
        this.trailer[k] = dict[k];
      }
    }
    return dict.Prev !== undefined ? dict.Prev : -1;
  };

  PDFDocument.prototype._reconstructXrefByScanning = async function () {
    var buf = this.buf;
    var text = bytesToLatin1(buf);
    var re = /(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b/g;
    var m;
    while ((m = re.exec(text))) {
      this.xref.set(parseInt(m[1], 10), { offset: m.index });
    }
    if (!this.trailer.Root) {
      var tm = /trailer\s*<</.exec(text);
      if (tm) {
        try {
          var parser = new C.ObjParser(buf, tm.index + "trailer".length);
          var trailerDict = parser.parseValue();
          if (trailerDict && trailerDict.Root) this.trailer.Root = trailerDict.Root;
          if (trailerDict && trailerDict.Size) this.trailer.Size = trailerDict.Size;
        } catch (e) {}
      }
    }
    if (!this.trailer.Root) {
      var nums = Array.from(this.xref.keys());
      for (var i = 0; i < nums.length; i++) {
        try {
          var obj = await this.getObject(nums[i]);
          if (C.isDict(obj) && C.isName(obj.Type, "Catalog")) {
            this.trailer.Root = new C.PDFRef(nums[i], 0);
            break;
          }
        } catch (e) {}
      }
    }
    if (!this.trailer.Size) {
      var maxNum = 0;
      this.xref.forEach(function (_, num) {
        if (num > maxNum) maxNum = num;
      });
      this.trailer.Size = maxNum + 1;
    }
  };

  // ---------------- object access ----------------

  PDFDocument.prototype.resolve = async function (obj) {
    var seen = 0;
    while (obj instanceof C.PDFRef && seen++ < 64) {
      obj = await this.getObject(obj.num, obj.gen);
    }
    return obj;
  };

  // Synchronous resolve for values we already know are fully cached
  // (used in hot paths after a document is fully loaded/warmed).
  PDFDocument.prototype.resolveCached = function (obj) {
    var seen = 0;
    while (obj instanceof C.PDFRef && seen++ < 64) {
      obj = (this.newObjects && this.newObjects.get(obj.num)) !== undefined
        ? this.newObjects.get(obj.num)
        : this.cache.get(obj.num);
    }
    return obj;
  };

  PDFDocument.prototype.getObject = async function (num) {
    if (this.newObjects && this.newObjects.has(num)) return this.newObjects.get(num);
    if (this.cache.has(num)) return this.cache.get(num);
    var info = this.xref.get(num);
    if (!info) return null;
    var value;
    if (info.offset !== undefined) {
      var parser = new C.ObjParser(this.buf, info.offset);
      value = parser.parseIndirectObjectAt(info.offset);
      if (this.decryptor) value = await this.decryptor.decryptObject(value, num, info.gen || 0);
    } else {
      value = await this._getFromObjStream(info.inStream, info.index);
    }
    this.cache.set(num, value);
    return value;
  };

  PDFDocument.prototype._getFromObjStream = async function (streamNum, indexWithinStream) {
    var entry = this.objStmCache.get(streamNum);
    if (!entry) {
      var streamObj = await this.getObject(streamNum);
      var data = await this._rawDecode(streamObj);
      var n = streamObj.dict.N;
      var first = streamObj.dict.First;
      var lex = new C.Lexer(data, 0);
      var pairs = [];
      for (var i = 0; i < n; i++) {
        var t1 = lex.next(),
          t2 = lex.next();
        pairs.push([t1.value, t2.value]);
      }
      var objects = new Map(); // objNum -> value
      var order = [];
      for (var j = 0; j < pairs.length; j++) {
        var objNum = pairs[j][0];
        var off = first + pairs[j][1];
        var p2 = new C.ObjParser(data, off);
        objects.set(objNum, p2.parseValue());
        order.push(objNum);
      }
      entry = { objects: objects, order: order };
      this.objStmCache.set(streamNum, entry);
    }
    var objNum = entry.order[indexWithinStream];
    return entry.objects.get(objNum);
  };

  PDFDocument.prototype._rawDecode = async function (streamObj) {
    var dict = streamObj.dict;
    var data = streamObj.raw;
    var filters = dict.Filter;
    if (!filters) return data;
    if (!Array.isArray(filters)) filters = [filters];
    var parms = dict.DecodeParms || dict.DP;
    if (!Array.isArray(parms)) parms = [parms];
    for (var i = 0; i < filters.length; i++) {
      var fname = filters[i] instanceof C.PDFName ? filters[i].name : filters[i];
      var parm = (await this.resolve(parms[i])) || {};
      data = await this._applyFilter(fname, data, parm);
    }
    return data;
  };

  PDFDocument.prototype._applyFilter = async function (fname, data, parm) {
    if (fname === "FlateDecode" || fname === "Fl") {
      var out = await Flate.inflate(data);
      var predictor = (await this.resolve(parm.Predictor)) || 1;
      if (predictor >= 10) {
        out = Flate.undoPngPredictor(
          out,
          (await this.resolve(parm.Colors)) || 1,
          (await this.resolve(parm.BitsPerComponent)) || 8,
          (await this.resolve(parm.Columns)) || 1
        );
      } else if (predictor === 2) {
        out = Flate.undoTiffPredictor(
          out,
          (await this.resolve(parm.Colors)) || 1,
          (await this.resolve(parm.BitsPerComponent)) || 8,
          (await this.resolve(parm.Columns)) || 1
        );
      }
      return out;
    }
    if (fname === "ASCIIHexDecode" || fname === "AHx") {
      var hex = bytesToLatin1(data).replace(/[^0-9a-fA-F]/g, "");
      var bytes = new Uint8Array(hex.length >> 1);
      for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      return bytes;
    }
    if (fname === "ASCII85Decode" || fname === "A85") {
      return ascii85Decode(data);
    }
    // DCTDecode (JPEG), CCITTFaxDecode, JBIG2Decode, JPXDecode: left as-is;
    // image-consuming code decodes JPEG via the browser instead.
    return data;
  };

  PDFDocument.prototype.getStreamBytes = async function (streamObj) {
    return this._rawDecode(streamObj);
  };

  // ---------------- page tree ----------------

  PDFDocument.prototype.getCatalog = async function () {
    return this.resolve(this.trailer.Root);
  };

  PDFDocument.prototype.getPages = async function () {
    if (this._pagesCache) return this._pagesCache;
    var catalog = await this.getCatalog();
    var pages = [];
    var self = this;
    var visited = new Set();

    async function walk(nodeRef, inherited) {
      var node = await self.resolve(nodeRef);
      if (!node) return;
      var merged = {
        Resources: node.Resources !== undefined ? node.Resources : inherited.Resources,
        MediaBox: node.MediaBox !== undefined ? node.MediaBox : inherited.MediaBox,
        CropBox: node.CropBox !== undefined ? node.CropBox : inherited.CropBox,
        Rotate: node.Rotate !== undefined ? node.Rotate : inherited.Rotate
      };
      var isPagesNode = C.isName(node.Type, "Pages") || (node.Kids !== undefined && !C.isName(node.Type, "Page"));
      if (isPagesNode) {
        var kids = (await self.resolve(node.Kids)) || [];
        for (var i = 0; i < kids.length; i++) {
          var key = kids[i] instanceof C.PDFRef ? kids[i].key() : "anon" + Math.random();
          if (visited.has(key)) continue;
          visited.add(key);
          await walk(kids[i], merged);
        }
      } else {
        pages.push({ ref: nodeRef, dict: node, inherited: merged });
      }
    }
    await walk(catalog.Pages, {});
    this._pagesCache = pages;
    return pages;
  };

  PDFDocument.prototype.getPageCount = async function () {
    return (await this.getPages()).length;
  };

  PDFDocument.prototype.getPageBox = async function (pageEntry, which) {
    which = which || "MediaBox";
    var box = (await this.resolve(pageEntry.dict[which])) || (await this.resolve(pageEntry.inherited[which]));
    if (!box) box = [0, 0, 612, 792];
    var resolved = [];
    for (var i = 0; i < box.length; i++) resolved.push(await this.resolve(box[i]));
    return resolved.map(function (n) {
      return typeof n === "number" ? n : 0;
    });
  };

  PDFDocument.prototype.getPageRotate = async function (pageEntry) {
    var r = pageEntry.dict.Rotate !== undefined ? await this.resolve(pageEntry.dict.Rotate) : await this.resolve(pageEntry.inherited.Rotate);
    r = r || 0;
    return ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  };

  PDFDocument.prototype.getPageResources = async function (pageEntry) {
    return (await this.resolve(pageEntry.dict.Resources)) || (await this.resolve(pageEntry.inherited.Resources)) || {};
  };

  PDFDocument.prototype.getPageContentBytes = async function (pageEntry) {
    var contents = await this.resolve(pageEntry.dict.Contents);
    if (!contents) return new Uint8Array(0);
    var streams = Array.isArray(contents) ? contents : [contents];
    var parts = [];
    var total = 0;
    for (var i = 0; i < streams.length; i++) {
      var s = await this.resolve(streams[i]);
      if (s instanceof C.PDFStream) {
        var bytes = await this._rawDecode(s);
        parts.push(bytes);
        total += bytes.length + 1;
      }
    }
    var out = new Uint8Array(total);
    var p = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], p);
      p += parts[j].length;
      out[p++] = 10;
    }
    return out;
  };

  // ---------------- mutation helpers ----------------

  PDFDocument.prototype.addObject = function (value) {
    this.newObjects = this.newObjects || new Map();
    var num = this.nextObjNum++;
    this.newObjects.set(num, value);
    return new C.PDFRef(num, 0);
  };

  PDFDocument.prototype.setObject = function (ref, value) {
    this.newObjects = this.newObjects || new Map();
    this.newObjects.set(ref.num, value);
    this.cache.set(ref.num, value);
  };

  PDFDocument.prototype.getInfoDict = async function () {
    return (await this.resolve(this.trailer.Info)) || {};
  };

  PDFDocument.prototype.setInfoDict = function (dict) {
    if (this.trailer.Info instanceof C.PDFRef) {
      this.setObject(this.trailer.Info, dict);
    } else {
      this.trailer.Info = this.addObject(dict);
    }
  };

  PDFDocument.prototype.allObjectNumbers = function () {
    var nums = new Set();
    this.xref.forEach(function (_, num) {
      nums.add(num);
    });
    if (this.newObjects) this.newObjects.forEach(function (_, num) { nums.add(num); });
    return Array.from(nums).sort(function (a, b) { return a - b; });
  };

  PDFDocument.prototype.save = async function () {
    return root.PDFWriter.save(this);
  };

  root.PDFDocument = PDFDocument;
  root.PDFDocUtil = { bytesToLatin1: bytesToLatin1, findLast: findLast, ascii85Decode: ascii85Decode };
})(typeof window !== "undefined" ? window : global);
