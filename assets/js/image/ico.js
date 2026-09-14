/*
  Minimal ICO writer. Modern Windows/browsers accept PNG-compressed image
  data directly inside an ICO container (no need to hand-roll BMP/DIB
  encoding), so this just wraps a set of same-format PNGs in an ICONDIR.
  entries: [{ size: number, bytes: Uint8Array (PNG data) }]
*/
(function (root) {
  "use strict";
  var Bartrue = (root.Bartrue = root.Bartrue || {});

  function writeUint16LE(arr, offset, value) {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >>> 8) & 0xff;
  }
  function writeUint32LE(arr, offset, value) {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >>> 8) & 0xff;
    arr[offset + 2] = (value >>> 16) & 0xff;
    arr[offset + 3] = (value >>> 24) & 0xff;
  }

  Bartrue.buildIco = function (entries) {
    var count = entries.length;
    var headerSize = 6 + 16 * count;
    var totalSize = headerSize + entries.reduce(function (sum, e) { return sum + e.bytes.length; }, 0);
    var out = new Uint8Array(totalSize);

    writeUint16LE(out, 0, 0); // reserved
    writeUint16LE(out, 2, 1); // type = icon
    writeUint16LE(out, 4, count);

    var dataOffset = headerSize;
    entries.forEach(function (entry, i) {
      var off = 6 + i * 16;
      var dim = entry.size >= 256 ? 0 : entry.size; // 0 means 256 per spec
      out[off] = dim; // width
      out[off + 1] = dim; // height
      out[off + 2] = 0; // color count
      out[off + 3] = 0; // reserved
      writeUint16LE(out, off + 4, 1); // color planes
      writeUint16LE(out, off + 6, 32); // bits per pixel
      writeUint32LE(out, off + 8, entry.bytes.length);
      writeUint32LE(out, off + 12, dataOffset);
      out.set(entry.bytes, dataOffset);
      dataOffset += entry.bytes.length;
    });

    return out;
  };
})(typeof window !== "undefined" ? window : this);
