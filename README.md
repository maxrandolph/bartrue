# Bartrue

An open-source, offline-first clone of the tools at [footrue.com](https://footrue.com/) — PDF and image utilities that run **entirely in your browser**. No server, no upload, no build step, no dependencies.

The project it clones has a simple criticism: it's not open source. This one is, and it's designed specifically to make "clone it and run it with zero setup" actually true.

## Why this exists

- **100% offline.** Every tool — merging PDFs, redacting text, converting images — runs with JavaScript already loaded in your tab. Once the page is open, you can disconnect from the internet and every tool keeps working. Nothing is ever uploaded anywhere.
- **Zero dependencies, zero build step.** There is no `npm install`, no bundler, no framework, no CDN script. It's plain HTML, CSS and JavaScript. Clone the repo, open `index.html`, and it works — on a plane, on a private network, in ten years when today's JS tooling has churned into something else.
- **Fully open source.** MIT licensed. Every byte of every tool — including the PDF parser, the image codecs' glue code, and the ZIP writer — is in this repository and readable.

## Running it

There is nothing to install or build. Pick whichever is convenient:

**Option A — just open it.** Double-click `index.html` (or open it with `Ctrl/Cmd+O` in your browser). Everything works from the `file://` protocol; no server required.

**Option B — serve it locally** (only needed if you want to avoid your browser's `file://` quirks, e.g. for GPS/clipboard permissions on some browsers):

```bash
# Any static file server works. For example, with Python already installed:
python3 -m http.server 8080
# then open http://localhost:8080/
```

There is no build command, no `package.json`, no install step. The repository *is* the deployable site.

## Architecture

- **No JS framework, no npm packages, no ES modules.** Every script is a classic `<script src="...">` tag that attaches its exports to a shared `Bartrue` (or `PDFCore`, `PDFDocument`, etc.) global. This sidesteps `file://` CORS restrictions on ES modules and means there is nothing to transpile or bundle.
- **`assets/js/pdf/`** is a from-scratch PDF engine: object model, tokenizer, classic and cross-reference-stream xref parsing, FlateDecode (via the browser's native `CompressionStream`/`DecompressionStream`), PNG/TIFF predictors, a content-stream interpreter for text extraction and drawing, Standard-14 font metrics, `/ToUnicode` CMap parsing, and the PDF Standard Security Handler (RC4 and AES-128 decryption, with a hand-written MD5). It reads and writes real PDF files without any third-party library.
- **Image tools** are built on the Canvas 2D API (`createImageBitmap`, `OffscreenCanvas`, `ctx.filter`, `canvas.toBlob`) — capabilities already built into every modern browser.
- **`assets/js/zip.js`** is a minimal from-scratch ZIP writer (CRC32 + DEFLATE via `CompressionStream("deflate-raw")`) used for tools that bundle multiple output files (e.g. Split PDF, Favicon Generator).
- **`assets/js/image/ico.js`** is a minimal ICO container writer (wraps PNG-compressed frames, which modern Windows and browsers accept directly).
- **`assets/js/image/exif.js`** is a minimal from-scratch EXIF/TIFF tag reader for the Image Metadata tool.

Nothing here calls out to a server, an API, or a CDN at runtime. The only network activity a browser will ever make while using this site is loading the page's own files.

## Tool status

### PDF Tools (12/12 complete)

| Tool | What it does |
|---|---|
| Merge PDF | Combine multiple PDFs into one document |
| Split PDF | Divide a PDF by page, by chunk size, or by page ranges |
| Compress PDF | Recompress embedded images to shrink file size |
| PDF to Text | Extract text content (via content-stream + font-metrics decoding) |
| Rotate PDF | Rotate one or all pages by 90/180/270° |
| Add Watermark | Stamp rotated, semi-transparent text over every page |
| Add Page Numbers | Insert configurable page numbers |
| PDF Metadata | View and edit Title/Author/Subject/Keywords/Creator, or strip all |
| Unlock PDF | Remove password protection given the correct password (RC4, AES-128) |
| PDF to Grayscale | Convert page content and embedded images to grayscale |
| Crop PDF | Trim page margins |
| Redact PDF | Search-and-black-out text, flattened into the page content |

Known limitation: PDFs encrypted with AES-256 (R6, PDF 2.0's newest scheme) are detected but not decrypted — an "unsupported" message is shown rather than a silent failure.

### Image Tools (30/30 complete)

| Tool | What it does |
|---|---|
| Compress Image | Re-encode with an adjustable quality slider |
| Resize Image | Change pixel dimensions, with aspect-lock and quick-percent buttons |
| Convert Image | Between PNG/JPG/WebP (reads anything the browser can decode) |
| Crop Image | Interactive drag-to-crop box, or exact pixel values |
| Rotate & Flip | 90° increments plus horizontal/vertical mirroring |
| Image to Grayscale | Adjustable-intensity grayscale |
| Adjust Brightness | Live brightness + contrast |
| Blur Image | Adjustable Gaussian-style blur |
| Image Watermark | Tiled or centered text watermark |
| Image to Base64 | Encode to a data URI, with/without the `data:` prefix |
| Base64 to Image | Decode a data URI or raw Base64 string back to a file |
| Image Metadata | File info plus a from-scratch EXIF reader for JPEGs |
| Color Picker from Image | Click to read hex/RGB/HSL, with pick history |
| Image Collage | Arrange multiple images into a grid |
| Favicon Generator | `.ico` + 8 PNG sizes, bundled as a zip, with the `<link>` snippet |
| Background Remover | Chroma-key style heuristic removal (click to sample the background color) |
| HEIC to JPG / PNG | Depends on the browser's native HEIC decode support (see note below) |
| WebP ⇄ PNG / JPG, JPG ⇄ WebP | Straightforward format conversion |
| AVIF to JPG / PNG | Depends on the browser's native AVIF decode support |
| SVG to PNG | Rasterize at any output resolution |
| PNG to SVG | Wraps the raster image in a valid SVG container (not a vector trace) |
| Placeholder Image | Generate a solid-color placeholder with centered label text |
| Add Border | Solid-color border, optionally with rounded corners |
| Image to ASCII | Character-ramp ASCII art, plain or colored, adjustable width |
| CSS Image Filters | Live-tune brightness/contrast/saturation/grayscale/sepia/hue/blur/invert and copy the CSS |

Known limitations, by design (documented in-app where relevant):

- **Background Remover** is a color-distance heuristic, not ML-based segmentation — there is no way to fetch or run a segmentation model fully offline in a dependency-free page. It works well on flat/solid backgrounds and poorly on busy photographic ones.
- **HEIC decoding** depends entirely on the browser's own `createImageBitmap` support for the format. Safari usually supports it; Chrome and Firefox often don't. There is no bundled HEIC decoder (no way to ship `libheif` without a dependency).
- **PNG to SVG** embeds the original raster image inside an SVG wrapper (valid, scalable, but still a bitmap under the hood) rather than tracing it into true vector paths.

All tools were tested end-to-end with real files (Playwright driving real file inputs, download events, and output validation against independent tools — `qpdf`, `poppler`'s `pdftoppm`/`pdfinfo`, and the `file` command).

## Adding a tool

1. Add an entry to `assets/js/tools-data.js` (`BARTRUE_TOOLS`).
2. Create `tools/<slug>/index.html` following the pattern of any existing tool in that category — a dropzone, an options panel, a status line, and a download button, wired up with the shared helpers in `assets/js/dropzone.js`, `assets/js/download.js`, and (for image tools) `assets/js/image/common.js`.
3. No build step to run — just open the new page.

## License

MIT — see `LICENSE`.
