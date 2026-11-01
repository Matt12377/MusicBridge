import { createServer, type Server } from 'node:net'

export interface LocalCorePorts {
  controlPort: number
  streamPort: number
}

export const DEFAULT_LOCAL_CORE_PORTS: Readonly<LocalCorePorts> = Object.freeze({ controlPort: 38501, streamPort: 38502 })
type LocalCorePortRole = 'control' | 'stream'
type LocalCorePortCode = 'CONFIG_INVALID' | 'EADDRINUSE' | 'EADDRNOTAVAIL' | 'EACCES' | 'UNKNOWN'

export class LocalCorePortError extends Error {
  constructor(readonly code: LocalCorePortCode, readonly role: LocalCorePortRole) {
    super(code === 'CONFIG_INVALID' ? '本地 Core 端口配置无效。' : `本地 Core ${role === 'control' ? '控制' : '媒体'}端口不可用。`)
    this.name = 'LocalCorePortError'
  }
}

export function parseLocalCorePort(value: string | undefined, fallback: number, role: LocalCorePortRole): number {
  const port = value === undefined || value.trim() === '' ? fallback : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LocalCorePortError('CONFIG_INVALID', role)
  return port
}

function portError(error: unknown, role: LocalCorePortRole): LocalCorePortError {
  let code: unknown
  try { code = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined } catch { /* 不读取异常正文。 */ }
  return new LocalCorePortError(code === 'EADDRINUSE' || code === 'EADDRNOTAVAIL' || code === 'EACCES' ? code : 'UNKNOWN', role)
}

async function listen(port: number, host: string, role: LocalCorePortRole): Promise<Server> {
  const server = createServer(socket => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: unknown) => { server.off('listening', ready); reject(error) }
      const ready = () => { server.off('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', ready)
      try { server.listen({ host, port, exclusive: true }) }
      catch (error) { server.off('error', failed); failed(error) }
    })
    return server
  } catch (error) {
    if (server.listening) await close(server)
    throw portError(error, role)
  }
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

/** 本地激活前的端口探测；不修改父环境，也不声称探测关闭后仍持有端口。 */
export async function selectLocalCorePorts(
  parent: NodeJS.ProcessEnv,
  options: { defaultPorts?: Readonly<LocalCorePorts> } = {},
): Promise<LocalCorePorts> {
  const defaults = options.defaultPorts ?? DEFAULT_LOCAL_CORE_PORTS
  const publicBase = parent.BRIDGE_PUBLIC_STREAM_BASE_URL?.trim()
  if (publicBase) {
    try { if (new URL(publicBase).protocol !== 'http:') throw new Error() }
    catch { throw new LocalCorePortError('CONFIG_INVALID', 'stream') }
  }
  const roles = ['control', 'stream'] as const
  const plans = roles.map(role => {
    const key = role === 'control' ? 'BRIDGE_CONTROL' : 'BRIDGE_STREAM'
    const host = parent[`${key}_HOST`]?.trim() || '127.0.0.1'
    if (host !== '127.0.0.1' && host !== '::1') throw new LocalCorePortError('CONFIG_INVALID', role)
    const value = parent[`${key}_PORT`]
    const port = parseLocalCorePort(value, role === 'control' ? defaults.controlPort : defaults.streamPort, role)
    // 显式public base保留原有路由语义；不能只换监听端口而留下旧媒体URL。
    const fixed = Boolean(value?.trim()) || role === 'stream' && Boolean(publicBase)
    return { role, host, port, fixed }
  })
  const control = plans[0]!, stream = plans[1]!
  if (control.fixed && stream.fixed && control.host === stream.host && control.port === stream.port) throw new LocalCorePortError('CONFIG_INVALID', 'stream')
  const servers: Server[] = []
  const selected: LocalCorePorts = { controlPort: 0, streamPort: 0 }
  let firstError: unknown
  const capture = async (plan: typeof control, port: number): Promise<void> => {
    const server = await listen(port, plan.host, plan.role)
    servers.push(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new LocalCorePortError('UNKNOWN', plan.role)
    selected[plan.role === 'control' ? 'controlPort' : 'streamPort'] = address.port
  }
  try {
    // 固定端口先占位，避免自动端口先占到另一角色明确指定的位置。
    const fallback: typeof plans = []
    for (const plan of [...plans].sort((left, right) => Number(right.fixed) - Number(left.fixed))) {
      try { await capture(plan, plan.port) }
      catch (error) {
        if (plan.fixed || !(error instanceof LocalCorePortError) || error.code !== 'EADDRINUSE') throw error
        fallback.push(plan)
      }
    }
    // 先保留其余空闲首选端口，随机回退不能把它们挤走。
    for (const plan of fallback) await capture(plan, 0)
    return selected
  } catch (error) {
    firstError = error
    throw error
  } finally {
    const results = await Promise.allSettled(servers.map(server => close(server)))
    const failed = results.find(result => result.status === 'rejected')
    if (firstError === undefined && failed?.status === 'rejected') throw new LocalCorePortError('UNKNOWN', 'control')
  }
}
