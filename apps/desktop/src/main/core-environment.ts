const CORE_RUNTIME_ENV_KEYS = [
  'NODE_ENV',
  'BRIDGE_CONTROL_HOST',
  'BRIDGE_CONTROL_PORT',
  'BRIDGE_STREAM_HOST',
  'BRIDGE_STREAM_PORT',
  'BRIDGE_PUBLIC_STREAM_BASE_URL',
  'NETEASE_DEFAULT_QUALITY',
  'LOG_LEVEL',
  'ENABLE_GENERAL_UNBLOCK',
  'ENABLE_PROXY',
  'ENABLE_RANDOM_CN_IP',
] as const

export interface CoreEnvironmentOptions {
  startupTest: boolean
  uiE2e: boolean
  coreCrashGate: boolean
  roonTimeGate?: boolean
}

function isRoonTimeGatePath(value: string | undefined): value is string {
  return value !== undefined && /^\/tmp\/musicbridge-roon-time-gate-[A-Za-z0-9._-]+\.jsonl$/.test(value)
}

export function buildCoreEnvironment(
  parent: NodeJS.ProcessEnv,
  options: CoreEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of CORE_RUNTIME_ENV_KEYS) {
    const value = parent[key]
    if (value !== undefined) environment[key] = value
  }

  if (options.startupTest || options.uiE2e) {
    environment.NODE_ENV = 'test'
    environment.MUSIC_BRIDGE_CORE_TEST_MODE = '1'
    if (options.coreCrashGate) {
      environment.MUSIC_BRIDGE_CORE_CRASH_PROBE = '1'
      const crashDelay = parent.MUSIC_BRIDGE_CORE_CRASH_DELAY_MS
      if (crashDelay !== undefined) environment.MUSIC_BRIDGE_CORE_CRASH_DELAY_MS = crashDelay
    }
  }

  if (options.roonTimeGate && isRoonTimeGatePath(parent.MUSIC_BRIDGE_ROON_TIME_GATE_PATH)) {
    environment.MUSIC_BRIDGE_ROON_TIME_GATE = '1'
    environment.MUSIC_BRIDGE_ROON_TIME_GATE_PATH = parent.MUSIC_BRIDGE_ROON_TIME_GATE_PATH
  }

  return environment
}
