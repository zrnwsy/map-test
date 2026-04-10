<script setup lang="ts">
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useEventListener } from '@vueuse/core'

const BASE_MODEL_SCALE = 10

const GLTF_PRESETS = [
  {
    id: 'duck',
    label: 'Khronos Duck',
    uri: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Duck/glTF-Binary/Duck.glb',
  },
  {
    id: 'box',
    label: 'Khronos Box',
    uri: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Box/glTF-Binary/Box.glb',
  },
  {
    id: 'boombox',
    label: 'Khronos BoomBox',
    uri: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/BoomBox/glTF-Binary/BoomBox.glb',
  },
] as const

type ModelId = string

interface ModelRuntime {
  uri: string
  position: [number, number]
  translation: [number, number, number]
  rotation: [number, number, number]
  scale: number
  initial: {
    position: [number, number]
    translation: [number, number, number]
    rotation: [number, number, number]
    scale: number
  }
}

const ionToken = import.meta.env.VITE_CESIUM_ION_ACCESS_TOKEN as string | undefined
const imageryUrlTemplate = (import.meta.env.VITE_CESIUM_IMAGERY_URL as string | undefined)?.trim()
const viewer = shallowRef<Cesium.Viewer | null>(null)
const containerRef = ref<HTMLElement | null>(null)

const models = reactive<Record<ModelId, ModelRuntime>>({})
const modelOrder = ref<ModelId[]>([])
const selectedId = ref<ModelId | null>(null)
const presetUri = ref<string>(GLTF_PRESETS[0].uri)

const drag = reactive({
  active: false,
  lastX: 0,
  lastY: 0,
  mode: null as 'moveH' | 'moveV' | 'rotateH' | 'scale' | null,
})

const STEP = { moveH: 0.35, moveV: 0.25, rotate: 2.5, scale: 0.04 }

function isCtrlLike(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey
}

type EditOverlayMode = 'moveH' | 'moveV' | 'rotateH' | 'scale'

const operationHint = reactive({
  visible: false,
  title: '',
  lines: [] as string[],
  x: 0,
  y: 0,
})

let operationHintHideTimer: ReturnType<typeof setTimeout> | null = null
let postRenderRemove: (() => void) | null = null
let eventHandler: Cesium.ScreenSpaceEventHandler | null = null
let detachWindowDrag: (() => void) | null = null

const scratchCart2 = new Cesium.Cartesian2()

function cancelOperationHintHide() {
  if (operationHintHideTimer != null) {
    clearTimeout(operationHintHideTimer)
    operationHintHideTimer = null
  }
}

function scheduleOperationHintHide(ms: number) {
  cancelOperationHintHide()
  operationHintHideTimer = setTimeout(() => {
    operationHint.visible = false
    operationHintHideTimer = null
  }, ms)
}

function effectiveCartographic(o: ModelRuntime): Cesium.Cartographic {
  const [lng0, lat0] = o.position
  const metersPerDegLat = 111320
  const metersPerDegLng = metersPerDegLat * Math.cos(Cesium.Math.toRadians(lat0))
  return Cesium.Cartographic.fromDegrees(
    lng0 + o.translation[0] / metersPerDegLng,
    lat0 + o.translation[1] / metersPerDegLat,
    Math.max(0, o.translation[2]),
  )
}

function effectiveAnchorDegrees(o: ModelRuntime): { lng: number; lat: number } {
  const c = effectiveCartographic(o)
  return {
    lng: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
  }
}

function formatOperationHintLines(o: ModelRuntime, mode: EditOverlayMode): { title: string; lines: string[] } {
  const { lng, lat } = effectiveAnchorDegrees(o)
  const coord = `经纬度：${lng.toFixed(6)}°, ${lat.toFixed(6)}°`
  switch (mode) {
    case 'moveH':
      return {
        title: '水平平移',
        lines: [
          coord,
          `东西偏移：${o.translation[0].toFixed(2)} m`,
          `南北偏移：${o.translation[1].toFixed(2)} m`,
        ],
      }
    case 'moveV':
      return { title: '竖直位移', lines: [coord, `离地高度：${o.translation[2].toFixed(2)} m`] }
    case 'rotateH':
      return {
        title: '旋转',
        lines: [
          coord,
          `俯仰：${o.rotation[0].toFixed(1)}° · 航向：${o.rotation[1].toFixed(1)}° · 滚转：${o.rotation[2].toFixed(1)}°`,
        ],
      }
    case 'scale':
      return {
        title: '缩放',
        lines: [coord, `相对倍数：×${o.scale.toFixed(2)}（显示含 ×${BASE_MODEL_SCALE}）`],
      }
    default:
      return { title: '', lines: [] }
  }
}

