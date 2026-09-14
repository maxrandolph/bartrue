/*
  Shared tool inventory. Plain script (no ES modules) so every page can just
  <script src="assets/js/tools-data.js"></script> and read window.BARTRUE_TOOLS.
  `status` is "ready" once a tool has a working implementation; "planned" ones
  still get a page (so the site map matches the roadmap) but show a
  "not implemented yet" notice instead of the working UI.
*/
(function () {
  var TOOLS = [
    // ---------------- PDF Tools ----------------
    { slug: "pdf-merge", category: "pdf", icon: "\u{1F4D1}", title: "Merge PDF", description: "Combine multiple PDF files into one document.", status: "ready" },
    { slug: "pdf-split", category: "pdf", icon: "✂️", title: "Split PDF", description: "Divide a PDF into separate files by page range.", status: "ready" },
    { slug: "pdf-compress", category: "pdf", icon: "\u{1F5DC}️", title: "Compress PDF", description: "Shrink file size by recompressing embedded images.", status: "ready" },
    { slug: "pdf-to-text", category: "pdf", icon: "\u{1F4C4}", title: "PDF to Text", description: "Extract text content from a PDF document.", status: "ready" },
    { slug: "pdf-rotate", category: "pdf", icon: "\u{1F504}", title: "Rotate PDF", description: "Rotate one or all pages by 90/180/270 degrees.", status: "ready" },
    { slug: "pdf-watermark", category: "pdf", icon: "\u{1F4A7}", title: "Add Watermark", description: "Stamp text over every page of a PDF.", status: "ready" },
    { slug: "pdf-page-numbers", category: "pdf", icon: "\u{1F522}", title: "Add Page Numbers", description: "Insert page numbers into a PDF document.", status: "ready" },
    { slug: "pdf-metadata", category: "pdf", icon: "ℹ️", title: "PDF Metadata", description: "View and edit a PDF's title, author and other properties.", status: "ready" },
    { slug: "pdf-unlock", category: "pdf", icon: "\u{1F513}", title: "Unlock PDF", description: "Remove password protection when you know the password.", status: "ready" },
    { slug: "pdf-grayscale", category: "pdf", icon: "⚫", title: "PDF to Grayscale", description: "Convert a color PDF to black and white.", status: "ready" },
    { slug: "pdf-crop", category: "pdf", icon: "✂️", title: "Crop PDF", description: "Adjust page dimensions and trim margins.", status: "ready" },
    { slug: "redact-pdf", category: "pdf", icon: "⬛", title: "Redact PDF", description: "Permanently black out and flatten sensitive regions.", status: "ready" },

    // ---------------- Image Tools ----------------
    { slug: "image-compress", category: "image", icon: "\u{1F5DC}️", title: "Compress Image", description: "Reduce image file size with an adjustable quality slider.", status: "ready" },
    { slug: "image-resize", category: "image", icon: "\u{1F4D0}", title: "Resize Image", description: "Adjust image dimensions, with optional locked aspect ratio.", status: "ready" },
    { slug: "image-convert", category: "image", icon: "\u{1F504}", title: "Convert Image", description: "Change an image between JPG, PNG, WebP, GIF and more.", status: "ready" },
    { slug: "image-crop", category: "image", icon: "✂️", title: "Crop Image", description: "Remove unwanted portions with a draggable crop box.", status: "ready" },
    { slug: "image-rotate", category: "image", icon: "↻", title: "Rotate & Flip", description: "Rotate by 90/180/270 or mirror horizontally/vertically.", status: "ready" },
    { slug: "image-grayscale", category: "image", icon: "⚫", title: "Image to Grayscale", description: "Convert a photo to black and white.", status: "ready" },
    { slug: "image-brightness", category: "image", icon: "☀️", title: "Adjust Brightness", description: "Modify brightness and contrast.", status: "ready" },
    { slug: "image-blur", category: "image", icon: "\u{1F4A8}", title: "Blur Image", description: "Apply an adjustable blur effect.", status: "ready" },
    { slug: "image-watermark", category: "image", icon: "\u{1F4A7}", title: "Image Watermark", description: "Add a text or image watermark.", status: "ready" },
    { slug: "image-to-base64", category: "image", icon: "\u{1F522}", title: "Image to Base64", description: "Encode an image into a Base64 data URI.", status: "ready" },
    { slug: "base64-to-image", category: "image", icon: "\u{1F5BC}️", title: "Base64 to Image", description: "Decode a Base64 string back into an image file.", status: "ready" },
    { slug: "image-metadata", category: "image", icon: "ℹ️", title: "Image Metadata", description: "View EXIF and file information embedded in an image.", status: "ready" },
    { slug: "image-color-picker", category: "image", icon: "\u{1F3A8}", title: "Color Picker from Image", description: "Click anywhere on an image to read its color.", status: "ready" },
    { slug: "image-collage", category: "image", icon: "\u{1F5BC}️", title: "Image Collage", description: "Combine multiple images into one grid layout.", status: "ready" },
    { slug: "image-favicon", category: "image", icon: "⭐", title: "Favicon Generator", description: "Generate a full favicon set (.ico + PNG sizes) from one image.", status: "ready" },
    { slug: "background-remover", category: "image", icon: "✂️", title: "Background Remover", description: "Strip a photo's background (heuristic, fully offline).", status: "ready" },
    { slug: "heic-to-jpg", category: "image", icon: "\u{1F504}", title: "HEIC to JPG", description: "Convert Apple's HEIC photos to JPG.", status: "ready" },
    { slug: "heic-to-png", category: "image", icon: "\u{1F504}", title: "HEIC to PNG", description: "Convert Apple's HEIC photos to PNG.", status: "ready" },
    { slug: "webp-to-png", category: "image", icon: "\u{1F504}", title: "WebP to PNG", description: "Convert WebP images to PNG.", status: "ready" },
    { slug: "png-to-webp", category: "image", icon: "\u{1F504}", title: "PNG to WebP", description: "Convert PNG images to WebP.", status: "ready" },
    { slug: "webp-to-jpg", category: "image", icon: "\u{1F504}", title: "WebP to JPG", description: "Convert WebP images to JPG.", status: "ready" },
    { slug: "jpg-to-webp", category: "image", icon: "\u{1F504}", title: "JPG to WebP", description: "Convert JPG images to WebP.", status: "ready" },
    { slug: "avif-to-jpg", category: "image", icon: "\u{1F504}", title: "AVIF to JPG", description: "Convert AVIF images to JPG.", status: "ready" },
    { slug: "avif-to-png", category: "image", icon: "\u{1F504}", title: "AVIF to PNG", description: "Convert AVIF images to PNG.", status: "ready" },
    { slug: "svg-to-png", category: "image", icon: "\u{1F504}", title: "SVG to PNG", description: "Rasterize a vector SVG into a PNG at any resolution.", status: "ready" },
    { slug: "png-to-svg", category: "image", icon: "\u{1F504}", title: "PNG to SVG", description: "Wrap or trace a raster image into an SVG container.", status: "ready" },
    { slug: "image-placeholder", category: "image", icon: "\u{1F5BC}️", title: "Placeholder Image", description: "Generate placeholder graphics at any size and color.", status: "ready" },
    { slug: "image-border", category: "image", icon: "\u{1F5BC}️", title: "Add Border", description: "Frame an image with a solid color border.", status: "ready" },
    { slug: "image-ascii", category: "image", icon: "\u{1F524}", title: "Image to ASCII", description: "Convert an image into ASCII/text art.", status: "ready" },
    { slug: "image-filters", category: "image", icon: "\u{1F3A8}", title: "CSS Image Filters", description: "Preview CSS filter effects and copy the generated code.", status: "ready" }
  ];

  var CATEGORIES = {
    pdf: { title: "PDF Tools", href_index: "pdf-tools/index.html", icon: "\u{1F4C4}" },
    image: { title: "Image Tools", href_index: "image-tools/index.html", icon: "\u{1F5BC}️" }
  };

  window.BARTRUE_TOOLS = TOOLS;
  window.BARTRUE_CATEGORIES = CATEGORIES;

  window.bartrueToolsByCategory = function (category) {
    return TOOLS.filter(function (t) {
      return t.category === category;
    });
  };

  window.bartrueToolHref = function (slug, root) {
    root = root || "";
    return root + "tools/" + slug + "/index.html";
  };
})();
