import {
  CredentialVaultError,
  type CredentialVault,
  type CredentialVaultReadResult,
} from './credential-vault.js'

export type ProviderProvisioningStatus =
  | 'configured'
  | 'missing'
  | 'invalid'
  | 'unavailable'

export interface CoreCredentialPort {
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

  const stored = await options.vault.read()
  if (stored.status === 'configured') {
    await options.core.setCredential(stored.credential)
  }
  return statusFromReadResult(stored)
}

export async function restoreProviderCredential(options: {
  vault: CredentialVault
  core: CoreCredentialPort
}): Promise<ProviderProvisioningStatus> {
  const stored = await options.vault.read()
  if (stored.status === 'configured') {
    await options.core.setCredential(stored.credential)
  }
  return statusFromReadResult(stored)
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
