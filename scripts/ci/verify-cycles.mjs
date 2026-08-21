import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const sourceRoots = [
  'packages/contracts/src',
  'packages/bridge-core/src',
  'apps/desktop/src',
]

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(absolute)
    return /\.(ts|js|mjs)$/.test(entry.name) ? [absolute] : []
  })
}

const files = sourceRoots.flatMap((relative) => walk(path.join(root, relative)))
const fileSet = new Set(files)

function resolveImport(from, specifier) {
  if (!specifier.startsWith('.')) return undefined
  const base = path.resolve(path.dirname(from), specifier.replace(/\.(js|mjs)$/, ''))
  const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts')]
  return candidates.find((candidate) => fileSet.has(candidate))
}

const graph = new Map()
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const imports = [...source.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)]
    .map((match) => resolveImport(file, match[1]))
    .filter((value) => value !== undefined)
  graph.set(file, imports)
}

const visiting = new Set()
const visited = new Set()
const stack = []

function visit(file) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file)
    const cycle = [...stack.slice(start), file].map((item) => path.relative(root, item)).join('>')
    console.error(`CYCLES=FAIL reason=${cycle}`)
    process.exit(1)
  }
  if (visited.has(file)) return
  visiting.add(file)
  stack.push(file)
  for (const dependency of graph.get(file) ?? []) visit(dependency)
  stack.pop()
  visiting.delete(file)
  visited.add(file)
}

for (const file of files) visit(file)
console.log(`CYCLES=PASS files=${files.length}`)
