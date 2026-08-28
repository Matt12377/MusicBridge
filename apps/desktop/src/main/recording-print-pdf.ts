/**
 * 仅处理本次受信Chromium printToPDF产生的经典xref PDF。
 * Chromium先把纸宽向上量化；这里只去掉JP0右侧量化余白，不缩放正文或改写流。
 * 不接受任意外部PDF：未知xref/页树/几何形状全部拒绝，不能用近似metadata冒充尺寸。
 */
type PdfNumber = { kind: 'number'; value: number; start: number; end: number }
type PdfName = { kind: 'name'; value: string }
type PdfRef = { kind: 'ref'; id: number }
type PdfArray = { kind: 'array'; values: Value[] }
type PdfDict = { kind: 'dict'; values: Map<string, Value> }
type Value = PdfNumber | PdfName | PdfRef | PdfArray | PdfDict | { kind: 'boolean'; value: boolean }
const invalid = (): never => { throw new Error('J-Card PDF 页盒结构不受支持。') }

// 只解析有限字典/数组/名字/数值/引用；字符串、注释、流及压缩对象不进入页字典。
function dictionary(source: string, offset: number): PdfDict {
  if (source.length > 65_536) return invalid()
  let cursor = 0, tokens = 0
  const space = () => { while (/[\x00\t\n\f\r ]/u.test(source[cursor] ?? 'x')) cursor++ }
  const name = (): string => {
    const match = /^\/([A-Za-z0-9_.+-]+)/u.exec(source.slice(cursor))
    if (!match) return invalid()
    cursor += match[0].length; return match[1]!
  }
  const number = (): PdfNumber => {
    const start = cursor, match = /^-?(?:\d+\.?\d*|\.\d+)/u.exec(source.slice(cursor))
    if (!match || !Number.isFinite(Number(match[0]))) return invalid()
    cursor += match[0].length
    return { kind: 'number', value: Number(match[0]), start: offset + start, end: offset + cursor }
  }
  const read = (depth: number): Value => {
    if (++tokens > 20_000 || depth > 10) return invalid()
    space()
    if (source.startsWith('<<', cursor)) {
      cursor += 2; const values = new Map<string, Value>()
      for (;;) {
        space(); if (source.startsWith('>>', cursor)) { cursor += 2; return { kind: 'dict', values } }
        const key = name(); if (values.has(key)) return invalid()
        values.set(key, read(depth + 1))
      }
    }
    if (source[cursor] === '[') {
      cursor++; const values: Value[] = []
      for (;;) { space(); if (source[cursor] === ']') { cursor++; return { kind: 'array', values } } values.push(read(depth + 1)) }
    }
    if (source[cursor] === '/') return { kind: 'name', value: name() }
    for (const word of ['true', 'false']) if (source.startsWith(word, cursor)) { cursor += word.length; return { kind: 'boolean', value: word === 'true' } }
    const result = number(), end = cursor
    // 引用必须精确为非零对象、generation 0；普通相邻数组数值不会被吞掉。
    space()
    if (Number.isSafeInteger(result.value) && result.value > 0 && /^0\s+R(?:\s|[\]>]|$)/u.test(source.slice(cursor))) {
      cursor += /^0\s+R/u.exec(source.slice(cursor))![0].length; return { kind: 'ref', id: result.value }
    }
    cursor = end; return result
  }
  const value = read(0); space()
  if (value.kind !== 'dict' || cursor !== source.length) return invalid()
  return value
}
const exactKeys = (dict: PdfDict, allowed: readonly string[]) => { if ([...dict.values.keys()].some(key => !allowed.includes(key))) return invalid() }
const numberValue = (value?: Value): number => value?.kind === 'number' ? value.value : invalid()
const reference = (value?: Value): number => value?.kind === 'ref' ? value.id : invalid()
const named = (value: Value | undefined, name: string): boolean => value?.kind === 'name' && value.value === name

