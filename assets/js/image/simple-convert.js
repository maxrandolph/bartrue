/*
  Shared wiring for the single-purpose "X to Y" converter pages (heic-to-jpg,
  webp-to-png, svg-to-png, etc). Each tool page just supplies the bits that
  differ (accept type, output mime, whether a quality slider makes sense)
  and calls Bartrue.initSimpleConverter(opts) once its DOM is in place.

  Expected DOM ids: dropzone, file-info, options, quality (optional),
  q-val (optional), bg-field/bg-color (optional), status, result,
  download-row, download-btn.
*/
(function (root) {
  "use strict";
  var Bartrue = (root.Bartrue = root.Bartrue || {});

  Bartrue.initSimpleConverter = function (opts) {
    var bitmap = null, srcFile = null, resultBlob = null;
    var hasQuality = !!document.getElementById('quality');
    var hasBg = !!document.getElementById('bg-color');

    Bartrue.createDropzone(document.getElementById('dropzone'), {
      accept: opts.accept || 'image/*',
      icon: opts.icon || '\u{1F504}',
      title: opts.dropTitle || 'Drop an image here',
      onFiles: async function (files) {
        var file = files[0];
        var statusEl = document.getElementById('status');
        try {
          bitmap = await Bartrue.loadImageBitmap(file);
          srcFile = file;
          document.getElementById('file-info').style.display = '';
          document.getElementById('file-info').textContent = file.name + ' — ' + bitmap.width + '×' + bitmap.height + ' · ' + Bartrue.formatBytes(file.size);
          document.getElementById('options').style.display = '';
          document.getElementById('result').style.display = 'none';
          document.getElementById('download-row').style.display = 'none';
          Bartrue.setStatus(statusEl, '');
          if (opts.autoConvert !== false) convert();
        } catch (e) {
          console.error(e);
          Bartrue.setStatus(statusEl, (opts.decodeErrorMessage || 'Could not read this file — your browser may not support decoding this format.'), 'error');
        }
      }
    });

    async function convert() {
      var statusEl = document.getElementById('status');
      Bartrue.setStatus(statusEl, 'Converting…', 'loading');
      try {
        var canvas = Bartrue.makeCanvas(bitmap.width, bitmap.height);
        var ctx = canvas.getContext('2d');
        if (opts.outputMime === 'image/jpeg') {
          ctx.fillStyle = hasBg ? document.getElementById('bg-color').value : '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bitmap, 0, 0);
        var quality = hasQuality ? parseInt(document.getElementById('quality').value, 10) / 100 : undefined;
        resultBlob = await Bartrue.canvasToBlob(canvas, opts.outputMime, quality);
        Bartrue.showCanvasResult(document.getElementById('result'), canvas, Bartrue.formatBytes(resultBlob.size));
        document.getElementById('download-row').style.display = '';
        Bartrue.setStatus(statusEl, 'Done.', 'success');
      } catch (e) {
        console.error(e);
        Bartrue.setStatus(statusEl, 'Could not convert this image: ' + e.message, 'error');
      }
    }

    if (hasQuality) {
      document.getElementById('quality').addEventListener('input', function () {
        var v = document.getElementById('q-val');
        if (v) v.textContent = this.value;
      });
      document.getElementById('quality').addEventListener('change', convert);
    }
    if (hasBg) document.getElementById('bg-color').addEventListener('input', convert);

    var runBtn = document.getElementById('run-btn');
    if (runBtn) runBtn.addEventListener('click', convert);

    document.getElementById('download-btn').addEventListener('click', function () {
      Bartrue.downloadBlob(resultBlob, Bartrue.suggestName(srcFile.name, '', opts.outputExt));
    });
  };
})(typeof window !== "undefined" ? window : this);
