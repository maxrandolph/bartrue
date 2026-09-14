/* Shared "save a result to disk" helper. Plain script, attaches to window.Bartrue. */
(function () {
  window.Bartrue = window.Bartrue || {};

  window.Bartrue.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke slightly later so Safari/Firefox have time to start the save.
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  };

  window.Bartrue.formatBytes = function (bytes) {
    if (bytes === 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var i = -1;
    do {
      bytes /= 1024;
      i++;
    } while (bytes >= 1024 && i < units.length - 1);
    return bytes.toFixed(bytes < 10 && i >= 0 ? 1 : 0) + " " + units[i];
  };

  window.Bartrue.suggestName = function (originalName, suffix, newExt) {
    var base = (originalName || "file").replace(/\.[^.]+$/, "");
    var ext = newExt || (originalName || "").split(".").pop() || "bin";
    return base + (suffix ? "-" + suffix : "") + "." + ext;
  };
})();
