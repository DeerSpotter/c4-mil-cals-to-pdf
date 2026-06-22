/*
  Optional direct-to-folder save path for browsers that support the
  File System Access API. This is separate from the normal file-input batch
  flow because normal browser file pickers do not provide write access to the
  source folder.
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

  function isSupportedName(name) {
    const lower = String(name || "").toLowerCase();
    return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function pdfPathForRelativePath(path) {
    return path.replace(/\\/g, "/").replace(/\.[^/.]+$/, ".pdf");
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

  function ascii(text) {
    return new TextEncoder().encode(text);
  }

  function utf8(text) {
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

    throw new Error(`Unsupported C4 tile compression flag at tile ${tile.entryNo}.`);
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
        content +=
          "q\n" +
          `${tileWidthPt.toFixed(6)} 0 0 ${tileHeightPt.toFixed(6)} ${x.toFixed(6)} ${y.toFixed(6)} cm\n` +
          `/Im${ref.objectId} Do\n` +
          "Q\n";
      }

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

  async function collectFiles(directoryHandle, prefix = "") {
    const files = [];
    for await (const [name, handle] of directoryHandle.entries()) {
      const relativePath = `${prefix}${name}`;
      if (handle.kind === "file") {
        if (isSupportedName(name)) files.push({ handle, name, relativePath });
      } else if (handle.kind === "directory") {
        files.push(...await collectFiles(handle, `${relativePath}/`));
      }
    }
    return files;
  }

  async function ensureReadWritePermission(directoryHandle) {
    const options = { mode: "readwrite" };
    if (typeof directoryHandle.queryPermission === "function") {
      const current = await directoryHandle.queryPermission(options);
      if (current === "granted") return true;
    }
    if (typeof directoryHandle.requestPermission === "function") {
      return (await directoryHandle.requestPermission(options)) === "granted";
    }
    return true;
  }

  async function writeOutputFile(directoryHandle, fileName, bytes, mimeType) {
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(new Blob([bytes], { type: mimeType }));
    } finally {
      await writable.close();
    }
  }

  async function convertAndSaveToSourceFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      setStatus("This browser cannot save directly into a selected folder.", true);
      setDetails("Use the normal Choose folder or Choose C4/MIL files buttons instead. Direct folder saving usually works in desktop Chrome and Edge, but not iOS Safari.");
      return;
    }

    try {
      const directoryHandle = await window.showDirectoryPicker({ id: "c4-mil-source-folder", mode: "readwrite" });
      if (!(await ensureReadWritePermission(directoryHandle))) {
        setStatus("Write permission was not granted for the selected folder.", true);
        return;
      }

      setStatus("Scanning selected folder...");
      setDetails("The page is reading the selected folder locally. Files are not uploaded.");
      await waitForPaint();

      const files = (await collectFiles(directoryHandle)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      if (!files.length) {
        setStatus("No .C4 or .MIL files were found in the selected folder.", true);
        return;
      }

      const { parseC4, buildPdfFromC4 } = getExportedConverter();
      const dpi = getDpi();
      const combine = shouldCombineIntoOnePdf();
      const usedOutputPaths = new Set();
      const zipEntries = [];
      const combinedDocs = [];
      const report = [
        `C4/MIL direct-to-folder conversion report`,
        `Generated: ${new Date().toLocaleString()}`,
        `DPI: ${dpi}`,
        `Output: ${combine ? "c4-mil-combined.pdf" : "c4-mil-converted-pdfs.zip"}`,
        `Supported C4/MIL files: ${files.length}`,
        "",
      ];
      let converted = 0;
      let failed = 0;

      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        setStatus(`Converting ${i + 1} of ${files.length}: ${item.relativePath}`);
        try {
          const file = await item.handle.getFile();
          const parsed = parseC4(await file.arrayBuffer());
          const outputPath = makeUniquePath(pdfPathForRelativePath(item.relativePath), usedOutputPaths);
          const pdfBytes = buildPdfFromC4(parsed, dpi);
          zipEntries.push({ path: outputPath, data: pdfBytes });
          combinedDocs.push({ path: item.relativePath, parsed });
          converted++;
          report.push(`OK   ${item.relativePath} -> ${outputPath} (${parsed.width} x ${parsed.height}, ${parsed.tileCount} tiles)`);
        } catch (error) {
          failed++;
          report.push(`FAIL ${item.relativePath} -> ${error instanceof Error ? error.message : String(error)}`);
        }
        if (i % 5 === 0) {
          setDetails(report.slice(-30).join("\n"));
          await waitForPaint();
        }
      }

      if (!converted) {
        setStatus("No PDFs were created. See the conversion report below.", true);
        setDetails(report.join("\n"));
        return;
      }

      if (combine) {
        const outputName = "c4-mil-combined.pdf";
        setStatus(`Saving ${outputName} to the selected folder...`);
        await waitForPaint();
        const combinedPdfBytes = buildCombinedPdfFromParsedDocs(combinedDocs, dpi);
        await writeOutputFile(directoryHandle, outputName, combinedPdfBytes, "application/pdf");
        setStatus(`Combined PDF saved to the selected folder. Added ${converted} page(s)${failed ? `, ${failed} failed` : ""}.`);
        setDetails([...report, "", "Combined PDF page order:", ...combinedDocs.map((doc, index) => `${index + 1}. ${doc.path}`)].join("\n"));
        return;
      }

      const outputName = "c4-mil-converted-pdfs.zip";
      setStatus(`Saving ${outputName} to the selected folder...`);
      await waitForPaint();
      const zipBytes = makeZip([...zipEntries, { path: "conversion_report.txt", data: utf8(report.join("\n")) }]);
      await writeOutputFile(directoryHandle, outputName, zipBytes, "application/zip");
      setStatus(`ZIP saved to the selected folder. Converted ${converted} file(s)${failed ? `, ${failed} failed` : ""}.`);
      setDetails(report.join("\n"));
    } catch (error) {
      if (error && error.name === "AbortError") {
        setStatus("Folder selection cancelled.");
        return;
      }
      setStatus("Could not save to the selected folder.", true);
      setDetails(error instanceof Error ? error.message : String(error));
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("folderSaveButton");
    if (!button) return;
    if (typeof window.showDirectoryPicker !== "function") {
      button.disabled = true;
      button.title = "This browser cannot give web pages write permission to a selected folder.";
    } else {
      button.addEventListener("click", convertAndSaveToSourceFolder);
    }
  });
})();
