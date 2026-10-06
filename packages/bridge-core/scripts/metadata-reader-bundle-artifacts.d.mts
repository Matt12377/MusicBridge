export const WORKER_ENTRY: string;
export const ROOT_INPUTS: string[];
export const LOADER_FILES: string[];
export function validateFixedWorkerReceiptShape(value: unknown): unknown;
export function readFixedMetadataWorkerBundle(coreRoot: string, check?: () => void): Promise<{ manifest: unknown; entryBytes: Uint8Array; mapBytes: Uint8Array; receiptRef: { file: string; bytes: number; sha256: string } }>;

export function fixedMetadataBuildSource(text: string, file: string): string;
