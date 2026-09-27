/** 同一发行版的历史分页、刷新和关系变更共用一个最新请求身份。 */
export function createPhysicalLinkHistoryFence() {
  let generation = 0
  return {
    invalidate(): void { generation++ },
    async read<T>(request: () => Promise<T>, publish: (value: T) => void): Promise<boolean> {
      const current = ++generation
      let value: T
      try { value = await request() }
      catch (error) { if (current !== generation) return false; throw error }
      if (current !== generation) return false
      publish(value)
      return true
    },
  }
}