function updateOperationHintAnchorPosition() {
  if (!operationHint.visible) return
  const v = viewer.value
  const sid = selectedId.value
  if (!v || !sid) return
  const o = models[sid]
  if (!o) return
  const cart = effectiveCartographic(o)
  const pos = Cesium.Cartesian3.fromRadians(cart.longitude, cart.latitude, cart.height)
  const out = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, pos, scratchCart2)
  if (!out) return
  const el = v.container
  const w = el.clientWidth
  const h = el.clientHeight
  operationHint.x = Math.min(w - 4, Math.max(4, out.x))
  operationHint.y = Math.min(h - 4, Math.max(4, out.y))
}

function showOperationHintForModel(o: ModelRuntime, mode: EditOverlayMode) {
  const { title, lines } = formatOperationHintLines(o, mode)
  operationHint.title = title
  operationHint.lines = lines
  operationHint.visible = true
  updateOperationHintAnchorPosition()
}

function showResetOperationHint(o: ModelRuntime) {
  cancelOperationHintHide()
  const { lng, lat } = effectiveAnchorDegrees(o)
  operationHint.title = '已重置'
  operationHint.lines = [
    `经纬度：${lng.toFixed(6)}°, ${lat.toFixed(6)}°`,
    '已恢复至初始放置状态',
    `离地 ${o.translation[2].toFixed(2)} m · 俯仰 ${o.rotation[0].toFixed(1)}° · 航向 ${o.rotation[1].toFixed(1)}° · ×${o.scale.toFixed(2)}`,
  ]
  operationHint.visible = true
  updateOperationHintAnchorPosition()
  scheduleOperationHintHide(1600)
}

function hideOperationHintImmediate() {
  cancelOperationHintHide()
  operationHint.visible = false
}

/** 选中编辑时关闭 Cesium 默认相机输入，避免与快捷键/修饰键+拖拽冲突；退出选中后恢复。 */
function syncCameraInteractionWithSelection() {
  const v = viewer.value
  if (!v) return
  const c = v.scene.screenSpaceCameraController
  if (selectedId.value != null) {
    c.enableInputs = false
  } else {
    c.enableInputs = true
    c.enableRotate = true
    c.enableTranslate = true
    c.enableZoom = true
    c.enableTilt = true
    c.enableLook = true
  }
}

watch(selectedId, () => {
  syncCameraInteractionWithSelection()
  const v = viewer.value
  if (v) {
    for (const id of modelOrder.value) syncEntity(v, id)
  }
})

function deltaWorldToENU(anchorCartesian: Cesium.Cartesian3, worldDelta: Cesium.Cartesian3): [number, number, number] {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(anchorCartesian)
  const inv = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4())
  const local = Cesium.Matrix4.multiplyByPointAsVector(inv, worldDelta, new Cesium.Cartesian3())
  return [local.x, local.y, local.z]
}

function pickEllipsoid(v: Cesium.Viewer, sx: number, sy: number): Cesium.Cartesian3 | undefined {
  const rect = v.scene.canvas.getBoundingClientRect()
  const pos = new Cesium.Cartesian2(sx - rect.left, sy - rect.top)
  return v.camera.pickEllipsoid(pos, v.scene.globe.ellipsoid) ?? undefined
}

function screenPointerDeltaToGroundENU(
  v: Cesium.Viewer,
  o: ModelRuntime,
  prevX: number,
  prevY: number,
  curX: number,
  curY: number,
): [number, number] {
  const cart = effectiveCartographic(o)
  const anchor = Cesium.Cartesian3.fromRadians(cart.longitude, cart.latitude, cart.height)
  const w0 = pickEllipsoid(v, prevX, prevY)
  const w1 = pickEllipsoid(v, curX, curY)
  if (!w0 || !w1) return [0, 0]
  const dw = Cesium.Cartesian3.subtract(w1, w0, new Cesium.Cartesian3())
  const [east, north] = deltaWorldToENU(anchor, dw)
  return [east, north]
}

