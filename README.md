# view.catalog

Catalog browser for [GAMS](https://github.com/kkgams/gams). Host runtime APIs, utilities and widgets remain external dependencies.

| View | Source | Screenshot | Original work |
| --- | --- | --- | --- |
| `view-catalog` | [views/view-catalog.js](src/view.catalog/views/view-catalog.js) | Not available | GAMS contributors |
| `view-catalog-tileset-edit` | [views/view-catalog-tileset-edit.js](src/view.catalog-tileset-edit/views/view-catalog-tileset-edit.js) | Not available | GAMS contributors |
| `view-catalog-sprite-import` | [views/view-catalog-sprite-import.js](src/view.catalog-sprite-import/views/view-catalog-sprite-import.js) | Not available | GAMS contributors |
| `view-catalog-nine-patch-edit` | [views/view-catalog-nine-patch-edit.js](src/view.catalog-nine-patch-edit/views/view-catalog-nine-patch-edit.js) | Not available | GAMS contributors |

GAMS contributions: [Apache-2.0](LICENSE); retain [NOTICE](NOTICE) and [licensing scope](LICENSING.md).

## Development

Requires Node.js 24+, Python 3, Make, curl, tar, unzip and zip. No compilation or package installation is required.

| Command | Purpose |
| --- | --- |
| `make open` | Open local gams.json in the released macOS Apple Silicon Host. |
| `make check` | Check View JavaScript syntax. |
| `make package` | Build stable-name View ZIPs and SHA256SUMS under build.nosync/. |
| `make docs` | Build pinned wiki v1.4.0 under build.nosync/site/. |
| `make serve-docs DOCS_PORT=8081` | Preview the wiki on an independent port. |
| `make validate-docs` | Validate wiki content and links. |
| `make clean` | Remove all of `build.nosync/`, `tools/` and `gams_modules/`, without ownership markers; refuse tracked files or symlinks in deletion paths before deleting anything. |

The local Project uses canonical View source and pinned released dependencies. The SQL provider creates ignored `catalog.sqlite`; the View initializes its schema. Import your own QOI or Aseprite artwork through the dialogs. Catalog SQL data, sprite import and tileset/nine-patch popup editing need native GUI verification. Missing required Host imports, config or schemas are errors.
