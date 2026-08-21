import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAX_CREDENTIAL_LENGTH = 64 * 1024
const MAX_ENCRYPTED_FILE_SIZE = 128 * 1024
const PRIVATE_FILE_MODE = 0o600

export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{
    result: string
    shouldReEncrypt: boolean
  }>
}

export type CredentialVaultReadResult =
  | { status: 'missing' }
  | { status: 'configured'; credential: string }
  | { status: 'invalid' }
  | { status: 'unavailable' }

export class CredentialVaultError extends Error {
  constructor(
    readonly code: 'SAFE_STORAGE_UNAVAILABLE' | 'INVALID_CREDENTIAL' | 'STORAGE_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'CredentialVaultError'
  }
}

export interface CredentialVaultOptions {
  filePath: string
  storage: AsyncSafeStorage
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function validateCredential(value: string): string {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CREDENTIAL_LENGTH ||
    normalized.includes('\u0000') ||
    normalized.includes('\n') ||
    normalized.includes('\r')
  ) {
    throw new CredentialVaultError('INVALID_CREDENTIAL', 'Credential value is invalid')
  }
  return normalized
}

function isPrivateRegularFile(stat: { isFile(): boolean; mode: number }): boolean {
  return stat.isFile() && (stat.mode & 0o777) === PRIVATE_FILE_MODE
}

export class CredentialVault {
  constructor(private readonly options: CredentialVaultOptions) {}

  async save(value: string): Promise<void> {
    const credential = validateCredential(value)
    let encryptionAvailable = false
    try {
      encryptionAvailable = await this.options.storage.isAsyncEncryptionAvailable()
    } catch {
      encryptionAvailable = false
    }
    if (!encryptionAvailable) {
      throw new CredentialVaultError(
        'SAFE_STORAGE_UNAVAILABLE',
        'safeStorage encryption is unavailable',
      )
    }

    let encrypted: Buffer
    try {
      encrypted = await this.options.storage.encryptStringAsync(credential)
    } catch (error) {
      throw new CredentialVaultError('STORAGE_FAILED', 'Credential encryption failed')
    }
    if (encrypted.length === 0 || encrypted.length > MAX_ENCRYPTED_FILE_SIZE) {
      throw new CredentialVaultError('STORAGE_FAILED', 'Encrypted credential is invalid')
    }

    await this.writeAtomically(encrypted)
  }

  async read(): Promise<CredentialVaultReadResult> {
    let stat
    try {
      stat = await lstat(this.options.filePath)
    } catch (error) {
      if (isNotFound(error)) return { status: 'missing' }
      return { status: 'invalid' }
    }
    if (
      !isPrivateRegularFile(stat) ||
      stat.size === 0 ||
      stat.size > MAX_ENCRYPTED_FILE_SIZE
    ) {
      return { status: 'invalid' }
    }
    let encryptionAvailable = false
    try {
      encryptionAvailable = await this.options.storage.isAsyncEncryptionAvailable()
    } catch {
      encryptionAvailable = false
    }
    if (!encryptionAvailable) {
      return { status: 'unavailable' }
    }

    let encrypted: Buffer
    try {
      encrypted = await readFile(this.options.filePath)
    } catch {
      return { status: 'invalid' }
    }

    try {
      const decrypted = await this.options.storage.decryptStringAsync(encrypted)
      const credential = validateCredential(decrypted.result)
      if (decrypted.shouldReEncrypt) {
        const reencrypted = await this.options.storage.encryptStringAsync(credential)
        if (reencrypted.length === 0 || reencrypted.length > MAX_ENCRYPTED_FILE_SIZE) {
          return { status: 'invalid' }
        }
        await this.writeAtomically(reencrypted)
      }
      return { status: 'configured', credential }
    } catch {
      return { status: 'invalid' }
    }
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.options.filePath)
    } catch (error) {
      if (!isNotFound(error)) {
        throw new CredentialVaultError('STORAGE_FAILED', 'Credential deletion failed')
      }
    }
    try {
      await lstat(this.options.filePath)
    } catch (error) {
      if (isNotFound(error)) return
      throw new CredentialVaultError('STORAGE_FAILED', 'Credential deletion could not be verified')
    }
    throw new CredentialVaultError('STORAGE_FAILED', 'Credential deletion could not be verified')
  }

  async migratePlaintext(value: string | undefined): Promise<'none' | 'migrated' | 'already_present'> {
    if (!value?.trim()) return 'none'
    const existing = await this.read()
    if (existing.status === 'configured') return 'already_present'
    await this.save(value)
    return 'migrated'
  }

  private async writeAtomically(encrypted: Buffer): Promise<void> {
    const directory = path.dirname(this.options.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.options.filePath}.${randomUUID()}.tmp`
    let temporaryCreated = false
    try {
      await writeFile(temporaryPath, encrypted, { flag: 'wx', mode: PRIVATE_FILE_MODE })
      temporaryCreated = true
      await chmod(temporaryPath, PRIVATE_FILE_MODE)
      await rename(temporaryPath, this.options.filePath)
      temporaryCreated = false
      const stat = await lstat(this.options.filePath)
      if (!isPrivateRegularFile(stat)) {
        throw new CredentialVaultError('STORAGE_FAILED', 'Credential vault file is invalid')
      }
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error
      throw new CredentialVaultError('STORAGE_FAILED', 'Credential vault write failed')
    } finally {
      if (temporaryCreated) {
        await unlink(temporaryPath).catch(() => undefined)
      }
    }
  }
}
