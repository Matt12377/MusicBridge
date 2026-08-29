import { mkdtempSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ElectronColdStartStage = 'seed' | 'restore'

export interface StartupTestConfiguration {
  uiE2eUserDataDirectory?: string
  isStartupTest: boolean
  userDataDirectory?: string
  coreCrashGate: boolean
  credentialVaultGate: boolean
  coreRestartCredentialRecoveryGate: boolean
  electronColdStartStage?: ElectronColdStartStage
}

const LEGACY_CREDENTIAL_RECOVERY_ENV = 'MUSIC_BRIDGE_CREDENTIAL_RECOVERY_GATE'
const STARTUP_USER_DATA_ENV = 'MUSIC_BRIDGE_STARTUP_USER_DATA_DIR'
const COLD_START_STAGE_ENV = 'MUSIC_BRIDGE_CREDENTIAL_COLD_START_STAGE'

function readExactFlag(environment: NodeJS.ProcessEnv, key: string): boolean {
  const value = environment[key]
  if (value === undefined) return false
  if (value !== '1') throw new Error(`${key} must be exactly 1`)
  return true
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function validateUserDataDirectory(value: string, expectedName = /^musicbridge-task036-(?:startup|cold-start)-[A-Za-z0-9._-]+$/): string {
  const requestedPath = path.resolve(value)
  const temporaryRoot = realpathSync(os.tmpdir())
  if (!expectedName.test(path.basename(requestedPath))) {
    throw new Error(`${STARTUP_USER_DATA_ENV} has an invalid temporary directory name`)
  }

  const resolvedPath = realpathSync(requestedPath)
  if (!isPathInside(temporaryRoot, resolvedPath) || !statSync(resolvedPath).isDirectory()) {
    throw new Error(`${STARTUP_USER_DATA_ENV} must be a unique directory below the system temp directory`)
  }
  return resolvedPath
}

// 仅在 Main 顶层调用一次；session 的目录必须在 ready 与首次 protocol 使用前固定。
export function initializeStartupTestPaths(
  configuration: StartupTestConfiguration,
  isUiE2e: boolean,
  application: {
    isReady(): boolean
    setPath(name: 'userData' | 'sessionData', value: string): void
  },
): string | undefined {
  if (!configuration.isStartupTest && !isUiE2e) return undefined
  if (application.isReady()) throw new Error('测试数据目录必须在 app ready 前初始化')

  let directory: string
  if (configuration.isStartupTest) {
    if (!configuration.userDataDirectory) throw new Error('Electron startup test userData directory is missing')
    directory = validateUserDataDirectory(configuration.userDataDirectory)
  } else if (configuration.uiE2eUserDataDirectory) {
    directory = validateUserDataDirectory(configuration.uiE2eUserDataDirectory, /^musicbridge-ui-(?:e2e|diagnostics)-[A-Za-z0-9._-]+$/)
  } else {
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'musicbridge-ui-e2e-'))
  }
  application.setPath('userData', directory)
  application.setPath('sessionData', directory)
  return directory
}

function readColdStartStage(environment: NodeJS.ProcessEnv): ElectronColdStartStage | undefined {
  const value = environment[COLD_START_STAGE_ENV]
  if (value === undefined) return undefined
  if (value !== 'seed' && value !== 'restore') {
    throw new Error(`${COLD_START_STAGE_ENV} must be seed or restore`)
  }
  return value
}

export function readStartupTestConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): StartupTestConfiguration {
  const uiDirectory = environment.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR
  if (uiDirectory !== undefined && environment.MUSIC_BRIDGE_UI_E2E !== '1') throw new Error('库存测试目录只能用于 UI 测试')
  const uiE2eUserDataDirectory = uiDirectory === undefined ? undefined
    : validateUserDataDirectory(uiDirectory, /^musicbridge-ui-(?:e2e|diagnostics)-[A-Za-z0-9._-]+$/)
  const startupTestValue = environment.MUSIC_BRIDGE_STARTUP_TEST
  if (startupTestValue !== undefined && startupTestValue !== '1') {
    throw new Error('MUSIC_BRIDGE_STARTUP_TEST must be exactly 1 when provided')
  }
  const isStartupTest = startupTestValue === '1'

  if (environment[LEGACY_CREDENTIAL_RECOVERY_ENV] !== undefined) {
    throw new Error(`${LEGACY_CREDENTIAL_RECOVERY_ENV} is obsolete; use the named Core restart gate`)
  }

  const userDataValue = environment[STARTUP_USER_DATA_ENV]
  const coldStartStage = readColdStartStage(environment)
  const coreCrashGate = readExactFlag(environment, 'MUSIC_BRIDGE_CORE_CRASH_GATE')
  const credentialVaultGate = readExactFlag(environment, 'MUSIC_BRIDGE_CREDENTIAL_VAULT_GATE')
  const coreRestartCredentialRecoveryGate = readExactFlag(
    environment,
    'MUSIC_BRIDGE_CORE_RESTART_CREDENTIAL_RECOVERY_GATE',
  )

  if (!isStartupTest) {
    if (userDataValue !== undefined || coldStartStage !== undefined) {
      throw new Error('Electron startup test variables require MUSIC_BRIDGE_STARTUP_TEST=1')
    }
    if (coreCrashGate || credentialVaultGate || coreRestartCredentialRecoveryGate) {
      throw new Error('Electron startup gates require MUSIC_BRIDGE_STARTUP_TEST=1')
    }
    return {
      isStartupTest: false,
      ...(uiE2eUserDataDirectory ? { uiE2eUserDataDirectory } : {}),
      coreCrashGate: false,
      credentialVaultGate: false,
      coreRestartCredentialRecoveryGate: false,
    }
  }

  if (userDataValue === undefined) {
    throw new Error(`${STARTUP_USER_DATA_ENV} is required for Electron startup tests`)
  }
  if (coldStartStage !== undefined && coreRestartCredentialRecoveryGate) {
    throw new Error('Electron cold-start and Core restart credential gates are mutually exclusive')
  }
  if (coldStartStage !== undefined && (coreCrashGate || credentialVaultGate)) {
    throw new Error('Electron cold-start credential recovery cannot be combined with another startup gate')
  }

  return {
    isStartupTest: true,
    userDataDirectory: validateUserDataDirectory(userDataValue),
    coreCrashGate,
    credentialVaultGate,
    coreRestartCredentialRecoveryGate,
    ...(coldStartStage !== undefined ? { electronColdStartStage: coldStartStage } : {}),
  }
}
