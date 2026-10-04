export interface RustElectronHostsReceipt { schemaVersion: number; kind: string; manifestPath: string; manifestSha256: string; binaryPath: string; binarySha256: string; platform: string; architecture: string; mainHostBuildRoot: string; collectionHostBuildRoot: string }
export function verifyRustElectronHosts(manifestPath: string, options: { root: string; runDirectory: string; platform?: string; architecture?: string }): RustElectronHostsReceipt;
export function readRustElectronHostsReceipt(receiptPath: string, root: string): RustElectronHostsReceipt;