function syncEntity(v: Cesium.Viewer, id: ModelId) {
  const o = models[id]
  const e = v.entities.getById(id)
  if (!o || !e) return
  o.translation[2] = Math.max(0, o.translation[2])
  const cart = effectiveCartographic(o)
  const pos = Cesium.Cartesian3.fromRadians(cart.longitude, cart.latitude, cart.height)
  e.position = new Cesium.ConstantPositionProperty(pos)
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(o.rotation[1]),
    Cesium.Math.toRadians(o.rotation[0]),
    Cesium.Math.toRadians(o.rotation[2]),
  )
  e.orientation = new Cesium.ConstantProperty(Cesium.Transforms.headingPitchRollQuaternion(pos, hpr))
  if (e.model) {
    e.model.scale = new Cesium.ConstantProperty(o.scale * BASE_MODEL_SCALE)
    const sel = selectedId.value === id
    e.model.silhouetteColor = new Cesium.ConstantProperty(sel ? Cesium.Color.fromCssColorString('#5ad8ff') : Cesium.Color.WHITE)
    e.model.silhouetteSize = new Cesium.ConstantProperty(sel ? 2.5 : 0)
  }
}

function applyAllEntities() {
  const v = viewer.value
  if (!v) return
  for (const id of modelOrder.value) syncEntity(v, id)
}

function focusOnModel(lng: number, lat: number) {
  const v = viewer.value
  if (!v) return
  const dest = Cesium.Cartesian3.fromDegrees(lng, lat, 180)
  v.camera.flyTo({
    destination: dest,
    duration: 0.9,
    orientation: {
      heading: Cesium.Math.toRadians(v.camera.heading),
      pitch: Cesium.Math.toRadians(-45),
      roll: v.camera.roll,
    },
  })
}

function addModelAt(uri: string, lng: number, lat: number) {
  const v = viewer.value
  if (!v) return ''
  const id = `m-${Date.now().toString(36)}`
  const m: ModelRuntime = {
    uri,
    position: [lng, lat],
    translation: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 1,
    initial: {
      position: [lng, lat],
      translation: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
    },
  }
  models[id] = m
  modelOrder.value = [...modelOrder.value, id]
  v.entities.add({
    id,
    model: {
      uri,
      scale: m.scale * BASE_MODEL_SCALE,
      minimumPixelSize: 48,
      silhouetteColor: Cesium.Color.WHITE,
      silhouetteSize: 0,
    },
  })
  applyAllEntities()
  selectedId.value = id
  focusOnModel(lng, lat)
  return id
}

function removeModel(id: ModelId) {
  const v = viewer.value
  if (!v) return
  v.entities.removeById(id)
  delete models[id]
  modelOrder.value = modelOrder.value.filter((x) => x !== id)
  if (selectedId.value === id) selectedId.value = null
  applyAllEntities()
}

function clearSelection() {
  hideOperationHintImmediate()
  selectedId.value = null
  applyAllEntities()
}

function selectModel(id: ModelId) {
  selectedId.value = id
  applyAllEntities()
  const o = models[id]
  if (o) {
    const { lng, lat } = effectiveAnchorDegrees(o)
    focusOnModel(lng, lat)
  }
}

/** 必须用指针事件上的修饰键；useMagicKeys 在 mousedown 时经常不同步导致拖拽不触发。 */
function resolveDragModeFromMouseEvent(e: MouseEvent): typeof drag.mode {
  const ctrl = isCtrlLike(e)
  const alt = e.altKey
  const shift = e.shiftKey
  if (ctrl && shift) return 'scale'
  if (alt && !shift) return 'moveV'
  if (shift && !alt) return 'rotateH'
  if (ctrl && !shift) return 'moveH'
  return null
}

function pickEntityAtWindow(v: Cesium.Viewer, clientX: number, clientY: number): Cesium.Entity | undefined {
  const rect = v.scene.canvas.getBoundingClientRect()
  const pos = new Cesium.Cartesian2(clientX - rect.left, clientY - rect.top)
  const picked = v.scene.pick(pos)
  if (!Cesium.defined(picked) || !picked.id) return undefined
  return picked.id instanceof Cesium.Entity ? picked.id : undefined
}

