export interface ElectronIdentity { schemaVersion: number; kind: string; version: string; platform: string; architecture: string; assetName: string; archivePath: string; archiveSha256: string; packageRoot: string; treeSha256: string; archiveEntries: number; fileEntries: number; executablePath: string; executableSha256: string }
export function verifiedElectronExecution(receiptPath?: string): ElectronIdentity;
export function verifyElectronArchive(archivePath: string): ElectronIdentity;
