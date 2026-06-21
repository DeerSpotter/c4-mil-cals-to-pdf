# AMCOM EDIS Delivery Context

This file explains how the C4/MIL converter relates to AMCOM EDIS engineering data deliveries.

The converter itself is still a C4/MIL to PDF tool. It is not a full EDIS submission package builder. The information below is included so users can understand why `.C4`, `.MIL`, `INDEX.DLF`, and JEDMICS file type values matter.

## Reference documents

This summary is based on these public reference documents:

- `MIS_STD_52406C_IS 3.pdf` - MIS-STD-52406C-IS, Interface Standard for System Interface Requirements for Engineering Data, 10 May 2017.
- `MIS_STD_52406B_IS 3.pdf` - MIS-STD-52406B-IS, older 14 June 2011 revision, superseded by revision C.
- `3018_FileTypes.pdf` - JBR 3.0.18 Standard JEDMICS File Types, 11 September 2017.
- `JBR_3.0.22_RST-DLF_Format_Spec 2.pdf` - JBR 3.0.22 Index File RST Format Definition, 9 December 2021.
- `C4-Img-Spec 2.pdf` - JEDMICS C4 Compressed Image File Format Technical Specification, April 2002.

## What EDIS is

MIS-STD-52406C-IS defines the method and format requirements for delivering engineering data to the U.S. Army Aviation and Missile Command, AMCOM, engineering data repository.

The repository identified in that standard is the Engineering Data Information Server, or EDIS.

The standard treats engineering data broadly. It can include drawings, files, specifications, standards, documents, 2D data, 3D data, models, lists, and other information related to design, procurement, fabrication, testing, storage, manipulation, or inspection of an item.

## Delivery package concept

Each EDIS delivery package contains two broad classes of data:

```text
1. Image/data file
2. Metadata file
```

For electronic delivery, MIS-STD-52406C-IS says files within a delivery set are encapsulated in a single standard Microsoft Windows `.ZIP` file. Each `.ZIP` delivery set is meant to be independent.

For CD/DVD physical media, the file structure is expected to comply with ISO-9660.

## INDEX.DLF metadata file

The metadata file required by MIS-STD-52406C-IS is named:

```text
INDEX.DLF
```

It is placed at the root level of the delivery structure.

The metadata file is a pipe-delimited ASCII text file. Each record describes one engineering data entity and references one image/data file in the delivery.

Conceptually:

```text
INDEX.DLF
  |
  +-- record 1 -> referenced drawing/image/file
  +-- record 2 -> referenced drawing/image/file
  +-- record 3 -> referenced drawing/image/file
```

The converter does not currently parse `INDEX.DLF`. A future feature could use it to locate C4/MIL files and convert only the referenced drawings.

## Important metadata fields for this converter

MIS-STD-52406C-IS defines a 58 field DLF record. The most relevant fields for this converter are:

| Field | Name | Why it matters |
|---:|---|---|
| 13 | `FileType` | Numeric file type identifier from the image file type table. |
| 14 | `FileTypeFormat` | Format category, such as `RSTR`. |
| 15 | `FileTypeSrcFlavor` | Source flavor, such as `C4`. |
| 16 | `FileTypeDestFlavor` | Destination flavor, such as `C4`. |
| 17 | `FileTypeContent` | Content value, such as `NATIVE`, when used. |
| 18 | `FileTypeVersion` | File type version, when used. |
| 20 | `FileName` | File name without extension. |
| 21 | `FileExtension` | Extension such as `C4`, `MIL`, `PDF`, or another registered type. |
| 22 | `FilePath` | Relative path to the referenced file in the delivery package. |
| 49 | `DistStmt` | Distribution statement value. |
| 56 | `WeaponsSystemCode` | Weapon system code. |
| 57 | `Version` | DFIS/DLF version value. |
| 58 | `Record End` | CR/LF line ending. |

The file path, file name, and extension together identify the referenced file in a delivery package.

## C4 and MIL in the file type table

The JEDMICS file type table identifies standard file type values.

The normal C4 entry is:

```text
FileType:          1
FileExtension:     C4
FileTypeFormat:    RSTR
FileTypeSrcFlavor: C4
FileTypeDestFlavor:C4
Comment:           JEDMICS CCITT4
```

The MIL entry is:

```text
FileType:          466
FileExtension:     MIL
FileTypeFormat:    RSTR
FileTypeSrcFlavor: C4
FileTypeDestFlavor:C4
FileTypeContent:   NATIVE
Comment:           JEDMICS CCITT4 saved with a .mil extension
```

This is why the project treats `.C4` and `.MIL` as the same internal C4/CCITT4 drawing data layout.

## Relationship to the C4 binary converter

The EDIS and DLF standards tell us how a file is referenced, classified, and packaged.

The C4 binary specification tells us how the drawing bytes are actually decoded.

The conversion pipeline is:

```text
C4/MIL file
  -> read C4 header
  -> read tile index
  -> locate 512 x 512 CCITT Group 4 tiles
  -> reconstruct image or embed tile streams into PDF
  -> write PDF
```

The DLF/EDIS metadata can identify that a file is C4/MIL, but it does not replace the C4 binary parser.

## Image quality guidance from MIS-STD-52406C-IS

MIS-STD-52406C-IS includes image quality expectations that are useful when judging converter output:

- Image should be centered in the frame.
- Extraneous data or clutter outside the engineering drawing should not appear.
- Lines should not bleed, blur, or fill in.
- Resolution should preserve visible line separation through the entire line length.
- Minimum line width is specified as 3 pels at 200 DPI or 10 pels at 300 DPI.
- Book form drawings and documents should be one sheet per frame/image or one page per PDF page.

The converter should preserve the drawing faithfully and avoid adding annotations, watermarks, or visual changes.

## Required image formats versus converter scope

MIS-STD-52406C-IS discusses required delivery formats such as CALS raster and PDF image data, and it also allows additional digital/native formats under controlled delivery rules.

That does not mean this project should convert every EDIS or JEDMICS file type.

Correct project scope:

```text
Primary support:
.C4 and .MIL JEDMICS C4/CCITT4 raster drawings

Additional desktop image support:
Pillow-readable raster images such as TIFF, PNG, JPG, BMP, GIF, WEBP, PBM, PGM, and PPM

Not in scope:
CAD, vector, office document, electronics, archive, audio, video, and vendor-native formats listed in JEDMICS file type tables
```

## Future feature idea: INDEX.DLF aware batch conversion

A future version could add EDIS package support:

```text
Select delivery ZIP or folder
  -> find INDEX.DLF
  -> parse pipe-delimited records
  -> locate FilePath + FileName + FileExtension
  -> convert referenced C4/MIL files to PDF
  -> create a conversion report
```

Possible report fields:

- Base document number
- CAGE code
- revision
- sheet number
- frame number
- file type
- file extension
- source path
- output PDF path
- conversion status
- error message, if any

This would be an EDIS helper feature, not a replacement for EDIS, IndexR, or the JEDMICS import process.

## Practical summary

`MIS-STD-52406C-IS` is relevant because it explains how AMCOM EDIS expects engineering data packages and `INDEX.DLF` metadata to be structured. It supports the project documentation around C4/MIL handling and gives a path for future DLF-aware batch conversion.

It does not define the internal C4 tile compression. The actual C4-to-PDF conversion logic still comes from the JEDMICS C4 compressed image specification.
