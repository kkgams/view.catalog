import { runtime, unwrap } from "/core/runtime.js"
import { registerViewPlugin, unregisterViewPlugin } from "/util/view-plugin.js"
import { sql } from "/util/sql.js"
import { decode as decodeQoi } from "/util/qoi/decode.js"

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
}

function basenameWithoutExtension(path) {
    const name = String(path || "").split("/").pop() || ""
    const dot = name.lastIndexOf(".")
    return dot > 0 ? name.slice(0, dot) : name
}

function dirname(path) {
    const normalized = String(path || "").trim().replace(/\/+/g, "/")
    if (!normalized || normalized === "/") return "/"
    const slashIndex = normalized.lastIndexOf("/")
    if (slashIndex <= 0) return "/"
    return normalized.slice(0, slashIndex)
}

function getExtension(path) {
    const name = String(path || "").split("/").pop() || ""
    const parts = name.split(".")
    if (parts.length <= 1) return ""
    return parts.pop().toLowerCase()
}

function normalizeName(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
}

function assertPositiveInteger(value, name) {
    assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer`)
}

function createCanvasFromQoi(bytes) {
    const decoded = decodeQoi(bytes.buffer, bytes.byteOffset, bytes.byteLength, 4)
    return { width: Number(decoded.width), height: Number(decoded.height) }
}

function inferDualGridTileSize(width, height) {
    assertPositiveInteger(width, "tileset source width")
    assertPositiveInteger(height, "tileset source height")
    const layouts = [
        { columns: 5, rows: 3 },
        { columns: 3, rows: 5 },
        { columns: 15, rows: 1 },
        { columns: 1, rows: 15 },
    ]
    for (const layout of layouts) {
        if (width % layout.columns !== 0 || height % layout.rows !== 0) continue
        return { tileWidth: width / layout.columns, tileHeight: height / layout.rows }
    }
    throw new Error(`cannot infer dual-grid tile size from ${width}×${height}; enter tile size manually`)
}

export class ViewCatalogTilesetEdit extends HTMLElement {
    constructor() {
        super()
        this.popupProps = this.popupProps || {}
        this.mode = "import"
        this.tilesetId = 0
        this.formElement = null
        this.statusElement = null
        this.draft = {
            imagePath: "",
            name: "",
            displayName: "",
            sourceWidth: 0,
            sourceHeight: 0,
            tileWidth: 0,
            tileHeight: 0,
        }
    }

    connectedCallback() {
        registerViewPlugin(this)
        if (this.dataset.ready) return
        this.dataset.ready = "1"
        this.popupProps = this.popupProps || {}
        this.mode = String(this.popupProps.mode || "import")
        assert(this.mode === "import" || this.mode === "edit", `unknown tileset edit mode ${this.mode}`)
        this.tilesetId = Number(this.popupProps.tilesetId || 0)
        if (this.mode === "edit") assert(Number.isInteger(this.tilesetId) && this.tilesetId > 0, "tileset edit requires tilesetId")
        this.style.display = "contents"
        this.innerHTML = '<form data-element="form" novalidate></form>'
        this.formElement = this.querySelector('[data-element="form"]')
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-tileset-edit missing form")
        this.formElement.addEventListener("submit", async (event) => this.handleSubmit(event))
        void this.initialize()
    }

    disconnectedCallback() {
        void unregisterViewPlugin(this)
    }

    async initialize() {
        if (this.mode === "edit") await this.loadTilesetDraft(this.tilesetId)
        this.render()
    }

    setStatus(text, tone = null) {
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog-tileset-edit status output is not initialized")
        this.statusElement.textContent = text
        this.statusElement.classList.remove("accent", "success", "warning", "danger", "info")
        if (tone) this.statusElement.classList.add(tone)
    }

    captureDraft() {
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-tileset-edit form is not initialized")
        const formData = new FormData(this.formElement)
        this.draft.imagePath = String(formData.get("image-path") || "").trim()
        this.draft.name = normalizeName(formData.get("name"))
        this.draft.displayName = String(formData.get("display-name") || "").trim()
        this.draft.tileWidth = Number(formData.get("tile-width"))
        this.draft.tileHeight = Number(formData.get("tile-height"))
    }

    render() {
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-tileset-edit form is not initialized")
        const submitLabel = this.mode === "edit" ? "Save tileset" : "Import tileset"
        const sourceInfo = this.draft.sourceWidth > 0 && this.draft.sourceHeight > 0 ? `${Number(this.draft.sourceWidth)}×${Number(this.draft.sourceHeight)} · dual grid masks 1–15` : this.mode === "edit" ? "Loaded from database." : "Choose a QOI or Aseprite file."
        this.formElement.innerHTML = `
      <fieldset>
        <legend>Source</legend>
        <label>Image path
          <input type="text" name="image-path" value="${escapeHtml(this.draft.imagePath)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <button type="submit" name="intent" value="choose-file">Choose file</button>
        <output data-element="source-info">${escapeHtml(sourceInfo)}</output>
      </fieldset>

      <fieldset>
        <legend>Dual grid tileset</legend>
        <label>Name
          <input type="text" name="name" value="${escapeHtml(this.draft.name)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <label>Display name
          <input type="text" name="display-name" value="${escapeHtml(this.draft.displayName)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <label>Tile width
          <input type="number" name="tile-width" min="1" value="${Number(this.draft.tileWidth)}">
        </label>
        <label>Tile height
          <input type="number" name="tile-height" min="1" value="${Number(this.draft.tileHeight)}">
        </label>
        <p>Saving creates exactly 15 mask tiles. Mask N uses tile index N from the selected source.</p>
      </fieldset>

      <footer>
        <output data-element="status"></output>
        <button type="submit" name="intent" value="cancel">Cancel</button>
        <button type="submit" name="intent" value="save" class="accent">${submitLabel}</button>
      </footer>
    `
        this.statusElement = this.formElement.querySelector('[data-element="status"]')
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog-tileset-edit missing status output")
    }

    async chooseFile() {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Choose Tileset Source",
                size: "large",
                tag: "view-files",
                props: {
                    mode: "chooser",
                    rootPath: dirname(this.draft.imagePath || "catalog/tilesets"),
                    filter: "*.qoi,*.aseprite,*.ase",
                },
            }),
        )
        if (payload?.cancelled) return
        const selection = payload?.selection
        assert(selection && !Array.isArray(selection), "tileset import requires one selected file")
        const path = String(selection.path || "").trim()
        assert(path, "tileset import selected file requires path")
        await this.loadSourceDraft(path)
    }

    async readSourceDimensions(path) {
        const extension = getExtension(path)
        if (extension === "qoi") {
            const bytes = new Uint8Array(unwrap(await runtime.invoke("fs/fs::read-file", path)))
            return createCanvasFromQoi(bytes)
        }
        if (extension === "aseprite" || extension === "ase") {
            let documentResource = null
            try {
                documentResource = unwrap(await runtime.invoke("aseprite/aseprite::open", path), "aseprite open")
                const info = unwrap(await runtime.invoke("aseprite/aseprite::info", documentResource), "aseprite info")
                return { width: Number(info.width), height: Number(info.height) }
            } finally {
                if (documentResource) await runtime.releaseResource(documentResource)
            }
        }
        throw new Error(`tileset source must be .qoi, .aseprite, or .ase: ${path}`)
    }

    async loadSourceDraft(path) {
        const dimensions = await this.readSourceDimensions(path)
        assertPositiveInteger(dimensions.width, "tileset source width")
        assertPositiveInteger(dimensions.height, "tileset source height")
        const baseName = basenameWithoutExtension(path)
        this.draft.imagePath = path
        this.draft.name = normalizeName(baseName)
        this.draft.displayName = baseName
        this.draft.sourceWidth = dimensions.width
        this.draft.sourceHeight = dimensions.height
        if (this.draft.tileWidth > 0 && this.draft.tileHeight > 0) return
        try {
            const tileSize = inferDualGridTileSize(dimensions.width, dimensions.height)
            this.draft.tileWidth = tileSize.tileWidth
            this.draft.tileHeight = tileSize.tileHeight
        } catch (_error) {
            this.draft.tileWidth = 0
            this.draft.tileHeight = 0
        }
    }

    async loadTilesetDraft(tilesetId) {
        const rows = await sql.queryObjects(
            `SELECT ts.id, ts.name, COALESCE(ts.display_name, '') AS display_name,
                    src.image_path, src.tile_width, src.tile_height
             FROM tileset ts
             JOIN tileset_image_source src ON src.tileset_id = ts.id
             WHERE ts.id = ?
             ORDER BY src.id
             LIMIT 1`,
            ["id", "name", "display_name", "image_path", "tile_width", "tile_height"],
            [String(tilesetId)],
        )
        assert(rows.length === 1, `expected one tileset for id ${tilesetId}, got ${rows.length}`)
        const row = rows[0]
        this.draft.imagePath = String(row.image_path)
        this.draft.name = String(row.name)
        this.draft.displayName = String(row.display_name)
        this.draft.tileWidth = Number(row.tile_width)
        this.draft.tileHeight = Number(row.tile_height)
    }

    validateDraft() {
        assert(this.draft.imagePath, "Choose a tileset source file")
        const extension = getExtension(this.draft.imagePath)
        assert(extension === "qoi" || extension === "aseprite" || extension === "ase", "Tileset source must be QOI or Aseprite")
        assert(this.draft.name, "Tileset name is required")
        assertPositiveInteger(this.draft.tileWidth, "tile width")
        assertPositiveInteger(this.draft.tileHeight, "tile height")
    }

    async validateSourceGrid() {
        const dimensions = await this.readSourceDimensions(this.draft.imagePath)
        assertPositiveInteger(dimensions.width, "tileset source width")
        assertPositiveInteger(dimensions.height, "tileset source height")
        assert(dimensions.width % this.draft.tileWidth === 0, "tileset source width must be divisible by tile width")
        assert(dimensions.height % this.draft.tileHeight === 0, "tileset source height must be divisible by tile height")
        const columns = dimensions.width / this.draft.tileWidth
        const rows = dimensions.height / this.draft.tileHeight
        assert(columns * rows >= 15, "dual-grid tileset source must contain at least 15 tiles")
        this.draft.sourceWidth = dimensions.width
        this.draft.sourceHeight = dimensions.height
    }

    async saveTileset() {
        this.validateDraft()
        await this.validateSourceGrid()
        await sql.exec("BEGIN TRANSACTION", [])
        try {
            let tilesetId = this.tilesetId
            if (this.mode === "edit") {
                assert(Number.isInteger(tilesetId) && tilesetId > 0, "tileset edit requires tilesetId")
                await sql.exec(
                    `UPDATE tileset
                     SET name = ?, display_name = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [this.draft.name, this.draft.displayName, String(tilesetId)],
                )
                await sql.exec("DELETE FROM tile WHERE tileset_id = ?", [String(tilesetId)])
                await sql.exec("DELETE FROM tileset_image_source WHERE tileset_id = ?", [String(tilesetId)])
            } else {
                await sql.exec(
                    `INSERT INTO tileset (name, display_name)
                     VALUES (?, ?)`,
                    [this.draft.name, this.draft.displayName],
                )
                tilesetId = Number(await sql.value("SELECT last_insert_rowid()", []))
            }

            await sql.exec(
                `INSERT INTO tileset_image_source (tileset_id, image_path, tile_width, tile_height)
                 VALUES (?, ?, ?, ?)`,
                [String(tilesetId), this.draft.imagePath, String(this.draft.tileWidth), String(this.draft.tileHeight)],
            )
            const imageSourceId = Number(await sql.value("SELECT last_insert_rowid()", []))
            for (let mask = 1; mask <= 15; mask += 1) {
                await sql.exec(
                    `INSERT INTO tile (tileset_id, image_source_id, mask, tile_index, variant_index, weight, name)
                     VALUES (?, ?, ?, ?, 0, 1, ?)`,
                    [String(tilesetId), String(imageSourceId), String(mask), String(mask), `mask_${mask}`],
                )
            }
            this.tilesetId = tilesetId
            await sql.exec("COMMIT", [])
        } catch (error) {
            await sql.exec("ROLLBACK", [])
            throw error
        }
    }

    async handleSubmit(event) {
        event.preventDefault()
        const formData = new FormData(this.formElement, event.submitter || undefined)
        const intent = String(formData.get("intent") || "save")
        this.captureDraft()

        if (intent === "cancel") {
            await runtime.call("ui.popup.close", { ok: false, cancelled: true })
            return
        }

        if (intent === "choose-file") {
            try {
                await this.chooseFile()
            } catch (error) {
                this.setStatus(String(error?.message || error), "danger")
                return
            }
            this.render()
            if (this.draft.tileWidth > 0 && this.draft.tileHeight > 0) {
                this.setStatus("Loaded tileset source.", "success")
            } else {
                this.setStatus("Loaded tileset source. Set tile width and height before importing.", "warning")
            }
            return
        }

        assert(intent === "save", `unknown tileset intent ${intent}`)
        try {
            await this.saveTileset()
            await runtime.call("ui.popup.close", { ok: true, cancelled: false, mode: this.mode, tilesetId: this.tilesetId, tilesetName: this.draft.name })
        } catch (error) {
            this.setStatus(String(error?.message || error), "danger")
        }
    }
}

if (!customElements.get("view-catalog-tileset-edit")) {
    customElements.define("view-catalog-tileset-edit", ViewCatalogTilesetEdit)
}
