/** 合成SFC环境提供Vue使用的文档身份；不替换表单指令或产品行为。 */
const documents = new WeakSet<object>()
class SyntheticDocument {
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && documents.has(value)
  }
}
class SyntheticShadowRoot {}

export function installSyntheticDocumentRealm(document: object): () => void {
  const keys = ['document', 'Document', 'ShadowRoot'] as const
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  const values = [document, SyntheticDocument, SyntheticShadowRoot]
  documents.add(document)
  const restore = () => {
    keys.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]!)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  try {
    keys.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, value: values[i] }))
  } catch (error) {
    restore()
    throw error
  }
  return restore
}

/** 已挂载的平面树属于同一文档，脱离节点仍返回其实际树根。 */
export function syntheticRootNode<T extends { parent: T | null }>(node: T, mountedRoot: T | null, document: object): T | object {
  let root = node
  while (root.parent) root = root.parent
  return root === mountedRoot ? document : root
}
