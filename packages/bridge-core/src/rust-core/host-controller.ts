import type { RustReadonlyCoreDatasetOwner, RustReadonlyCoreDatasetOwnerStatus } from './core-dataset-owner.js';

/** 仅由可信主机持有的控制能力；不进入公共 IPC 或 Renderer。 */
export interface RustReadonlyCoreController {
  refresh(): Promise<void>;
  invalidate(): void;
  getStatus(): RustReadonlyCoreDatasetOwnerStatus;
}

/** 闭包只交付三项能力，既不交付端点，也不借用其原型。 */
export function createRustReadonlyCoreController(endpoint: RustReadonlyCoreDatasetOwner): RustReadonlyCoreController {
  return Object.freeze({
    refresh: () => endpoint.refresh(),
    invalidate: () => endpoint.invalidate(),
    getStatus: () => endpoint.getStatus(),
  });
}
