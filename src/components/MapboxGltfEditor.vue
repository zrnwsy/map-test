<script setup lang="ts">
import mapboxgl from 'mapbox-gl'
import type { ModelLayerSpecification, ModelSourceModelsSpecification } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useEventListener, useMagicKeys } from '@vueuse/core'

const SOURCE_ID = 'gltf-models'
const LAYER_ID = 'gltf-model-layer'
const BASE_MODEL_SCALE = 10

const GLTF_PRESETS = [
  {
    id: 'ego_car',
    label: 'Ego 汽车 (Mapbox)',
    uri: 'https://docs.mapbox.com/mapbox-gl-js/assets/ego_car.glb',
  },
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

const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
const map = shallowRef<mapboxgl.Map | null>(null)
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
const keys = useMagicKeys()

type EditOverlayMode = 'moveH' | 'moveV' | 'rotateH' | 'scale'

const operationHint = reactive({
  visible: false,
  title: '',
  lines: [] as string[],
  x: 0,
  y: 0,
})

let operationHintHideTimer: ReturnType<typeof setTimeout> | null = null

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

function formatOperationHintLines(o: ModelRuntime, mode: EditOverlayMode): { title: string; lines: string[] } {
  const ll = effectiveAnchorLngLat(o)
  const coord = `经纬度：${ll.lng.toFixed(6)}°, ${ll.lat.toFixed(6)}°`
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

function effectiveAnchorLngLat(o: ModelRuntime): mapboxgl.LngLat {
  const [lng0, lat0] = o.position
  const metersPerDegLat = 111320
  const metersPerDegLng = metersPerDegLat * Math.cos((lat0 * Math.PI) / 180)
  return new mapboxgl.LngLat(
    lng0 + o.translation[0] / metersPerDegLng,
    lat0 + o.translation[1] / metersPerDegLat,
  )
}

function updateOperationHintAnchorPosition() {
  if (!operationHint.visible) return
  const mapInst = map.value
  const sid = selectedId.value
  if (!mapInst || !sid) return
  const o = models[sid]
  if (!o) return
  try {
    const ll = effectiveAnchorLngLat(o)
    const p = mapInst.project(ll, o.translation[2])
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    const el = mapInst.getContainer()
    const w = el.clientWidth
    const h = el.clientHeight
    operationHint.x = Math.min(w - 4, Math.max(4, p.x))
    operationHint.y = Math.min(h - 4, Math.max(4, p.y))
  } catch {
    /* ignore */
  }
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
  const ll = effectiveAnchorLngLat(o)
  operationHint.title = '已重置'
  operationHint.lines = [
    `经纬度：${ll.lng.toFixed(6)}°, ${ll.lat.toFixed(6)}°`,
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

function hasModelLayer(m: mapboxgl.Map) {
  return !!m.getLayer(LAYER_ID)
}

function syncMapDefaultRotationWithSelection() {
  const m = map.value
  if (!m) return
  if (selectedId.value != null) {
    m.keyboard.disableRotation()
    m.dragRotate.disable()
  } else {
    m.keyboard.enableRotation()
    m.dragRotate.enable()
  }
}

watch(selectedId, () => {
  syncMapDefaultRotationWithSelection()
})

function focusOnModel(lng: number, lat: number) {
  const mp = map.value
  if (!mp || !hasModelLayer(mp)) return
  mp.easeTo({
    center: [lng, lat],
    zoom: Math.max(mp.getZoom(), 19),
    pitch: 60,
    bearing: mp.getBearing(),
    duration: 900,
  })
}

function addModelAt(uri: string, lng: number, lat: number) {
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
  syncSourceModels()
  applyAllFeatureStates()
  selectedId.value = id
  focusOnModel(lng, lat)
  return id
}

function removeModel(id: ModelId) {
  delete models[id]
  modelOrder.value = modelOrder.value.filter((x) => x !== id)
  if (selectedId.value === id) selectedId.value = null
  syncSourceModels()
  applyAllFeatureStates()
}

function syncSourceModels() {
  const m = map.value
  if (!m) return
  const src = m.getSource(SOURCE_ID) as mapboxgl.ModelSource | undefined
  if (!src) return
  const spec: ModelSourceModelsSpecification = {}
  for (const id of modelOrder.value) {
    const o = models[id]
    if (!o) continue
    spec[id] = { uri: o.uri, position: o.position, orientation: [0, 0, 0] }
  }
  src.setModels(spec)
}

function scaleVecFor(o: ModelRuntime): [number, number, number] {
  const s = o.scale * BASE_MODEL_SCALE
  return [s, s, s]
}

function syncModelFeatureState(id: ModelId) {
  const m = map.value
  if (!m) return
  const o = models[id]
  if (!o) return
  o.translation[2] = Math.max(0, o.translation[2])
  const s = selectedId.value === id
  m.setFeatureState(
    { source: SOURCE_ID, sourceLayer: '', id },
    {
      selected: s,
      translation: o.translation,
      rotation: o.rotation,
      scaleVec: scaleVecFor(o),
    },
  )
}

function applyAllFeatureStates() {
  for (const id of modelOrder.value) syncModelFeatureState(id)
}

function clearSelection() {
  hideOperationHintImmediate()
  selectedId.value = null
  applyAllFeatureStates()
}

function selectModel(id: ModelId) {
  selectedId.value = id
  applyAllFeatureStates()
  const o = models[id]
  if (o) focusOnModel(o.position[0], o.position[1])
}

function buildStyleLayer(): ModelLayerSpecification {
  return {
    id: LAYER_ID,
    type: 'model',
    source: SOURCE_ID,
    paint: {
      'model-type': 'common-3d',
      'model-elevation-reference': 'ground',
      'model-translation': [
        'coalesce',
        ['feature-state', 'translation'],
        ['literal', [0, 0, 0]],
      ],
      'model-rotation': [
        'coalesce',
        ['feature-state', 'rotation'],
        ['literal', [0, 0, 0]],
      ],
      'model-scale': [
        'coalesce',
        ['feature-state', 'scaleVec'],
        ['literal', [BASE_MODEL_SCALE, BASE_MODEL_SCALE, BASE_MODEL_SCALE]],
      ],
      'model-emissive-strength': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        0.55,
        0,
      ],
    },
  }
}

function screenPointerDeltaToGroundMeters(
  mapInst: mapboxgl.Map,
  pPrev: mapboxgl.Point,
  pCur: mapboxgl.Point,
): [number, number] {
  const ll0 = mapInst.unproject(pPrev)
  const ll1 = mapInst.unproject(pCur)
  const midLat = (ll0.lat + ll1.lat) / 2
  const metersPerDegLat = 111320
  const metersPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180)
  return [(ll1.lng - ll0.lng) * metersPerDegLng, (ll1.lat - ll0.lat) * metersPerDegLat]
}

function resolveDragModeFromKeys(): typeof drag.mode {
  const ctrl = keys.ctrl.value
  const alt = keys.alt.value
  const shift = keys.shift.value
  if (ctrl && shift) return 'scale'
  if (alt && !shift) return 'moveV'
  if (shift && !alt) return 'rotateH'
  if (ctrl && !shift) return 'moveH'
  return null
}

function bindInteractionHandlers(m: mapboxgl.Map) {
  m.on('click', (e) => {
    if (!hasModelLayer(m)) return
    const feats = m.queryRenderedFeatures(e.point, { layers: [LAYER_ID] })
    if (!feats.length) {
      selectedId.value = null
      applyAllFeatureStates()
      return
    }
    const f = feats[0]
    const id = f.id
    if (id == null) return
    const sid = String(id)
    if (models[sid]) {
      selectedId.value = sid
      applyAllFeatureStates()
    }
  })

  m.on('mouseenter', LAYER_ID, () => {
    m.getCanvas().style.cursor = 'pointer'
  })
  m.on('mouseleave', LAYER_ID, () => {
    if (!drag.active) m.getCanvas().style.cursor = ''
  })

  m.on('mousedown', (e) => {
    if (!selectedId.value || !hasModelLayer(m)) return
    const feats = m.queryRenderedFeatures(e.point, { layers: [LAYER_ID] })
    if (!feats.length) return
    if (String(feats[0].id) !== selectedId.value) return
    const mode = resolveDragModeFromKeys()
    if (!mode) return
    const idSel = selectedId.value
    const oDown = models[idSel]
    if (!oDown) return
    e.preventDefault()
    drag.active = true
    drag.mode = mode
    drag.lastX = e.point.x
    drag.lastY = e.point.y
    cancelOperationHintHide()
    showOperationHintForModel(oDown, mode)
    m.dragPan.disable()
    m.getCanvas().style.cursor = 'grabbing'
  })

  m.on('mousemove', (e) => {
    if (!drag.active || !selectedId.value || !drag.mode) return
    const id = selectedId.value
    const o = models[id]
    if (!o) return
    const pPrev = new mapboxgl.Point(drag.lastX, drag.lastY)
    const pCur = e.point
    const dx = pCur.x - pPrev.x
    const dy = pCur.y - pPrev.y
    drag.lastX = pCur.x
    drag.lastY = pCur.y
    const mode = drag.mode
    if (mode === 'moveH') {
      const [mx, my] = screenPointerDeltaToGroundMeters(m, pPrev, pCur)
      o.translation[0] += mx
      o.translation[1] -= my
    } else if (mode === 'moveV') {
      o.translation[2] += -dy * 0.08
    } else if (mode === 'rotateH') {
      o.rotation[1] += dx * 0.35
      o.rotation[0] += -dy * 0.35
    } else if (mode === 'scale') {
      const f = 1 - dy * 0.005
      o.scale = Math.max(0.05, Math.min(40, o.scale * f))
    }
    syncModelFeatureState(id)
    showOperationHintForModel(o, mode)
  })

  m.on('mouseup', () => {
    if (!drag.active) return
    drag.active = false
    drag.mode = null
    m.dragPan.enable()
    m.getCanvas().style.cursor = ''
    scheduleOperationHintHide(600)
  })
}

function initMap() {
  if (!token || !containerRef.value) return
  mapboxgl.accessToken = token
  const center: [number, number] = [-74.0134, 40.7153]
  const m = new mapboxgl.Map({
    container: containerRef.value,
    style: 'mapbox://styles/mapbox/streets-v12',
    center,
    zoom: 18,
    pitch: 60,
    bearing: 35,
    antialias: true,
  })
  m.addControl(new mapboxgl.NavigationControl(), 'top-right')
  m.once('load', () => {
    m.addSource(SOURCE_ID, { type: 'model', models: {} })
    m.addLayer(buildStyleLayer())
    addModelAt(GLTF_PRESETS[0].uri, center[0] - 0.00015, center[1])
    addModelAt(GLTF_PRESETS[1].uri, center[0] + 0.00015, center[1])
    bindInteractionHandlers(m)
    syncMapDefaultRotationWithSelection()
    m.on('render', updateOperationHintAnchorPosition)
  })
  map.value = m
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
    if (!selectedId.value || !map.value) return
    const id = selectedId.value
    const o = models[id]
    if (!o) return
    const ctrl = e.ctrlKey
    const alt = e.altKey
    const shift = e.shiftKey

    if (e.code === 'KeyR' && ctrl && alt && !shift) {
      e.preventDefault()
      o.position = [...o.initial.position] as [number, number]
      o.translation = [...o.initial.translation] as [number, number, number]
      o.rotation = [...o.initial.rotation] as [number, number, number]
      o.scale = o.initial.scale
      syncSourceModels()
      syncModelFeatureState(id)
      showResetOperationHint(o)
      return
    }

    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const dir = e.code === 'ArrowLeft' ? -1 : 1
      if (ctrl && shift) return
      if (ctrl && !shift && !alt) {
        e.preventDefault()
        o.translation[0] += dir * STEP.moveH
        syncModelFeatureState(id)
        showOperationHintForModel(o, 'moveH')
        scheduleOperationHintHide(750)
      } else if (shift && !alt) {
        e.preventDefault()
        o.rotation[1] += dir * STEP.rotate
        syncModelFeatureState(id)
        showOperationHintForModel(o, 'rotateH')
        scheduleOperationHintHide(750)
      }
    }

    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const dir = e.code === 'ArrowUp' ? 1 : -1
      if (ctrl && shift) {
        e.preventDefault()
        o.scale = Math.max(0.05, Math.min(40, o.scale + dir * STEP.scale))
        syncModelFeatureState(id)
        showOperationHintForModel(o, 'scale')
        scheduleOperationHintHide(750)
      } else if (alt && !shift) {
        e.preventDefault()
        o.translation[2] += dir * STEP.moveV
        syncModelFeatureState(id)
        showOperationHintForModel(o, 'moveV')
        scheduleOperationHintHide(750)
      } else if (ctrl && !shift && !alt) {
        e.preventDefault()
        o.translation[1] -= dir * STEP.moveH
        syncModelFeatureState(id)
        showOperationHintForModel(o, 'moveH')
        scheduleOperationHintHide(750)
      } else if (shift && !ctrl && !alt) {
        e.preventDefault()
        o.rotation[0] += dir * STEP.rotate
        syncModelFeatureState(id)
        showOperationHintForModel(o, 'rotateH')
        scheduleOperationHintHide(750)
      }
    }
  },
)

