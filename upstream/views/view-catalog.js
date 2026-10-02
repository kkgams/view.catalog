import { runtime, unwrap } from "/core/runtime.js"
import { registerViewPlugin, unregisterViewPlugin } from "/util/view-plugin.js"
import { sql } from "/util/sql.js"
import { decode as decodeQoi } from "/util/qoi/decode.js"

const CATALOG_TABLES = Object.freeze({
    tileset: "tileset",
    tilesetImageSource: "tileset_image_source",
    tile: "tile",
    sprite: "sprite",
    spriteAnimation: "sprite_animation",
    spriteAnimationFrame: "sprite_animation_frame",
    ninePatch: "nine_patch",
})

const CATALOG_INDEXES = Object.freeze({
    tilesetImageSourceTileset: "idx_tileset_image_source_tileset",
    tileTilesetMask: "idx_tile_tileset_mask",
    tileImageSource: "idx_tile_image_source",
    spriteAnimationSprite: "idx_sprite_animation_sprite",
    spriteAnimationFrameAnimation: "idx_sprite_animation_frame_animation",
})

const CATALOG_SCHEMA_TABLE_NAMES = Object.freeze(Object.values(CATALOG_TABLES))

function quoteIdent(name) {
    return String(name).replace(/"/g, '""')
}

function sqlIdent(name) {
    return `"${quoteIdent(name)}"`
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function getExtension(path) {
    const name =
        String(path || "")
            .split("/")
            .pop() || ""
    const parts = name.split(".")
    if (parts.length <= 1) return ""
    return parts.pop().toLowerCase()
}

function createCanvasFromQoi(bytes) {
    const decoded = decodeQoi(bytes.buffer, bytes.byteOffset, bytes.byteLength, 4)
    const pixels = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
    const canvas = document.createElement("canvas")
    canvas.width = decoded.width
    canvas.height = decoded.height
    const ctx = canvas.getContext("2d")
    assert(ctx, "view-catalog qoi canvas requires 2d context")
    ctx.putImageData(new ImageData(pixels, decoded.width, decoded.height), 0, 0)
    return canvas
}

function createCanvasFromPixels(pixels, label) {
    assert(pixels && typeof pixels === "object", `${label} pixels result must be an object`)
    assert(Number.isInteger(pixels.width) && pixels.width > 0, `${label} pixels width must be a positive integer`)
    assert(Number.isInteger(pixels.height) && pixels.height > 0, `${label} pixels height must be a positive integer`)
    assert(Array.isArray(pixels.data), `${label} pixels data must be an array`)
    const data = new Uint8ClampedArray(pixels.data)
    assert(data.length === pixels.width * pixels.height * 4, `${label} pixels data length must match RGBA dimensions`)
    const canvas = document.createElement("canvas")
    canvas.width = pixels.width
    canvas.height = pixels.height
    const ctx = canvas.getContext("2d")
    assert(ctx, `${label} pixels canvas requires 2d context`)
    ctx.putImageData(new ImageData(data, pixels.width, pixels.height), 0, 0)
    return canvas
}

function assertPositiveInteger(value, name) {
    assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer`)
}

function catalogSchemaStatements() {
    const tileset = sqlIdent(CATALOG_TABLES.tileset)
    const tilesetImageSource = sqlIdent(CATALOG_TABLES.tilesetImageSource)
    const tile = sqlIdent(CATALOG_TABLES.tile)
    const sprite = sqlIdent(CATALOG_TABLES.sprite)
    const spriteAnimation = sqlIdent(CATALOG_TABLES.spriteAnimation)
    const spriteAnimationFrame = sqlIdent(CATALOG_TABLES.spriteAnimationFrame)
    const ninePatch = sqlIdent(CATALOG_TABLES.ninePatch)

    return [
        `CREATE TABLE IF NOT EXISTS ${tileset} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS ${tilesetImageSource} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tileset_id INTEGER NOT NULL,
            image_path TEXT NOT NULL,
            tile_width INTEGER NOT NULL CHECK (tile_width > 0),
            tile_height INTEGER NOT NULL CHECK (tile_height > 0),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tileset_id) REFERENCES ${tileset}(id) ON DELETE CASCADE,
            UNIQUE (tileset_id, image_path),
            UNIQUE (id, tileset_id)
        )`,
        `CREATE TABLE IF NOT EXISTS ${tile} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tileset_id INTEGER NOT NULL,
            image_source_id INTEGER NOT NULL,
            mask INTEGER NOT NULL CHECK (mask >= 1 AND mask <= 15),
            tile_index INTEGER NOT NULL CHECK (tile_index >= 1),
            variant_index INTEGER NOT NULL DEFAULT 0 CHECK (variant_index >= 0),
            weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
            name TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tileset_id) REFERENCES ${tileset}(id) ON DELETE CASCADE,
            FOREIGN KEY (image_source_id, tileset_id) REFERENCES ${tilesetImageSource}(id, tileset_id) ON DELETE CASCADE,
            UNIQUE (tileset_id, mask, variant_index)
        )`,
        `CREATE INDEX IF NOT EXISTS ${sqlIdent(CATALOG_INDEXES.tilesetImageSourceTileset)} ON ${tilesetImageSource} (tileset_id)`,
        `CREATE INDEX IF NOT EXISTS ${sqlIdent(CATALOG_INDEXES.tileTilesetMask)} ON ${tile} (tileset_id, mask)`,
        `CREATE INDEX IF NOT EXISTS ${sqlIdent(CATALOG_INDEXES.tileImageSource)} ON ${tile} (image_source_id)`,
        `CREATE TABLE IF NOT EXISTS ${sprite} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT,
            image_path TEXT NOT NULL,
            source_x INTEGER NOT NULL DEFAULT 0,
            source_y INTEGER NOT NULL DEFAULT 0,
            source_width INTEGER NOT NULL DEFAULT 1 CHECK (source_width > 0),
            source_height INTEGER NOT NULL DEFAULT 1 CHECK (source_height > 0),
            source_slice_name TEXT NOT NULL DEFAULT '',
            grid_width INTEGER NOT NULL CHECK (grid_width > 0),
            grid_height INTEGER NOT NULL CHECK (grid_height > 0),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (image_path, source_slice_name)
        )`,
        `CREATE TABLE IF NOT EXISTS ${spriteAnimation} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sprite_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            start_frame INTEGER NOT NULL CHECK (start_frame >= 0),
            end_frame INTEGER NOT NULL CHECK (end_frame >= start_frame),
            direction TEXT NOT NULL CHECK (direction IN ('forward', 'reverse', 'ping-pong', 'ping-pong-reverse')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sprite_id) REFERENCES ${sprite}(id) ON DELETE CASCADE,
            UNIQUE (sprite_id, name)
        )`,
        `CREATE INDEX IF NOT EXISTS ${sqlIdent(CATALOG_INDEXES.spriteAnimationSprite)} ON ${spriteAnimation} (sprite_id)`,
        `CREATE TABLE IF NOT EXISTS ${spriteAnimationFrame} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sprite_animation_id INTEGER NOT NULL,
            frame_index INTEGER NOT NULL CHECK (frame_index >= 0),
            pivot_x INTEGER NOT NULL,
            pivot_y INTEGER NOT NULL,
            source_x INTEGER NOT NULL DEFAULT 0,
            source_y INTEGER NOT NULL DEFAULT 0,
            source_width INTEGER NOT NULL DEFAULT 1 CHECK (source_width > 0),
            source_height INTEGER NOT NULL DEFAULT 1 CHECK (source_height > 0),
            source_slice_name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sprite_animation_id) REFERENCES ${spriteAnimation}(id) ON DELETE CASCADE,
            UNIQUE (sprite_animation_id, frame_index)
        )`,
        `CREATE INDEX IF NOT EXISTS ${sqlIdent(CATALOG_INDEXES.spriteAnimationFrameAnimation)} ON ${spriteAnimationFrame} (sprite_animation_id)`,
        `CREATE TABLE IF NOT EXISTS ${ninePatch} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT,
            image_path TEXT NOT NULL,
            source_x INTEGER NOT NULL DEFAULT 0,
            source_y INTEGER NOT NULL DEFAULT 0,
            source_width INTEGER NOT NULL DEFAULT 0 CHECK (source_width >= 0),
            source_height INTEGER NOT NULL DEFAULT 0 CHECK (source_height >= 0),
            source_slice_name TEXT NOT NULL DEFAULT '',
            slice_left INTEGER NOT NULL CHECK (slice_left >= 0),
            slice_top INTEGER NOT NULL CHECK (slice_top >= 0),
            slice_right INTEGER NOT NULL CHECK (slice_right > slice_left),
            slice_bottom INTEGER NOT NULL CHECK (slice_bottom > slice_top),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (image_path, source_slice_name)
        )`,
    ]
}

export class ViewCatalog extends HTMLElement {
    constructor() {
        super()
        this.activeTab = "tilesets"
        this.selectedTilesetId = 0
        this.selectedSpriteId = 0
        this.selectedNinePatchId = 0
        this.tilesetRows = []
        this.spriteRows = []
        this.ninePatchRows = []
        this.tilesetTableElement = null
        this.spriteTableElement = null
        this.ninePatchTableElement = null
        this.statusElement = null
        this.headerControlsElement = null
    }

    connectedCallback() {
        registerViewPlugin(this)
        if (this.dataset.ready) {
            this.mountHeaderControls()
            return
        }
        this.dataset.ready = "1"
        this.style.display = "contents"

        this.innerHTML = `
      <article>
        <div role="tablist">
          <button type="button" role="tab" data-tab="tilesets" aria-selected="true">Tilesets</button>
          <button type="button" role="tab" data-tab="sprites" aria-selected="false">Sprites</button>
          <button type="button" role="tab" data-tab="nine-patches" aria-selected="false">Nine patches</button>
        </div>
        <section role="tabpanel" data-panel="tilesets">
          <table data-element="tileset-table">
            <thead>
              <tr>
                <th>Preview</th>
                <th>Name</th>
                <th>Source</th>
                <th>Tile size</th>
                <th>Masks</th>
                <th>Tiles</th>
                <th>Variants</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </section>
        <section role="tabpanel" data-panel="sprites" hidden>
          <table data-element="sprite-table">
            <thead>
              <tr>
                <th>Preview</th>
                <th>Name</th>
                <th>Source</th>
                <th>Grid</th>
                <th>Animations</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </section>
        <section role="tabpanel" data-panel="nine-patches" hidden>
          <table data-element="nine-patch-table">
            <thead>
              <tr>
                <th>Preview</th>
                <th>Name</th>
                <th>Source</th>
                <th>Slices</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </section>
      </article>
      <footer data-element="footer">
        <output data-element="status">Loading...</output>
      </footer>
    `

        this.tilesetTableElement = this.querySelector('[data-element="tileset-table"]')
        this.spriteTableElement = this.querySelector('[data-element="sprite-table"]')
        this.ninePatchTableElement = this.querySelector('[data-element="nine-patch-table"]')
        this.statusElement = this.querySelector('[data-element="status"]')
        assert(this.tilesetTableElement instanceof HTMLTableElement, "view-catalog missing tileset table")
        assert(this.spriteTableElement instanceof HTMLTableElement, "view-catalog missing sprite table")
        assert(this.ninePatchTableElement instanceof HTMLTableElement, "view-catalog missing nine-patch table")
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog missing status output")

        this.querySelector('[data-tab="tilesets"]').addEventListener("click", () => this.selectTab("tilesets"))
        this.querySelector('[data-tab="sprites"]').addEventListener("click", () => this.selectTab("sprites"))
        this.querySelector('[data-tab="nine-patches"]').addEventListener("click", () => this.selectTab("nine-patches"))

        this.mountHeaderControls()
        void this.refresh()
    }

    disconnectedCallback() {
        this.unmountHeaderControls()
        void unregisterViewPlugin(this)
    }

    createViewPluginMethods() {
        return {
            reload: async () => {
                await this.refresh()
                return { ok: true }
            },
        }
    }

    createHeaderControlsElement() {
        const toolbar = document.createElement("div")
        toolbar.dataset.element = "toolbar"
        toolbar.setAttribute("slot", "header-controls")
        toolbar.innerHTML = `
      <div role="buttongroup" data-element="file-actions">
        <button type="button" data-action="reload" aria-label="Reload" title="Reload"><i aria-hidden="true">refresh</i></button>
      </div>
      <div role="buttongroup" data-element="tool-actions">
        <button type="button" data-action="new" aria-label="New catalog record" title="New"><i aria-hidden="true">add</i></button>
        <button type="button" data-action="preview" aria-label="Preview selected catalog record" title="Preview"><i aria-hidden="true">visibility</i></button>
        <button type="button" data-action="edit" aria-label="Edit selected catalog record" title="Edit"><i aria-hidden="true">edit</i></button>
      </div>
    `
        toolbar.querySelector('[data-action="reload"]').addEventListener("click", () => this.refresh())
        toolbar.querySelector('[data-action="new"]').addEventListener("click", () => this.importForActiveTab())
        toolbar.querySelector('[data-action="preview"]').addEventListener("click", () => this.previewSelectedForActiveTab())
        toolbar.querySelector('[data-action="edit"]').addEventListener("click", () => this.edit())
        return toolbar
    }

    mountHeaderControls() {
        if (!this.parentElement || this.headerControlsElement) return
        const toolbar = this.createHeaderControlsElement()
        this.headerControlsElement = toolbar
        this.parentElement.appendChild(toolbar)
        this.updateHeaderControlsUI()
    }

    unmountHeaderControls() {
        if (!this.headerControlsElement) return
        this.headerControlsElement.remove()
        this.headerControlsElement = null
    }

    selectTab(tab) {
        assert(tab === "tilesets" || tab === "sprites" || tab === "nine-patches", `unknown catalog tab ${tab}`)
        this.activeTab = tab
        for (const button of this.querySelectorAll('[role="tab"]')) {
            button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false")
        }
        for (const panel of this.querySelectorAll('[role="tabpanel"]')) {
            panel.hidden = panel.dataset.panel !== tab
        }
        this.updateHeaderControlsUI()
        this.updateStatus()
    }

    updateHeaderControlsUI() {
        if (!this.headerControlsElement) return
        const previewButton = this.headerControlsElement.querySelector('[data-action="preview"]')
        const editButton = this.headerControlsElement.querySelector('[data-action="edit"]')
        assert(previewButton instanceof HTMLButtonElement, "view-catalog preview button missing")
        assert(editButton instanceof HTMLButtonElement, "view-catalog edit button missing")
        const hasSelection =
            this.activeTab === "tilesets"
                ? this.selectedTilesetId > 0
                : this.activeTab === "sprites"
                  ? this.selectedSpriteId > 0
                  : this.selectedNinePatchId > 0
        previewButton.disabled = !hasSelection
        editButton.disabled = !hasSelection
    }

    setStatus(text, tone = null) {
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog status output is not initialized")
        this.statusElement.textContent = text
        this.statusElement.classList.remove("accent", "success", "warning", "danger", "info")
        if (tone) this.statusElement.classList.add(tone)
    }

    updateStatus() {
        if (this.activeTab === "tilesets") {
            this.setStatus(`${this.tilesetRows.length} tilesets`, "success")
            return
        }
        if (this.activeTab === "sprites") {
            this.setStatus(`${this.spriteRows.length} sprites`, "success")
            return
        }
        this.setStatus(`${this.ninePatchRows.length} nine patches`, "success")
    }

    async importForActiveTab() {
        if (this.activeTab === "sprites") {
            await this.importSprite()
            return
        }
        if (this.activeTab === "nine-patches") {
            await this.importNinePatch()
            return
        }
        assert(this.activeTab === "tilesets", `unknown catalog tab ${this.activeTab}`)
        await this.importTileset()
    }

    async importTileset() {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Import Tileset",
                size: "large",
                tag: "view-catalog-tileset-edit",
            }),
        )
        if (payload?.cancelled) return
        await this.refresh()
        this.selectTab("tilesets")
    }

    async importSprite() {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Import Sprite",
                size: "large",
                tag: "view-catalog-sprite-import",
            }),
        )
        if (payload?.cancelled) return
        await this.refresh()
        this.selectTab("sprites")
    }

    selectedTilesetRow() {
        const row = this.tilesetRows.find((item) => Number(item.id) === this.selectedTilesetId)
        assert(row, `selected tileset ${this.selectedTilesetId} not found`)
        return row
    }

    selectedSpriteRow() {
        const row = this.spriteRows.find((item) => Number(item.id) === this.selectedSpriteId)
        assert(row, `selected sprite ${this.selectedSpriteId} not found`)
        return row
    }

    selectedNinePatchRow() {
        const row = this.ninePatchRows.find((item) => Number(item.id) === this.selectedNinePatchId)
        assert(row, `selected nine patch ${this.selectedNinePatchId} not found`)
        return row
    }

    async importNinePatch() {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Import Nine Patch",
                size: "large",
                tag: "view-catalog-nine-patch-edit",
            }),
        )
        if (payload?.cancelled) return
        await this.refresh()
        this.selectTab("nine-patches")
    }

    async previewSelectedForActiveTab() {
        if (this.activeTab === "sprites") {
            assert(this.selectedSpriteId > 0, "select a sprite before preview")
            const row = this.selectedSpriteRow()
            const path = String(row.image_path || "").trim()
            assert(path, "selected sprite requires image path")
            await runtime.call("ui.popup.open", {
                title: path.split("/").pop() || path,
                size: "large",
                tag: "view-aseprite",
                props: { path },
            })
            return
        }
        if (this.activeTab === "nine-patches") {
            assert(this.selectedNinePatchId > 0, "select a nine patch before preview")
            const row = this.selectedNinePatchRow()
            const path = String(row.image_path || "").trim()
            assert(path, "selected nine patch requires image path")
            await runtime.call("ui.popup.open", {
                title: path.split("/").pop() || path,
                size: "large",
                tag: "view-image",
                props: { path },
            })
            return
        }
        assert(this.activeTab === "tilesets", `unknown catalog tab ${this.activeTab}`)
        assert(this.selectedTilesetId > 0, "select a tileset before preview")
        const row = this.selectedTilesetRow()
        const path = String(row.preview_image_path || "").trim()
        assert(path, "selected tileset requires preview image path")
        const extension = getExtension(path)
        await runtime.call("ui.popup.open", {
            title: path.split("/").pop() || path,
            size: "large",
            tag: extension === "aseprite" || extension === "ase" ? "view-aseprite" : "view-image",
            props: { path },
        })
    }

    async edit() {
        await this.editSelectedForActiveTab()
    }

    async editSelectedForActiveTab() {
        if (this.activeTab === "sprites") {
            assert(this.selectedSpriteId > 0, "select a sprite before editing")
            const payload = unwrap(
                await runtime.call("ui.popup.open", {
                    title: "Edit Sprite",
                    size: "large",
                    tag: "view-catalog-sprite-import",
                    props: {
                        mode: "edit",
                        spriteId: this.selectedSpriteId,
                    },
                }),
            )
            if (payload?.cancelled) return
            await this.refresh()
            this.selectTab("sprites")
            return
        }
        if (this.activeTab === "nine-patches") {
            assert(this.selectedNinePatchId > 0, "select a nine patch before editing")
            const payload = unwrap(
                await runtime.call("ui.popup.open", {
                    title: "Edit Nine Patch",
                    size: "large",
                    tag: "view-catalog-nine-patch-edit",
                    props: {
                        mode: "edit",
                        ninePatchId: this.selectedNinePatchId,
                    },
                }),
            )
            if (payload?.cancelled) return
            await this.refresh()
            this.selectTab("nine-patches")
            return
        }
        assert(this.activeTab === "tilesets", `unknown catalog tab ${this.activeTab}`)
        assert(this.selectedTilesetId > 0, "select a tileset before editing")
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Edit Tileset",
                size: "large",
                tag: "view-catalog-tileset-edit",
                props: {
                    mode: "edit",
                    tilesetId: this.selectedTilesetId,
                },
            }),
        )
        if (payload?.cancelled) return
        await this.refresh()
        this.selectTab("tilesets")
    }

    async refresh() {
        this.setStatus("Loading...", "info")
        await this.ensureCatalogSchema()
        this.tilesetRows = await this.fetchTilesets()
        this.spriteRows = await this.fetchSprites()
        this.ninePatchRows = await this.fetchNinePatches()
        if (!this.tilesetRows.some((row) => Number(row.id) === this.selectedTilesetId)) this.selectedTilesetId = 0
        if (!this.spriteRows.some((row) => Number(row.id) === this.selectedSpriteId)) this.selectedSpriteId = 0
        if (!this.ninePatchRows.some((row) => Number(row.id) === this.selectedNinePatchId)) this.selectedNinePatchId = 0
        this.renderTilesets()
        this.renderSprites()
        this.renderNinePatches()
        await this.renderTilesetPreviews()
        await this.renderSpritePreviews()
        await this.renderNinePatchPreviews()
        this.updateHeaderControlsUI()
        this.updateStatus()
    }

    async ensureCatalogSchema() {
        const placeholders = CATALOG_SCHEMA_TABLE_NAMES.map(() => "?").join(", ")
        const existingTables = await sql.queryObjects(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
            ["name"],
            CATALOG_SCHEMA_TABLE_NAMES,
        )

        await sql.exec("PRAGMA foreign_keys = ON")
        if (existingTables.length !== CATALOG_SCHEMA_TABLE_NAMES.length) {
            for (const statement of catalogSchemaStatements()) {
                await sql.exec(statement)
            }
        }
        await this.ensureCatalogSchemaMigrations()
    }

    async ensureCatalogSchemaMigrations() {
        const spriteAnimationFrame = sqlIdent(CATALOG_TABLES.spriteAnimationFrame)
        const columns = await sql.queryObjects(`PRAGMA table_info(${spriteAnimationFrame})`, ["cid", "name", "type", "notnull", "dflt_value", "pk"])
        const columnNames = new Set(columns.map((column) => String(column.name)))
        const missingColumnStatements = [
            ["source_x", `ALTER TABLE ${spriteAnimationFrame} ADD COLUMN source_x INTEGER NOT NULL DEFAULT 0`],
            ["source_y", `ALTER TABLE ${spriteAnimationFrame} ADD COLUMN source_y INTEGER NOT NULL DEFAULT 0`],
            ["source_width", `ALTER TABLE ${spriteAnimationFrame} ADD COLUMN source_width INTEGER NOT NULL DEFAULT 1`],
            ["source_height", `ALTER TABLE ${spriteAnimationFrame} ADD COLUMN source_height INTEGER NOT NULL DEFAULT 1`],
            ["source_slice_name", `ALTER TABLE ${spriteAnimationFrame} ADD COLUMN source_slice_name TEXT NOT NULL DEFAULT ''`],
        ]
        let addedFrameSourceColumn = false
        for (const [columnName, statement] of missingColumnStatements) {
            if (!columnNames.has(columnName)) {
                await sql.exec(statement)
                addedFrameSourceColumn = true
            }
        }
        if (addedFrameSourceColumn) {
            const spriteAnimation = sqlIdent(CATALOG_TABLES.spriteAnimation)
            const sprite = sqlIdent(CATALOG_TABLES.sprite)
            await sql.exec(
                `UPDATE ${spriteAnimationFrame}
                 SET source_x = (SELECT s.source_x FROM ${spriteAnimation} a JOIN ${sprite} s ON s.id = a.sprite_id WHERE a.id = ${spriteAnimationFrame}.sprite_animation_id),
                     source_y = (SELECT s.source_y FROM ${spriteAnimation} a JOIN ${sprite} s ON s.id = a.sprite_id WHERE a.id = ${spriteAnimationFrame}.sprite_animation_id),
                     source_width = (SELECT s.source_width FROM ${spriteAnimation} a JOIN ${sprite} s ON s.id = a.sprite_id WHERE a.id = ${spriteAnimationFrame}.sprite_animation_id),
                     source_height = (SELECT s.source_height FROM ${spriteAnimation} a JOIN ${sprite} s ON s.id = a.sprite_id WHERE a.id = ${spriteAnimationFrame}.sprite_animation_id),
                     source_slice_name = (SELECT s.source_slice_name FROM ${spriteAnimation} a JOIN ${sprite} s ON s.id = a.sprite_id WHERE a.id = ${spriteAnimationFrame}.sprite_animation_id)`,
            )
        }
    }

    async fetchTilesets() {
        const tileTable = sqlIdent(CATALOG_TABLES.tile)
        const tilesetImageSourceTable = sqlIdent(CATALOG_TABLES.tilesetImageSource)
        const tilesetTable = sqlIdent(CATALOG_TABLES.tileset)
        return await sql.queryObjects(
            `
        WITH stats AS (
          SELECT
            tileset_id,
            COUNT(*) AS tile_count,
            COUNT(DISTINCT mask) AS mask_count,
            SUM(CASE WHEN variant_index > 0 THEN 1 ELSE 0 END) AS variant_count
          FROM ${tileTable}
          GROUP BY tileset_id
        ),
        previews AS (
          SELECT
            t.tileset_id,
            t.tile_index AS preview_tile_index,
            src.image_path AS preview_image_path,
            src.tile_width AS preview_tile_width,
            src.tile_height AS preview_tile_height
          FROM ${tileTable} t
          JOIN ${tilesetImageSourceTable} src
            ON src.id = t.image_source_id
           AND src.tileset_id = t.tileset_id
          WHERE t.mask = 15
            AND t.variant_index = 0
        )
        SELECT
          ts.id AS id,
          ts.name AS name,
          COALESCE(ts.display_name, ts.name) AS display_name,
          previews.preview_image_path AS preview_image_path,
          previews.preview_tile_width AS preview_tile_width,
          previews.preview_tile_height AS preview_tile_height,
          previews.preview_tile_index AS preview_tile_index,
          stats.mask_count AS mask_count,
          stats.tile_count AS tile_count,
          stats.variant_count AS variant_count
        FROM ${tilesetTable} ts
        JOIN stats ON stats.tileset_id = ts.id
        JOIN previews ON previews.tileset_id = ts.id
        ORDER BY ts.name
      `,
            [
                "id",
                "name",
                "display_name",
                "preview_image_path",
                "preview_tile_width",
                "preview_tile_height",
                "preview_tile_index",
                "mask_count",
                "tile_count",
                "variant_count",
            ],
        )
    }

    async fetchSprites() {
        const spriteTable = sqlIdent(CATALOG_TABLES.sprite)
        const spriteAnimationTable = sqlIdent(CATALOG_TABLES.spriteAnimation)
        const spriteAnimationFrameTable = sqlIdent(CATALOG_TABLES.spriteAnimationFrame)
        return await sql.queryObjects(
            `
        WITH preview_frames AS (
          SELECT
            a.sprite_id,
            f.source_x,
            f.source_y,
            f.source_width,
            f.source_height,
            f.source_slice_name,
            ROW_NUMBER() OVER (PARTITION BY a.sprite_id ORDER BY a.start_frame, f.frame_index, a.id, f.id) AS rn
          FROM ${spriteAnimationTable} a
          JOIN ${spriteAnimationFrameTable} f ON f.sprite_animation_id = a.id
        )
        SELECT
          s.id AS id,
          s.name AS name,
          COALESCE(s.display_name, s.name) AS display_name,
          s.image_path AS image_path,
          s.grid_width AS grid_width,
          s.grid_height AS grid_height,
          COUNT(a.id) AS animation_count,
          COALESCE(p.source_x, s.source_x) AS source_x,
          COALESCE(p.source_y, s.source_y) AS source_y,
          COALESCE(p.source_width, s.source_width) AS source_width,
          COALESCE(p.source_height, s.source_height) AS source_height,
          COALESCE(p.source_slice_name, s.source_slice_name) AS source_slice_name
        FROM ${spriteTable} s
        LEFT JOIN ${spriteAnimationTable} a ON a.sprite_id = s.id
        LEFT JOIN preview_frames p ON p.sprite_id = s.id AND p.rn = 1
        GROUP BY s.id
        ORDER BY s.name
      `,
            ["id", "name", "display_name", "image_path", "grid_width", "grid_height", "animation_count", "source_x", "source_y", "source_width", "source_height", "source_slice_name"],
        )
    }

    async fetchNinePatches() {
        const ninePatchTable = sqlIdent(CATALOG_TABLES.ninePatch)
        return await sql.queryObjects(
            `
        SELECT
          id,
          name,
          COALESCE(display_name, name) AS display_name,
          image_path,
          source_x,
          source_y,
          source_width,
          source_height,
          source_slice_name,
          slice_left,
          slice_top,
          slice_right,
          slice_bottom
        FROM ${ninePatchTable}
        ORDER BY name
      `,
            ["id", "name", "display_name", "image_path", "source_x", "source_y", "source_width", "source_height", "source_slice_name", "slice_left", "slice_top", "slice_right", "slice_bottom"],
        )
    }

    renderTilesets() {
        assert(this.tilesetTableElement instanceof HTMLTableElement, "view-catalog tileset table is not initialized")
        const body = this.tilesetTableElement.querySelector("tbody")
        assert(body instanceof HTMLTableSectionElement, "view-catalog missing tileset table body")
        body.replaceChildren()

        for (const row of this.tilesetRows) {
            const tr = document.createElement("tr")
            tr.dataset.tilesetId = String(row.id)
            tr.setAttribute("aria-selected", Number(row.id) === this.selectedTilesetId ? "true" : "false")
            tr.addEventListener("click", () => this.selectTileset(Number(row.id)))
            tr.addEventListener("dblclick", async () => {
                this.selectTileset(Number(row.id))
                await this.editSelectedForActiveTab()
            })

            const preview = document.createElement("td")
            const canvas = document.createElement("canvas")
            canvas.dataset.element = "preview"
            canvas.dataset.tilesetId = String(row.id)
            preview.appendChild(canvas)

            const name = document.createElement("td")
            name.textContent = row.display_name

            const source = document.createElement("td")
            source.textContent = row.preview_image_path

            const tileSize = document.createElement("td")
            tileSize.textContent = `${row.preview_tile_width}×${row.preview_tile_height}`

            const masks = document.createElement("td")
            masks.textContent = `${row.mask_count}/15`

            const tiles = document.createElement("td")
            tiles.textContent = String(row.tile_count)

            const variants = document.createElement("td")
            variants.textContent = String(row.variant_count)

            tr.append(preview, name, source, tileSize, masks, tiles, variants)
            body.appendChild(tr)
        }
    }

    renderSprites() {
        assert(this.spriteTableElement instanceof HTMLTableElement, "view-catalog sprite table is not initialized")
        const body = this.spriteTableElement.querySelector("tbody")
        assert(body instanceof HTMLTableSectionElement, "view-catalog missing sprite table body")
        body.replaceChildren()

        for (const row of this.spriteRows) {
            const tr = document.createElement("tr")
            tr.dataset.spriteId = String(row.id)
            tr.setAttribute("aria-selected", Number(row.id) === this.selectedSpriteId ? "true" : "false")
            tr.addEventListener("click", () => this.selectSprite(Number(row.id)))
            tr.addEventListener("dblclick", async () => {
                this.selectSprite(Number(row.id))
                await this.editSelectedForActiveTab()
            })

            const preview = document.createElement("td")
            const canvas = document.createElement("canvas")
            canvas.dataset.element = "preview"
            canvas.dataset.spriteId = String(row.id)
            preview.appendChild(canvas)

            const name = document.createElement("td")
            name.textContent = row.display_name

            const source = document.createElement("td")
            const sourceSliceName = String(row.source_slice_name || "")
            source.textContent = sourceSliceName ? `${row.image_path}#${sourceSliceName}` : row.image_path

            const grid = document.createElement("td")
            grid.textContent = `${row.grid_width}×${row.grid_height}`

            const animations = document.createElement("td")
            animations.textContent = String(row.animation_count)

            tr.append(preview, name, source, grid, animations)
            body.appendChild(tr)
        }
    }

    renderNinePatches() {
        assert(this.ninePatchTableElement instanceof HTMLTableElement, "view-catalog nine-patch table is not initialized")
        const body = this.ninePatchTableElement.querySelector("tbody")
        assert(body instanceof HTMLTableSectionElement, "view-catalog missing nine-patch table body")
        body.replaceChildren()

        for (const row of this.ninePatchRows) {
            const tr = document.createElement("tr")
            tr.dataset.ninePatchId = String(row.id)
            tr.setAttribute("aria-selected", Number(row.id) === this.selectedNinePatchId ? "true" : "false")
            tr.addEventListener("click", () => this.selectNinePatch(Number(row.id)))
            tr.addEventListener("dblclick", async () => {
                this.selectNinePatch(Number(row.id))
                await this.editSelectedForActiveTab()
            })

            const preview = document.createElement("td")
            const canvas = document.createElement("canvas")
            canvas.dataset.element = "preview"
            canvas.dataset.ninePatchId = String(row.id)
            preview.appendChild(canvas)

            const name = document.createElement("td")
            name.textContent = row.display_name

            const source = document.createElement("td")
            const sourceSliceName = String(row.source_slice_name || "")
            source.textContent = sourceSliceName ? `${row.image_path}#${sourceSliceName}` : row.image_path

            const slices = document.createElement("td")
            slices.textContent = `${row.slice_left}, ${row.slice_top}, ${row.slice_right}, ${row.slice_bottom}`

            tr.append(preview, name, source, slices)
            body.appendChild(tr)
        }
    }

    selectTileset(tilesetId) {
        assert(Number.isInteger(tilesetId) && tilesetId > 0, "tileset selection requires positive id")
        this.selectedTilesetId = tilesetId
        for (const row of this.querySelectorAll("tr[data-tileset-id]")) {
            row.setAttribute("aria-selected", Number(row.dataset.tilesetId) === tilesetId ? "true" : "false")
        }
        this.updateHeaderControlsUI()
    }

    selectSprite(spriteId) {
        assert(Number.isInteger(spriteId) && spriteId > 0, "sprite selection requires positive id")
        this.selectedSpriteId = spriteId
        for (const row of this.querySelectorAll("tr[data-sprite-id]")) {
            row.setAttribute("aria-selected", Number(row.dataset.spriteId) === spriteId ? "true" : "false")
        }
        this.updateHeaderControlsUI()
    }

    selectNinePatch(ninePatchId) {
        assert(Number.isInteger(ninePatchId) && ninePatchId > 0, "nine-patch selection requires positive id")
        this.selectedNinePatchId = ninePatchId
        for (const row of this.querySelectorAll("tr[data-nine-patch-id]")) {
            row.setAttribute("aria-selected", Number(row.dataset.ninePatchId) === ninePatchId ? "true" : "false")
        }
        this.updateHeaderControlsUI()
    }

    async renderTilesetPreviews() {
        const imageCache = new Map()
        for (const row of this.tilesetRows) {
            const canvas = this.querySelector(`canvas[data-tileset-id="${row.id}"]`)
            assert(canvas instanceof HTMLCanvasElement, `view-catalog missing preview canvas for tileset ${row.id}`)
            await this.renderTilesetPreview(canvas, row, imageCache)
        }
    }

    async renderTilesetPreview(canvas, row, imageCache) {
        const path = row.preview_image_path
        assert(typeof path === "string" && path.length > 0, "catalog preview requires image path")
        const extension = getExtension(path)
        assert(extension === "qoi" || extension === "aseprite" || extension === "ase", `catalog preview supports qoi or aseprite files only: ${path}`)

        let source = imageCache.get(path)
        if (!source) {
            if (extension === "qoi") {
                const bytes = new Uint8Array(unwrap(await runtime.invoke("fs/fs::read-file", path)))
                source = createCanvasFromQoi(bytes)
            } else {
                source = await this.loadAsepriteFrameCanvas(path)
            }
            imageCache.set(path, source)
        }

        const tileWidth = Number(row.preview_tile_width)
        const tileHeight = Number(row.preview_tile_height)
        const tileIndex = Number(row.preview_tile_index)
        assertPositiveInteger(tileWidth, "preview tile width")
        assertPositiveInteger(tileHeight, "preview tile height")
        assertPositiveInteger(tileIndex, "preview tile index")
        assert(source.width % tileWidth === 0, `${path} width must be divisible by tile width`)
        assert(source.height % tileHeight === 0, `${path} height must be divisible by tile height`)

        const columns = source.width / tileWidth
        const rows = source.height / tileHeight
        assert(tileIndex <= columns * rows, `${path} tile index ${tileIndex} exceeds source tile count ${columns * rows}`)

        const zeroBasedIndex = tileIndex - 1
        const tileX = zeroBasedIndex % columns
        const tileY = Math.floor(zeroBasedIndex / columns)

        const scale = 3
        canvas.width = tileWidth * scale
        canvas.height = tileHeight * scale
        const ctx = canvas.getContext("2d")
        assert(ctx, "view-catalog preview requires 2d context")
        ctx.imageSmoothingEnabled = false
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(source, tileX * tileWidth, tileY * tileHeight, tileWidth, tileHeight, 0, 0, canvas.width, canvas.height)
    }

    async renderSpritePreviews() {
        const spriteCache = new Map()
        for (const row of this.spriteRows) {
            const canvas = this.querySelector(`canvas[data-sprite-id="${row.id}"]`)
            assert(canvas instanceof HTMLCanvasElement, `view-catalog missing preview canvas for sprite ${row.id}`)
            await this.renderSpritePreview(canvas, row, spriteCache)
        }
    }

    async renderSpritePreview(canvas, row, spriteCache) {
        const path = row.image_path
        assert(typeof path === "string" && path.length > 0, "sprite preview requires image path")
        assert(getExtension(path) === "aseprite" || getExtension(path) === "ase", `sprite preview currently supports aseprite files only: ${path}`)

        let sprite = spriteCache.get(path)
        if (!sprite) {
            sprite = await this.loadAsepriteSprite(path)
            spriteCache.set(path, sprite)
        }

        const source = sprite.preview
        const sourceX = Number(row.source_x)
        const sourceY = Number(row.source_y)
        const sourceWidth = Number(row.source_width)
        const sourceHeight = Number(row.source_height)
        assert(Number.isInteger(sourceX), "sprite preview source x must be an integer")
        assert(Number.isInteger(sourceY), "sprite preview source y must be an integer")
        assertPositiveInteger(sourceWidth, "sprite preview source width")
        assertPositiveInteger(sourceHeight, "sprite preview source height")
        const maxSize = 64
        const scale = Math.max(1, Math.floor(maxSize / Math.max(sourceWidth, sourceHeight)))
        canvas.width = sourceWidth * scale
        canvas.height = sourceHeight * scale
        const ctx = canvas.getContext("2d")
        assert(ctx, "view-catalog sprite preview requires 2d context")
        ctx.imageSmoothingEnabled = false
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)

        return sprite
    }

    async loadAsepriteSprite(path) {
        let documentResource = null
        try {
            documentResource = unwrap(await runtime.invoke("aseprite/aseprite::open", path), "aseprite open")
            const pixels = unwrap(await runtime.invoke("aseprite/aseprite::render-frame", documentResource, 0), "aseprite render frame")
            return {
                preview: createCanvasFromPixels(pixels, "view-catalog sprite preview"),
            }
        } finally {
            if (documentResource) await runtime.releaseResource(documentResource)
        }
    }

    async renderNinePatchPreviews() {
        const imageCache = new Map()
        for (const row of this.ninePatchRows) {
            const canvas = this.querySelector(`canvas[data-nine-patch-id="${row.id}"]`)
            assert(canvas instanceof HTMLCanvasElement, `view-catalog missing preview canvas for nine patch ${row.id}`)
            await this.renderNinePatchPreview(canvas, row, imageCache)
        }
    }

    async renderNinePatchPreview(canvas, row, imageCache) {
        const path = String(row.image_path || "")
        assert(path.length > 0, "nine-patch preview requires image path")

        let source = imageCache.get(path)
        if (!source) {
            const extension = getExtension(path)
            if (extension === "qoi") {
                const bytes = new Uint8Array(unwrap(await runtime.invoke("fs/fs::read-file", path)))
                source = createCanvasFromQoi(bytes)
            } else if (extension === "aseprite" || extension === "ase") {
                source = await this.loadAsepriteFrameCanvas(path)
            } else {
                canvas.width = 96
                canvas.height = 48
                const ctx = canvas.getContext("2d")
                assert(ctx, "view-catalog nine-patch preview requires 2d context")
                ctx.clearRect(0, 0, canvas.width, canvas.height)
                ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1)
                ctx.fillText("image", 8, 26)
                return
            }
            imageCache.set(path, source)
        }

        const sourceX = Number(row.source_x)
        const sourceY = Number(row.source_y)
        const sourceWidth = Number(row.source_width) || source.width
        const sourceHeight = Number(row.source_height) || source.height
        assert(Number.isInteger(sourceX), "nine-patch preview source x must be an integer")
        assert(Number.isInteger(sourceY), "nine-patch preview source y must be an integer")
        assertPositiveInteger(sourceWidth, "nine-patch preview source width")
        assertPositiveInteger(sourceHeight, "nine-patch preview source height")

        const scale = Math.max(1, Math.floor(96 / Math.max(sourceWidth, sourceHeight)))
        canvas.width = sourceWidth * scale
        canvas.height = sourceHeight * scale
        const ctx = canvas.getContext("2d")
        assert(ctx, "view-catalog nine-patch preview requires 2d context")
        ctx.imageSmoothingEnabled = false
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        ctx.strokeRect(Number(row.slice_left) * scale + 0.5, 0.5, 0, canvas.height - 1)
        ctx.strokeRect(Number(row.slice_right) * scale + 0.5, 0.5, 0, canvas.height - 1)
        ctx.strokeRect(0.5, Number(row.slice_top) * scale + 0.5, canvas.width - 1, 0)
        ctx.strokeRect(0.5, Number(row.slice_bottom) * scale + 0.5, canvas.width - 1, 0)
    }

    async loadAsepriteFrameCanvas(path) {
        let documentResource = null
        try {
            documentResource = unwrap(await runtime.invoke("aseprite/aseprite::open", path), "aseprite open")
            const pixels = unwrap(await runtime.invoke("aseprite/aseprite::render-frame", documentResource, 0), "aseprite render frame")
            return createCanvasFromPixels(pixels, "view-catalog nine-patch preview")
        } finally {
            if (documentResource) await runtime.releaseResource(documentResource)
        }
    }
}

if (!customElements.get("view-catalog")) {
    customElements.define("view-catalog", ViewCatalog)
}