interface Page { id: number; width: PdfNumber; height: PdfNumber }
function inspect(pdf: Buffer, expectedPages: number): Page[] {
  if (!Buffer.isBuffer(pdf) || pdf.length < 12 || pdf.length > 4_194_304 || !Number.isInteger(expectedPages) || expectedPages < 1 || expectedPages > 24) return invalid()
  const source = pdf.toString('latin1')
  if (!source.startsWith('%PDF-1.')) return invalid()
  const footer = /startxref\n([0-9]{1,10})\n%%EOF\n?$/u.exec(source)
  if (!footer) return invalid()
  const xrefOffset = Number(footer[1]), header = /^xref\n0 ([1-9]\d*)\n/u.exec(source.slice(xrefOffset))
  if (!header || xrefOffset >= footer.index) return invalid()
  const count = Number(header[1]); if (count < 4 || count > 20_000) return invalid()
  let cursor = xrefOffset + header[0].length
  if (source.slice(cursor, cursor + 20) !== '0000000000 65535 f \n') return invalid()
  cursor += 20
  const offsets: Array<{ id: number; offset: number }> = []
  for (let id = 1; id < count; id++, cursor += 20) {
    const entry = /^(\d{10}) 00000 n \n$/u.exec(source.slice(cursor, cursor + 20))
    if (!entry) return invalid()
    const offset = Number(entry[1]); if (offset < 9 || offset >= xrefOffset) return invalid()
    offsets.push({ id, offset })
  }
  if (source.slice(cursor, cursor + 8) !== 'trailer\n') return invalid()
  const trailer = dictionary(source.slice(cursor + 8, footer.index), cursor + 8)
  exactKeys(trailer, ['Size', 'Root', 'Info'])
  if (numberValue(trailer.values.get('Size')) !== count) return invalid()
  const root = reference(trailer.values.get('Root'))
  if (trailer.values.has('Info')) reference(trailer.values.get('Info'))
  offsets.sort((a, b) => a.offset - b.offset)
  const bodies = new Map<number, { source: string; offset: number }>(), allPageIds = new Set<number>()
  for (const [index, entry] of offsets.entries()) {
    const end = offsets[index + 1]?.offset ?? xrefOffset, segment = source.slice(entry.offset, end), prefix = `${entry.id} 0 obj\n`
    if (!segment.startsWith(prefix) || !segment.endsWith('\nendobj\n')) return invalid()
    const body = { source: segment.slice(prefix.length, -8), offset: entry.offset + prefix.length }
    bodies.set(entry.id, body)
    if (body.source.startsWith('<</Type /Page\n')) allPageIds.add(entry.id)
    if (body.source.startsWith('<</Type /ObjStm') || body.source.startsWith('<</Type /XRef')) return invalid()
  }
  const object = (id: number): PdfDict => { const body = bodies.get(id); return body ? dictionary(body.source, body.offset) : invalid() }
  const catalog = object(root); exactKeys(catalog, ['Type', 'Pages', 'ViewerPreferences'])
  if (!named(catalog.values.get('Type'), 'Catalog')) return invalid()
  if (catalog.values.has('ViewerPreferences')) {
    const prefs = catalog.values.get('ViewerPreferences')!
    if (prefs.kind !== 'dict') return invalid()
    exactKeys(prefs, ['Type', 'DisplayDocTitle'])
    if (!named(prefs.values.get('Type'), 'ViewerPreferences') || prefs.values.get('DisplayDocTitle')?.kind !== 'boolean') return invalid()
  }
  const visited = new Set<number>(), pages: Page[] = []
  const visit = (id: number, parent?: number): number => {
    if (visited.has(id) || visited.size > 48) return invalid()
    visited.add(id)
    const dict = object(id)
    if (parent === undefined ? dict.values.has('Parent') : reference(dict.values.get('Parent')) !== parent) return invalid()
    if (named(dict.values.get('Type'), 'Pages')) {
      exactKeys(dict, ['Type', 'Count', 'Kids', 'Parent'])
      const kids = dict.values.get('Kids')
      if (kids?.kind !== 'array' || !kids.values.length || kids.values.length > 24) return invalid()
      const total = kids.values.reduce((sum, kid) => sum + visit(reference(kid), id), 0)
      if (total !== numberValue(dict.values.get('Count'))) return invalid()
      return total
    }
    exactKeys(dict, ['Type', 'Resources', 'MediaBox', 'Contents', 'Tabs', 'Parent'])
    if (!named(dict.values.get('Type'), 'Page') || dict.values.get('Resources')?.kind !== 'dict' || !bodies.has(reference(dict.values.get('Contents')))) return invalid()
    if (dict.values.has('Tabs') && !named(dict.values.get('Tabs'), 'S')) return invalid()
    const box = dict.values.get('MediaBox')
    if (box?.kind !== 'array' || box.values.length !== 4 || !box.values.every(value => value.kind === 'number')) return invalid()
    const [x, y, width, height] = box.values as PdfNumber[]
    if (x!.value !== 0 || y!.value !== 0 || height!.value !== 288 || !(width!.value === 292.5 || Math.abs(width!.value - 293.04001) <= 0.00001)) return invalid()
    pages.push({ id, width: width!, height: height! }); if (pages.length > 24) return invalid()
    return 1
  }
  if (visit(reference(catalog.values.get('Pages'))) !== expectedPages || pages.length !== allPageIds.size || pages.some(page => !allPageIds.has(page.id))) return invalid()
  return pages
}

export function normalizeRecordingPrintPdf(pdf: Buffer, expectedPages: number): Buffer {
  const pages = inspect(pdf, expectedPages), result = Buffer.from(pdf)
  for (const page of pages) {
    const token = '292.5', length = page.width.end - page.width.start
    if (length < token.length) return invalid()
    result.write(token.padEnd(length, ' '), page.width.start, length, 'ascii')
  }
  const verified = inspect(result, expectedPages)
  if (result.length !== pdf.length || verified.some((page, index) => page.width.value !== 292.5 || page.id !== pages[index]?.id || page.width.start !== pages[index]?.width.start)) return invalid()
  return result
}
