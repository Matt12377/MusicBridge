import type { Plugin } from 'vite'
export interface CollectionReadonlyBuildOptions { probeExpectation: 'node' | 'rust' | 'pin'; manifestPin: string; outDir: string }
export interface CollectionReadonlyBuildConfiguration {
  main: { root: string; define: Record<string, string>; plugins: Plugin[];
    build: { outDir: string; rollupOptions: {
      input: { index: string; core: string; 'dataset-owner': string; 'spreadsheet-worker': string };
      output: { entryFileNames: '[name].js' } } } }
}
export function createCollectionReadonlyBuildConfiguration(options: CollectionReadonlyBuildOptions): Promise<CollectionReadonlyBuildConfiguration>