function bindInteractionHandlers(v: Cesium.Viewer) {
  eventHandler?.destroy()
  eventHandler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)

  eventHandler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
    const rect = v.scene.canvas.getBoundingClientRect()
    const ex = rect.left + click.position.x
    const ey = rect.top + click.position.y
    const ent = pickEntityAtWindow(v, ex, ey)
    if (!ent || typeof ent.id !== 'string' || !models[ent.id]) {
      selectedId.value = null
      applyAllEntities()
      return
    }
    selectedId.value = ent.id
    applyAllEntities()
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  const canvas = v.scene.canvas

  canvas.addEventListener(
    'mousedown',
    (e: MouseEvent) => {
    if (!selectedId.value) return
    const ent = pickEntityAtWindow(v, e.clientX, e.clientY)
    if (!ent || ent.id !== selectedId.value) return
    const mode = resolveDragModeFromMouseEvent(e)
    if (!mode) return
    const idSel = selectedId.value
    const oDown = models[idSel]
    if (!oDown) return
    e.preventDefault()
    drag.active = true
    drag.mode = mode
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    cancelOperationHintHide()
    showOperationHintForModel(oDown, mode)
    canvas.style.cursor = 'grabbing'
    },
    true,
  )

  detachWindowDrag?.()
  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)
  detachWindowDrag = () => {
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    detachWindowDrag = null
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!drag.active || !selectedId.value || !drag.mode) return
    const id = selectedId.value
    const o = models[id]
    if (!o) return
    const prevX = drag.lastX
    const prevY = drag.lastY
    const dx = e.clientX - prevX
    const dy = e.clientY - prevY
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    const mode = drag.mode
    if (mode === 'moveH') {
      const [east, north] = screenPointerDeltaToGroundENU(v, o, prevX, prevY, e.clientX, e.clientY)
      o.translation[0] += east
      o.translation[1] += north
    } else if (mode === 'moveV') {
      o.translation[2] += -dy * 0.08
    } else if (mode === 'rotateH') {
      o.rotation[1] += dx * 0.35
      o.rotation[0] += -dy * 0.35
    } else if (mode === 'scale') {
      const f = 1 - dy * 0.005
      o.scale = Math.max(0.05, Math.min(40, o.scale * f))
    }
    syncEntity(v, id)
    showOperationHintForModel(o, mode)
  }

  function onWindowMouseUp() {
    if (!drag.active) return
    drag.active = false
    drag.mode = null
    canvas.style.cursor = ''
    scheduleOperationHintHide(600)
  }

  v.cesiumWidget.container.addEventListener('mousemove', (ev: Event) => {
    if (drag.active) return
    const e = ev as MouseEvent
    const ent = pickEntityAtWindow(v, e.clientX, e.clientY)
    canvas.style.cursor = ent && typeof ent.id === 'string' && models[ent.id] ? 'pointer' : ''
  })
}

/** 底图：优先自定义 URL，其次 Ion 全球影像（需 token），最后 OSM（部分网络会超时）。 */
async function applyBaseImagery(v: Cesium.Viewer) {
  if (imageryUrlTemplate) {
    v.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: imageryUrlTemplate,
        credit: 'Custom imagery (VITE_CESIUM_IMAGERY_URL)',
      }),
    )
    return
  }
  if (ionToken) {
    try {
      const provider = await Cesium.createWorldImageryAsync()
      v.imageryLayers.addImageryProvider(provider)
      return
    } catch (e) {
      console.warn('[CesiumGltfEditor] Ion world imagery failed, falling back to OSM.', e)
    }
  }
  v.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      credit: '© OpenStreetMap contributors',
    }),
  )
}

