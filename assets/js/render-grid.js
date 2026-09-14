/* Renders a grid of tool cards from window.BARTRUE_TOOLS. */
(function () {
  window.Bartrue = window.Bartrue || {};

  window.Bartrue.renderToolGrid = function (container, tools, root) {
    root = root || "";
    var esc = window.Bartrue.escapeHtml || function (s) { return s; };
    if (!tools.length) {
      container.innerHTML = '<div class="empty-state">No tools match your search.</div>';
      return;
    }
    container.className = "grid";
    container.innerHTML = tools
      .map(function (t) {
        var href = root + "tools/" + t.slug + "/index.html";
        var disabled = t.status !== "ready";
        return (
          '<a class="card' + (disabled ? " card--disabled" : "") + '" href="' +
          (disabled ? "javascript:void(0)" : href) +
          '"' + (disabled ? ' aria-disabled="true"' : "") + ">" +
          '<span class="card__icon">' + t.icon + "</span>" +
          "<h3>" + esc(t.title) + (disabled ? " <span class=\"tag\">Soon</span>" : "") + "</h3>" +
          "<p>" + esc(t.description) + "</p>" +
          "</a>"
        );
      })
      .join("");
  };

  window.Bartrue.initSearchableGrid = function (opts) {
    var tools = opts.tools;
    var container = opts.container;
    var input = opts.input;
    var root = opts.root || "";
    function apply() {
      var q = (input && input.value || "").trim().toLowerCase();
      var filtered = !q
        ? tools
        : tools.filter(function (t) {
            return (
              t.title.toLowerCase().indexOf(q) !== -1 ||
              t.description.toLowerCase().indexOf(q) !== -1 ||
              t.slug.toLowerCase().indexOf(q) !== -1
            );
          });
      window.Bartrue.renderToolGrid(container, filtered, root);
    }
    if (input) input.addEventListener("input", apply);
    apply();
  };
})();
