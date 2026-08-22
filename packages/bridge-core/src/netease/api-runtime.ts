import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BridgeError } from '../shared/errors.js'

type XeapiPublicKeyState = Record<string, unknown> & {
  publicKey: string
  sk: string
  version: string | number
}

interface XeapiKeyModule {
  getXeapiPublicKey(
    currentPublicKey: Record<string, unknown>,
    deviceId?: string,
  ): Promise<unknown>
}

interface NeteaseApiUtilModule {
  generateDeviceId(): unknown
}

const xeapiPublicKeyPath = path.join(os.tmpdir(), 'xeapi_public_key')
let preparationPromise: Promise<void> | undefined
let prepared = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPublicKeyState(value: unknown): value is XeapiPublicKeyState {
  if (!isRecord(value)) return false
  return (
    typeof value.publicKey === 'string' &&
    value.publicKey.length > 0 &&
    typeof value.sk === 'string' &&
    value.sk.length > 0 &&
    (typeof value.version === 'string' || typeof value.version === 'number')
  )
}

async function readExistingPublicKey(): Promise<XeapiPublicKeyState | undefined> {
  try {
    const raw = await readFile(xeapiPublicKeyPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isPublicKeyState(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function writePublicKeyAtomically(state: XeapiPublicKeyState): Promise<void> {
  const temporaryPath = `${xeapiPublicKeyPath}.${randomUUID()}.tmp`
  let temporaryCreated = false
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    temporaryCreated = true
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, xeapiPublicKeyPath)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined)
  }
}

function apiRuntimeError(cause: unknown): BridgeError {
  return new BridgeError(
    'NETEASE_REQUEST_FAILED',
    'NetEase audio runtime initialization failed',
    { cause, httpStatus: 502 },
  )
}

async function prepare(): Promise<void> {
  const current = await readExistingPublicKey()
  let keyModule: XeapiKeyModule
  let utilModule: NeteaseApiUtilModule
  try {
    const require = createRequire(import.meta.url)
    keyModule = require('@neteasecloudmusicapienhanced/api/util/xeapiKey') as XeapiKeyModule
    utilModule = require('@neteasecloudmusicapienhanced/api/util') as NeteaseApiUtilModule
  } catch (error) {
    if (current) return
    throw apiRuntimeError(error)
  }

  try {
    const deviceId = utilModule.generateDeviceId()
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new Error('invalid generated device id')
    }
    const runtimeGlobal = globalThis as typeof globalThis & { deviceId?: string }
    runtimeGlobal.deviceId = deviceId
    const next = await keyModule.getXeapiPublicKey(current ?? {}, deviceId)
    if (!isPublicKeyState(next)) throw new Error('invalid xeapi public key response')
    await writePublicKeyAtomically(next)
  } catch (error) {
    if (current) return
    throw apiRuntimeError(error)
  }
}

/**
 * The pinned API package expects this public key cache before song_url_v1.
 * Keep initialization lazy so library browsing remains available offline.
 */
export function ensureNeteaseApiRuntime(): Promise<void> {
  if (prepared) return Promise.resolve()
  if (!preparationPromise) {
    preparationPromise = prepare()
      .then(() => {
        prepared = true
      })
      .finally(() => {
        preparationPromise = undefined
      })
  }
  return preparationPromise
}