function initViewer() {
  if (!containerRef.value) return
  if (ionToken) Cesium.Ion.defaultAccessToken = ionToken

  const v = new Cesium.Viewer(containerRef.value, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: true,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    shouldAnimate: true,
  })

  v.imageryLayers.removeAll()
  void applyBaseImagery(v)

  v.scene.globe.depthTestAgainstTerrain = false

  const centerLng = -74.0134
  const centerLat = 40.7153
  v.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(centerLng, centerLat, 420),
    orientation: {
      heading: Cesium.Math.toRadians(35),
      pitch: Cesium.Math.toRadians(-45),
      roll: 0,
    },
  })

  postRenderRemove = v.scene.postRender.addEventListener(() => {
    updateOperationHintAnchorPosition()
  })

  viewer.value = v

  bindInteractionHandlers(v)
  syncCameraInteractionWithSelection()

  addModelAt(GLTF_PRESETS[0].uri, centerLng - 0.00015, centerLat)
  addModelAt(GLTF_PRESETS[1].uri, centerLng + 0.00015, centerLat)
}

function shouldIgnoreKeyTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

useEventListener(
  () => window,
  'keydown',
  (e: KeyboardEvent) => {
    if (shouldIgnoreKeyTarget(e.target)) return
    if (!selectedId.value || !viewer.value) return
    const id = selectedId.value
    const o = models[id]
    if (!o) return
    const ctrl = isCtrlLike(e)
    const alt = e.altKey
    const shift = e.shiftKey

    if (e.code === 'KeyR' && ctrl && alt && !shift) {
      e.preventDefault()
      o.position = [...o.initial.position] as [number, number]
      o.translation = [...o.initial.translation] as [number, number, number]
      o.rotation = [...o.initial.rotation] as [number, number, number]
      o.scale = o.initial.scale
      syncEntity(viewer.value, id)
      showResetOperationHint(o)
      return
    }

    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const dir = e.code === 'ArrowLeft' ? -1 : 1
      if (ctrl && shift) return
      if (ctrl && !shift && !alt) {
        e.preventDefault()
        o.translation[0] += dir * STEP.moveH
        syncEntity(viewer.value, id)
        showOperationHintForModel(o, 'moveH')
        scheduleOperationHintHide(750)
      } else if (shift && !alt) {
        e.preventDefault()
        o.rotation[1] += dir * STEP.rotate
        syncEntity(viewer.value, id)
        showOperationHintForModel(o, 'rotateH')
        scheduleOperationHintHide(750)
      }
    }

    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const dir = e.code === 'ArrowUp' ? 1 : -1
      if (ctrl && shift) {
        e.preventDefault()
        o.scale = Math.max(0.05, Math.min(40, o.scale + dir * STEP.scale))
        syncEntity(viewer.value, id)
        showOperationHintForModel(o, 'scale')
        scheduleOperationHintHide(750)
      } else if (alt && !shift) {
        e.preventDefault()
        o.translation[2] += dir * STEP.moveV
        syncEntity(viewer.value, id)
        showOperationHintForModel(o, 'moveV')
        scheduleOperationHintHide(750)
      } else if (ctrl && !shift && !alt) {
        e.preventDefault()
        o.translation[1] -= dir * STEP.moveH
        syncEntity(viewer.value, id)
        showOperationHintForModel(o, 'moveH')
        scheduleOperationHintHide(750)
      } else if (shift && !ctrl && !alt) {
        e.preventDefault()
        o.rotation[0] += dir * STEP.rotate
        syncEntity(viewer.value, id)
        showOperationHintForModel(o, 'rotateH')
        scheduleOperationHintHide(750)
      }
    }
  },
  { capture: true },
)

function addPresetModel() {
  const v = viewer.value
  if (!v) return
  const center = v.camera.pickEllipsoid(
    new Cesium.Cartesian2(v.scene.canvas.clientWidth / 2, v.scene.canvas.clientHeight / 2),
    v.scene.globe.ellipsoid,
  )
  if (!center) return
  const c = Cesium.Cartographic.fromCartesian(center)
  const lng = Cesium.Math.toDegrees(c.longitude)
  const lat = Cesium.Math.toDegrees(c.latitude)
  const jitter = (modelOrder.value.length % 5) * 0.00008
  addModelAt(presetUri.value, lng + jitter, lat + jitter)
}

onMounted(() => {
  initViewer()
})

onBeforeUnmount(() => {
  hideOperationHintImmediate()
  detachWindowDrag?.()
  if (postRenderRemove) {
    postRenderRemove()
    postRenderRemove = null
  }
  eventHandler?.destroy()
  eventHandler = null
  const v = viewer.value
  if (v) {
    const c = v.scene.screenSpaceCameraController
    c.enableInputs = true
    c.enableRotate = true
    c.enableTranslate = true
    c.enableZoom = true
    c.enableTilt = true
    c.enableLook = true
    v.destroy()
  }
  viewer.value = null
})
</script>

