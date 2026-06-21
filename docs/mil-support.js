/*
  Adds .MIL support to the existing GitHub Pages converter without changing the
  original C4 app code. JEDMICS File Type 466 stores C4/CCITT4 data with a .mil
  extension, so this handler runs the same parser/PDF builder for .MIL files.
*/

(() => {
  const DEFAULT_DPI = 200;

  function isMilFile(file) {
    return file && file.name && file.name.toLowerCase().endsWith(".mil");
  }

  function safePdfFileName(name) {
    const base = name.replace(/\.[^.]+$/, "") || "converted";
    return `${base}.pdf`;
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
    document.getElementById("preview").src = url;
  }

  let milPdfUrl = null;

  function clearMilPdfUrl() {
    if (milPdfUrl) URL.revokeObjectURL(milPdfUrl);
    milPdfUrl = null;
  }

  function describeParsed(parsed, fileName, dpi) {
    const widthIn = parsed.width / dpi;
    const heightIn = parsed.height / dpi;
    return [
      `File: ${fileName}`,
      "Detected type: JEDMICS MIL file containing C4/CCITT4 data",
      `Pixels: ${parsed.width.toLocaleString()} x ${parsed.height.toLocaleString()}`,
      `Tiles: ${parsed.cols} columns x ${parsed.rows} rows = ${parsed.tileCount}`,
      `Scale: ${dpi} dpi = ${widthIn.toFixed(2)} x ${heightIn.toFixed(2)} inches`,
      "PDF method: direct CCITT Group 4 tile embedding",
      "Privacy: the file stays in this browser session.",
    ].join("\n");
  }

  async function convertMilFile(file) {
    const exported = window.module && window.module.exports ? window.module.exports : {};
    if (typeof exported.parseC4 !== "function" || typeof exported.buildPdfFromC4 !== "function") {
      setStatus("MIL support could not find the C4 parser exported by app.js.", true);
      return;
    }

    setStatus(`Reading ${file.name}...`);
    setDetails("");
    clearMilPdfUrl();
    setPreviewUrl("about:blank");
    document.getElementById("downloadButton").disabled = true;
    document.getElementById("openButton").disabled = true;

    try {
      const dpi = getDpi();
      const buffer = await file.arrayBuffer();
      const parsed = exported.parseC4(buffer);
      const pdfBytes = exported.buildPdfFromC4(parsed, dpi);
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      milPdfUrl = URL.createObjectURL(blob);
      const pdfFileName = safePdfFileName(file.name);

      const download = document.getElementById("downloadButton");
      download.disabled = false;
      download.onclick = () => {
        const a = document.createElement("a");
        a.href = milPdfUrl;
        a.download = pdfFileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };

      const open = document.getElementById("openButton");
      open.disabled = false;
      open.onclick = () => window.open(milPdfUrl, "_blank", "noopener,noreferrer");

      setPreviewUrl(milPdfUrl);
      setDetails(describeParsed(parsed, file.name, dpi));
      setStatus(`Converted ${file.name} to ${pdfFileName}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, true);
      setDetails("Conversion failed. This .MIL file must contain the same tiled 512 x 512 C4/JEDMICS CCITT4 layout used by .C4 files.");
    }
  }

  function setupMilSupport() {
    const fileInput = document.getElementById("fileInput");
    const dropZone = document.getElementById("dropZone");
    if (!fileInput || !dropZone) return;

    fileInput.setAttribute("accept", ".c4,.C4,.mil,.MIL");

    fileInput.addEventListener(
      "change",
      (event) => {
        const file = fileInput.files && fileInput.files[0];
        if (!isMilFile(file)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        convertMilFile(file);
      },
      true
    );

    dropZone.addEventListener(
      "drop",
      (event) => {
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (!isMilFile(file)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dropZone.classList.remove("dragover");
        convertMilFile(file);
      },
      true
    );

    setStatus("Ready. Select one .C4 or .MIL file.");
  }

  document.addEventListener("DOMContentLoaded", setupMilSupport);
})();
