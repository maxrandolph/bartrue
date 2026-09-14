/*
  Shared helpers for image tools: decode a File to a bitmap, draw to a
  canvas, export a canvas back to a Blob, and a couple of tiny UI helpers
  reused by nearly every image tool page.
*/
(function (root) {
  "use strict";
  var Bartrue = (root.Bartrue = root.Bartrue || {});

  Bartrue.loadImageBitmap = async function (file) {
    return createImageBitmap(file);
  };

  Bartrue.makeCanvas = function (w, h) {
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  };

  Bartrue.canvasToBlob = function (canvas, mime, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(
        function (blob) {
          resolve(blob);
        },
        mime || "image/png",
        quality
      );
    });
  };

  Bartrue.EXT_FOR_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp"
  };

  // Renders a live preview of a canvas/blob into a <div class="result-preview"> shell.
  Bartrue.showCanvasResult = function (containerEl, canvas, infoText) {
    containerEl.innerHTML = "";
    containerEl.style.display = "";
    var img = document.createElement("img");
    img.src = canvas.toDataURL();
    containerEl.appendChild(img);
    var bar = document.createElement("div");
    bar.className = "result-preview__bar";
    bar.innerHTML = "<span>" + (infoText || "") + "</span>";
    containerEl.appendChild(bar);
  };

  // Sets up a dropzone that decodes the first picked/dropped file into an
  // ImageBitmap and hands it (plus the original File) to onImage.
  Bartrue.setupImageDropzone = function (el, opts) {
    opts = opts || {};
    return Bartrue.createDropzone(el, {
      accept: opts.accept || "image/*",
      multiple: !!opts.multiple,
      icon: opts.icon || "\u{1F5BC}️",
      title: opts.title || "Drop an image here",
      hint: opts.hint || "or click to browse",
      onFiles: async function (files) {
        if (opts.multiple) {
          opts.onFiles(files);
          return;
        }
        var file = files[0];
        try {
          var bitmap = await Bartrue.loadImageBitmap(file);
          opts.onImage(bitmap, file);
        } catch (e) {
          if (opts.onError) opts.onError(e, file);
        }
      }
    });
  };
})(typeof window !== "undefined" ? window : this);
