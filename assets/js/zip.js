/*
  Minimal ZIP writer (no external library): stores entries with DEFLATE
  compression using the browser's native CompressionStream("deflate-raw"),
  computing CRC32 ourselves (required by the ZIP local/central headers).
  Good enough for bundling a handful of generated files into one download
  — not a general-purpose archiver.
*/
(function (root) {
  "use strict";

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function deflateRaw(bytes) {
    var cs = new CompressionStream("deflate-raw");
    var writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var reader = cs.readable.getReader();
    var chunks = [];
    var total = 0;
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      total += r.value.length;
    }
    var out = new Uint8Array(total);
    var p = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], p);
      p += chunks[i].length;
    }
    return out;
  }

  function dosDateTime(date) {
    date = date || new Date();
    var time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
    var d = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
    return { time: time, date: d };
  }

  function writeUint32LE(arr, offset, value) {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >>> 8) & 0xff;
    arr[offset + 2] = (value >>> 16) & 0xff;
    arr[offset + 3] = (value >>> 24) & 0xff;
  }
  function writeUint16LE(arr, offset, value) {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >>> 8) & 0xff;
  }

  // files: [{ name: string, data: Uint8Array }]
  async function createZip(files) {
    var chunks = [];
    var centralRecords = [];
    var offset = 0;
    var dt = dosDateTime();

    for (var i = 0; i < files.length; i++) {
      var nameBytes = new TextEncoder().encode(files[i].name);
      var data = files[i].data;
      var crc = crc32(data);
      var compressed = await deflateRaw(data);
      var useStore = compressed.length >= data.length;
      var payload = useStore ? data : compressed;
      var method = useStore ? 0 : 8;

      var localHeader = new Uint8Array(30 + nameBytes.length);
      writeUint32LE(localHeader, 0, 0x04034b50);
      writeUint16LE(localHeader, 4, 20);
      writeUint16LE(localHeader, 6, 0);
      writeUint16LE(localHeader, 8, method);
      writeUint16LE(localHeader, 10, dt.time);
      writeUint16LE(localHeader, 12, dt.date);
      writeUint32LE(localHeader, 14, crc);
      writeUint32LE(localHeader, 18, payload.length);
      writeUint32LE(localHeader, 22, data.length);
      writeUint16LE(localHeader, 26, nameBytes.length);
      writeUint16LE(localHeader, 28, 0);
      localHeader.set(nameBytes, 30);

      chunks.push(localHeader, payload);

      var central = new Uint8Array(46 + nameBytes.length);
      writeUint32LE(central, 0, 0x02014b50);
      writeUint16LE(central, 4, 20);
      writeUint16LE(central, 6, 20);
      writeUint16LE(central, 8, 0);
      writeUint16LE(central, 10, method);
      writeUint16LE(central, 12, dt.time);
      writeUint16LE(central, 14, dt.date);
      writeUint32LE(central, 16, crc);
      writeUint32LE(central, 20, payload.length);
      writeUint32LE(central, 24, data.length);
      writeUint16LE(central, 28, nameBytes.length);
      writeUint32LE(central, 42, offset);
      central.set(nameBytes, 46);
      centralRecords.push(central);

      offset += localHeader.length + payload.length;
    }

    var centralStart = offset;
    var centralSize = 0;
    for (var j = 0; j < centralRecords.length; j++) {
      chunks.push(centralRecords[j]);
      centralSize += centralRecords[j].length;
    }

    var end = new Uint8Array(22);
    writeUint32LE(end, 0, 0x06054b50);
    writeUint16LE(end, 8, files.length);
    writeUint16LE(end, 10, files.length);
    writeUint32LE(end, 12, centralSize);
    writeUint32LE(end, 16, centralStart);
    chunks.push(end);

    return new Blob(chunks, { type: "application/zip" });
  }

  root.BartrueZip = { createZip: createZip, crc32: crc32 };
})(typeof window !== "undefined" ? window : global);
