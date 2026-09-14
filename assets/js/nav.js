/*
  Renders the shared header/nav and footer without any fetch() calls, so the
  site works when opened directly from disk (file://) as well as over http.
  Each page sets `window.BARTRUE_ROOT` (relative path back to the project
  root, e.g. "" or "../" or "../../") and `window.BARTRUE_ACTIVE` (a category
  key or tool slug) before this script runs.
*/
(function () {
  var ROOT = window.BARTRUE_ROOT || "";
  var ACTIVE = window.BARTRUE_ACTIVE || "";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function navLink(href, label, key) {
    var current = key === ACTIVE ? ' aria-current="page"' : "";
    return '<a href="' + href + '"' + current + ">" + escapeHtml(label) + "</a>";
  }

  function renderHeader() {
    var links = [
      navLink(ROOT + "index.html", "Home", "home"),
      navLink(ROOT + "pdf-tools/index.html", "PDF Tools", "pdf"),
      navLink(ROOT + "image-tools/index.html", "Image Tools", "image")
    ].join("");

    var html =
      '<div class="site-header__inner">' +
      '<a class="brand" href="' + ROOT + 'index.html">' +
      '<span class="brand__mark">BT</span><span>Bartrue</span>' +
      "</a>" +
      '<nav class="site-nav" aria-label="Primary">' + links + "</nav>" +
      '<span class="header-tag">100% offline &middot; no uploads</span>' +
      "</div>";

    var header = document.createElement("header");
    header.className = "site-header";
    header.innerHTML = html;
    document.body.insertBefore(header, document.body.firstChild);
  }

  function renderFooter() {
    var year = new Date().getFullYear();
    var html =
      '<div class="site-footer__inner">' +
      "<div>Bartrue &mdash; an open-source, offline-first clone of " +
      '<a href="https://footrue.com/" target="_blank" rel="noopener">footrue.com</a>' +
      ". Every tool runs locally in your browser; no file you process is ever uploaded anywhere.</div>" +
      "<div>MIT licensed &middot; " + year + "</div>" +
      "</div>";
    var footer = document.createElement("footer");
    footer.className = "site-footer";
    footer.innerHTML = html;
    document.body.appendChild(footer);
  }

  function wrapMain() {
    // Wrap everything currently in <body> (the page's own content) in a
    // <main class="site-main"> so header/footer can sit outside it.
    var main = document.createElement("main");
    main.className = "site-main";
    while (document.body.firstChild) {
      main.appendChild(document.body.firstChild);
    }
    document.body.appendChild(main);
    return main;
  }

  wrapMain(); // body is now just [main]
  renderHeader(); // inserted before main -> [header, main]
  renderFooter(); // appended after main -> [header, main, footer]

  window.Bartrue = window.Bartrue || {};
  window.Bartrue.root = ROOT;
  window.Bartrue.escapeHtml = escapeHtml;
})();
