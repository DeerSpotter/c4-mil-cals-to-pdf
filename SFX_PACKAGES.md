# ZIP and self extracting EXE package support

Some legacy technical data packages are distributed as WinZip self extracting `.EXE` files. These files are Windows programs only because a small extraction stub is prepended to a normal ZIP archive.

This project treats those files as archives only:

1. The file is read as bytes.
2. The ZIP end of central directory record is located near the end of the file.
3. The central directory is used to list package entries.
4. Supported embedded drawing/image entries are extracted.
5. The extracted bytes are passed to the existing PDF converter.
6. The `.EXE` is never executed.

## Browser behavior

The GitHub Pages version supports package conversion with **Choose EXE/ZIP package**.

- Supported package inputs: `.zip`, old WinZip self extracting `.exe`.
- Supported embedded drawing inputs: `.C4`, `.MIL`, `.CAL`, `.CALS`, `.TIF`, `.TIFF`.
- Browser TIFF support is limited to 1 bit CCITT Group 4 TIFF pages. Multi-page Group 4 TIFF files are supported when each page is stored as a single strip.
- Supported ZIP compression methods: stored and deflated.
- Deflated entries use the browser's `DecompressionStream("deflate-raw")` API.
- Output is either `c4-mil-cals-package-converted-pdfs.zip` or `c4-mil-cals-package-combined.pdf`, depending on the **Combine batch output into one multi-page PDF** checkbox.

## Python dashboard behavior

The Windows dashboard supports packages in **Batch convert folder...** mode.

- Normal `.C4` / `.MIL` / `.CAL` / `.CALS` / `.TIF` / `.TIFF` files still convert beside the source file.
- Package outputs are written beside the package under `<package_name>_pdfs`.
- Internal package folders are preserved below that output folder.
- Existing package output PDFs are skipped unless **Overwrite PDFs in batch** is checked.
- Old binary Word `.DOC` files may be present in some packages as native notes or documents, but this converter does not convert `.DOC` files in the browser.

Example:

```text
source folder/
  1_FA8532-05R77127A04889469RN.exe
  1_FA8532-05R77127A04889469RN_pdfs/
    04889469RN/
      OPTI0001.pdf
      OPTI0002.pdf
      ...
```

## Why package output uses a subfolder

A package may contain hundreds of drawings. Writing them directly into the same source folder as the `.EXE` would clutter the folder and create filename collisions. The `<package_name>_pdfs` folder keeps the generated PDFs grouped with the source package while preserving the original internal structure.
