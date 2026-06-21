/*
  Browser folder and multi-file batch conversion for C4/MIL files.

  The browser cannot silently write PDFs back into the selected source folders.
  Instead this scans the selected directory tree locally, converts supported files,
  and either downloads a ZIP of individual PDFs or one combined multi-page PDF.
*/

(() => {
  const DEFAULT_DPI = 200;
  const TILE_SIZE = 512;
  const SUPPORTED_EXTENSIONS = [".c4", ".mil"];

  function getExportedConverter() {
    const exported = window.module && window.module.exports ? window.module.exports : {};
    if (typeof exported.parseC4 !== "function" || typeof exported.buildPdfFromC4 !== "function") {
      throw new Error("Could not find the C4 parser exported by app.js.");
    }
    return exported;
  }

  function isSupportedFile(file) {
    const name = (file && file.name ? file.name : "").toLowerCase();
    return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
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

  function setStatus(message, isError = false) {
    const status = document.getElementById("status");
    status.textContent = message;
    status.classList.toggle("error", isError);
  }

  function setDetails(message) {
    document.getElementById("details").textContent = message;
  }

  function waitForPaint() {
    return new Promise((resolve) => setTimeout(resolve, 0));
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

  function stripTopFolder(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 1) return normalized;
    return parts.slice(1).join("/");
  }

  function relativePathForFile(file) {
    return file.webkitRelativePath ? stripTopFolder(file.webkitRelativePath) : file.name;
  }

  function pdfPathForFile(file) {
    return relativePathForFile(file).replace(/\.[^/.]+$/, ".pdf");
  }

  function makeUniquePath(path, usedPaths) {
    const normalized = path.replace(/\\/g, "/");
    if (!usedPaths.has(normalized)) {
      usedPaths.add(normalized);
      return normalized;
    }

    const dot = normalized.lastIndexOf(".");
    const slash = normalized.lastIndexOf("/");
    const hasExtension = dot > slash;
    const stem = hasExtension ? normalized.slice(0, dot) : normalized;
    const extension = hasExtension ? normalized.slice(dot) : "";

    let counter = 2;
    while (true) {
      const candidate = `${stem}_${counter}${extension}`;
      if (!usedPaths.has(candidate)) {
        usedPaths.add(candidate);
        return candidate;
      }
      counter++;
    }
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2);
    const dosDate =
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();
    return { dosTime, dosDate };
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function ascii(text) {
    return new TextEncoder().encode(text);
  }

  function concat(chunks) {
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

  function pushU16(out, value) {
    out.push(value & 0xff, (value >>> 8) & 0xff);
  }

  function pushU32(out, value) {
    out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  function makeZip(entries) {
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    const timestamp = dosDateTime();

    for (const entry of entries) {
      const nameBytes = utf8(entry.path);
      const data = entry.data;
      const checksum = crc32(data);

      const localHeader = [];
      pushU32(localHeader, 0x04034b50);
      pushU16(localHeader, 20);
      pushU16(localHeader, 0x0800);
      pushU16(localHeader, 0);
      pushU16(localHeader, timestamp.dosTime);
      pushU16(localHeader, timestamp.dosDate);
      pushU32(localHeader, checksum);
      pushU32(localHeader, data.length);
      pushU32(localHeader, data.length);
      pushU16(localHeader, nameBytes.length);
      pushU16(localHeader, 0);

      const localHeaderBytes = new Uint8Array(localHeader);
      localChunks.push(localHeaderBytes, nameBytes, data);

      const centralHeader = [];
      pushU32(centralHeader, 0x02014b50);
      pushU16(centralHeader, 20);
      pushU16(centralHeader, 20);
      pushU16(centralHeader, 0x0800);
      pushU16(centralHeader, 0);
      pushU16(centralHeader, timestamp.dosTime);
      pushU16(centralHeader, timestamp.dosDate);
      pushU32(centralHeader, checksum);
      pushU32(centralHeader, data.length);
      pushU32(centralHeader, data.length);
      pushU16(centralHeader, nameBytes.length);
      pushU16(centralHeader, 0);
      pushU16(centralHeader, 0);
      pushU16(centralHeader, 0);
      pushU16(centralHeader, 0);
      pushU32(centralHeader, 0);
      pushU32(centralHeader, offset);

      centralChunks.push(new Uint8Array(centralHeader), nameBytes);
      offset += localHeaderBytes.length + nameBytes.length + data.length;
    }

    const centralDirectory = concat(centralChunks);
    const centralOffset = offset;
    const end = [];
    pushU32(end, 0x06054b50);
    pushU16(end, 0);
    pushU16(end, 0);
    pushU16(end, entries.length);
    pushU16(end, entries.length);
    pushU32(end, centralDirectory.length);
    pushU32(end, centralOffset);
    pushU16(end, 0);

    return concat([...localChunks, centralDirectory, new Uint8Array(end)]);
  }

  function makeImageObject(tile) {
    const tileData = tile.data;

    if (tile.compression === 0x00) {
      return concat([
        ascii(
          `<< /Type /XObject /Subtype /Image /Width ${TILE_SIZE} /Height ${TILE_SIZE} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 1 ` +
            `/Filter /CCITTFaxDecode ` +
            `/DecodeParms << /K -1 /Columns ${TILE_SIZE} /Rows ${TILE_SIZE} /BlackIs1 false >> ` +
            `/Length ${tileData.length} >>\nstream\n`
        ),
        tileData,
        ascii("\nendstream"),
      ]);
    }

    if (tile.compression === 0x80) {
      return concat([
        ascii(
          `<< /Type /XObject /Subtype /Image /Width ${TILE_SIZE} /Height ${TILE_SIZE} ` +
            `/ColorSpace /DeviceGray /BitsPerComponent 1 ` +
            `/Length ${tileData.length} >>\nstream\n`
        ),
        tileData,
        ascii("\nendstream"),
      ]);
    }

    throw new Error(
      `Unsupported C4 tile compression flag at tile ${tile.entryNo}: 0x${tile.compression
        .toString(16)
        .padStart(2, "0")}.`
    );
  }

  function buildCombinedPdfFromParsedDocs(docs, dpi = DEFAULT_DPI) {
    if (!docs.length) throw new Error("No converted drawings are available to combine.");

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

      const contentBytes = ascii(content);
      const contentObjectId = nextObjectId++;
      objects.set(
        contentObjectId,
        concat([
          ascii(`<< /Length ${contentBytes.length} >>\nstream\n`),
          contentBytes,
          ascii("endstream"),
        ])
      );

      const xobjects = imageRefs.map((ref) => `/Im${ref.objectId} ${ref.objectId} 0 R`).join(" ");
      const pageObjectId = nextObjectId++;
      objects.set(
        pageObjectId,
        ascii(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(6)} ${pageHeightPt.toFixed(
            6
          )}] /Resources << /XObject << ${xobjects} >> >> /Contents ${contentObjectId} 0 R >>`
        )
      );
      pageIds.push(pageObjectId);
    }

    objects.set(2, ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`));
    objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));

    const maxObjectId = Math.max(...objects.keys());
    const chunks = [ascii("%PDF-1.4\n% C4/MIL combined PDF generated by GitHub Pages\n")];
    const offsets = new Array(maxObjectId + 1).fill(0);
    let lengthSoFar = chunks[0].length;

    for (let objectId = 1; objectId <= maxObjectId; objectId++) {
      const body = objects.get(objectId);
      if (!body) throw new Error(`Internal combined PDF build error: missing object ${objectId}.`);
      offsets[objectId] = lengthSoFar;
      const prefix = ascii(`${objectId} 0 obj\n`);
      const suffix = ascii("\nendobj\n");
      chunks.push(prefix, body, suffix);
      lengthSoFar += prefix.length + body.length + suffix.length;
    }

    const startXref = lengthSoFar;
    let xref = `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
    for (let objectId = 1; objectId <= maxObjectId; objectId++) {
      xref += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
    chunks.push(ascii(xref));

    return concat(chunks);
  }

  async function collectConvertedDocs(supported, parseC4, buildPdfFromC4, dpi) {
    const zipEntries = [];
    const combinedDocs = [];
    const report = [];
    const usedOutputPaths = new Set();
    let converted = 0;
    let failed = 0;

    for (let i = 0; i < supported.length; i++) {
      const file = supported[i];
      const inputPath = file.webkitRelativePath || file.name;
      const outputPath = makeUniquePath(pdfPathForFile(file), usedOutputPaths);
      setStatus(`Converting ${i + 1} of ${supported.length}: ${inputPath}`);

      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseC4(buffer);
        const pdfBytes = buildPdfFromC4(parsed, dpi);
        zipEntries.push({ path: outputPath, data: pdfBytes });
        combinedDocs.push({ path: inputPath, outputPath, parsed });
        converted++;
        report.push(`OK   ${inputPath} -> ${outputPath} (${parsed.width} x ${parsed.height}, ${parsed.tileCount} tiles)`);
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        report.push(`FAIL ${inputPath} -> ${message}`);
      }

      if (i % 5 === 0) {
        setDetails(report.slice(-30).join("\n"));
        await waitForPaint();
      }
    }

    return { zipEntries, combinedDocs, report, converted, failed };
  }

  function buildReportHeader(mode, files, supported, converted, failed, dpi) {
    return [
      `C4/MIL ${mode} conversion report`,
      `Generated: ${new Date().toLocaleString()}`,
      `DPI: ${dpi}`,
      `Scanned files: ${files.length}`,
      `Supported C4/MIL files: ${supported.length}`,
      `Converted: ${converted}`,
      `Failed: ${failed}`,
      "",
    ];
  }

  async function convertBatchFiles(fileList, sourceLabel) {
    const files = Array.from(fileList || []);
    const supported = files.filter(isSupportedFile).sort((a, b) => {
      const ap = a.webkitRelativePath || a.name;
      const bp = b.webkitRelativePath || b.name;
      return ap.localeCompare(bp);
    });

    if (!supported.length) {
      setStatus(`No .C4 or .MIL files were found in the selected ${sourceLabel}.`, true);
      setDetails(`Scanned ${files.length.toLocaleString()} file(s), but found no supported C4/MIL drawings.`);
      return;
    }

    const { parseC4, buildPdfFromC4 } = getExportedConverter();
    const dpi = getDpi();
    const combine = shouldCombineIntoOnePdf();

    setStatus(
      `Found ${supported.length.toLocaleString()} C4/MIL file(s). Converting${combine ? " into one PDF" : ""}...`
    );
    setDetails("");
    await waitForPaint();

    const result = await collectConvertedDocs(supported, parseC4, buildPdfFromC4, dpi);
    const reportHeader = buildReportHeader(
      combine ? "combined PDF" : "folder/file batch",
      files,
      supported,
      result.converted,
      result.failed,
      dpi
    );
    const fullReport = [...reportHeader, ...result.report];

    if (!result.converted) {
      setStatus("No PDFs were created. See the conversion report below.", true);
      setDetails(fullReport.join("\n"));
      return;
    }

    if (combine) {
      setStatus("Building combined PDF download...");
      await waitForPaint();
      const combinedPdfBytes = buildCombinedPdfFromParsedDocs(result.combinedDocs, dpi);
      downloadBytes(combinedPdfBytes, "c4-mil-combined.pdf", "application/pdf");
      setStatus(
        `Combined PDF complete. Added ${result.converted} page(s)${result.failed ? `, ${result.failed} failed` : ""}. Download started.`
      );
      setDetails([
        ...fullReport,
        "",
        "Combined PDF page order:",
        ...result.combinedDocs.map((doc, index) => `${index + 1}. ${doc.path}`),
      ].join("\n"));
      return;
    }

    const zipEntries = [...result.zipEntries, { path: "conversion_report.txt", data: utf8(fullReport.join("\n")) }];
    setStatus("Building ZIP download...");
    await waitForPaint();
    const zipBytes = makeZip(zipEntries);
    downloadBytes(zipBytes, "c4-mil-converted-pdfs.zip", "application/zip");

    setStatus(`Batch complete. Converted ${result.converted} file(s)${result.failed ? `, ${result.failed} failed` : ""}. ZIP download started.`);
    setDetails(fullReport.join("\n"));
  }

  function setupBatchInputs() {
    const folderInput = document.getElementById("folderInput");
    const folderButton = document.getElementById("folderButton");
    const multiFileInput = document.getElementById("multiFileInput");
    const filesButton = document.getElementById("filesButton");

    if (folderInput && folderButton) {
      if (!("webkitdirectory" in folderInput)) {
        folderButton.disabled = true;
        folderButton.title = "This browser does not expose recursive folder selection to web pages. Use Choose C4/MIL files instead.";
      } else {
        folderButton.addEventListener("click", () => {
          folderInput.value = "";
          folderInput.click();
        });
        folderInput.addEventListener("change", () => convertBatchFiles(folderInput.files, "folder"));
      }
    }

    if (multiFileInput && filesButton) {
      filesButton.addEventListener("click", () => {
        multiFileInput.value = "";
        multiFileInput.click();
      });
      multiFileInput.addEventListener("change", () => convertBatchFiles(multiFileInput.files, "file list"));
    }
  }

  document.addEventListener("DOMContentLoaded", setupBatchInputs);
})();
