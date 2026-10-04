import { existsSync, lstatSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';

const external = '/Volumes/LifeWeave/Developer/CommandLine';
const within = (value, root) => value === root || value.startsWith(root + path.sep);
function canonical(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('构建路径必须明确为绝对目录。');
  const normalized = value.replace(/\/+$/u, '') || '/';
  if (path.resolve(normalized) !== normalized) throw new Error('构建路径不能包含非规范化分量。');
  return normalized;
}
export function buildStoragePolicy({ env = process.env, platform = process.platform } = {}) {
  const hosted = env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  let root;
  if (hosted) root = canonical(env.RUNNER_TEMP);
  else if (platform === 'darwin') {
    if (statSync('/Volumes/LifeWeave').dev === statSync('/').dev) throw new Error('LifeWeave外置卷必须真实挂载。');
    root = external;
  } else root = canonical(env.DEV_BUILD_ROOT ?? env.TMPDIR);
  const identity = lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || realpathSync(root) !== root) throw new Error('批准构建根必须是真实规范目录。');
  accessSync(root, constants.R_OK | constants.W_OK);
  function check(candidate, { mustExist = false, kind = 'directory' } = {}) {
    const target = canonical(candidate);
    if (!within(target, root) || target === root) throw new Error('构建目录必须位于批准根之下。');
    if (hosted && !/^musicbridge-[A-Za-z0-9-]+$/u.test(path.relative(root, target).split(path.sep)[0])) throw new Error('Hosted输出必须在专用MusicBridge子树。');
    let ancestor = target;
    while (!existsSync(ancestor)) {
      if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('构建目录不能包含断链。');
      const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error('构建目录没有有效祖先。'); ancestor = parent;
    }
    const info = lstatSync(ancestor);
    const validType = ancestor !== target ? info.isDirectory() : kind === 'file' ? info.isFile() : info.isDirectory();
    if (!validType || info.isSymbolicLink() || realpathSync(ancestor) !== ancestor || !within(realpathSync(ancestor), root) || info.dev !== identity.dev) throw new Error('构建目录真实身份越界。');
    if (mustExist && ancestor !== target) throw new Error('所需构建目录尚不存在。');
    return target;
  }
  return { root, hosted, check };
}
