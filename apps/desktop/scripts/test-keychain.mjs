// 仅测试启动器使用；普通应用入口与Fuses不读取此模式。
export function readTestKeychainMode(mode = process.env.MUSIC_BRIDGE_TEST_KEYCHAIN_MODE) {
  if (mode === undefined || mode === 'system') return 'system'
  if (mode === 'mock') return 'mock'
  throw new Error('测试钥匙串模式无效')
}

export function testElectronArguments(args, mode = process.env.MUSIC_BRIDGE_TEST_KEYCHAIN_MODE) {
  const selected = readTestKeychainMode(mode)
  return selected === 'mock' && !args.includes('--use-mock-keychain')
    ? [...args, '--use-mock-keychain'] : [...args]
}

// 脚本无CLI参数时始终保持原system模式；不隐式继承测试runner的环境选择。
export function parseTestKeychainMode(args) {
  if (args.length === 0) return 'system'
  if (args.length === 1 && args[0] === '--keychain=mock') return 'mock'
  if (args.length === 1 && args[0] === '--keychain=system') return 'system'
  throw new Error('测试钥匙串模式无效')
}
