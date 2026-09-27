/** 视图与曲目各自持有最新请求身份；失效后迟到的成功和失败都不发布。 */
export function createPhysicalRelationRequestFence() {
  let generation = 0
  const current = (token: number, valid?: () => boolean): boolean => token === generation && (valid?.() ?? true)
  return {
    invalidate(): void { generation++ },
    version(): number { return generation },
    isCurrent(token: number, valid?: () => boolean): boolean { return current(token, valid) },
    async read<T>(request: () => Promise<T>, handlers: {
      success(value: T): void
      failure(error: unknown): void
      settled?(): void
      valid?(): boolean
    }): Promise<boolean> {
      const token = ++generation
      let value: T
      try { value = await request() }
      catch (error) {
        if (!current(token, handlers.valid)) return false
        try { handlers.failure(error) } finally { handlers.settled?.() }
        return false
      }
      if (!current(token, handlers.valid)) return false
      try { handlers.success(value) } finally { handlers.settled?.() }
      return true
    },
  }
}
