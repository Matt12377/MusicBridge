import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** 核验代码或合同变化即撤销旧缓存；界面调整不改变这个身份。 */
export async function captureLocalAuditImplementation(root) {
  const digest = createHash('sha256');
  async function visit(relative) {
    const file = path.join(root, relative), info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('核验实现输入不能是链接。');
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(relative + '/' + name);
    } else if (info.isFile()) {
      const bytes = await readFile(file);
      digest.update(relative + '\0' + bytes.length + '\0').update(bytes);
    } else throw new Error('核验实现输入必须是普通文件。');
  }
  await visit('packages/contracts/src');
  await visit('packages/bridge-core/src');
  return digest.digest('hex');
}
