import type { Plugin } from 'vite'

/** 签前工具只能选择两个静态入口；Node 不接收 Rust 清单 pin。 */
export type PackagedRendererBuildOptions = {
  coreEntry: 'packaged-renderer-node-core-entry.ts'
  manifestPin: null
  outDir: string
} | {
  coreEntry: 'packaged-renderer-rust-core-entry.ts'
  manifestPin: string
  outDir: string
}

export interface PackagedRendererBuildConfiguration {
  main: {
    root: string
    define: {
      __MUSIC_BRIDGE_PACKAGED_ROUTE_DIAGNOSTICS__: 'false'
      __MUSIC_BRIDGE_PACKAGED_RENDERER_DIAGNOSTICS__: 'true'
      __MUSIC_BRIDGE_RUST_MANIFEST_SHA256__: string
      __MUSIC_BRIDGE_DEVELOPMENT_BUILD__: 'false'
      __MUSIC_BRIDGE_FFMPEG_MANIFEST_SHA256__: string
      __MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__: string
      __MUSIC_BRIDGE_OUTPUT_DEVICE_MANIFEST_SHA256__: string
      __MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__: string
    }
    plugins: Plugin[]
    build: {
      outDir: string
      rollupOptions: {
        input: { index: string; core: string; 'dataset-owner': string; 'spreadsheet-worker': string }
        output: { entryFileNames: '[name].js' }
      }
    }
  }
}

export function createPackagedRendererBuildConfiguration(options: PackagedRendererBuildOptions): Promise<PackagedRendererBuildConfiguration>