<template>
  <div class="wrap">
    <div ref="containerRef" class="cesium" />

    <div class="panel">
      <h2 class="title">Cesium · GLTF 模型</h2>
      <p class="hint muted-small">
        底图：未配 <code>VITE_CESIUM_IMAGERY_URL</code> 时，若已设 Ion Token 则用 Cesium 全球影像，否则用 OSM（国内直连常超时，可配自建瓦片 URL 模板，需含
        <code>{z}/{x}/{y}</code>）。地形：椭球。
      </p>
      <label class="row">
        <span>选择模型</span>
        <select v-model="presetUri" class="select">
          <option v-for="p in GLTF_PRESETS" :key="p.id" :value="p.uri">
            {{ p.label }}
          </option>
        </select>
      </label>
      <button type="button" class="btn" @click="addPresetModel">在视野中心附近添加</button>

      <p class="hint">模型加载后，点击模型进入编辑</p>
      <p class="hint">(1) ctrl+←↑→↓ 或 ctrl+在模型上拖拽：水平面平移</p>
      <p class="hint">(2) alt+↑/↓ 或 alt+竖直拖拽：离地高度（≥0）</p>
      <p class="hint">(3) shift+方向键 / shift+拖拽：旋转（俯仰+航向）</p>
      <p class="hint muted-small">选中编辑时会暂时关闭 Cesium 默认相机操作（鼠标/键盘），退出选中后恢复。</p>
      <p class="hint">(4) ctrl+shift+↑/↓ 或对应拖拽：缩放</p>
      <p class="hint">(5) ctrl+alt+R：重置</p>

      <div v-if="selectedId" class="status">
        <span class="em">编辑中 · {{ selectedId }}</span>
        <button type="button" class="btn ghost" @click="clearSelection">退出选中</button>
      </div>
      <div v-else class="muted">未选中模型</div>

      <ul v-if="modelOrder.length" class="list">
        <li v-for="id in modelOrder" :key="id">
          <button type="button" class="link" @click="selectModel(id)">
            {{ id.slice(0, 12) }}…
          </button>
          <button type="button" class="btn danger small" @click="removeModel(id)">删除</button>
        </li>
      </ul>
    </div>

    <div
      v-show="operationHint.visible"
      class="operation-toast"
      role="status"
      aria-live="polite"
      :style="{ left: `${operationHint.x}px`, top: `${operationHint.y}px` }"
    >
      <div class="operation-toast__title">{{ operationHint.title }}</div>
      <div v-for="(line, idx) in operationHint.lines" :key="idx" class="operation-toast__line">
        {{ line }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.cesium {
  position: absolute;
  inset: 0;
}
.panel {
  position: absolute;
  left: 12px;
  top: 12px;
  max-width: min(420px, calc(100% - 24px));
  padding: 14px 16px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
  font-size: 13px;
  line-height: 1.45;
}
.title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 600;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.select {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #ccc;
}
.btn {
  display: inline-block;
  margin-bottom: 10px;
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: #4192eb;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.btn.ghost {
  background: #eef4fb;
  color: #1a3a5c;
}
.btn.danger {
  background: #e85d5d;
}
.btn.small {
  padding: 4px 8px;
  margin-bottom: 0;
  font-size: 12px;
}
.hint {
  margin: 4px 0;
  color: #333;
}
.em {
  color: #4192eb;
  font-weight: 600;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.muted {
  margin-top: 8px;
  color: #6b7280;
}
.muted-small {
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
  line-height: 1.35;
}
.list {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.list li {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.link {
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 4px 0;
  border: none;
  background: none;
  color: #2563eb;
  cursor: pointer;
  text-decoration: underline;
}
.operation-toast {
  position: absolute;
  z-index: 30;
  transform: translate(-50%, calc(-100% - 12px));
  min-width: 200px;
  max-width: min(92vw, 380px);
  padding: 12px 18px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 13px;
  line-height: 1.55;
  text-align: center;
  pointer-events: none;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
}
.operation-toast__title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 6px;
}
.operation-toast__line {
  opacity: 0.95;
}
</style>
