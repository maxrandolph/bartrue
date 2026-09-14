/*
  Shared drag & drop / click-to-browse file picker.
  Usage:
    var dz = Bartrue.createDropzone(document.getElementById('dz'), {
      accept: 'application/pdf',
      multiple: true,
      title: 'Drop PDF files here',
      hint: 'or click to browse — files never leave your device',
      onFiles: function (files) { ... }
    });
    dz.reset();
*/
(function () {
  window.Bartrue = window.Bartrue || {};

  window.Bartrue.createDropzone = function (container, opts) {
    opts = opts || {};
    var title = opts.title || "Drop files here";
    var hint = opts.hint || "or click to browse — files never leave your device";
    var icon = opts.icon || "\u{1F4C1}";

    container.classList.add("dropzone");
    container.setAttribute("tabindex", "0");
    container.setAttribute("role", "button");
    container.innerHTML =
      '<div class="dropzone__icon">' + icon + "</div>" +
      '<div class="dropzone__title">' + title + "</div>" +
      '<div class="dropzone__hint">' + hint + "</div>" +
      '<input type="file"' +
      (opts.accept ? ' accept="' + opts.accept + '"' : "") +
      (opts.multiple ? " multiple" : "") +
      ">";

    var input = container.querySelector("input[type=file]");

    function handleFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      if (opts.onFiles) opts.onFiles(files);
    }

    container.addEventListener("click", function () {
      input.value = "";
      input.click();
    });
    container.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", function () {
      handleFiles(input.files);
    });
    ["dragenter", "dragover"].forEach(function (evt) {
      container.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        container.classList.add("is-dragover");
      });
    });
    ["dragleave", "dragend", "drop"].forEach(function (evt) {
      container.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        container.classList.remove("is-dragover");
      });
    });
    container.addEventListener("drop", function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        handleFiles(dt.files);
      }
    });

    return {
      reset: function () {
        input.value = "";
      },
      el: container
    };
  };

  // Renders a removable list of picked files into `listEl`.
  window.Bartrue.renderFileList = function (listEl, files, onRemove) {
    listEl.innerHTML = "";
    if (!files.length) {
      listEl.classList.add("file-list--empty");
      return;
    }
    files.forEach(function (file, idx) {
      var li = document.createElement("li");
      li.className = "file-row";
      var name = document.createElement("span");
      name.className = "file-row__name";
      name.textContent = file.name;
      var size = document.createElement("span");
      size.className = "file-row__size";
      size.textContent = window.Bartrue.formatBytes(file.size);
      li.appendChild(name);
      li.appendChild(size);
      if (onRemove) {
        var btn = document.createElement("button");
        btn.className = "file-row__remove";
        btn.type = "button";
        btn.innerHTML = "&times;";
        btn.title = "Remove";
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          onRemove(idx);
        });
        li.appendChild(btn);
      }
      listEl.appendChild(li);
    });
  };

  window.Bartrue.setStatus = function (el, message, kind) {
    el.classList.remove("is-error", "is-success");
    if (kind === "error") el.classList.add("is-error");
    if (kind === "success") el.classList.add("is-success");
    el.innerHTML = "";
    if (kind === "loading") {
      var spin = document.createElement("span");
      spin.className = "spinner";
      el.appendChild(spin);
    }
    var span = document.createElement("span");
    span.textContent = message || "";
    el.appendChild(span);
  };
})();
