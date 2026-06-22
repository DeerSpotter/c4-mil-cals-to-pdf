/* Optional direct-to-folder save path for browsers that support the File System Access API. */
(() => {
  const DEFAULT_DPI = 200;

  function getExportedConverter() {
    const exported = window.module && window.module.exports ? window.module.exports : {};
    if (typeof exported.convertDrawingArrayBuffer !== "function" || typeof exported.buildCombinedPdfFromParsedDocs !== "function") {
      throw new Error("Could not find the drawing converter exported by app.js/cals-support.js.");
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

  function waitForPaint() { return new Promise((resolve) => setTimeout(resolve, 0)); }

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

  function utf8(text) { return new TextEncoder().encode(text); }

  function concat(chunks) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
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
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function pushU16(out, value) { out.push(value & 0xff, (value >>> 8) & 0xff); }
  function pushU32(out, value) { out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff); }

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

  async function collectFiles(directoryHandle, exported, prefix = "") {
    const files = [];
    for await (const [name, handle] of directoryHandle.entries()) {
      const relativePath = `${prefix}${name}`;
      if (handle.kind === "file") {
        if (exported.isSupportedDrawingName(name)) files.push({ handle, name, relativePath });
      } else if (handle.kind === "directory") {
        files.push(...await collectFiles(handle, exported, `${relativePath}/`));
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
      setDetails("Use the normal Choose folder or Choose drawing files buttons instead. Direct folder saving usually works in desktop Chrome and Edge, but not iOS Safari.");
      return;
    }

    try {
      const exported = getExportedConverter();
      const directoryHandle = await window.showDirectoryPicker({ id: "c4-mil-cals-source-folder", mode: "readwrite" });
      if (!(await ensureReadWritePermission(directoryHandle))) {
        setStatus("Write permission was not granted for the selected folder.", true);
        return;
      }

      setStatus("Scanning selected folder...");
      setDetails("The page is reading the selected folder locally. Files are not uploaded.");
      await waitForPaint();

      const files = (await collectFiles(directoryHandle, exported)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      if (!files.length) {
        setStatus("No .C4, .MIL, .CAL, or .CALS files were found in the selected folder.", true);
        return;
      }

      const dpi = getDpi();
      const combine = shouldCombineIntoOnePdf();
      const usedOutputPaths = new Set();
      const zipEntries = [];
      const combinedDocs = [];
      const report = [
        "C4/MIL/CALS direct-to-folder conversion report",
        `Generated: ${new Date().toLocaleString()}`,
        `DPI: ${dpi}`,
        `Output: ${combine ? "c4-mil-cals-combined.pdf" : "c4-mil-cals-converted-pdfs.zip"}`,
        `Supported drawing files: ${files.length}`,
        "",
      ];
      let converted = 0;
      let failed = 0;

      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        setStatus(`Converting ${i + 1} of ${files.length}: ${item.relativePath}`);
        try {
          const file = await item.handle.getFile();
          const result = exported.convertDrawingArrayBuffer(await file.arrayBuffer(), item.name, dpi);
          const outputPath = makeUniquePath(pdfPathForRelativePath(item.relativePath), usedOutputPaths);
          zipEntries.push({ path: outputPath, data: result.pdfBytes });
          combinedDocs.push({ path: item.relativePath, parsed: result.parsed });
          converted++;
          report.push(`OK   ${item.relativePath} -> ${outputPath} (${exported.describeParsedDrawing(result.parsed)})`);
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
        const outputName = "c4-mil-cals-combined.pdf";
        setStatus(`Saving ${outputName} to the selected folder...`);
        await waitForPaint();
        await writeOutputFile(directoryHandle, outputName, exported.buildCombinedPdfFromParsedDocs(combinedDocs, dpi), "application/pdf");
        setStatus(`Combined PDF saved to the selected folder. Added ${converted} page(s)${failed ? `, ${failed} failed` : ""}.`);
        setDetails([...report, "", "Combined PDF page order:", ...combinedDocs.map((doc, index) => `${index + 1}. ${doc.path}`)].join("\n"));
        return;
      }

      const outputName = "c4-mil-cals-converted-pdfs.zip";
      setStatus(`Saving ${outputName} to the selected folder...`);
      await waitForPaint();
      await writeOutputFile(directoryHandle, outputName, makeZip([...zipEntries, { path: "conversion_report.txt", data: utf8(report.join("\n")) }]), "application/zip");
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
