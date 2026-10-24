import assert from 'node:assert/strict'
import test from 'node:test'
import { captureSourceWorkbenchDirectoryPhysical } from '../src/collection/source-writes-authority.js'
import { readLibraryDirectoryStructureBytes, type LibraryDirectoryPhysical } from '../src/library/fsevents-library-monitor.js'
import { isCanonicalNodeStatInode, nodeStatInodeAsUnsignedDecimal } from '../src/shared/filesystem-inode.js'

const physical = { path: '/synthetic/library', dev: '1', ino: '-3556428480154677835', birthtimeNs: '1780728792000000000', mode: '16832', uid: '501', gid: '20' }

test('SMB目录编号：私有许可保留Node有符号原值，Native边界转换同一个64位inode', () => {
  for (const [node, native] of [['-3556428480154677835', '14890315593554873781'], ['-9223372036854775808', '9223372036854775808'], ['-1', '18446744073709551615'], ['0', '0'], ['18446744073709551615', '18446744073709551615']]) {
    assert.equal(captureSourceWorkbenchDirectoryPhysical({ ...physical, ino: node }).ino, node)
    assert.equal(nodeStatInodeAsUnsignedDecimal(node!), native)
    assert.equal(nodeStatInodeAsUnsignedDecimal(BigInt(node!)), native)
  }
})

test('SMB目录编号：拒绝非规范和越界inode，其余物理字段仍拒负数', () => {
  for (const ino of ['-9223372036854775809', '18446744073709551616', '-0', '-00', '00', '+1', '1.0', '1e2', ' 1', '', 'NaN', '9'.repeat(100), null, 1]) {
    assert.equal(isCanonicalNodeStatInode(ino), false)
    assert.throws(() => captureSourceWorkbenchDirectoryPhysical({ ...physical, ino }))
    if (typeof ino === 'string') assert.throws(() => nodeStatInodeAsUnsignedDecimal(ino), RangeError)
  }
  for (const field of ['dev', 'birthtimeNs', 'mode', 'uid', 'gid']) assert.throws(() => captureSourceWorkbenchDirectoryPhysical({ ...physical, [field]: '-1' }))
})

test('SMB目录编号：Native完整物理帧只接受同inode的u64回显，不能借规范化接受换根或溢出', () => {
  const { path: _path, ...raw } = physical
  const expected: LibraryDirectoryPhysical = { ...raw, ino: nodeStatInodeAsUnsignedDecimal(raw.ino) }
  const facts = { schema: 'musicbridge.directory-structure.fd.v1', bounds: { depth: 2, entries: 256, childFds: 12 }, root: expected,
    directories: [{ ...expected, relative: '', entries: [] }], entriesRead: 0, childDirectoriesOpened: 0, bounded: false,
    physicalClosed: { inputFd: true, duplicateRootFd: true, childDirectoryFds: true, directoryStreams: true } }
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
  assert.deepEqual(JSON.parse(JSON.stringify(readLibraryDirectoryStructureBytes(bytes(facts), expected))), facts)
  for (const ino of ['14890315593554873782', raw.ino, '18446744073709551616']) {
    const changed = structuredClone(facts); changed.root.ino = ino; changed.directories[0]!.ino = ino
    assert.throws(() => readLibraryDirectoryStructureBytes(bytes(changed), expected))
  }
  const overflow = { ...expected, ino: '18446744073709551616' }
  const changed = structuredClone(facts); changed.root = overflow; changed.directories[0] = { ...overflow, relative: '', entries: [] }
  assert.throws(() => readLibraryDirectoryStructureBytes(bytes(changed), overflow))
})
