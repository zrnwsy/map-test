/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_ACCESS_TOKEN?: string
  /** 影像瓦片 URL 模板，需含 {z}、{x}、{y}，例如自建代理或国内镜像 */
  readonly VITE_CESIUM_IMAGERY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
