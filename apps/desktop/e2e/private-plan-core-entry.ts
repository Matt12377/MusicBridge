import { startPrivateTestCore } from './private-test-core-entry.js'

// 旧 073/074：仅允许合成设备选择与计划冻结；不签发 Gate B 或正式 Attempt。
startPrivateTestCore('plan-only')
