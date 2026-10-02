import { runtime, unwrap } from "/core/runtime.js"
import { registerViewPlugin, unregisterViewPlugin } from "/util/view-plugin.js"
import { sql } from "/util/sql.js"

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

function normalizeName(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
}

function assertInteger(value, name) {
    assert(Number.isInteger(value), `${name} must be an integer`)
}

function assertNonNegativeInteger(value, name) {
    assert(Number.isInteger(value) && value >= 0, `${name} must be a non-negative integer`)
}

function assertPositiveInteger(value, name) {
    assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer`)
}

function normalizePatch(value, name) {
    if (value === null) return null
    assert(value && typeof value === "object", `${name} must be a rect option`)
    const patch = "is_some" in value ? (value.is_some ? value.val : null) : "isSome" in value ? (value.isSome ? value.val : null) : value
    if (patch === null) return null
    const x = Number(patch.x)
    const y = Number(patch.y)
    const width = Number(patch.width)
    const height = Number(patch.height)
    assertNonNegativeInteger(x, `${name} x`)
    assertNonNegativeInteger(y, `${name} y`)
    assertPositiveInteger(width, `${name} width`)
    assertPositiveInteger(height, `${name} height`)
    return { x, y, width, height }
}

function firstSliceKey(slice) {
    assert(slice && typeof slice === "object", "Aseprite slice must be an object")
    assert(Array.isArray(slice.keys), `Aseprite slice ${String(slice.name || "")} keys must be an array`)
    assert(slice.keys.length > 0, `Aseprite slice ${String(slice.name || "")} requires at least one key`)
    const sortedKeys = [...slice.keys].sort((left, right) => Number(left.frame) - Number(right.frame))
    return sortedKeys[0]
}

function buildSourceNinePatches({ baseName, slices }) {
    assert(Array.isArray(slices), "Aseprite slices must be an array")
    assert(slices.length > 0, "Aseprite nine-patch import requires at least one slice")
    const multiple = slices.length > 1
    const ninePatches = slices.map((slice) => {
        const sliceName = String(slice.name || "").trim()
        assert(sliceName, "Aseprite slice requires name")
        const key = firstSliceKey(slice)
        const sourceX = Number(key.x)
        const sourceY = Number(key.y)
        const sourceWidth = Number(key.width)
        const sourceHeight = Number(key.height)
        assertInteger(sourceX, `Aseprite slice ${sliceName} source x`)
        assertInteger(sourceY, `Aseprite slice ${sliceName} source y`)
        assertPositiveInteger(sourceWidth, `Aseprite slice ${sliceName} source width`)
        assertPositiveInteger(sourceHeight, `Aseprite slice ${sliceName} source height`)
        const patch = normalizePatch(key.patch, `Aseprite slice ${sliceName} patch`)
        assert(patch, `Aseprite slice ${sliceName} requires a nine-patch center patch`)
        assert(patch.x + patch.width <= sourceWidth, `Aseprite slice ${sliceName} patch exceeds source width`)
        assert(patch.y + patch.height <= sourceHeight, `Aseprite slice ${sliceName} patch exceeds source height`)
        return {
            sliceName,
            name: multiple ? normalizeName(sliceName) : normalizeName(baseName),
            displayName: multiple ? sliceName : baseName,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            sliceLeft: patch.x,
            sliceTop: patch.y,
            sliceRight: patch.x + patch.width,
            sliceBottom: patch.y + patch.height,
        }
    })
    const names = new Set()
    for (const ninePatch of ninePatches) {
        assert(ninePatch.name, `Aseprite slice ${ninePatch.sliceName} produced empty nine-patch name`)
        assert(!names.has(ninePatch.name), `duplicate nine-patch name from Aseprite slices: ${ninePatch.name}`)
        names.add(ninePatch.name)
    }
    return ninePatches
}

export class ViewCatalogNinePatchEdit extends HTMLElement {
    constructor() {
        super()
        this.popupProps = this.popupProps || {}
        this.mode = "import"
        this.ninePatchId = 0
        this.formElement = null
        this.statusElement = null
        this.draft = {
            imagePath: "",
            name: "",
            displayName: "",
            sourceNinePatches: [],
            selectedSourceIndex: 0,
            sourceX: 0,
            sourceY: 0,
            sourceWidth: 0,
            sourceHeight: 0,
            sourceSliceName: "",
            sliceLeft: 0,
            sliceTop: 0,
            sliceRight: 1,
            sliceBottom: 1,
        }
    }

    connectedCallback() {
        registerViewPlugin(this)
        if (this.dataset.ready) return
        this.dataset.ready = "1"
        this.popupProps = this.popupProps || {}
        this.mode = String(this.popupProps.mode || "import")
        assert(this.mode === "import" || this.mode === "edit", `unknown nine-patch edit mode ${this.mode}`)
        this.ninePatchId = Number(this.popupProps.ninePatchId || 0)
        if (this.mode === "edit") assert(Number.isInteger(this.ninePatchId) && this.ninePatchId > 0, "nine-patch edit requires ninePatchId")
        this.style.display = "contents"
        this.innerHTML = '<form data-element="form" novalidate></form>'
        this.formElement = this.querySelector('[data-element="form"]')
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-nine-patch-edit missing form")
        this.formElement.addEventListener("submit", async (event) => this.handleSubmit(event))
        this.formElement.addEventListener("change", (event) => this.handleChange(event))
        void this.initialize()
    }

    disconnectedCallback() {
        void unregisterViewPlugin(this)
    }

    async initialize() {
        if (this.mode === "edit") await this.loadDraft(this.ninePatchId)
        this.render()
    }

    setStatus(text, tone = null) {
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog-nine-patch-edit status output is not initialized")
        this.statusElement.textContent = text
        this.statusElement.classList.remove("accent", "success", "warning", "danger", "info")
        if (tone) this.statusElement.classList.add(tone)
    }

    selectedSourceNinePatch() {
        assert(this.draft.sourceNinePatches.length > 0, "nine-patch source selection requires imported source patches")
        assertNonNegativeInteger(this.draft.selectedSourceIndex, "selected nine-patch source index")
        assert(this.draft.selectedSourceIndex < this.draft.sourceNinePatches.length, "selected nine-patch source index is out of range")
        return this.draft.sourceNinePatches[this.draft.selectedSourceIndex]
    }

    applySourceNinePatchToDraft(ninePatch) {
        this.draft.name = ninePatch.name
        this.draft.displayName = ninePatch.displayName
        this.draft.sourceX = ninePatch.sourceX
        this.draft.sourceY = ninePatch.sourceY
        this.draft.sourceWidth = ninePatch.sourceWidth
        this.draft.sourceHeight = ninePatch.sourceHeight
        this.draft.sourceSliceName = ninePatch.sliceName
        this.draft.sliceLeft = ninePatch.sliceLeft
        this.draft.sliceTop = ninePatch.sliceTop
        this.draft.sliceRight = ninePatch.sliceRight
        this.draft.sliceBottom = ninePatch.sliceBottom
    }

    captureDraftFieldsIntoSourceNinePatch(index, formData) {
        assertNonNegativeInteger(index, "nine-patch source index")
        assert(index < this.draft.sourceNinePatches.length, "nine-patch source index is out of range")
        const ninePatch = this.draft.sourceNinePatches[index]
        ninePatch.name = normalizeName(formData.get("name"))
        ninePatch.displayName = String(formData.get("display-name") || "").trim()
        ninePatch.sliceLeft = Number(formData.get("slice-left"))
        ninePatch.sliceTop = Number(formData.get("slice-top"))
        ninePatch.sliceRight = Number(formData.get("slice-right"))
        ninePatch.sliceBottom = Number(formData.get("slice-bottom"))
        this.applySourceNinePatchToDraft(ninePatch)
    }

    captureDraft() {
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-nine-patch-edit form is not initialized")
        const formData = new FormData(this.formElement)
        this.draft.imagePath = String(formData.get("image-path") || "").trim()
        this.draft.name = normalizeName(formData.get("name"))
        this.draft.displayName = String(formData.get("display-name") || "").trim()
        this.draft.sliceLeft = Number(formData.get("slice-left"))
        this.draft.sliceTop = Number(formData.get("slice-top"))
        this.draft.sliceRight = Number(formData.get("slice-right"))
        this.draft.sliceBottom = Number(formData.get("slice-bottom"))
        if (this.draft.sourceNinePatches.length > 0) {
            this.captureDraftFieldsIntoSourceNinePatch(this.draft.selectedSourceIndex, formData)
        }
    }

    render() {
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-nine-patch-edit form is not initialized")
        const submitLabel = this.mode === "edit" ? "Save nine patch" : "Import nine patch"
        const sourceInfo = this.draft.sourceNinePatches.length > 0
            ? `${this.draft.sourceNinePatches.length} nine patches from Aseprite slices`
            : this.mode === "edit"
              ? "Loaded from database."
              : "Choose a QOI/PNG/etc file for manual entry, or an Aseprite file with slices."
        const sourceSelector = this.draft.sourceNinePatches.length > 1
            ? `
      <fieldset>
        <legend>Aseprite slice imports</legend>
        <label>Nine patch to inspect/edit
          <select name="source-nine-patch-index">
            ${this.draft.sourceNinePatches
                .map((ninePatch, index) => `<option value="${index}" ${index === this.draft.selectedSourceIndex ? "selected" : ""}>${escapeHtml(ninePatch.sliceName)} → ${escapeHtml(ninePatch.name)}</option>`)
                .join("")}
          </select>
        </label>
        <p>Changes below apply to the selected slice. Saving imports all ${this.draft.sourceNinePatches.length} nine patches.</p>
      </fieldset>
`
            : ""
        const sourceRect = this.draft.sourceNinePatches.length > 0
            ? `<p>Source slice: ${escapeHtml(this.draft.sourceSliceName)} · rect ${Number(this.draft.sourceX)}, ${Number(this.draft.sourceY)}, ${Number(this.draft.sourceWidth)}×${Number(this.draft.sourceHeight)}</p>`
            : ""
        this.formElement.innerHTML = `
      <fieldset>
        <legend>Source</legend>
        <label>Image path
          <input type="text" name="image-path" value="${escapeHtml(this.draft.imagePath)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <button type="submit" name="intent" value="choose-file">Choose file</button>
        <p>${escapeHtml(sourceInfo)}</p>
      </fieldset>

      ${sourceSelector}

      <fieldset>
        <legend>Nine patch record</legend>
        ${sourceRect}
        <label>Name
          <input type="text" name="name" value="${escapeHtml(this.draft.name)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <label>Display name
          <input type="text" name="display-name" value="${escapeHtml(this.draft.displayName)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
      </fieldset>

      <fieldset>
        <legend>Slice lines</legend>
        <label>Left
          <input type="number" name="slice-left" min="0" value="${Number(this.draft.sliceLeft)}">
        </label>
        <label>Top
          <input type="number" name="slice-top" min="0" value="${Number(this.draft.sliceTop)}">
        </label>
        <label>Right
          <input type="number" name="slice-right" min="1" value="${Number(this.draft.sliceRight)}">
        </label>
        <label>Bottom
          <input type="number" name="slice-bottom" min="1" value="${Number(this.draft.sliceBottom)}">
        </label>
      </fieldset>

      <footer>
        <output data-element="status"></output>
        <button type="submit" name="intent" value="cancel">Cancel</button>
        <button type="submit" name="intent" value="save" class="accent">${submitLabel}</button>
      </footer>
    `
        this.statusElement = this.formElement.querySelector('[data-element="status"]')
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog-nine-patch-edit missing status output")
    }

    async chooseFile() {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Choose Nine Patch Source",
                size: "large",
                tag: "view-files",
                props: {
                    mode: "chooser",
                    rootPath: dirname(this.draft.imagePath || "catalog/nine-patches"),
                    filter: "*.qoi,*.png,*.jpg,*.jpeg,*.webp,*.aseprite,*.ase",
                },
            }),
        )
        if (payload?.cancelled) return
        const selection = payload?.selection
        assert(selection && !Array.isArray(selection), "nine-patch import requires one selected file")
        const path = String(selection.path || "").trim()
        assert(path, "nine-patch selected file requires path")
        const lowerPath = path.toLowerCase()
        if (lowerPath.endsWith(".aseprite") || lowerPath.endsWith(".ase")) {
            await this.loadAsepriteDraft(path)
            return
        }
        const baseName = basenameWithoutExtension(path)
        this.draft.imagePath = path
        this.draft.sourceNinePatches = []
        this.draft.selectedSourceIndex = 0
        this.draft.sourceX = 0
        this.draft.sourceY = 0
        this.draft.sourceWidth = 0
        this.draft.sourceHeight = 0
        this.draft.sourceSliceName = ""
        if (!this.draft.name) this.draft.name = normalizeName(baseName)
        if (!this.draft.displayName) this.draft.displayName = baseName
    }

    async loadAsepriteDraft(path) {
        let documentResource = null
        try {
            documentResource = unwrap(await runtime.invoke("aseprite/aseprite::open", path), "aseprite open")
            const slices = unwrap(await runtime.invoke("aseprite/aseprite::slices", documentResource), "aseprite slices")
            const baseName = basenameWithoutExtension(path)
            this.draft.imagePath = path
            this.draft.sourceNinePatches = buildSourceNinePatches({ baseName, slices })
            this.draft.selectedSourceIndex = 0
            this.applySourceNinePatchToDraft(this.draft.sourceNinePatches[0])
        } finally {
            if (documentResource) await runtime.releaseResource(documentResource)
        }
    }

    async loadDraft(ninePatchId) {
        const rows = await sql.queryObjects(
            `SELECT id, name, COALESCE(display_name, '') AS display_name,
                    image_path, source_x, source_y, source_width, source_height, source_slice_name,
                    slice_left, slice_top, slice_right, slice_bottom
             FROM nine_patch
             WHERE id = ?`,
            ["id", "name", "display_name", "image_path", "source_x", "source_y", "source_width", "source_height", "source_slice_name", "slice_left", "slice_top", "slice_right", "slice_bottom"],
            [String(ninePatchId)],
        )
        assert(rows.length === 1, `expected one nine_patch for id ${ninePatchId}, got ${rows.length}`)
        const row = rows[0]
        this.draft.imagePath = String(row.image_path)
        this.draft.name = String(row.name)
        this.draft.displayName = String(row.display_name)
        this.draft.sourceX = Number(row.source_x)
        this.draft.sourceY = Number(row.source_y)
        this.draft.sourceWidth = Number(row.source_width)
        this.draft.sourceHeight = Number(row.source_height)
        this.draft.sourceSliceName = String(row.source_slice_name || "")
        this.draft.sourceNinePatches = [
            {
                sliceName: this.draft.sourceSliceName,
                name: this.draft.name,
                displayName: this.draft.displayName,
                sourceX: this.draft.sourceX,
                sourceY: this.draft.sourceY,
                sourceWidth: this.draft.sourceWidth,
                sourceHeight: this.draft.sourceHeight,
                sliceLeft: Number(row.slice_left),
                sliceTop: Number(row.slice_top),
                sliceRight: Number(row.slice_right),
                sliceBottom: Number(row.slice_bottom),
            },
        ]
        this.draft.selectedSourceIndex = 0
        this.draft.sliceLeft = Number(row.slice_left)
        this.draft.sliceTop = Number(row.slice_top)
        this.draft.sliceRight = Number(row.slice_right)
        this.draft.sliceBottom = Number(row.slice_bottom)
    }

    validateDraft() {
        assert(this.draft.imagePath, "Choose a nine-patch source file")
        assert(this.draft.name, "Nine-patch name is required")
        assertNonNegativeInteger(this.draft.sliceLeft, "slice left")
        assertNonNegativeInteger(this.draft.sliceTop, "slice top")
        assertNonNegativeInteger(this.draft.sliceRight, "slice right")
        assertNonNegativeInteger(this.draft.sliceBottom, "slice bottom")
        assert(this.draft.sliceRight > this.draft.sliceLeft, "slice right must be greater than slice left")
        assert(this.draft.sliceBottom > this.draft.sliceTop, "slice bottom must be greater than slice top")
        if (this.draft.sourceNinePatches.length > 0) {
            const names = new Set()
            for (const ninePatch of this.draft.sourceNinePatches) {
                assert(ninePatch.name, "Nine-patch name is required")
                assert(!names.has(ninePatch.name), `Duplicate nine-patch name: ${ninePatch.name}`)
                names.add(ninePatch.name)
                assertInteger(Number(ninePatch.sourceX), `nine-patch ${ninePatch.name} source x`)
                assertInteger(Number(ninePatch.sourceY), `nine-patch ${ninePatch.name} source y`)
                assertNonNegativeInteger(Number(ninePatch.sourceWidth), `nine-patch ${ninePatch.name} source width`)
                assertNonNegativeInteger(Number(ninePatch.sourceHeight), `nine-patch ${ninePatch.name} source height`)
                assertNonNegativeInteger(Number(ninePatch.sliceLeft), `nine-patch ${ninePatch.name} slice left`)
                assertNonNegativeInteger(Number(ninePatch.sliceTop), `nine-patch ${ninePatch.name} slice top`)
                assertNonNegativeInteger(Number(ninePatch.sliceRight), `nine-patch ${ninePatch.name} slice right`)
                assertNonNegativeInteger(Number(ninePatch.sliceBottom), `nine-patch ${ninePatch.name} slice bottom`)
                assert(Number(ninePatch.sliceRight) > Number(ninePatch.sliceLeft), `nine-patch ${ninePatch.name} slice right must be greater than slice left`)
                assert(Number(ninePatch.sliceBottom) > Number(ninePatch.sliceTop), `nine-patch ${ninePatch.name} slice bottom must be greater than slice top`)
            }
        }
    }

    manualNinePatch() {
        return {
            sliceName: this.draft.sourceSliceName || "",
            name: this.draft.name,
            displayName: this.draft.displayName,
            sourceX: this.draft.sourceX,
            sourceY: this.draft.sourceY,
            sourceWidth: this.draft.sourceWidth,
            sourceHeight: this.draft.sourceHeight,
            sliceLeft: this.draft.sliceLeft,
            sliceTop: this.draft.sliceTop,
            sliceRight: this.draft.sliceRight,
            sliceBottom: this.draft.sliceBottom,
        }
    }

    async saveNinePatchRow(ninePatch, id = null) {
        const params = [
            ninePatch.name,
            ninePatch.displayName,
            this.draft.imagePath,
            String(ninePatch.sourceX),
            String(ninePatch.sourceY),
            String(ninePatch.sourceWidth),
            String(ninePatch.sourceHeight),
            String(ninePatch.sliceName || ""),
            String(ninePatch.sliceLeft),
            String(ninePatch.sliceTop),
            String(ninePatch.sliceRight),
            String(ninePatch.sliceBottom),
        ]
        if (id !== null) {
            await sql.exec(
                `UPDATE nine_patch
                 SET name = ?, display_name = ?, image_path = ?,
                     source_x = ?, source_y = ?, source_width = ?, source_height = ?, source_slice_name = ?,
                     slice_left = ?, slice_top = ?, slice_right = ?, slice_bottom = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [...params, String(id)],
            )
            return
        }
        await sql.exec(
            `INSERT INTO nine_patch (name, display_name, image_path, source_x, source_y, source_width, source_height, source_slice_name, slice_left, slice_top, slice_right, slice_bottom)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params,
        )
    }

    async saveNinePatch() {
        this.validateDraft()
        if (this.mode === "edit") {
            assert(this.draft.sourceNinePatches.length <= 1, "nine-patch edit requires at most one source nine-patch")
            await this.saveNinePatchRow(this.draft.sourceNinePatches[0] || this.manualNinePatch(), this.ninePatchId)
            return
        }
        const ninePatches = this.draft.sourceNinePatches.length > 0 ? this.draft.sourceNinePatches : [this.manualNinePatch()]
        await sql.exec("BEGIN TRANSACTION", [])
        try {
            for (const ninePatch of ninePatches) await this.saveNinePatchRow(ninePatch)
            await sql.exec("COMMIT", [])
        } catch (error) {
            await sql.exec("ROLLBACK", [])
            throw error
        }
    }

    handleChange(event) {
        const target = event.target
        if (!(target instanceof HTMLSelectElement)) return
        if (target.name !== "source-nine-patch-index") return
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-nine-patch-edit form is not initialized")
        const formData = new FormData(this.formElement)
        this.draft.imagePath = String(formData.get("image-path") || "").trim()
        this.captureDraftFieldsIntoSourceNinePatch(this.draft.selectedSourceIndex, formData)
        const nextIndex = Number(target.value)
        assertNonNegativeInteger(nextIndex, "selected nine-patch source index")
        assert(nextIndex < this.draft.sourceNinePatches.length, "selected nine-patch source index is out of range")
        this.draft.selectedSourceIndex = nextIndex
        this.applySourceNinePatchToDraft(this.selectedSourceNinePatch())
        this.render()
        this.setStatus(`Editing ${this.draft.sourceSliceName}. Save imports all ${this.draft.sourceNinePatches.length} nine patches.`, "info")
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
            this.setStatus("Loaded nine-patch source.", "success")
            return
        }

        assert(intent === "save", `unknown nine-patch intent ${intent}`)
        try {
            await this.saveNinePatch()
            await runtime.call("ui.popup.close", { ok: true, cancelled: false, mode: this.mode, ninePatchName: this.draft.name })
        } catch (error) {
            this.setStatus(String(error?.message || error), "danger")
        }
    }
}

if (!customElements.get("view-catalog-nine-patch-edit")) {
    customElements.define("view-catalog-nine-patch-edit", ViewCatalogNinePatchEdit)
}