function addPresetModel() {
  const c = map.value?.getCenter()
  if (!c) return
  const jitter = (modelOrder.value.length % 5) * 0.00008
  addModelAt(presetUri.value, c.lng + jitter, c.lat + jitter)
}

onMounted(() => {
  if (!token) console.warn('请在 .env 中设置 VITE_MAPBOX_ACCESS_TOKEN')
  initMap()
})

onBeforeUnmount(() => {
  hideOperationHintImmediate()
  const m = map.value
  if (m) {
    m.keyboard.enableRotation()
    m.dragRotate.enable()
    m.remove()
  }
  map.value = null
})
</script>

<template>
  <div class="wrap">
    <div ref="containerRef" class="map" />

    <div class="panel">
      <h2 class="title">GLTF 模型</h2>
      <label class="row">
        <span>选择模型</span>
        <select v-model="presetUri" class="select">
          <option v-for="p in GLTF_PRESETS" :key="p.id" :value="p.uri">
            {{ p.label }}
          </option>
        </select>
      </label>
      <button type="button" class="btn" @click="addPresetModel">在地图中心附近添加</button>

      <p class="hint">模型部署后，点击模型可进入编辑状态</p>
      <p class="hint">
        (1) ctrl+←↑→↓ 或 ctrl+在模型上拖拽：水平面平移
      </p>
      <p class="hint">(2) alt+↑/↓ 或 alt+竖直拖拽：离地高度</p>
      <p class="hint">(3) shift+方向键 / shift+拖拽：旋转（俯仰+航向）</p>
      <p class="hint muted-small">
        选中模型时会关闭地图默认 Shift 键盘旋转与拖拽旋转，避免冲突。
      </p>
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

    <div v-if="!token" class="banner">
      请配置 <code>.env</code> 中 <code>VITE_MAPBOX_ACCESS_TOKEN</code>
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
.map {
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
.banner {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 14px;
  border-radius: 8px;
  background: #fef3c7;
  color: #92400e;
  font-size: 13px;
  max-width: 90%;
  text-align: center;
}
.banner code {
  font-size: 12px;
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
