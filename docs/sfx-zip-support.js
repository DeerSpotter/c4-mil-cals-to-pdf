/* ZIP and WinZip self extracting EXE support. EXE files are read as archives only and are never executed. */
(() => {
  const DEFAULT_DPI = 200;
  const TILE_SIZE = 512;
  const DRAWING_EXTENSIONS = [".c4", ".mil"];
  const PACKAGE_EXTENSIONS = [".exe", ".zip"];
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();

  class ZipPackageError extends Error {}

  function getExportedConverter() {
    const exported = window.module && window.module.exports ? window.module.exports : {};
    if (typeof exported.parseC4 !== "function" || typeof exported.buildPdfFromC4 !== "function") {
      throw new ZipPackageError("Could not find the C4 parser exported by app.js.");
    }
    return exported;
  }

  function u16(view, offset) { return view.getUint16(offset, true); }
  function u32(view, offset) { return view.getUint32(offset, true); }
  function utf8(text) { return encoder.encode(text); }
  function waitForPaint() { return new Promise((resolve) => setTimeout(resolve, 0)); }

  function concat(chunks) {
    let size = 0;
    for (const chunk of chunks) size += chunk.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function setStatus(message, isError = false) {
    const status = document.getElementById("status");
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  function setDetails(message) {
    document.getElementById("details").textContent = message;
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

  function shouldCombineIntoOnePdf() {
    const checkbox = document.getElementById("combinePdfCheckbox");
    return Boolean(checkbox && checkbox.checked);
  }

  function isPackageFile(file) {
    const name = (file && file.name ? file.name : "").toLowerCase();
    return PACKAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
  }

  function isDrawingPath(path) {
    const lower = String(path || "").toLowerCase();
    return DRAWING_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function sigAt(bytes, offset, sig) {
    return offset >= 0 && offset + 4 <= bytes.length &&
      bytes[offset] === (sig & 255) &&
      bytes[offset + 1] === ((sig >>> 8) & 255) &&
      bytes[offset + 2] === ((sig >>> 16) & 255) &&
      bytes[offset + 3] === ((sig >>> 24) & 255);
  }

  function findEocd(bytes) {
    const min = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (sigAt(bytes, i, 0x06054b50)) return i;
    }
    throw new ZipPackageError("Could not find a ZIP directory. This does not look like a ZIP or WinZip SFX archive.");
  }

  function cleanPath(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== ".." && !part.includes(":"))
      .join("/");
  }

  function pdfPath(packageName, entryName) {
    const packageStem = cleanPath(packageName).replace(/\.[^/.]+$/, "") || "package";
    const entry = cleanPath(entryName).replace(/\.[^/.]+$/, ".pdf") || "drawing.pdf";
    return `${packageStem}/${entry}`;
  }

  function makeUniquePath(path, used) {
    const normalized = cleanPath(path);
    if (!used.has(normalized)) {
      used.add(normalized);
      return normalized;
    }
    const slash = normalized.lastIndexOf("/");
    const dot = normalized.lastIndexOf(".");
    const stem = dot > slash ? normalized.slice(0, dot) : normalized;
    const ext = dot > slash ? normalized.slice(dot) : "";
    let counter = 2;
    while (true) {
      const candidate = `${stem}_${counter}${ext}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
      counter++;
    }
  }

  function parseZipDirectory(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const eocd = findEocd(bytes);
    const entryCount = u16(view, eocd + 10);
    const centralSize = u32(view, eocd + 12);
    let centralOffset = u32(view, eocd + 16);

    if (!sigAt(bytes, centralOffset, 0x02014b50)) {
      const computed = eocd - centralSize;
      if (sigAt(bytes, computed, 0x02014b50)) centralOffset = computed;
    }
    if (!sigAt(bytes, centralOffset, 0x02014b50)) {
      throw new ZipPackageError("ZIP central directory offset could not be resolved.");
    }

    const firstLocal = bytes.findIndex((_, i) => sigAt(bytes, i, 0x04034b50));
    const entries = [];
    let pos = centralOffset;
    for (let i = 0; i < entryCount; i++) {
      if (!sigAt(bytes, pos, 0x02014b50)) throw new ZipPackageError(`Bad central directory entry ${i + 1}.`);
      const method = u16(view, pos + 10);
      const compressedSize = u32(view, pos + 20);
      const uncompressedSize = u32(view, pos + 24);
      const nameLength = u16(view, pos + 28);
      const extraLength = u16(view, pos + 30);
      const commentLength = u16(view, pos + 32);
      const relativeLocalOffset = u32(view, pos + 42);
      const name = decoder.decode(bytes.slice(pos + 46, pos + 46 + nameLength));

      let localOffset = relativeLocalOffset;
      if (!sigAt(bytes, localOffset, 0x04034b50) && firstLocal >= 0 && sigAt(bytes, firstLocal + relativeLocalOffset, 0x04034b50)) {
        localOffset = firstLocal + relativeLocalOffset;
      }
      if (!sigAt(bytes, localOffset, 0x04034b50)) throw new ZipPackageError(`Could not locate local file header for ${name}.`);

      const localNameLength = u16(view, localOffset + 26);
      const localExtraLength = u16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      entries.push({ name, method, compressedSize, uncompressedSize, dataStart, isDirectory: name.endsWith("/") });
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return { bytes, entries };
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new ZipPackageError("This browser cannot inflate deflated ZIP entries. Try current desktop Chrome, Edge, or Firefox.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function extractEntry(zip, entry) {
    const compressed = zip.bytes.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) return inflateRaw(compressed);
    throw new ZipPackageError(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`);
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function pushU16(out, value) { out.push(value & 255, (value >>> 8) & 255); }
  function pushU32(out, value) { out.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255); }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  function makeZip(entries) {
    const localChunks = [];
    const centralChunks = [];
    const timestamp = dosDateTime();
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = utf8(entry.path);
      const data = entry.data;
      const checksum = crc32(data);
      const localHeader = [];
      pushU32(localHeader, 0x04034b50); pushU16(localHeader, 20); pushU16(localHeader, 0x0800); pushU16(localHeader, 0);
      pushU16(localHeader, timestamp.dosTime); pushU16(localHeader, timestamp.dosDate);
      pushU32(localHeader, checksum); pushU32(localHeader, data.length); pushU32(localHeader, data.length);
      pushU16(localHeader, nameBytes.length); pushU16(localHeader, 0);
      const localHeaderBytes = new Uint8Array(localHeader);
      localChunks.push(localHeaderBytes, nameBytes, data);

      const centralHeader = [];
      pushU32(centralHeader, 0x02014b50); pushU16(centralHeader, 20); pushU16(centralHeader, 20); pushU16(centralHeader, 0x0800); pushU16(centralHeader, 0);
      pushU16(centralHeader, timestamp.dosTime); pushU16(centralHeader, timestamp.dosDate);
      pushU32(centralHeader, checksum); pushU32(centralHeader, data.length); pushU32(centralHeader, data.length);
      pushU16(centralHeader, nameBytes.length); pushU16(centralHeader, 0); pushU16(centralHeader, 0); pushU16(centralHeader, 0); pushU16(centralHeader, 0);
      pushU32(centralHeader, 0); pushU32(centralHeader, offset);
      centralChunks.push(new Uint8Array(centralHeader), nameBytes);
      offset += localHeaderBytes.length + nameBytes.length + data.length;
    }
    const centralDirectory = concat(centralChunks);
    const end = [];
    pushU32(end, 0x06054b50); pushU16(end, 0); pushU16(end, 0); pushU16(end, entries.length); pushU16(end, entries.length);
    pushU32(end, centralDirectory.length); pushU32(end, offset); pushU16(end, 0);
    return concat([...localChunks, centralDirectory, new Uint8Array(end)]);
  }

  function makeImageObject(tile) {
    const tileData = tile.data;
    if (tile.compression === 0x00) {
      return concat([
        utf8(`<< /Type /XObject /Subtype /Image /Width ${TILE_SIZE} /Height ${TILE_SIZE} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${TILE_SIZE} /Rows ${TILE_SIZE} /BlackIs1 false >> /Length ${tileData.length} >>\nstream\n`),
        tileData,
        utf8("\nendstream"),
      ]);
    }
    if (tile.compression === 0x80) {
      return concat([
        utf8(`<< /Type /XObject /Subtype /Image /Width ${TILE_SIZE} /Height ${TILE_SIZE} /ColorSpace /DeviceGray /BitsPerComponent 1 /Length ${tileData.length} >>\nstream\n`),
        tileData,
        utf8("\nendstream"),
      ]);
    }
    throw new ZipPackageError(`Unsupported C4 tile compression flag at tile ${tile.entryNo}.`);
  }

  function buildCombinedPdfFromParsedDocs(docs, dpi = DEFAULT_DPI) {
    const cleanDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_DPI;
    const objects = new Map();
    const pageIds = [];
    let nextObjectId = 3;
    for (const doc of docs) {
      const parsed = doc.parsed;
      const pageWidthPt = (parsed.width / cleanDpi) * 72;
      const pageHeightPt = (parsed.height / cleanDpi) * 72;
      const tileWidthPt = (TILE_SIZE / cleanDpi) * 72;
      const tileHeightPt = (TILE_SIZE / cleanDpi) * 72;
      const imageRefs = [];
      for (const tile of [...parsed.tiles].sort((a, b) => a.logicalTile - b.logicalTile)) {
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
        content += `q\n${tileWidthPt.toFixed(6)} 0 0 ${tileHeightPt.toFixed(6)} ${x.toFixed(6)} ${y.toFixed(6)} cm\n/Im${ref.objectId} Do\nQ\n`;
      }
      const contentBytes = utf8(content);
      const contentObjectId = nextObjectId++;
      objects.set(contentObjectId, concat([utf8(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, utf8("endstream")]));
      const xobjects = imageRefs.map((ref) => `/Im${ref.objectId} ${ref.objectId} 0 R`).join(" ");
      const pageObjectId = nextObjectId++;
      objects.set(pageObjectId, utf8(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(6)} ${pageHeightPt.toFixed(6)}] /Resources << /XObject << ${xobjects} >> >> /Contents ${contentObjectId} 0 R >>`));
      pageIds.push(pageObjectId);
    }
    objects.set(2, utf8(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`));
    objects.set(1, utf8("<< /Type /Catalog /Pages 2 0 R >>"));
    const maxObjectId = Math.max(...objects.keys());
    const chunks = [utf8("%PDF-1.4\n% C4/MIL package combined PDF generated by GitHub Pages\n")];
    const offsets = new Array(maxObjectId + 1).fill(0);
    let length = chunks[0].length;
    for (let objectId = 1; objectId <= maxObjectId; objectId++) {
      const body = objects.get(objectId);
      if (!body) throw new ZipPackageError(`Internal combined PDF build error: missing object ${objectId}.`);
      offsets[objectId] = length;
      const prefix = utf8(`${objectId} 0 obj\n`);
      const suffix = utf8("\nendobj\n");
      chunks.push(prefix, body, suffix);
      length += prefix.length + body.length + suffix.length;
    }
    const startXref = length;
    let xref = `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
    for (let objectId = 1; objectId <= maxObjectId; objectId++) xref += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
    chunks.push(utf8(xref));
    return concat(chunks);
  }

  function downloadBytes(bytes, fileName, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  async function convertPackageFiles(fileList) {
    const packages = Array.from(fileList || []).filter(isPackageFile);
    if (!packages.length) return;
    const { parseC4, buildPdfFromC4 } = getExportedConverter();
    const dpi = getDpi();
    const combine = shouldCombineIntoOnePdf();
    const zipEntries = [];
    const combinedDocs = [];
    const usedPaths = new Set();
    const report = [
      "C4/MIL EXE/ZIP package conversion report",
      `Generated: ${new Date().toLocaleString()}`,
      `DPI: ${dpi}`,
      `Packages selected: ${packages.length}`,
      "",
    ];
    let converted = 0;
    let failed = 0;

    setStatus(`Reading ${packages.length} EXE/ZIP package(s)...`);
    setDetails("Selected EXE files are treated as ZIP/SFX containers only. Nothing is executed.");
    await waitForPaint();

    for (let packageIndex = 0; packageIndex < packages.length; packageIndex++) {
      const file = packages[packageIndex];
      report.push(`PACKAGE ${file.name}`);
      try {
        const zip = parseZipDirectory(await file.arrayBuffer());
        const drawings = zip.entries.filter((entry) => !entry.isDirectory && isDrawingPath(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
        report.push(`  ZIP entries: ${zip.entries.length}`);
        report.push(`  C4/MIL entries: ${drawings.length}`);
        if (!drawings.length) {
          failed++;
          report.push("  FAIL no .C4 or .MIL files found in this package");
          continue;
        }
        for (let i = 0; i < drawings.length; i++) {
          const entry = drawings[i];
          setStatus(`Converting package ${packageIndex + 1}/${packages.length}, drawing ${i + 1}/${drawings.length}: ${entry.name}`);
          try {
            const drawingBytes = await extractEntry(zip, entry);
            const parsed = parseC4(drawingBytes.buffer.slice(drawingBytes.byteOffset, drawingBytes.byteOffset + drawingBytes.byteLength));
            const pdfBytes = buildPdfFromC4(parsed, dpi);
            const outPath = makeUniquePath(pdfPath(file.name, entry.name), usedPaths);
            zipEntries.push({ path: outPath, data: pdfBytes });
            combinedDocs.push({ path: `${file.name}/${entry.name}`, parsed });
            converted++;
            report.push(`  OK   ${entry.name} -> ${outPath} (${parsed.width} x ${parsed.height}, ${parsed.tileCount} tiles)`);
          } catch (error) {
            failed++;
            report.push(`  FAIL ${entry.name} -> ${error instanceof Error ? error.message : String(error)}`);
          }
          if (i % 5 === 0) {
            setDetails(report.slice(-35).join("\n"));
            await waitForPaint();
          }
        }
      } catch (error) {
        failed++;
        report.push(`  FAIL package could not be read -> ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!converted) {
      setStatus("No PDFs were created from the selected package(s).", true);
      setDetails(report.join("\n"));
      return;
    }

    if (combine) {
      setStatus("Building combined package PDF...");
      await waitForPaint();
      const combined = buildCombinedPdfFromParsedDocs(combinedDocs, dpi);
      downloadBytes(combined, "c4-mil-package-combined.pdf", "application/pdf");
      setStatus(`Package conversion complete. Added ${converted} page(s)${failed ? `, ${failed} failed` : ""}.`);
      setDetails([...report, "", "Combined PDF page order:", ...combinedDocs.map((doc, index) => `${index + 1}. ${doc.path}`)].join("\n"));
      return;
    }

    const fullReport = report.join("\n");
    const zipBytes = makeZip([...zipEntries, { path: "conversion_report.txt", data: utf8(fullReport) }]);
    downloadBytes(zipBytes, "c4-mil-package-converted-pdfs.zip", "application/zip");
    setStatus(`Package conversion complete. Converted ${converted} file(s)${failed ? `, ${failed} failed` : ""}. ZIP download started.`);
    setDetails(fullReport);
  }

  function setupPackageInput() {
    const input = document.getElementById("packageInput");
    const button = document.getElementById("packageButton");
    if (!input || !button) return;
    button.addEventListener("click", () => {
      input.value = "";
      input.click();
    });
    input.addEventListener("change", () => convertPackageFiles(input.files));
  }

  document.addEventListener("DOMContentLoaded", setupPackageInput);
})();
