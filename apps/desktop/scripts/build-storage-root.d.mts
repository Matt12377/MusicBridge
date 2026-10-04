export function buildStoragePolicy(options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): {
  root: string; hosted: boolean; check(candidate: string, options?: { mustExist?: boolean; kind?: 'file' | 'directory' }): string
};
