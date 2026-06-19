/*
  Browser C4/JEDMICS single-file to PDF converter.

  This version is intentionally separate from the Python desktop dashboard.
  It does not decode CCITT Group 4 to pixels. Instead it parses the C4 tile
  directory and writes a PDF that embeds each 512 x 512 tile as a PDF image
  object using /CCITTFaxDecode. The browser's PDF viewer handles the preview.
*/

(() => {
  const TILE_SIZE = 512;
  const DEFAULT_DPI = 200;

  class C4Error extends Error {}

  function readU16LE(view, offset) {
    return view.getUint16(offset, true);
  }

  function readU32LE(view, offset) {
    return view.getUint32(offset, true);
  }

  function readU32BE(view, offset) {
    return view.getUint32(offset, false);
  }

  function asciiBytes(text) {
    return new TextEncoder().encode(text);
  }

  function concatBytes(chunks) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function safePdfFileName(name) {
    const base = name.replace(/\.[^.]+$/, "") || "converted";
    return `${base}.pdf`;
  }

  function parseC4(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 16) {
      throw new C4Error("File is too small to be a supported C4/JEDMICS drawing.");
    }

    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);

    const indexOffset = readU32LE(view, 0);
    const height = readU16LE(view, 4);
    const bytesWide = readU16LE(view, 6);
    const dataOffset = readU32BE(view, 8);
    let tileCount = bytes[12];
    const width = bytesWide * 8;

    if (width <= 0 || height <= 0) {
      throw new C4Error(`Invalid C4 dimensions: ${width} x ${height}.`);
    }
    if (indexOffset <= 0 || indexOffset >= bytes.length) {
      throw new C4Error(`Invalid C4 index offset: ${indexOffset}.`);
    }
    if (dataOffset <= 0 || dataOffset > bytes.length) {
      throw new C4Error(`Invalid C4 data offset: ${dataOffset}.`);
    }

    const cols = Math.ceil(width / TILE_SIZE);
    const rows = Math.ceil(height / TILE_SIZE);
    const expectedTiles = cols * rows;
    if (tileCount === 0) tileCount = expectedTiles;
    if (tileCount !== expectedTiles) {
      throw new C4Error(
        `Tile count mismatch. Header says ${tileCount}, but ${width} x ${height} requires ${expectedTiles} tiles.`
      );
    }

    const tiles = [];
    let indexPos = indexOffset;
    let payloadPos = dataOffset;

    for (let entryNo = 0; entryNo < tileCount; entryNo++) {
      if (indexPos + 4 > bytes.length) {
        throw new C4Error(`Tile index ended early at entry ${entryNo}.`);
      }

      const tileNo = bytes[indexPos];
      const compression = bytes[indexPos + 1];
      const size = readU16LE(view, indexPos + 2);

      if (size <= 0) {
        throw new C4Error(`Tile ${entryNo} has an invalid payload size: ${size}.`);
      }
      if (payloadPos + size > bytes.length) {
        throw new C4Error(`Tile ${entryNo} payload extends beyond end of file.`);
      }

      const logicalTile = tileCount > 252 ? entryNo : tileNo;
      tiles.push({
        entryNo,
        tileNo,
        logicalTile,
        compression,
        data: bytes.slice(payloadPos, payloadPos + size),
      });

      indexPos += 4;
      payloadPos += size;
    }

    return {
      width,
      height,
      cols,
      rows,
      tileCount,
      indexOffset,
      dataOffset,
      tiles,
    };
  }

  function makeImageObject(tile) {
    const tileData = tile.data;

    if (tile.compression === 0x00) {
      return concatBytes([
        asciiBytes(
          `<< /Type /XObject /Subtype /Image /Width ${TILE_SIZE} /Height ${TILE_SIZE} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 1 ` +
            `/Filter /CCITTFaxDecode ` +
            `/DecodeParms << /K -1 /Columns ${TILE_SIZE} /Rows ${TILE_SIZE} /BlackIs1 false >> ` +
            `/Length ${tileData.length} >>\nstream\n`
        ),
        tileData,
        asciiBytes("\nendstream"),
      ]);
    }

    if (tile.compression === 0x80) {
      return concatBytes([
        asciiBytes(
          `<< /Type /XObject /Subtype /Image /Width ${TILE_SIZE} /Height ${TILE_SIZE} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 1 ` +
            `/Length ${tileData.length} >>\nstream\n`
        ),
        tileData,
        asciiBytes("\nendstream"),
      ]);
    }

    throw new C4Error(
      `Unsupported C4 tile compression flag at tile ${tile.entryNo}: 0x${tile.compression
        .toString(16)
        .padStart(2, "0")}.`
    );
  }

  function buildPdfFromC4(parsed, dpi = DEFAULT_DPI) {
    const cleanDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_DPI;
    const pageWidthPt = (parsed.width / cleanDpi) * 72;
    const pageHeightPt = (parsed.height / cleanDpi) * 72;
    const tileWidthPt = (TILE_SIZE / cleanDpi) * 72;
    const tileHeightPt = (TILE_SIZE / cleanDpi) * 72;

    const objects = new Map();
    const imageRefs = [];
    let nextObjectId = 5;

    const sortedTiles = [...parsed.tiles].sort((a, b) => a.logicalTile - b.logicalTile);
    for (const tile of sortedTiles) {
      const objectId = nextObjectId++;
      objects.set(objectId, makeImageObject(tile));
      imageRefs.push({ objectId, logicalTile: tile.logicalTile });
    }

    let content = "";
    for (const ref of imageRefs) {
      const col = ref.logicalTile % parsed.cols;
      const row = Math.floor(ref.logicalTile / parsed.cols);
      const x = col * tileWidthPt;
      const y = pageHeightPt - (row + 1) * tileHeightPt;
      content +=
        "q\n" +
        `${tileWidthPt.toFixed(6)} 0 0 ${tileHeightPt.toFixed(6)} ${x.toFixed(6)} ${y.toFixed(6)} cm\n` +
        `/Im${ref.objectId} Do\n` +
        "Q\n";
    }

    const contentBytes = asciiBytes(content);
    objects.set(
      4,
      concatBytes([
        asciiBytes(`<< /Length ${contentBytes.length} >>\nstream\n`),
        contentBytes,
        asciiBytes("endstream"),
      ])
    );

    const xobjects = imageRefs.map((ref) => `/Im${ref.objectId} ${ref.objectId} 0 R`).join(" ");
    objects.set(
      3,
      asciiBytes(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(6)} ${pageHeightPt.toFixed(
          6
        )}] /Resources << /XObject << ${xobjects} >> >> /Contents 4 0 R >>`
      )
    );
    objects.set(2, asciiBytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
    objects.set(1, asciiBytes("<< /Type /Catalog /Pages 2 0 R >>"));

    const maxObjectId = Math.max(...objects.keys());
    const chunks = [asciiBytes("%PDF-1.4\n% C4 generated by GitHub Pages\n")];
    const offsets = new Array(maxObjectId + 1).fill(0);
    let lengthSoFar = chunks[0].length;

    for (let objectId = 1; objectId <= maxObjectId; objectId++) {
      const body = objects.get(objectId);
      if (!body) throw new C4Error(`Internal PDF build error: missing object ${objectId}.`);
      offsets[objectId] = lengthSoFar;
      const prefix = asciiBytes(`${objectId} 0 obj\n`);
      const suffix = asciiBytes("\nendobj\n");
      chunks.push(prefix, body, suffix);
      lengthSoFar += prefix.length + body.length + suffix.length;
    }

    const startXref = lengthSoFar;
    let xref = `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
    for (let objectId = 1; objectId <= maxObjectId; objectId++) {
      xref += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
    chunks.push(asciiBytes(xref));

    return concatBytes(chunks);
  }

  function describeParsed(parsed, fileName, dpi) {
    const widthIn = parsed.width / dpi;
    const heightIn = parsed.height / dpi;
    return [
      `File: ${fileName}`,
      `Pixels: ${parsed.width.toLocaleString()} x ${parsed.height.toLocaleString()}`,
      `Tiles: ${parsed.cols} columns x ${parsed.rows} rows = ${parsed.tileCount}`,
      `Scale: ${dpi} dpi = ${widthIn.toFixed(2)} x ${heightIn.toFixed(2)} inches`,
      `PDF method: direct CCITT Group 4 tile embedding`,
      `Privacy: the file stays in this browser session.`,
    ].join("\n");
  }

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

  function setDetails(message) {
    document.getElementById("details").textContent = message;
  }

  function setPreviewUrl(url) {
    const preview = document.getElementById("preview");
    preview.src = url;
  }

  let currentPdfUrl = null;
  let currentPdfFileName = "converted.pdf";

  function clearCurrentPdfUrl() {
    if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
    currentPdfUrl = null;
  }

  async function convertSelectedFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".c4")) {
      setStatus("Select a .C4 file for this GitHub Pages version.", true);
      return;
    }

    setStatus(`Reading ${file.name}...`);
    setDetails("");
    clearCurrentPdfUrl();
    setPreviewUrl("about:blank");
    document.getElementById("downloadButton").disabled = true;
    document.getElementById("openButton").disabled = true;

    try {
      const dpi = getDpi();
      const buffer = await file.arrayBuffer();
      const parsed = parseC4(buffer);
      const pdfBytes = buildPdfFromC4(parsed, dpi);
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      currentPdfUrl = URL.createObjectURL(blob);
      currentPdfFileName = safePdfFileName(file.name);

      const download = document.getElementById("downloadButton");
      download.disabled = false;
      download.onclick = () => {
        const a = document.createElement("a");
        a.href = currentPdfUrl;
        a.download = currentPdfFileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };

      const open = document.getElementById("openButton");
      open.disabled = false;
      open.onclick = () => window.open(currentPdfUrl, "_blank", "noopener,noreferrer");

      setPreviewUrl(currentPdfUrl);
      setDetails(describeParsed(parsed, file.name, dpi));
      setStatus(`Converted ${file.name} to ${currentPdfFileName}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
      setDetails("Conversion failed. This page currently supports the same tiled 512 x 512 C4/JEDMICS layout used by the Python release.");
    }
  }

  function setupBrowserUi() {
    const fileInput = document.getElementById("fileInput");
    const dropZone = document.getElementById("dropZone");
    const chooseButton = document.getElementById("chooseButton");

    chooseButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => convertSelectedFile(fileInput.files?.[0]));

    for (const eventName of ["dragenter", "dragover"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.add("dragover");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.remove("dragover");
      });
    }
    dropZone.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) convertSelectedFile(file);
    });

    setStatus("Choose one .C4 file to preview and download as PDF.");
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("DOMContentLoaded", setupBrowserUi);
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseC4, buildPdfFromC4, C4Error };
  }
})();
