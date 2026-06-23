/* Group 4 TIFF support layered onto the C4/MIL/CALS browser converter. */
(() => {
  const DEFAULT_DPI = 300;
  const TILE_SIZE = 512;
  const encoder = new TextEncoder();

  class TiffError extends Error {}

  function ascii(text) { return encoder.encode(text); }

  function concat(chunks) {
    let size = 0;
    for (const chunk of chunks) size += chunk.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  function isTiffName(name) {
    const lower = String(name || "").toLowerCase();
    return lower.endsWith(".tif") || lower.endsWith(".tiff");
  }

  function typeSize(type) {
    if ([1, 2, 6, 7].includes(type)) return 1;
    if ([3, 8].includes(type)) return 2;
    if ([4, 9, 11].includes(type)) return 4;
    if ([5, 10, 12].includes(type)) return 8;
    throw new TiffError(`Unsupported TIFF field type ${type}.`);
  }

  function readU16(view, offset, little) { return view.getUint16(offset, little); }
  function readU32(view, offset, little) { return view.getUint32(offset, little); }

  function readValues(bytes, view, entryOffset, little) {
    const type = readU16(view, entryOffset + 2, little);
    const count = readU32(view, entryOffset + 4, little);
    const valueOrOffset = readU32(view, entryOffset + 8, little);
    const totalBytes = typeSize(type) * count;
    const dataOffset = totalBytes <= 4 ? entryOffset + 8 : valueOrOffset;
    if (dataOffset < 0 || dataOffset + totalBytes > bytes.length) {
      throw new TiffError("TIFF tag data points outside the file.");
    }

    const values = [];
    for (let i = 0; i < count; i++) {
      const pos = dataOffset + i * typeSize(type);
      if (type === 1 || type === 7) values.push(bytes[pos]);
      else if (type === 2) values.push(String.fromCharCode(bytes[pos]));
      else if (type === 3) values.push(view.getUint16(pos, little));
      else if (type === 4) values.push(view.getUint32(pos, little));
      else if (type === 5) {
        const n = view.getUint32(pos, little);
        const d = view.getUint32(pos + 4, little);
        values.push(d ? n / d : n);
      } else if (type === 6) values.push(view.getInt8(pos));
      else if (type === 8) values.push(view.getInt16(pos, little));
      else if (type === 9) values.push(view.getInt32(pos, little));
      else if (type === 10) {
        const n = view.getInt32(pos, little);
        const d = view.getInt32(pos + 4, little);
        values.push(d ? n / d : n);
      } else if (type === 11) values.push(view.getFloat32(pos, little));
      else if (type === 12) values.push(view.getFloat64(pos, little));
    }
    if (type === 2) return [values.join("").replace(/\0+$/, "")];
    return values;
  }

  function first(values, fallback = undefined) {
    return values && values.length ? values[0] : fallback;
  }

  function parseTiff(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 8) {
      throw new TiffError("File is too small to be a TIFF drawing.");
    }
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const byteOrder = String.fromCharCode(bytes[0], bytes[1]);
    const little = byteOrder === "II";
    if (!little && byteOrder !== "MM") throw new TiffError("Unsupported TIFF byte order. Expected II or MM.");
    const magic = readU16(view, 2, little);
    if (magic !== 42) throw new TiffError(`Unsupported TIFF magic ${magic}. BigTIFF is not supported.`);

    let ifdOffset = readU32(view, 4, little);
    const pages = [];
    const seen = new Set();
    while (ifdOffset) {
      if (seen.has(ifdOffset)) throw new TiffError("TIFF IFD loop detected.");
      seen.add(ifdOffset);
      if (ifdOffset + 2 > bytes.length) throw new TiffError("TIFF IFD offset points outside the file.");

      const tagCount = readU16(view, ifdOffset, little);
      const entriesStart = ifdOffset + 2;
      const entriesEnd = entriesStart + tagCount * 12;
      if (entriesEnd + 4 > bytes.length) throw new TiffError("TIFF IFD extends outside the file.");

      const tags = new Map();
      for (let i = 0; i < tagCount; i++) {
        const entryOffset = entriesStart + i * 12;
        tags.set(readU16(view, entryOffset, little), readValues(bytes, view, entryOffset, little));
      }

      const width = first(tags.get(256));
      const height = first(tags.get(257));
      const bitsPerSample = first(tags.get(258), 1);
      const compression = first(tags.get(259));
      const photometric = first(tags.get(262), 0);
      const stripOffsets = tags.get(273) || [];
      const samplesPerPixel = first(tags.get(277), 1);
      const rowsPerStrip = first(tags.get(278), height);
      const stripByteCounts = tags.get(279) || [];
      const resolutionUnit = first(tags.get(296), 2);
      let xResolution = first(tags.get(282), DEFAULT_DPI);

      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new TiffError("TIFF page has invalid dimensions.");
      }
      if (compression !== 4) {
        throw new TiffError(`Unsupported TIFF compression ${compression}. Only CCITT Group 4 is supported in the browser.`);
      }
      if (bitsPerSample !== 1 || samplesPerPixel !== 1) {
        throw new TiffError("Only 1 bit, single sample TIFF Group 4 drawings are supported in the browser.");
      }
      if (stripOffsets.length !== 1 || stripByteCounts.length !== 1) {
        throw new TiffError("Only single strip Group 4 TIFF pages are supported in the browser.");
      }

      if (resolutionUnit === 3) xResolution *= 2.54;
      const dpi = Number.isFinite(xResolution) && xResolution > 0 ? Math.round(xResolution) : DEFAULT_DPI;
      const dataOffset = stripOffsets[0];
      const byteCount = stripByteCounts[0];
      if (dataOffset < 0 || byteCount <= 0 || dataOffset + byteCount > bytes.length) {
        throw new TiffError("TIFF strip data points outside the file.");
      }

      pages.push({
        width, height, dpi, compression, photometric, rowsPerStrip,
        data: bytes.slice(dataOffset, dataOffset + byteCount),
      });

      ifdOffset = readU32(view, entriesEnd, little);
      if (pages.length > 10000) throw new TiffError("Too many TIFF pages.");
    }

    if (!pages.length) throw new TiffError("No TIFF pages were found.");
    return {
      kind: "tiff",
      format: "TIFF CCITT Group 4 raster",
      compression: "CCITT Group 4",
      width: pages[0].width,
      height: pages[0].height,
      dpi: pages[0].dpi || DEFAULT_DPI,
      pageCount: pages.length,
      pages,
    };
  }

  function makeImageObject(width, height, data) {
    return concat([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode ` +
          `/DecodeParms << /K -1 /Columns ${width} /Rows ${height} /BlackIs1 false >> ` +
          `/Length ${data.length} >>\nstream\n`
      ),
      data,
      ascii("\nendstream"),
    ]);
  }

  function makeRawImageObject(width, height, data) {
    return concat([
      ascii(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Length ${data.length} >>\nstream\n`),
      data,
      ascii("\nendstream"),
    ]);
  }

  function addPage(objects, nextObjectId, pageWidthPt, pageHeightPt, imageRefs, content) {
    const contentBytes = ascii(content);
    const contentObjectId = nextObjectId++;
    objects.set(contentObjectId, concat([ascii(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, ascii("endstream")]));
    const xobjects = imageRefs.map((ref) => `/Im${ref.objectId} ${ref.objectId} 0 R`).join(" ");
    const pageObjectId = nextObjectId++;
    objects.set(
      pageObjectId,
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(6)} ${pageHeightPt.toFixed(6)}] ` +
          `/Resources << /XObject << ${xobjects} >> >> /Contents ${contentObjectId} 0 R >>`
      )
    );
    return { pageObjectId, nextObjectId };
  }

  function appendParsedPages(doc, dpi, objects, nextObjectId) {
    const parsed = doc.parsed;
    const pageIds = [];

    if (parsed.kind === "tiff") {
      for (const page of parsed.pages) {
        const cleanDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : (page.dpi || parsed.dpi || DEFAULT_DPI);
        const pageWidthPt = (page.width / cleanDpi) * 72;
        const pageHeightPt = (page.height / cleanDpi) * 72;
        const objectId = nextObjectId++;
        objects.set(objectId, makeImageObject(page.width, page.height, page.data));
        const content = `q\n${pageWidthPt.toFixed(6)} 0 0 ${pageHeightPt.toFixed(6)} 0 0 cm\n/Im${objectId} Do\nQ\n`;
        const added = addPage(objects, nextObjectId, pageWidthPt, pageHeightPt, [{ objectId }], content);
        pageIds.push(added.pageObjectId);
        nextObjectId = added.nextObjectId;
      }
      return { pageIds, nextObjectId };
    }

    if (parsed.kind === "cals") {
      const cleanDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : (parsed.dpi || DEFAULT_DPI);
      const pageWidthPt = (parsed.width / cleanDpi) * 72;
      const pageHeightPt = (parsed.height / cleanDpi) * 72;
      const objectId = nextObjectId++;
      objects.set(objectId, makeImageObject(parsed.width, parsed.height, parsed.data));
      const content = `q\n${pageWidthPt.toFixed(6)} 0 0 ${pageHeightPt.toFixed(6)} 0 0 cm\n/Im${objectId} Do\nQ\n`;
      const added = addPage(objects, nextObjectId, pageWidthPt, pageHeightPt, [{ objectId }], content);
      pageIds.push(added.pageObjectId);
      return { pageIds, nextObjectId: added.nextObjectId };
    }

    const cleanDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_DPI;
    const pageWidthPt = (parsed.width / cleanDpi) * 72;
    const pageHeightPt = (parsed.height / cleanDpi) * 72;
    const tileWidthPt = (TILE_SIZE / cleanDpi) * 72;
    const tileHeightPt = (TILE_SIZE / cleanDpi) * 72;
    const imageRefs = [];
    let content = "";
    for (const tile of [...parsed.tiles].sort((a, b) => a.logicalTile - b.logicalTile)) {
      const objectId = nextObjectId++;
      if (tile.compression === 0x00) objects.set(objectId, makeImageObject(TILE_SIZE, TILE_SIZE, tile.data));
      else if (tile.compression === 0x80) objects.set(objectId, makeRawImageObject(TILE_SIZE, TILE_SIZE, tile.data));
      else throw new TiffError(`Unsupported C4 tile compression flag at tile ${tile.entryNo}.`);
      imageRefs.push({ objectId, logicalTile: tile.logicalTile });
    }
    for (const ref of imageRefs) {
      const col = ref.logicalTile % parsed.cols;
      const row = Math.floor(ref.logicalTile / parsed.cols);
      const x = col * tileWidthPt;
      const y = pageHeightPt - (row + 1) * tileHeightPt;
      content += `q\n${tileWidthPt.toFixed(6)} 0 0 ${tileHeightPt.toFixed(6)} ${x.toFixed(6)} ${y.toFixed(6)} cm\n/Im${ref.objectId} Do\nQ\n`;
    }
    const added = addPage(objects, nextObjectId, pageWidthPt, pageHeightPt, imageRefs, content);
    pageIds.push(added.pageObjectId);
    return { pageIds, nextObjectId: added.nextObjectId };
  }

  function buildCombinedPdfFromParsedDocs(docs, dpi = DEFAULT_DPI) {
    if (!docs.length) throw new TiffError("No converted drawings are available to combine.");
    const objects = new Map();
    const pageIds = [];
    let nextObjectId = 3;
    for (const doc of docs) {
      const result = appendParsedPages(doc, dpi || doc.parsed.dpi || DEFAULT_DPI, objects, nextObjectId);
      pageIds.push(...result.pageIds);
      nextObjectId = result.nextObjectId;
    }
    objects.set(2, ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`));
    objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));
    const maxObjectId = Math.max(...objects.keys());
    const chunks = [ascii("%PDF-1.4\n% C4/MIL/CALS/TIFF combined PDF generated by GitHub Pages\n")];
    const offsets = new Array(maxObjectId + 1).fill(0);
    let length = chunks[0].length;
    for (let objectId = 1; objectId <= maxObjectId; objectId++) {
      const body = objects.get(objectId);
      if (!body) throw new TiffError(`Internal PDF build error: missing object ${objectId}.`);
      offsets[objectId] = length;
      const prefix = ascii(`${objectId} 0 obj\n`);
      const suffix = ascii("\nendobj\n");
      chunks.push(prefix, body, suffix);
      length += prefix.length + body.length + suffix.length;
    }
    const startXref = length;
    let xref = `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
    for (let objectId = 1; objectId <= maxObjectId; objectId++) {
      xref += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
    chunks.push(ascii(xref));
    return concat(chunks);
  }

  function buildPdfFromTiff(parsed, dpi = parsed.dpi || DEFAULT_DPI) {
    return buildCombinedPdfFromParsedDocs([{ path: "tiff", parsed }], dpi);
  }

  function describeParsedDrawing(parsed) {
    if (parsed.kind === "tiff") return `${parsed.width} x ${parsed.height}, Group 4 TIFF, ${parsed.pageCount} page(s), ${parsed.dpi || DEFAULT_DPI} dpi`;
    return originalDescribeParsedDrawing(parsed);
  }

  const exported = window.module && window.module.exports ? window.module.exports : {};
  const originalIsSupportedDrawingName = exported.isSupportedDrawingName || (() => false);
  const originalConvertDrawingArrayBuffer = exported.convertDrawingArrayBuffer;
  const originalDescribeParsedDrawing = exported.describeParsedDrawing || ((parsed) => `${parsed.width} x ${parsed.height}`);

  if (typeof originalConvertDrawingArrayBuffer !== "function") {
    throw new TiffError("TIFF support could not find the shared drawing converter exported by cals-support.js.");
  }

  Object.assign(exported, {
    TiffError,
    parseTiff,
    buildPdfFromTiff,
    buildCombinedPdfFromParsedDocs,
    isTiffName,
    isSupportedDrawingName: (name) => isTiffName(name) || originalIsSupportedDrawingName(name),
    convertDrawingArrayBuffer: (arrayBuffer, name, dpi) => {
      if (isTiffName(name)) {
        const parsed = parseTiff(arrayBuffer);
        return { parsed, pdfBytes: buildPdfFromTiff(parsed, dpi || parsed.dpi || DEFAULT_DPI), kind: "TIFF" };
      }
      return originalConvertDrawingArrayBuffer(arrayBuffer, name, dpi);
    },
    describeParsedDrawing,
    supportedDrawingExtensions: [".c4", ".mil", ".cal", ".cals", ".tif", ".tiff"],
  });

  function getDpi() {
    const input = document.getElementById("dpiInput");
    const value = Number.parseInt(input.value, 10);
    if (!Number.isFinite(value) || value < 72 || value > 600) {
      input.value = String(DEFAULT_DPI);
      return DEFAULT_DPI;
    }
    return value;
  }

  function setStatus(message, isError = false) {
    const status = document.getElementById("status");
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  function setDetails(message) { document.getElementById("details").textContent = message; }
  function setPreviewUrl(url) { document.getElementById("preview").src = url; }

  let tiffPdfUrl = null;
  function clearTiffPdfUrl() {
    if (tiffPdfUrl) URL.revokeObjectURL(tiffPdfUrl);
    tiffPdfUrl = null;
  }

  async function convertTiffFile(file) {
    setStatus(`Reading ${file.name}...`);
    setDetails("");
    clearTiffPdfUrl();
    setPreviewUrl("about:blank");
    document.getElementById("downloadButton").disabled = true;
    document.getElementById("openButton").disabled = true;

    try {
      const dpi = getDpi();
      const result = exported.convertDrawingArrayBuffer(await file.arrayBuffer(), file.name, dpi);
      const blob = new Blob([result.pdfBytes], { type: "application/pdf" });
      tiffPdfUrl = URL.createObjectURL(blob);
      const pdfFileName = `${String(file.name || "converted").replace(/\.[^.]+$/, "") || "converted"}.pdf`;
      const download = document.getElementById("downloadButton");
      download.disabled = false;
      download.onclick = () => {
        const a = document.createElement("a");
        a.href = tiffPdfUrl;
        a.download = pdfFileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      const open = document.getElementById("openButton");
      open.disabled = false;
      open.onclick = () => window.open(tiffPdfUrl, "_blank", "noopener,noreferrer");
      setPreviewUrl(tiffPdfUrl);
      setDetails([
        `File: ${file.name}`,
        "Detected type: TIFF raster drawing",
        "Compression: CCITT Group 4",
        `Pages: ${result.parsed.pageCount}`,
        `First page pixels: ${result.parsed.width.toLocaleString()} x ${result.parsed.height.toLocaleString()}`,
        `Header DPI: ${result.parsed.dpi}`,
        `PDF scale: ${dpi} dpi`,
        "PDF method: direct CCITT Group 4 image embedding",
        "Privacy: the file stays in this browser session.",
      ].join("\n"));
      setStatus(`Converted ${file.name} to ${pdfFileName}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      setDetails("Conversion failed. Browser TIFF support is limited to 1 bit CCITT Group 4 TIFF pages stored as a single strip per page.");
    }
  }

  function setupTiffSupport() {
    const fileInput = document.getElementById("fileInput");
    const multiFileInput = document.getElementById("multiFileInput");
    const dropZone = document.getElementById("dropZone");
    if (!fileInput || !dropZone) return;
    const accept = ".c4,.C4,.mil,.MIL,.cal,.CAL,.cals,.CALS,.tif,.TIF,.tiff,.TIFF";
    fileInput.setAttribute("accept", accept);
    if (multiFileInput) multiFileInput.setAttribute("accept", accept);
    fileInput.addEventListener("change", (event) => {
      const file = fileInput.files && fileInput.files[0];
      if (!file || !isTiffName(file.name)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      convertTiffFile(file);
    }, true);
    dropZone.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file || !isTiffName(file.name)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dropZone.classList.remove("dragover");
      convertTiffFile(file);
    }, true);
    setStatus("Ready. Select one .C4, .MIL, .CAL, .CALS, .TIF, or .TIFF file.");
  }

  document.addEventListener("DOMContentLoaded", setupTiffSupport);
})();
