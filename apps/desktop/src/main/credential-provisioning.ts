import {
  CredentialVaultError,
  type CredentialVault,
  type CredentialVaultReadResult,
} from './credential-vault.js'

export type ProviderProvisioningStatus =
  | 'configured'
  | 'missing'
  | 'invalid'
  | 'expired'
  | 'unavailable'

export interface CoreCredentialPort {
  verifyCredential(credential: string): Promise<'authorized' | 'expired' | 'unavailable'>
  setCredential(credential: string): Promise<unknown>
  clearCredential(): Promise<unknown>
}

function statusFromReadResult(result: CredentialVaultReadResult): ProviderProvisioningStatus {
  return result.status
}

function statusFromMigrationError(error: unknown): ProviderProvisioningStatus {
  if (
    error instanceof CredentialVaultError &&
    error.code === 'SAFE_STORAGE_UNAVAILABLE'
  ) {
    return 'unavailable'
  }
  return 'invalid'
}

async function hydrateStoredCredential(options: {
  vault: CredentialVault
  core: CoreCredentialPort
  stored: CredentialVaultReadResult
}): Promise<ProviderProvisioningStatus> {
  if (options.stored.status !== 'configured') return statusFromReadResult(options.stored)

  let verification: 'authorized' | 'expired' | 'unavailable'
  try {
    verification = await options.core.verifyCredential(options.stored.credential)
  } catch {
    return 'unavailable'
  }
  if (verification === 'expired') {
    await options.vault.delete()
    return 'expired'
  }
  if (verification !== 'authorized') return 'unavailable'

  try {
    await options.core.setCredential(options.stored.credential)
  } catch {
    return 'unavailable'
  }
  return 'configured'
}

export async function provisionProviderCredential(options: {
  vault: CredentialVault
  core: CoreCredentialPort
  environment: NodeJS.ProcessEnv
}): Promise<ProviderProvisioningStatus> {
  const environmentCredential = options.environment.NETEASE_COOKIE
  try {
    await options.vault.migratePlaintext(environmentCredential)
  } catch (error) {
    delete options.environment.NETEASE_COOKIE
    return statusFromMigrationError(error)
  }
  delete options.environment.NETEASE_COOKIE

  return hydrateStoredCredential({
    vault: options.vault,
    core: options.core,
    stored: await options.vault.read(),
  })
}

export async function restoreProviderCredential(options: {
  vault: CredentialVault
  core: CoreCredentialPort
}): Promise<ProviderProvisioningStatus> {
  return hydrateStoredCredential({
    vault: options.vault,
    core: options.core,
    stored: await options.vault.read(),
  })
}

export async function logoutProviderCredential(options: {
  vault: CredentialVault
  core: CoreCredentialPort
}): Promise<void> {
  let coreError: unknown
  try {
    await options.core.clearCredential()
  } catch (error) {
    coreError = error
  }
  await options.vault.delete()
  if (coreError) throw coreError
}
