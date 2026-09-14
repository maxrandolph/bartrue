/*
  Minimal from-scratch EXIF reader for JPEG files (APP1 segment, TIFF/IFD
  structure). No external libraries — just enough tag coverage for a useful
  metadata viewer. Returns null for non-JPEG or images with no EXIF segment.
*/
(function (root) {
  "use strict";
  var Bartrue = (root.Bartrue = root.Bartrue || {});

  var TAG_NAMES = {
    0x010F: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x011A: "XResolution",
    0x011B: "YResolution", 0x0128: "ResolutionUnit", 0x0131: "Software",
    0x0132: "DateTime", 0x013B: "Artist", 0x8298: "Copyright",
    0x829A: "ExposureTime", 0x829D: "FNumber", 0x8822: "ExposureProgram",
    0x8827: "ISOSpeedRatings", 0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized",
    0x9201: "ShutterSpeedValue", 0x9202: "ApertureValue", 0x9204: "ExposureBiasValue",
    0x9205: "MaxApertureValue", 0x9207: "MeteringMode", 0x9209: "Flash",
    0x920A: "FocalLength", 0xA002: "PixelXDimension", 0xA003: "PixelYDimension",
    0xA405: "FocalLengthIn35mmFilm", 0xA406: "SceneCaptureType",
    0x0100: "ImageWidth", 0x0101: "ImageHeight"
  };
  var ORIENTATION_LABELS = {
    1: "Normal", 2: "Flipped horizontally", 3: "Rotated 180°",
    4: "Flipped vertically", 5: "Rotated 90° CW + flipped", 6: "Rotated 90° CW",
    7: "Rotated 90° CCW + flipped", 8: "Rotated 90° CCW"
  };

  var TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function readIFD(view, offset, tiffStart, little, out) {
    var count = view.getUint16(offset, little);
    var entries = [];
    for (var i = 0; i < count; i++) {
      var entryOffset = offset + 2 + i * 12;
      var tag = view.getUint16(entryOffset, little);
      var type = view.getUint16(entryOffset + 2, little);
      var numValues = view.getUint32(entryOffset + 4, little);
      var typeSize = TYPE_SIZES[type] || 1;
      var totalSize = typeSize * numValues;
      var valueOffset = totalSize <= 4 ? entryOffset + 8 : tiffStart + view.getUint32(entryOffset + 8, little);
      var value = readValue(view, valueOffset, type, numValues, little);
      entries.push({ tag: tag, value: value });
      if (TAG_NAMES[tag]) out[TAG_NAMES[tag]] = value;
      if (tag === 0x8769) out.__exifIFDOffset = tiffStart + value; // ExifIFD pointer
      if (tag === 0x8825) out.__gpsIFDOffset = tiffStart + value; // GPS pointer
    }
    var nextOffset = view.getUint16(offset + 2 + count * 12, little);
    return nextOffset;
  }

  function readValue(view, offset, type, count, little) {
    function one(i) {
      switch (type) {
        case 1: case 7: return view.getUint8(offset + i);
        case 2: return null; // handled below as string
        case 3: return view.getUint16(offset + i * 2, little);
        case 4: return view.getUint32(offset + i * 4, little);
        case 5: {
          var num = view.getUint32(offset + i * 8, little);
          var den = view.getUint32(offset + i * 8 + 4, little);
          return den ? num / den : 0;
        }
        case 9: return view.getInt32(offset + i * 4, little);
        case 10: {
          var n = view.getInt32(offset + i * 8, little);
          var d = view.getInt32(offset + i * 8 + 4, little);
          return d ? n / d : 0;
        }
        default: return null;
      }
    }
    if (type === 2) {
      var bytes = [];
      for (var i = 0; i < count; i++) {
        var c = view.getUint8(offset + i);
        if (c === 0) break;
        bytes.push(c);
      }
      return String.fromCharCode.apply(null, bytes);
    }
    if (count === 1) return one(0);
    var arr = [];
    for (var j = 0; j < count; j++) arr.push(one(j));
    return arr;
  }

  // Returns {tags: {...}} or null.
  Bartrue.readExif = async function (file) {
    if (!file.type || file.type.indexOf("jpeg") === -1) {
      // Still attempt for files without a reliable MIME type (e.g. from disk with odd type)
      if (file.name && !/\.jpe?g$/i.test(file.name)) return null;
    }
    var buf = await file.slice(0, 256 * 1024).arrayBuffer();
    var view = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) return null; // not a JPEG

    var offset = 2;
    var app1Offset = -1, app1Length = 0;
    while (offset < view.byteLength - 4) {
      if (view.getUint8(offset) !== 0xFF) break;
      var marker = view.getUint8(offset + 1);
      if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
      var segLength = view.getUint16(offset + 2);
      if (marker === 0xE1) { app1Offset = offset + 4; app1Length = segLength - 2; break; }
      if (marker === 0xDA) break; // start of scan — no more metadata segments
      offset += 2 + segLength;
    }
    if (app1Offset === -1) return null;
    // Expect "Exif\0\0" header
    var header = String.fromCharCode(view.getUint8(app1Offset), view.getUint8(app1Offset + 1), view.getUint8(app1Offset + 2), view.getUint8(app1Offset + 3));
    if (header !== "Exif") return null;
    var tiffStart = app1Offset + 6;
    var byteOrder = String.fromCharCode(view.getUint8(tiffStart), view.getUint8(tiffStart + 1));
    var little = byteOrder === "II";
    var firstIFDOffset = view.getUint32(tiffStart + 4, little);

    var tags = {};
    try {
      readIFD(view, tiffStart + firstIFDOffset, tiffStart, little, tags);
      if (tags.__exifIFDOffset) readIFD(view, tags.__exifIFDOffset, tiffStart, little, tags);
    } catch (e) {
      // Truncated/malformed segment — return whatever we got.
    }
    delete tags.__exifIFDOffset;
    delete tags.__gpsIFDOffset;
    if (tags.Orientation) tags.OrientationLabel = ORIENTATION_LABELS[tags.Orientation] || String(tags.Orientation);
    return Object.keys(tags).length ? tags : null;
  };
})(typeof window !== "undefined" ? window : this);
