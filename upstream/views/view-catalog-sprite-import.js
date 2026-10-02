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

function assertPositiveInteger(value, name) {
    assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer`)
}

function assertInteger(value, name) {
    assert(Number.isInteger(value), `${name} must be an integer`)
}

function assertNonNegativeInteger(value, name) {
    assert(Number.isInteger(value) && value >= 0, `${name} must be a non-negative integer`)
}

const ANIMATION_DIRECTIONS = ["forward", "reverse", "ping-pong", "ping-pong-reverse"]

function assertAnimationDirection(value, name) {
    assert(ANIMATION_DIRECTIONS.includes(value), `${name} must be one of: ${ANIMATION_DIRECTIONS.join(", ")}`)
}

function normalizePivot(value, name) {
    if (value === null) return null
    assert(value && typeof value === "object", `${name} must be a point option`)
    const pivot = "is_some" in value ? (value.is_some ? value.val : null) : "isSome" in value ? (value.isSome ? value.val : null) : value
    if (pivot === null) return null
    const x = Number(pivot.x)
    const y = Number(pivot.y)
    assertInteger(x, `${name} x`)
    assertInteger(y, `${name} y`)
    return { x, y }
}

function frameSourceForFrame(frameSources, frame) {
    const frameSource = frameSources.find((item) => Number(item.frame) === frame)
    assert(frameSource, `missing sprite frame source for frame ${frame}`)
    return frameSource
}

function buildConstantFrameSources(frameCount, sourceX, sourceY, sourceWidth, sourceHeight, sliceName, pivotX, pivotY) {
    assertPositiveInteger(frameCount, "sprite frame count")
    assertInteger(sourceX, "sprite frame source x")
    assertInteger(sourceY, "sprite frame source y")
    assertPositiveInteger(sourceWidth, "sprite frame source width")
    assertPositiveInteger(sourceHeight, "sprite frame source height")
    assertInteger(pivotX, "sprite pivot x")
    assertInteger(pivotY, "sprite pivot y")
    return Array.from({ length: frameCount }, (_, frame) => ({ frame, sourceX, sourceY, sourceWidth, sourceHeight, sliceName, x: pivotX, y: pivotY }))
}

function normalizeSliceKey(slice, key) {
    const sliceName = String(slice.name || "").trim()
    const frame = Number(key.frame)
    const sourceX = Number(key.x)
    const sourceY = Number(key.y)
    const sourceWidth = Number(key.width)
    const sourceHeight = Number(key.height)
    assertNonNegativeInteger(frame, `Aseprite slice ${sliceName} key frame`)
    assertInteger(sourceX, `Aseprite slice ${sliceName} source x`)
    assertInteger(sourceY, `Aseprite slice ${sliceName} source y`)
    assertPositiveInteger(sourceWidth, `Aseprite slice ${sliceName} source width`)
    assertPositiveInteger(sourceHeight, `Aseprite slice ${sliceName} source height`)
    const pivot = normalizePivot(key.pivot, `Aseprite slice ${sliceName} pivot`)
    const pivotX = pivot ? pivot.x : Math.floor(sourceWidth / 2)
    const pivotY = pivot ? pivot.y : Math.floor(sourceHeight / 2)
    assertInteger(pivotX, `Aseprite slice ${sliceName} relative pivot x`)
    assertInteger(pivotY, `Aseprite slice ${sliceName} relative pivot y`)
    return { frame, sourceX, sourceY, sourceWidth, sourceHeight, sliceName, x: pivotX, y: pivotY }
}

function buildFrameSourcesFromSlice(slice, frameCount) {
    assert(slice && typeof slice === "object", "Aseprite slice must be an object")
    assert(Array.isArray(slice.keys), `Aseprite slice ${String(slice.name || "")} keys must be an array`)
    assertPositiveInteger(frameCount, "sprite frame count")
    const keyedSources = slice.keys.map((key) => normalizeSliceKey(slice, key))
    assert(keyedSources.length > 0, `Aseprite slice ${String(slice.name || "")} requires at least one key`)
    for (const source of keyedSources) assert(source.frame < frameCount, `Aseprite slice ${String(slice.name || "")} key frame is outside source frame count`)
    keyedSources.sort((left, right) => left.frame - right.frame)

    const uniqueSources = []
    for (const source of keyedSources) {
        const previous = uniqueSources[uniqueSources.length - 1]
        if (previous && previous.frame === source.frame) {
            assert(
                previous.sourceX === source.sourceX &&
                    previous.sourceY === source.sourceY &&
                    previous.sourceWidth === source.sourceWidth &&
                    previous.sourceHeight === source.sourceHeight &&
                    previous.x === source.x &&
                    previous.y === source.y,
                `multiple Aseprite slice keys disagree for frame ${source.frame}`,
            )
            continue
        }
        uniqueSources.push(source)
    }

    const frameSources = []
    let sourceIndex = 0
    for (let frame = 0; frame < frameCount; frame += 1) {
        while (sourceIndex + 1 < uniqueSources.length && uniqueSources[sourceIndex + 1].frame <= frame) sourceIndex += 1
        const source = frame < uniqueSources[0].frame ? uniqueSources[0] : uniqueSources[sourceIndex]
        frameSources.push({ ...source, frame })
    }
    return frameSources
}

function firstSliceKey(slice) {
    assert(slice && typeof slice === "object", "Aseprite slice must be an object")
    assert(Array.isArray(slice.keys), `Aseprite slice ${String(slice.name || "")} keys must be an array`)
    assert(slice.keys.length > 0, `Aseprite slice ${String(slice.name || "")} requires at least one key`)
    const sortedKeys = [...slice.keys].sort((left, right) => Number(left.frame) - Number(right.frame))
    return sortedKeys[0]
}

function buildSourceSprites({ baseName, width, height, frameCount, slices }) {
    assert(Array.isArray(slices), "Aseprite slices must be an array")
    assertPositiveInteger(width, "sprite source width")
    assertPositiveInteger(height, "sprite source height")
    assertPositiveInteger(frameCount, "sprite source frame count")
    if (slices.length === 0) {
        const pivotX = Math.floor(width / 2)
        const pivotY = Math.floor(height / 2)
        return [
            {
                sliceName: "",
                name: normalizeName(baseName),
                displayName: baseName,
                sourceX: 0,
                sourceY: 0,
                sourceWidth: width,
                sourceHeight: height,
                frameSources: buildConstantFrameSources(frameCount, 0, 0, width, height, "", pivotX, pivotY),
            },
        ]
    }

    const multiple = slices.length > 1
    const sourceSprites = slices.map((slice) => {
        const sliceName = String(slice.name || "").trim()
        assert(sliceName, "Aseprite slice requires name")
        const key = firstSliceKey(slice)
        const firstSource = normalizeSliceKey(slice, key)
        return {
            sliceName,
            name: multiple ? normalizeName(`${baseName}_${sliceName}`) : normalizeName(baseName),
            displayName: multiple ? `${baseName} ${sliceName}` : baseName,
            sourceX: firstSource.sourceX,
            sourceY: firstSource.sourceY,
            sourceWidth: firstSource.sourceWidth,
            sourceHeight: firstSource.sourceHeight,
            frameSources: buildFrameSourcesFromSlice(slice, frameCount),
        }
    })
    const names = new Set()
    for (const sourceSprite of sourceSprites) {
        assert(sourceSprite.name, `Aseprite slice ${sourceSprite.sliceName} produced empty sprite name`)
        assert(!names.has(sourceSprite.name), `duplicate sprite name from Aseprite slices: ${sourceSprite.name}`)
        names.add(sourceSprite.name)
    }
    return sourceSprites
}

export class ViewCatalogSpriteImport extends HTMLElement {
    constructor() {
        super()
        this.popupProps = this.popupProps || {}
        this.mode = "import"
        this.spriteId = 0
        this.formElement = null
        this.statusElement = null
        this.draft = {
            imagePath: "",
            name: "",
            displayName: "",
            gridWidth: 1,
            gridHeight: 1,
            width: 0,
            height: 0,
            frameCount: 0,
            sourceSprites: [],
            selectedSourceIndex: 0,
            frameSources: [],
            animations: [],
        }
    }

    connectedCallback() {
        registerViewPlugin(this)
        if (this.dataset.ready) return
        this.dataset.ready = "1"
        this.popupProps = this.popupProps || {}
        this.mode = String(this.popupProps.mode || "import")
        assert(this.mode === "import" || this.mode === "edit", `unknown sprite import mode ${this.mode}`)
        this.spriteId = Number(this.popupProps.spriteId || 0)
        if (this.mode === "edit") assert(Number.isInteger(this.spriteId) && this.spriteId > 0, "sprite edit requires spriteId")
        this.style.display = "contents"
        this.innerHTML = '<form data-element="form" novalidate></form>'
        this.formElement = this.querySelector('[data-element="form"]')
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-sprite-import missing form")
        this.formElement.addEventListener("submit", async (event) => this.handleSubmit(event))
        this.formElement.addEventListener("change", (event) => this.handleChange(event))
        void this.initialize()
    }

    async initialize() {
        if (this.mode === "edit") await this.loadSpriteDraft(this.spriteId)
        this.render()
    }

    disconnectedCallback() {
        void unregisterViewPlugin(this)
    }

    setStatus(text, tone = null) {
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog-sprite-import status output is not initialized")
        this.statusElement.textContent = text
        this.statusElement.classList.remove("accent", "success", "warning", "danger", "info")
        if (tone) this.statusElement.classList.add(tone)
    }

    selectedSourceSprite() {
        assert(this.draft.sourceSprites.length > 0, "sprite source selection requires imported source sprites")
        assertNonNegativeInteger(this.draft.selectedSourceIndex, "selected sprite source index")
        assert(this.draft.selectedSourceIndex < this.draft.sourceSprites.length, "selected sprite source index is out of range")
        return this.draft.sourceSprites[this.draft.selectedSourceIndex]
    }

    applySourceSpriteToDraft(sourceSprite) {
        this.draft.name = sourceSprite.name
        this.draft.displayName = sourceSprite.displayName
        this.draft.frameSources = sourceSprite.frameSources
    }

    captureDraftFieldsIntoSourceSprite(index, formData) {
        assertNonNegativeInteger(index, "sprite source index")
        assert(index < this.draft.sourceSprites.length, "sprite source index is out of range")
        const sourceSprite = this.draft.sourceSprites[index]
        sourceSprite.name = normalizeName(formData.get("name"))
        sourceSprite.displayName = String(formData.get("display-name") || "").trim()
        this.applySourceSpriteToDraft(sourceSprite)
    }

    captureDraft() {
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-sprite-import form is not initialized")
        const formData = new FormData(this.formElement)
        this.draft.imagePath = String(formData.get("image-path") || "").trim()
        this.draft.name = normalizeName(formData.get("name"))
        this.draft.displayName = String(formData.get("display-name") || "").trim()
        this.draft.gridWidth = Number(formData.get("grid-width"))
        this.draft.gridHeight = Number(formData.get("grid-height"))
        if (this.draft.sourceSprites.length > 0) {
            this.captureDraftFieldsIntoSourceSprite(this.draft.selectedSourceIndex, formData)
        }

        this.draft.animations = this.draft.animations.map((animation, index) => ({
            name: String(formData.get(`animation-name-${index}`) || "").trim(),
            startFrame: Number(formData.get(`animation-start-${index}`)),
            endFrame: Number(formData.get(`animation-end-${index}`)),
            direction: String(formData.get(`animation-direction-${index}`) || "").trim(),
        }))
    }

    render() {
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-sprite-import form is not initialized")
        const isEdit = this.mode === "edit"
        const submitLabel = isEdit ? "Save sprite" : "Import sprite"
        const sourceInfo = this.draft.frameCount > 0 ? `${Number(this.draft.width)}×${Number(this.draft.height)} · ${Number(this.draft.frameCount)} frames · ${Number(this.draft.sourceSprites.length)} sprites` : isEdit ? "Loaded from database." : "Choose an Aseprite file."
        const sourceSelector = this.draft.sourceSprites.length > 1
            ? `
      <fieldset>
        <legend>Aseprite slice imports</legend>
        <label>Sprite to inspect/edit
          <select name="source-sprite-index">
            ${this.draft.sourceSprites
                .map((sourceSprite, index) => `<option value="${index}" ${index === this.draft.selectedSourceIndex ? "selected" : ""}>${escapeHtml(sourceSprite.sliceName)} → ${escapeHtml(sourceSprite.name)}</option>`)
                .join("")}
          </select>
        </label>
        <p>Changes below apply to the selected slice. Saving imports all ${this.draft.sourceSprites.length} sprites.</p>
      </fieldset>
`
            : ""
        const selectedSourceSprite = this.draft.sourceSprites.length > 0 ? this.selectedSourceSprite() : null
        const sourceRect = selectedSourceSprite
            ? `<p>Source slice: ${escapeHtml(selectedSourceSprite.sliceName)} · first frame rect ${Number(selectedSourceSprite.sourceX)}, ${Number(selectedSourceSprite.sourceY)}, ${Number(selectedSourceSprite.sourceWidth)}×${Number(selectedSourceSprite.sourceHeight)}</p>`
            : ""
        const animationsRows = this.draft.animations
            .map((animation, index) => {
                assertAnimationDirection(animation.direction, `animation ${animation.name || index} direction`)
                const directionOptions = ANIMATION_DIRECTIONS.map(
                    (direction) => `<option value="${escapeHtml(direction)}" ${animation.direction === direction ? "selected" : ""}>${escapeHtml(direction)}</option>`,
                ).join("")
                return `
              <tr>
                <td><input type="text" name="animation-name-${index}" value="${escapeHtml(animation.name)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></td>
                <td><input type="number" name="animation-start-${index}" min="0" value="${Number(animation.startFrame)}"></td>
                <td><input type="number" name="animation-end-${index}" min="0" value="${Number(animation.endFrame)}"></td>
                <td><select name="animation-direction-${index}">${directionOptions}</select></td>
              </tr>
            `
            })
            .join("")

        this.formElement.innerHTML = `
      <fieldset>
        <legend>Source</legend>
        <label>Image path
          <input type="text" name="image-path" value="${escapeHtml(this.draft.imagePath)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <button type="submit" name="intent" value="choose-file">Choose file</button>
        <output data-element="source-info">${sourceInfo}</output>
      </fieldset>

      ${sourceSelector}

      <fieldset>
        <legend>Sprite record</legend>
        ${sourceRect}
        <label>Name
          <input type="text" name="name" value="${escapeHtml(this.draft.name)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <label>Display name
          <input type="text" name="display-name" value="${escapeHtml(this.draft.displayName)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </label>
        <label>Grid width
          <input type="number" name="grid-width" min="1" value="${Number(this.draft.gridWidth)}">
        </label>
        <label>Grid height
          <input type="number" name="grid-height" min="1" value="${Number(this.draft.gridHeight)}">
        </label>
      </fieldset>

      <fieldset>
        <legend>Animations</legend>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Start frame</th>
              <th>End frame</th>
              <th>Direction</th>
            </tr>
          </thead>
          <tbody>${animationsRows}</tbody>
        </table>
      </fieldset>

      <footer>
        <output data-element="status"></output>
        <button type="submit" name="intent" value="cancel">Cancel</button>
        <button type="submit" name="intent" value="save" class="accent">${submitLabel}</button>
      </footer>
    `
        this.statusElement = this.formElement.querySelector('[data-element="status"]')
        assert(this.statusElement instanceof HTMLOutputElement, "view-catalog-sprite-import missing status output")
    }

    async chooseFile() {
        const payload = unwrap(
            await runtime.call("ui.popup.open", {
                title: "Choose Sprite Source",
                size: "large",
                tag: "view-files",
                props: {
                    mode: "chooser",
                    rootPath: dirname(this.draft.imagePath || "catalog/sprites"),
                    filter: "*.aseprite,*.ase",
                },
            }),
        )
        if (payload?.cancelled) return
        const selection = payload?.selection
        assert(selection && !Array.isArray(selection), "sprite import requires one selected file")
        const path = String(selection.path || "").trim()
        assert(path, "sprite import selected file requires path")
        await this.loadAsepriteDraft(path)
    }

    async loadAsepriteDraft(path) {
        let documentResource = null
        try {
            documentResource = unwrap(await runtime.invoke("aseprite/aseprite::open", path), "aseprite open")
            const info = unwrap(await runtime.invoke("aseprite/aseprite::info", documentResource), "aseprite info")
            const frames = unwrap(await runtime.invoke("aseprite/aseprite::frames", documentResource), "aseprite frames")
            const tags = unwrap(await runtime.invoke("aseprite/aseprite::tags", documentResource), "aseprite tags")
            const slices = unwrap(await runtime.invoke("aseprite/aseprite::slices", documentResource), "aseprite slices")
            const baseName = basenameWithoutExtension(path)
            this.draft.imagePath = path
            this.draft.name = normalizeName(baseName)
            this.draft.displayName = baseName
            this.draft.width = Number(info.width)
            this.draft.height = Number(info.height)
            this.draft.frameCount = frames.length
            this.draft.sourceSprites = buildSourceSprites({ baseName, width: this.draft.width, height: this.draft.height, frameCount: this.draft.frameCount, slices })
            this.draft.selectedSourceIndex = 0
            this.applySourceSpriteToDraft(this.draft.sourceSprites[0])
            this.draft.animations = tags.map((tag) => ({
                name: String(tag.name || "").trim(),
                startFrame: Number(tag["from-frame"] ?? tag.from),
                endFrame: Number(tag["to-frame"] ?? tag.to),
                direction: String(tag.direction || "").trim(),
            }))
            assertPositiveInteger(this.draft.width, "sprite source width")
            assertPositiveInteger(this.draft.height, "sprite source height")
            assertPositiveInteger(this.draft.frameCount, "sprite source frame count")
            for (const animation of this.draft.animations) {
                assert(animation.name, "sprite animation requires name")
                assertNonNegativeInteger(animation.startFrame, `sprite animation ${animation.name} start frame`)
                assertNonNegativeInteger(animation.endFrame, `sprite animation ${animation.name} end frame`)
                assert(animation.endFrame >= animation.startFrame, `sprite animation ${animation.name} end frame must be >= start frame`)
                assertAnimationDirection(animation.direction, `sprite animation ${animation.name} direction`)
            }
        } finally {
            if (documentResource) await runtime.releaseResource(documentResource)
        }
    }

    async loadSpriteDraft(spriteId) {
        const sprites = await sql.queryObjects(
            `SELECT
               id,
               name,
               COALESCE(display_name, '') AS display_name,
               image_path,
               source_x,
               source_y,
               source_width,
               source_height,
               source_slice_name,
               grid_width,
               grid_height
             FROM sprite
             WHERE id = ?`,
            ["id", "name", "display_name", "image_path", "source_x", "source_y", "source_width", "source_height", "source_slice_name", "grid_width", "grid_height"],
            [String(spriteId)],
        )
        assert(sprites.length === 1, `expected one sprite for id ${spriteId}, got ${sprites.length}`)
        const sprite = sprites[0]
        const animations = await sql.queryObjects(
            `SELECT id, name, start_frame, end_frame, direction
             FROM sprite_animation
             WHERE sprite_id = ?
             ORDER BY start_frame, id`,
            ["id", "name", "start_frame", "end_frame", "direction"],
            [String(spriteId)],
        )
        this.draft.imagePath = String(sprite.image_path)
        this.draft.name = String(sprite.name)
        this.draft.displayName = String(sprite.display_name)
        this.draft.gridWidth = Number(sprite.grid_width)
        this.draft.gridHeight = Number(sprite.grid_height)
        this.draft.width = 0
        this.draft.height = 0
        this.draft.frameCount = 0
        this.draft.frameSources = await this.loadFrameSources(animations.map((animation) => Number(animation.id)))
        this.draft.sourceSprites = [
            {
                sliceName: String(sprite.source_slice_name || ""),
                name: this.draft.name,
                displayName: this.draft.displayName,
                sourceX: Number(sprite.source_x),
                sourceY: Number(sprite.source_y),
                sourceWidth: Number(sprite.source_width),
                sourceHeight: Number(sprite.source_height),
                frameSources: this.draft.frameSources,
            },
        ]
        this.draft.selectedSourceIndex = 0
        this.draft.animations = animations.map((animation) => ({
            name: String(animation.name),
            startFrame: Number(animation.start_frame),
            endFrame: Number(animation.end_frame),
            direction: String(animation.direction),
        }))
    }

    async loadFrameSources(animationIds) {
        if (animationIds.length === 0) return []
        const placeholders = animationIds.map(() => "?").join(", ")
        const rows = await sql.queryObjects(
            `SELECT f.frame_index, f.pivot_x, f.pivot_y, f.source_x, f.source_y, f.source_width, f.source_height, f.source_slice_name
             FROM sprite_animation_frame f
             JOIN sprite_animation a ON a.id = f.sprite_animation_id
             WHERE f.sprite_animation_id IN (${placeholders})
             ORDER BY f.frame_index`,
            ["frame_index", "pivot_x", "pivot_y", "source_x", "source_y", "source_width", "source_height", "source_slice_name"],
            animationIds.map((id) => String(id)),
        )
        const frameSources = []
        for (const row of rows) {
            const frame = Number(row.frame_index)
            const x = Number(row.pivot_x)
            const y = Number(row.pivot_y)
            const sourceX = Number(row.source_x)
            const sourceY = Number(row.source_y)
            const sourceWidth = Number(row.source_width)
            const sourceHeight = Number(row.source_height)
            const sliceName = String(row.source_slice_name || "")
            assertNonNegativeInteger(frame, "sprite animation frame source frame")
            assertInteger(x, `sprite animation frame ${frame} pivot x`)
            assertInteger(y, `sprite animation frame ${frame} pivot y`)
            assertInteger(sourceX, `sprite animation frame ${frame} source x`)
            assertInteger(sourceY, `sprite animation frame ${frame} source y`)
            assertPositiveInteger(sourceWidth, `sprite animation frame ${frame} source width`)
            assertPositiveInteger(sourceHeight, `sprite animation frame ${frame} source height`)
            const previous = frameSources[frameSources.length - 1]
            if (previous && previous.frame === frame) {
                assert(
                    previous.x === x &&
                        previous.y === y &&
                        previous.sourceX === sourceX &&
                        previous.sourceY === sourceY &&
                        previous.sourceWidth === sourceWidth &&
                        previous.sourceHeight === sourceHeight &&
                        previous.sliceName === sliceName,
                    `sprite animation frame sources disagree for frame ${frame}`,
                )
                continue
            }
            frameSources.push({ frame, x, y, sourceX, sourceY, sourceWidth, sourceHeight, sliceName })
        }
        return frameSources
    }

    validateDraft() {
        assert(this.draft.imagePath, "Choose a sprite source file")
        assert(this.draft.name, "Sprite name is required")
        assertPositiveInteger(this.draft.gridWidth, "grid width")
        assertPositiveInteger(this.draft.gridHeight, "grid height")
        assert(this.draft.animations.length > 0, "Sprite import requires at least one animation")
        assert(Array.isArray(this.draft.sourceSprites), "Sprite import source sprites must be an array")
        assert(this.draft.sourceSprites.length > 0, "Sprite import requires at least one source sprite")
        const spriteNames = new Set()
        for (const sourceSprite of this.draft.sourceSprites) {
            assert(sourceSprite.name, "Sprite name is required")
            assert(!spriteNames.has(sourceSprite.name), `Duplicate sprite name: ${sourceSprite.name}`)
            spriteNames.add(sourceSprite.name)
            assertInteger(Number(sourceSprite.sourceX), `sprite ${sourceSprite.name} source x`)
            assertInteger(Number(sourceSprite.sourceY), `sprite ${sourceSprite.name} source y`)
            assertPositiveInteger(Number(sourceSprite.sourceWidth), `sprite ${sourceSprite.name} source width`)
            assertPositiveInteger(Number(sourceSprite.sourceHeight), `sprite ${sourceSprite.name} source height`)
            assert(Array.isArray(sourceSprite.frameSources), `sprite ${sourceSprite.name} frame sources must be an array`)
            assert(sourceSprite.frameSources.length > 0, `sprite ${sourceSprite.name} requires frame sources`)
            for (const frameSource of sourceSprite.frameSources) {
                assertNonNegativeInteger(Number(frameSource.frame), `sprite ${sourceSprite.name} frame source frame`)
                assertInteger(Number(frameSource.x), `sprite ${sourceSprite.name} frame ${frameSource.frame} pivot x`)
                assertInteger(Number(frameSource.y), `sprite ${sourceSprite.name} frame ${frameSource.frame} pivot y`)
                assertInteger(Number(frameSource.sourceX), `sprite ${sourceSprite.name} frame ${frameSource.frame} source x`)
                assertInteger(Number(frameSource.sourceY), `sprite ${sourceSprite.name} frame ${frameSource.frame} source y`)
                assertPositiveInteger(Number(frameSource.sourceWidth), `sprite ${sourceSprite.name} frame ${frameSource.frame} source width`)
                assertPositiveInteger(Number(frameSource.sourceHeight), `sprite ${sourceSprite.name} frame ${frameSource.frame} source height`)
            }
        }
        const names = new Set()
        for (const animation of this.draft.animations) {
            assert(animation.name, "Animation name is required")
            assert(!names.has(animation.name), `Duplicate animation name: ${animation.name}`)
            names.add(animation.name)
            assertNonNegativeInteger(animation.startFrame, `animation ${animation.name} start frame`)
            assertNonNegativeInteger(animation.endFrame, `animation ${animation.name} end frame`)
            assert(animation.endFrame >= animation.startFrame, `animation ${animation.name} end frame must be >= start frame`)
            assertAnimationDirection(animation.direction, `animation ${animation.name} direction`)
        }
    }

    async saveSpriteAnimations(spriteId, sourceSprite) {
        for (const animation of this.draft.animations) {
            await sql.exec(
                `INSERT INTO sprite_animation (sprite_id, name, start_frame, end_frame, direction)
                 VALUES (?, ?, ?, ?, ?)`,
                [String(spriteId), animation.name, String(animation.startFrame), String(animation.endFrame), animation.direction],
            )
            const animationId = await sql.value("SELECT last_insert_rowid()", [])
            for (let frame = animation.startFrame; frame <= animation.endFrame; frame += 1) {
                const frameSource = frameSourceForFrame(sourceSprite.frameSources, frame)
                await sql.exec(
                    `INSERT INTO sprite_animation_frame (sprite_animation_id, frame_index, pivot_x, pivot_y, source_x, source_y, source_width, source_height, source_slice_name)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        String(animationId),
                        String(frame),
                        String(frameSource.x),
                        String(frameSource.y),
                        String(frameSource.sourceX),
                        String(frameSource.sourceY),
                        String(frameSource.sourceWidth),
                        String(frameSource.sourceHeight),
                        String(frameSource.sliceName || ""),
                    ],
                )
            }
        }
    }

    async saveSprite() {
        this.validateDraft()
        await sql.exec("BEGIN TRANSACTION", [])
        try {
            let firstSpriteId = this.spriteId
            if (this.mode === "edit") {
                assert(this.draft.sourceSprites.length === 1, "sprite edit requires exactly one source sprite")
                const sourceSprite = this.draft.sourceSprites[0]
                assert(Number.isInteger(firstSpriteId) && firstSpriteId > 0, "sprite edit requires spriteId")
                await sql.exec(
                    `UPDATE sprite
                     SET name = ?, display_name = ?, image_path = ?, source_x = ?, source_y = ?, source_width = ?, source_height = ?, source_slice_name = ?, grid_width = ?, grid_height = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [
                        sourceSprite.name,
                        sourceSprite.displayName,
                        this.draft.imagePath,
                        String(sourceSprite.sourceX),
                        String(sourceSprite.sourceY),
                        String(sourceSprite.sourceWidth),
                        String(sourceSprite.sourceHeight),
                        String(sourceSprite.sliceName || ""),
                        String(this.draft.gridWidth),
                        String(this.draft.gridHeight),
                        String(firstSpriteId),
                    ],
                )
                await sql.exec("DELETE FROM sprite_animation WHERE sprite_id = ?", [String(firstSpriteId)])
                await this.saveSpriteAnimations(firstSpriteId, sourceSprite)
            } else {
                firstSpriteId = 0
                for (const sourceSprite of this.draft.sourceSprites) {
                    await sql.exec(
                        `INSERT INTO sprite (name, display_name, image_path, source_x, source_y, source_width, source_height, source_slice_name, grid_width, grid_height)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            sourceSprite.name,
                            sourceSprite.displayName,
                            this.draft.imagePath,
                            String(sourceSprite.sourceX),
                            String(sourceSprite.sourceY),
                            String(sourceSprite.sourceWidth),
                            String(sourceSprite.sourceHeight),
                            String(sourceSprite.sliceName || ""),
                            String(this.draft.gridWidth),
                            String(this.draft.gridHeight),
                        ],
                    )
                    const spriteId = await sql.value("SELECT last_insert_rowid()", [])
                    if (!firstSpriteId) firstSpriteId = Number(spriteId)
                    await this.saveSpriteAnimations(spriteId, sourceSprite)
                }
            }
            this.spriteId = Number(firstSpriteId)
            await sql.exec("COMMIT", [])
        } catch (error) {
            await sql.exec("ROLLBACK", [])
            throw error
        }
    }

    handleChange(event) {
        const target = event.target
        if (!(target instanceof HTMLSelectElement)) return
        if (target.name !== "source-sprite-index") return
        assert(this.formElement instanceof HTMLFormElement, "view-catalog-sprite-import form is not initialized")
        this.captureDraft()
        const nextIndex = Number(target.value)
        assertNonNegativeInteger(nextIndex, "selected sprite source index")
        assert(nextIndex < this.draft.sourceSprites.length, "selected sprite source index is out of range")
        this.draft.selectedSourceIndex = nextIndex
        this.applySourceSpriteToDraft(this.selectedSourceSprite())
        this.render()
        this.setStatus(`Editing ${this.draft.sourceSprites[this.draft.selectedSourceIndex].sliceName}. Save imports all ${this.draft.sourceSprites.length} sprites.`, "info")
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
            this.setStatus("Loaded sprite source.", "success")
            return
        }

        assert(intent === "save", `unknown sprite import intent ${intent}`)
        try {
            await this.saveSprite()
            await runtime.call("ui.popup.close", { ok: true, cancelled: false, mode: this.mode, spriteId: this.spriteId, spriteName: this.draft.name })
        } catch (error) {
            this.setStatus(String(error?.message || error), "danger")
        }
    }
}

if (!customElements.get("view-catalog-sprite-import")) {
    customElements.define("view-catalog-sprite-import", ViewCatalogSpriteImport)
}
