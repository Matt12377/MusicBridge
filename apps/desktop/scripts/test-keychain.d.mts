export type TestKeychainMode = 'system' | 'mock'
export function readTestKeychainMode(mode?: string): TestKeychainMode
export function testElectronArguments(args: string[], mode?: string): string[]
export function parseTestKeychainMode(args: string[]): TestKeychainMode
