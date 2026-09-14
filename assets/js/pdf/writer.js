/*
  Serializes a PDFDocument (loaded + edited, or freshly created) back to
  PDF bytes. Always performs a full rewrite with contiguous renumbering
  (1..N) and a classic (non-stream) xref table + trailer — the simplest
  approach to get right from scratch, and universally compatible with
  every PDF reader. Encryption, if any, is dropped (documents are read
  decrypted; re-protecting a PDF is a separate future tool).
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;

  function ByteWriter() {
    this.parts = [];
    this.length = 0;
  }
  ByteWriter.prototype.writeLatin1 = function (str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    this.writeBytes(bytes);
  };
  ByteWriter.prototype.writeBytes = function (bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
  };
  ByteWriter.prototype.toUint8Array = function () {
    var out = new Uint8Array(this.length);
    var p = 0;
    for (var i = 0; i < this.parts.length; i++) {
      out.set(this.parts[i], p);
      p += this.parts[i].length;
    }
    return out;
  };

  function formatNumber(n) {
    if (!isFinite(n)) return "0";
    if (Number.isInteger(n)) return String(n);
    var s = n.toFixed(6);
    s = s.replace(/0+$/, "").replace(/\.$/, "");
    if (s === "" || s === "-") s = "0";
    return s;
  }

  function escapeName(name) {
    var out = "/";
    for (var i = 0; i < name.length; i++) {
      var c = name.charCodeAt(i);
      var ch = name[i];
      if (c <= 0x20 || c >= 0x7f || "()<>[]{}/%#".indexOf(ch) !== -1) {
        out += "#" + c.toString(16).padStart(2, "0");
      } else {
        out += ch;
      }
    }
    return out;
  }

  function hexString(bytes) {
    var out = "<";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out + ">";
  }

  // Deep-clones a value, renumbering any PDFRef via oldToNew (refs to
  // objects outside the map are dropped to PDFNull-ish `null`).
  function renumber(value, oldToNew) {
    if (value instanceof C.PDFRef) {
      var newNum = oldToNew.get(value.num);
      return newNum ? new C.PDFRef(newNum, 0) : null;
    }
    if (value instanceof C.PDFStream) {
      var dict = renumber(value.dict, oldToNew);
      return new C.PDFStream(dict, value.raw);
    }
    if (Array.isArray(value)) {
      return value.map(function (v) {
        return renumber(v, oldToNew);
      });
    }
    if (value instanceof C.PDFName || value instanceof C.PDFString) return value;
    if (value && typeof value === "object") {
      var out = {};
      for (var k in value) {
        if (value[k] === undefined) continue;
        out[k] = renumber(value[k], oldToNew);
      }
      return out;
    }
    return value; // number, boolean, null, string(shouldn't happen), undefined
  }

  function serializeValue(value, w) {
    if (value === undefined || value === null) {
      w.writeLatin1("null");
    } else if (value === true) {
      w.writeLatin1("true");
    } else if (value === false) {
      w.writeLatin1("false");
    } else if (typeof value === "number") {
      w.writeLatin1(formatNumber(value));
    } else if (value instanceof C.PDFName) {
      w.writeLatin1(escapeName(value.name));
    } else if (value instanceof C.PDFString) {
      w.writeLatin1(hexString(value.bytes));
    } else if (value instanceof C.PDFRef) {
      w.writeLatin1(value.num + " " + value.gen + " R");
    } else if (Array.isArray(value)) {
      w.writeLatin1("[");
      for (var i = 0; i < value.length; i++) {
        if (i > 0) w.writeLatin1(" ");
        serializeValue(value[i], w);
      }
      w.writeLatin1("]");
    } else if (value instanceof C.PDFStream) {
      serializeDict(value.dict, w, value.raw.length);
      w.writeLatin1("\nstream\n");
      w.writeBytes(value.raw);
      w.writeLatin1("\nendstream");
    } else if (typeof value === "object") {
      serializeDict(value, w, null);
    } else {
      w.writeLatin1("null");
    }
  }

  function serializeDict(dict, w, forcedLength) {
    w.writeLatin1("<<");
    var keys = Object.keys(dict).filter(function (k) {
      return k !== "Length" && dict[k] !== undefined;
    });
    for (var i = 0; i < keys.length; i++) {
      w.writeLatin1(" " + escapeName(keys[i]) + " ");
      serializeValue(dict[keys[i]], w);
    }
    if (forcedLength !== null) {
      w.writeLatin1(" " + escapeName("Length") + " " + forcedLength);
    }
    w.writeLatin1(" >>");
  }

  async function save(doc) {
    var origNums = doc.allObjectNumbers();
    var values = new Map();
    for (var i = 0; i < origNums.length; i++) {
      try {
        var v = await doc.getObject(origNums[i]);
        if (v !== null && v !== undefined) values.set(origNums[i], v);
      } catch (e) {
        /* skip unreadable/dangling object */
      }
    }

    var oldToNew = new Map();
    var newNum = 1;
    values.forEach(function (_, oldNum) {
      oldToNew.set(oldNum, newNum++);
    });

    var renumbered = new Map();
    values.forEach(function (v, oldNum) {
      renumbered.set(oldToNew.get(oldNum), renumber(v, oldToNew));
    });

    var w = new ByteWriter();
    w.writeLatin1("%PDF-1.7\n%\xc2\xa5\xc2\xb1\xc3\xab\n"); // binary-marker comment (helps tools detect binary-safe PDF)

    var offsets = new Array(newNum); // index by new object number
    for (var n = 1; n < newNum; n++) {
      offsets[n] = w.length;
      w.writeLatin1(n + " 0 obj\n");
      serializeValue(renumbered.get(n), w);
      w.writeLatin1("\nendobj\n");
    }

    var xrefOffset = w.length;
    w.writeLatin1("xref\n0 " + newNum + "\n");
    w.writeLatin1("0000000000 65535 f \n");
    for (var m = 1; m < newNum; m++) {
      w.writeLatin1(String(offsets[m]).padStart(10, "0") + " 00000 n \n");
    }

    var trailer = {};
    trailer.Root = mapRefOnly(doc.trailer.Root, oldToNew);
    if (doc.trailer.Info) trailer.Info = mapRefOnly(doc.trailer.Info, oldToNew);
    trailer.Size = newNum;

    w.writeLatin1("trailer\n");
    serializeValue(trailer, w);
    w.writeLatin1("\nstartxref\n" + xrefOffset + "\n%%EOF");

    return w.toUint8Array();
  }

  function mapRefOnly(ref, oldToNew) {
    if (ref instanceof C.PDFRef) {
      var n = oldToNew.get(ref.num);
      return n ? new C.PDFRef(n, 0) : null;
    }
    return ref || null;
  }

  root.PDFWriter = { save: save, formatNumber: formatNumber, ByteWriter: ByteWriter };
})(typeof window !== "undefined" ? window : global);
