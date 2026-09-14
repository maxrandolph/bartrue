/*
  PDF Standard Security Handler support (ISO 32000-1 Algorithm 2/1) for the
  Unlock PDF tool: derives the file decryption key from a user password and
  decrypts strings/streams with RC4 or AES-128-CBC (revisions 2-4, i.e.
  40-bit/128-bit RC4 and 128-bit AES — the overwhelming majority of
  password-protected PDFs found in the wild). AES-256 (revision 5/6, PDF
  2.0) is detected and reported as unsupported rather than silently
  mishandled.

  WebCrypto (crypto.subtle) provides AES-CBC; MD5 has no native browser API
  so it's implemented here from the well-known public algorithm (RFC 1321).
*/
(function (root) {
  "use strict";
  var C = root.PDFCore;

  // ---------------- MD5 (RFC 1321) ----------------
  function md5(bytes) {
    function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
    var s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    var K = new Int32Array(64);
    for (var i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;

    var msgLen = bytes.length;
    var withOne = msgLen + 1;
    var padLen = ((withOne + 8 + 63) & ~63);
    var buf = new Uint8Array(padLen);
    buf.set(bytes);
    buf[msgLen] = 0x80;
    var bitLenLow = (msgLen * 8) >>> 0;
    var bitLenHigh = Math.floor((msgLen * 8) / 0x100000000) >>> 0;
    var dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, bitLenLow, true);
    dv.setUint32(padLen - 4, bitLenHigh, true);

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    for (var chunk = 0; chunk < padLen; chunk += 64) {
      var M = new Int32Array(16);
      for (var j = 0; j < 16; j++) M[j] = dv.getInt32(chunk + j * 4, true);
      var A = a0, B = b0, Cc = c0, D = d0;
      for (var k = 0; k < 64; k++) {
        var F, g;
        if (k < 16) { F = (B & Cc) | (~B & D); g = k; }
        else if (k < 32) { F = (D & B) | (~D & Cc); g = (5 * k + 1) % 16; }
        else if (k < 48) { F = B ^ Cc ^ D; g = (3 * k + 5) % 16; }
        else { F = Cc ^ (B | ~D); g = (7 * k) % 16; }
        F = (F + A + K[k] + M[g]) | 0;
        A = D; D = Cc; Cc = B;
        B = (B + rotl(F, s[k])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + Cc) | 0; d0 = (d0 + D) | 0;
    }
    var out = new Uint8Array(16);
    var odv = new DataView(out.buffer);
    odv.setInt32(0, a0, true); odv.setInt32(4, b0, true); odv.setInt32(8, c0, true); odv.setInt32(12, d0, true);
    return out;
  }

  // ---------------- RC4 ----------------
  function rc4(key, data) {
    var S = new Uint8Array(256);
    for (var i = 0; i < 256; i++) S[i] = i;
    var j = 0;
    for (i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xff;
      var tmp = S[i]; S[i] = S[j]; S[j] = tmp;
    }
    var out = new Uint8Array(data.length);
    var a = 0, b = 0;
    for (var n = 0; n < data.length; n++) {
      a = (a + 1) & 0xff;
      b = (b + S[a]) & 0xff;
      var t = S[a]; S[a] = S[b]; S[b] = t;
      out[n] = data[n] ^ S[(S[a] + S[b]) & 0xff];
    }
    return out;
  }

  var PAD = new Uint8Array([
    0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
    0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A
  ]);

  function concatBytes(arrs) {
    var total = 0;
    for (var i = 0; i < arrs.length; i++) total += arrs[i].length;
    var out = new Uint8Array(total);
    var p = 0;
    for (i = 0; i < arrs.length; i++) { out.set(arrs[i], p); p += arrs[i].length; }
    return out;
  }

  function passwordBytes(password) {
    var out = new Uint8Array(32);
    var pwBytes = new Uint8Array(password.length);
    for (var i = 0; i < password.length; i++) pwBytes[i] = password.charCodeAt(i) & 0xff;
    var n = Math.min(32, pwBytes.length);
    out.set(pwBytes.subarray(0, n), 0);
    out.set(PAD.subarray(0, 32 - n), n);
    return out;
  }

  function int32LE(n) {
    return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  }

  async function computeFileKey(encrypt, idBytes, password) {
    var R = encrypt.R;
    var lengthBits = encrypt.Length || 40;
    var keyLen = Math.floor(lengthBits / 8);
    var O = encrypt.O.bytes;
    var P = encrypt.P;
    var pw = passwordBytes(password || "");
    var parts = [pw, O.subarray(0, 32), int32LE(P), idBytes];
    if (R >= 4 && encrypt.EncryptMetadata === false) {
      parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    }
    var hash = md5(concatBytes(parts));
    if (R >= 3) {
      for (var i = 0; i < 50; i++) hash = md5(hash.subarray(0, keyLen));
    }
    return hash.subarray(0, keyLen);
  }

  function objectKey(fileKey, num, gen, isAES) {
    var extra = [fileKey, new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff]), new Uint8Array([gen & 0xff, (gen >> 8) & 0xff])];
    if (isAES) extra.push(new Uint8Array([0x73, 0x41, 0x6c, 0x54]));
    var h = md5(concatBytes(extra));
    var len = Math.min(fileKey.length + 5, 16);
    return h.subarray(0, len);
  }

  async function aesCbcDecrypt(key, data) {
    if (data.length < 16) return new Uint8Array(0);
    var iv = data.subarray(0, 16);
    var ciphertext = data.subarray(16);
    if (ciphertext.length === 0) return new Uint8Array(0);
    var cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
    try {
      var plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, cryptoKey, ciphertext);
      return new Uint8Array(plain);
    } catch (e) {
      return new Uint8Array(0);
    }
  }

  // Verifies the password by recomputing U and comparing (Algorithm 4/5).
  async function verifyPassword(encrypt, idBytes, fileKey, R) {
    var U = encrypt.U.bytes;
    if (R === 2) {
      var enc = rc4(fileKey, PAD);
      return bytesEqual(enc, U.subarray(0, 32));
    }
    var h = md5(concatBytes([PAD, idBytes]));
    var enc2 = rc4(fileKey, h);
    for (var i = 1; i <= 19; i++) {
      var xored = new Uint8Array(fileKey.length);
      for (var b = 0; b < fileKey.length; b++) xored[b] = fileKey[b] ^ i;
      enc2 = rc4(xored, enc2);
    }
    return bytesEqual(enc2, U.subarray(0, 16));
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  async function setup(doc, password) {
    var encrypt = await doc.resolve(doc.trailer.Encrypt);
    var filter = encrypt.Filter instanceof C.PDFName ? encrypt.Filter.name : "";
    var V = encrypt.V || 1;
    var R = encrypt.R || 2;
    if (R >= 5) {
      return {
        unsupported: true,
        decryptObject: async function (v) { return v; }
      };
    }
    var idArr = doc.trailer.ID;
    var idBytes = idArr && idArr[0] instanceof C.PDFString ? idArr[0].bytes : new Uint8Array(0);
    if (!encrypt.Length) encrypt.Length = V === 1 ? 40 : 128;
    var fileKey = await computeFileKey(encrypt, idBytes, password);
    var ok = await verifyPassword(encrypt, idBytes, fileKey, R);

    // Determine cipher: V4/V5 crypt filters can specify AESV2; default V1/V2 is RC4.
    var useAES = false;
    if (V >= 4 && encrypt.CF) {
      var cfDict = await doc.resolve(encrypt.CF);
      var stmFName = encrypt.StmF instanceof C.PDFName ? encrypt.StmF.name : "Identity";
      var cf = stmFName !== "Identity" ? await doc.resolve(cfDict[stmFName]) : null;
      var cfm = cf && cf.CFM instanceof C.PDFName ? cf.CFM.name : "";
      useAES = cfm === "AESV2" || cfm === "AESV3";
    }

    var encryptRefNum = doc.trailer.Encrypt instanceof C.PDFRef ? doc.trailer.Encrypt.num : -1;

    function decryptBytes(bytes, num, gen) {
      var key = objectKey(fileKey, num, gen, useAES);
      if (useAES) return aesCbcDecrypt(key, bytes);
      return Promise.resolve(rc4(key, bytes));
    }

    async function decryptValue(value, num, gen) {
      if (value instanceof C.PDFString) {
        var dec = await decryptBytes(value.bytes, num, gen);
        return new C.PDFString(dec);
      }
      if (value instanceof C.PDFStream) {
        var newDict = await decryptValue(value.dict, num, gen);
        var decRaw = await decryptBytes(value.raw, num, gen);
        return new C.PDFStream(newDict, decRaw);
      }
      if (Array.isArray(value)) {
        var arr = [];
        for (var i = 0; i < value.length; i++) arr.push(await decryptValue(value[i], num, gen));
        return arr;
      }
      if (value && typeof value === "object" && !(value instanceof C.PDFName) && !(value instanceof C.PDFRef)) {
        var out = {};
        for (var k in value) out[k] = await decryptValue(value[k], num, gen);
        return out;
      }
      return value;
    }

    return {
      passwordOk: ok,
      unsupported: false,
      decryptObject: async function (value, num, gen) {
        if (num === encryptRefNum) return value; // the Encrypt dict itself is never encrypted
        return decryptValue(value, num, gen);
      }
    };
  }

  root.PDFCrypto = { setup: setup, md5: md5, rc4: rc4 };
})(typeof window !== "undefined" ? window : global);
