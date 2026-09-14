/*
  FlateDecode/Encode for the PDF engine, implemented on top of the browser's
  native CompressionStream/DecompressionStream ("deflate" = zlib format,
  which is exactly what PDF's FlateDecode filter uses). No external zlib
  library needed. Works in Chrome 80+, Firefox 113+, Safari 16.4+, and in
  Node (used by our test harness) since both runtimes implement the same
  Streams API.
*/
(function (root) {
  async function runStream(streamCtor, format, bytes) {
    var cs = new streamCtor(format);
    var writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var reader = cs.readable.getReader();
    var chunks = [];
    var total = 0;
    while (true) {
      var res = await reader.read();
      if (res.done) break;
      chunks.push(res.value);
      total += res.value.length;
    }
    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  async function inflate(bytes) {
    return runStream(DecompressionStream, "deflate", bytes);
  }

  async function deflate(bytes) {
    return runStream(CompressionStream, "deflate", bytes);
  }

  // PNG-style predictor un-filtering (Predictor values 10-15), used for
  // FlateDecode'd image sample data. `colors`=components per pixel,
  // `bpc`=bits per component, `columns`=pixels per row.
  function undoPngPredictor(data, colors, bpc, columns) {
    var bpp = Math.max(1, Math.ceil((colors * bpc) / 8)); // bytes per complete pixel
    var rowBytes = Math.ceil((colors * bpc * columns) / 8);
    var rows = Math.floor(data.length / (rowBytes + 1));
    var out = new Uint8Array(rows * rowBytes);
    var prevRow = new Uint8Array(rowBytes);
    var pos = 0;
    for (var r = 0; r < rows; r++) {
      var filterType = data[pos++];
      var row = data.subarray(pos, pos + rowBytes);
      pos += rowBytes;
      var outRow = new Uint8Array(rowBytes);
      for (var i = 0; i < rowBytes; i++) {
        var a = i >= bpp ? outRow[i - bpp] : 0; // left
        var b = prevRow[i]; // up
        var c = i >= bpp ? prevRow[i - bpp] : 0; // upper-left
        var x = row[i];
        var val;
        switch (filterType) {
          case 0:
            val = x;
            break;
          case 1:
            val = (x + a) & 0xff;
            break;
          case 2:
            val = (x + b) & 0xff;
            break;
          case 3:
            val = (x + ((a + b) >> 1)) & 0xff;
            break;
          case 4:
            var pa = Math.abs(b - c),
              pb = Math.abs(a - c),
              pc = Math.abs(a + b - 2 * c);
            var pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            val = (x + pr) & 0xff;
            break;
          default:
            val = x;
        }
        outRow[i] = val;
      }
      out.set(outRow, r * rowBytes);
      prevRow = outRow;
    }
    return out;
  }

  // TIFF predictor 2 (simple horizontal differencing), less common but easy.
  function undoTiffPredictor(data, colors, bpc, columns) {
    if (bpc !== 8) return data; // only handle the common 8-bit case
    var out = new Uint8Array(data.length);
    var rowBytes = colors * columns;
    var rows = Math.floor(data.length / rowBytes);
    for (var r = 0; r < rows; r++) {
      var base = r * rowBytes;
      for (var i = 0; i < rowBytes; i++) {
        var left = i >= colors ? out[base + i - colors] : 0;
        out[base + i] = (data[base + i] + left) & 0xff;
      }
    }
    return out;
  }

  root.PDFFlate = {
    inflate: inflate,
    deflate: deflate,
    undoPngPredictor: undoPngPredictor,
    undoTiffPredictor: undoTiffPredictor
  };
})(typeof window !== "undefined" ? window : global);
