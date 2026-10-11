import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';
import { coreTestSourceInputs } from './run-core-tests.mjs';
import { readFixedMetadataWorkerBundle } from '../../packages/bridge-core/scripts/metadata-reader-bundle-artifacts.mjs';
import { CI_REPORT_MIRROR_ORIGINAL_TESTS, captureCiReportMirrorStage,
  ciReportMirrorGitEnvironment } from './verify-ci-report-mirror.mjs';
import { V39_INTEGRATION_TASK, V39_INTEGRATION_BRANCH, V39_INTEGRATION_BASE,
  V39_INTEGRATION_SOURCE_PARENT, V39_INTEGRATION_FAILED_SOURCE1, V39_INTEGRATION_FAILED_SOURCE2,
  V39_INTEGRATION_SOURCE_FILES, V39_INTEGRATION_SOURCE_DELTA_FILES,
  V39_INTEGRATION_REPORT_PATHS, V39_INTEGRATION_ADMISSION_CASE_NAMES, V39_INTEGRATION_REPORT_CASE_NAMES,
  inspectV39IntegrationAdmission, inspectV39IntegrationReportAdmission, v39IntegrationCanonicalPin } from './v39-integration-admission.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const external = '/Volumes/LifeWeave/Developer/CommandLine';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (value, root) => value.startsWith(root + path.sep);
const code = error => /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'V39_INTEGRATION_GATE_FAILED';
function refuse(value) { throw Object.assign(new Error('V3.9 Tape组合 Gate 拒绝。'), { code: value }); }
const check = deadline => { if (!Number.isFinite(deadline) || performance.now() >= deadline) refuse('V39_INTEGRATION_WHOLE_TIMEOUT'); };

export const V39_INTEGRATION_GATE_LIMITS = Object.freeze({ stageMs: 180_000, wholeMs: 480_000,
  rawBytesPerStream: 16 * 1024 * 1024, gitBytes: 16 * 1024 * 1024, gitMs: 10_000, ownerRequestMs: 2000 });
// 复用已验证捕获器的较小子限；没有扩大其90秒或产品180秒上限。
export const V39_INTEGRATION_EFFECTIVE_CAPTURE_MS = 90_000;
export const V39_INTEGRATION_SAFETY_CASE_NAMES = Object.freeze([
  '当前Main完整ZIP预览经真实Owner与持久outbox保留旧目录及个人关联',
  '当前进度缓存仅单操作复用且Tape历史事实在冷开后重新核对',
  '合成两库Owner自然关闭后隔离备份恢复保留回执与历史并释放真实资源',
  '组合Gate精确Tape74名称与完整TAP不能被缺例重复或skip替代',
  '组合Gate标准日志必须完整自然结束且原退出码与字节身份匹配',
  '组合Gate拒绝输出复用路径越界符号链与Node覆盖',
  '组合Gate当前准入与输入绑定不得以普通声明或漂移冒充',
  '组合Gate真实子进程自然退出完整raw与物理关闭',
  '组合Gate超时输出溢出与管道残留均不能写PASS',
  '组合Gate报告继承产品证据明确区分本轮执行和Source复用',
]);
export const V39_INTEGRATION_REPORT_SKIP = 'EXACT_PARENT_CURRENT_SOURCE_PRODUCT_EVIDENCE_REUSED_NOT_REPEATED';
export const V39_INTEGRATION_STAGE_NAMES = Object.freeze(['original-173', 'tape-74', 'integration-safety',
  'admission-safety', 'control-plane', 'boundaries', 'cycles']);
export const V39_INTEGRATION_EXPORT_ROOT_FILES = Object.freeze(['summary.json', 'source-before.json', 'source-after.json',
  'fresh-reader.json', 'verify.log', 'standard-verification.json', 'integration-case-proof.json',
  ...V39_INTEGRATION_STAGE_NAMES.flatMap(name => [`${name}.json`, `${name}.stdout.log`, `${name}.stderr.log`])]);

export const V39_INTEGRATION_TAPE_TESTS = Object.freeze([
  {
    "path": "apps/desktop/test/cassette-catalog-ui.test.ts",
    "expectedTests": 23,
    "expectedCaseNames": [
      "合成634条完整目录包含16条缺主图，同书多来源只读一次当前版次，不创建库存",
      "品牌→型号→原书年份仅做UI分组，同型号各年份与未知保留，IEC和系列差异可辨",
      "完整目录搜索型号、原书页与说明，品牌和带型筛选不混入库存事实",
      "读取身份已变化的目录不返回旧来源，当前发布来源不在首页时精确读取",
      "26个同书历史来源按25条分页完整收集，同书当前版次只读一次",
      "第二页的新书也读取当前条目，不把第一页结果静默当完整目录",
      "来源超过总预算、后页缺条目或总数漂移时明确失败，不返回截断目录",
      "归档原书图可作为同型号候选，缺主图与非法资产不补位，旧内嵌图继续可用",
      "完整ZIP选择只预览，确认后绑定原预览和dataset，未知回执仅恢复同一命令",
      "导入单飞，关闭后迟到回执不更新局部状态或触发目录导航",
      "取消重新选择保留原预览；选择失败不暴露Main文件路径",
      "实际关联审核面板接收资料条目后只读定位当前来源与review步骤，不触发库存写入",
      "实际完整详情组件切换条目时旧全文回执不能覆盖新条目，年份保持原书证据",
      "实际详情顶部优先原书原图，辅助画廊排除同一主图，兼容旧base资产",
      "实际资料浏览组件层级可回退，搜索结果直接打开具体reference，无需三次点击",
      "资料详情添加收藏只预填已知品牌型号和IEC，实物年份、版次、数量必须按原校验保存",
      "实际完整ZIP预览展示同ID资料字段更新数量和完整ID，兼容旧delta没有更新字段",
      "实际收藏页默认634新版，旧656可独立浏览且切换不丢库存参考候选",
      "旧历史读取失败保留当前目录和已读参考，迟到的旧读取不覆盖较新刷新",
      "历史头部缺根明确提示，已读历史与库存参考候选保留",
      "较新当前目录读取失败结束历史加载状态，旧异步完成不能覆盖失败提示",
      "资料范围切换清空旧详情与层级，历史详情阻止编辑关联但保留原库存入口与明确添加操作",
      "完整ZIP预览准确显示634新版与656旧编号保留，预览阶段不调用导入"
    ]
  },
  {
    "path": "apps/desktop/test/collection-reference-images.test.ts",
    "expectedTests": 9,
    "expectedCaseNames": [
      "同型号参考候选保留多个版次，不把 SA 当 SA-X，也不改变库存",
      "明确年份或版次不匹配时不拿相似图片补位",
      "书中图名允许空格大小写差异，不接受缺品牌的泛匹配",
      "只使用资料中明确登记的参考图别名，长度和颜色后缀不自动删除",
      "收藏墙在实物照片缺席时显示带来源的参考候选，详情保留全部版次",
      "参考图只读取每本书的当前发布版本，同书多个来源不重复读取",
      "参考来源超出加载预算或读取失败时不伪装为空目录",
      "历史目录严格按原revision和来源身份读取，旧关联不从当前目录回填",
      "历史链循环、错序或缺根明确拒绝，合法链按最近版次顺序保留旧编号"
    ]
  },
  {
    "path": "packages/contracts/test/reference-catalog.test.ts",
    "expectedTests": 23,
    "expectedCaseNames": [
      "参考图别名带核对说明且有界，不改变目录身份或默默吞掉冲突",
      "带图修订接受有界多图内容，原资料入口仍为1MiB且超大修订拒绝",
      "参考资料iec只接受字符串枚举，原JSON与IPC/outbox拒绝数组强制转换",
      "参考资料confidence只接受字符串枚举，原JSON与IPC/outbox拒绝数组强制转换",
      "目录审核status只接受字符串枚举，setMatch与IPC/outbox拒绝非字符串",
      "目录审核availability只接受字符串枚举，setMatch与IPC/outbox拒绝非字符串",
      "资料原文可保留BOM/空白，严格解析且不隐式生成来源",
      "完整目录支持654至2000条，数量与字节预算仍独立生效",
      "同参考项重复页及时长归并，冲突版次或重复canonical身份拒绝",
      "参考图只允许明确参考来源与受限内嵌JPEG，无外网或私有路径",
      "发布要求原基线指纹与确认；映射仅有限合并或拆分",
      "未匹配不等于Missing，候选/拆分待审不伪装已确认拥有",
      "snapshot是有界一致时点事实，不接受额外路径或不守恒counts",
      "新增写命令均进入有限outbox且响应按命令校验，读命令不能重放",
      "revision响应按字段事实比较match且历史snapshot不可串接其它canonical",
      "UTF8按字节限额，未知字段和稀疏数组不能绕过有界输入",
      "2000项完整目录响应保持关联保护，成员访问量随目录线性增长",
      "目录修订映射的成员校验保持完整，访问量随条目与映射数量增长",
      "档案绑定只携带完整ZIP哈希和安全逻辑主图编号，旧图片合同继续可用",
      "634项档案目录包含16个明确缺主图项目，仍使用1MiB原文预算且不以图片增加身份",
      "档案预览与导入请求绑定工作库和原基线，不接收路径、原文、图片或自定义映射",
      "保留ID的资料变化可在delta明确列出，旧预览兼容且变化只能指向保留成员",
      "历史保留证明只允许精确的退出编号集合和有界修订快照身份，写请求不能携带伪造证明"
    ]
  },
  {
    "path": "packages/bridge-core/test/reference-archive-catalog-store.test.ts",
    "expectedTests": 9,
    "expectedCaseNames": [
      "634项完整档案一次原子登记发布，16缺主图保持unknown且全部既有个人数据逐行守恒",
      "完整self mapping保留全部匹配状态和旧修订，资料字段变化明确列入preview delta",
      "同一来源原子发布失败回滚所有表，既有sources/revisions/links原样保留，原命令可明确重试",
      "相同ID身份改变在写入前阻断；缺席新版的ID须精确保留在原历史而不推测映射",
      "NFKC与大小写身份相同仍可自映射，非身份字段变化显式预览而不改旧referenceId",
      "档案哈希混用、超预算原文和附带未知字段均不能登记来源或写入目录",
      "预览绑定原文、工作库、匹配和库存事实，任一改变均拒绝旧指纹而不产生半条来源",
      "同ZIP同命令与新命令均幂等，后续用户改版后旧命令只返原回执且新导入禁止倒退",
      "archive-import回执和完整绑定通过冷开/只读备份校验，原命令结果与个人资料继续保留"
    ]
  },
  {
    "path": "packages/bridge-core/test/reference-catalog-retention.test.ts",
    "expectedTests": 10,
    "expectedCaseNames": [
      "656旧编号和634新编号零交集，旧库存关联/愿望/进度与个人数据保留，新资料不推断拥有",
      "部分交集仅沿用相同编号，退出当前版的关联保留在原修订而不自动迁移",
      "退出编号再次出现时核对其最近历史身份，不回填更早历史或绕过身份保护",
      "暖开库在预览后缺失旧快照时拒绝无证明导入，所有表相对故障注入后保持原值",
      "合法形状但匹配事实错误的旧快照不能作为历史保留证明",
      "旧库存合法变化允许新预览，预览后的库存变化使历史保留指纹失效",
      "暖开目录注入循环修订链后停止导入，不能仅凭旧编号存在而放行",
      "暖开目录注入错误顺序修订链后停止导入，不能仅凭旧编号存在而放行",
      "暖开目录注入缺根修订链后停止导入，不能仅凭旧编号存在而放行",
      "暖开目录注入跨书修订链后停止导入，不能仅凭旧编号存在而放行"
    ]
  }
].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(row => Object.freeze({ ...row, expectedCaseNames: Object.freeze(row.expectedCaseNames) })));

function git(directory, args, env, deadline) {
  check(deadline);
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', ...args], {
    cwd: directory, env: ciReportMirrorGitEnvironment(env), timeout: Math.max(1, Math.floor(Math.min(10_000, deadline - performance.now()))),
    maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  check(deadline);
  if (result.error || result.signal !== null || result.status !== 0) refuse('V39_INTEGRATION_GIT_READ_FAILED');
  return result.stdout;
}
function whole(filename, deadline, cap = 16 * 1024 * 1024) {
  check(deadline); const first = lstatSync(filename, { bigint: true });
  if (!first.isFile() || first.isSymbolicLink() || first.size > BigInt(cap) || realpathSync(filename) !== filename)
    refuse('V39_INTEGRATION_FILE_NOT_CLOSED');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true }), pieces = []; let at = 0;
    if (opened.dev !== first.dev || opened.ino !== first.ino) refuse('V39_INTEGRATION_FILE_CHANGED');
    while (at < Number(opened.size)) {
      check(deadline); const length = Math.min(1024 * 1024, Number(opened.size) - at);
      const bytes=Buffer.alloc(length),read=readSync(fd,bytes,0,length,at);
      if (read<1) refuse('V39_INTEGRATION_FILE_CHANGED');pieces.push(bytes.subarray(0,read));at+=read;check(deadline);
    }
    const bytes = Buffer.concat(pieces), after = fstatSync(fd, { bigint: true }), named = lstatSync(filename, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs']) if (opened[key] !== first[key]
      || after[key] !== opened[key] || named[key] !== opened[key]) refuse('V39_INTEGRATION_FILE_CHANGED');
    if (bytes.length !== Number(opened.size)) refuse('V39_INTEGRATION_FILE_CHANGED'); check(deadline);
    return { bytes, pin: { path: filename, bytes: bytes.length, sha256: digest(bytes) } };
  } finally { closeSync(fd); }
}
function leaf(directory, relative, deadline) {
  const read = whole(path.join(directory, relative), deadline), info = lstatSync(read.pin.path);
  return { path: relative, bytes: read.pin.bytes, sha256: read.pin.sha256, mode: info.mode & 0o111 ? '100755' : '100644', blob: blob(read.bytes) };
}
function writeJson(root, name, value) { writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function tree(directory, env, deadline) {
  return new Map(git(directory, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], env, deadline).split('\0').filter(Boolean).map(row => {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if (!match) refuse('V39_INTEGRATION_PRODUCT_TREE_INVALID'); return [match[3], { mode: match[1], blob: match[2] }];
  }));
}
function productInputs(directory, env, deadline) {
  const tracked = tree(directory, env, deadline), records = coreTestSourceInputs(() => check(deadline));
  const extra = ['pnpm-lock.yaml', ...[...tracked.keys()].filter(p => p.startsWith('apps/') || p.startsWith('packages/'))];
  const paths = [...new Set([...records.map(row => row.path), ...extra])].sort();
  return paths.map(relative => {
    const actual = leaf(directory, relative, deadline), expected = tracked.get(relative);
    if (!expected || actual.mode !== expected.mode || actual.blob !== expected.blob) refuse('V39_INTEGRATION_PRODUCT_NOT_ACTUAL_GIT');
    return actual;
  });
}
export function inspectV39IntegrationGateInputs(directory, env = process.env, deadline = performance.now() + 480_000) {
  const head = git(directory, ['rev-parse', 'HEAD'], env, deadline).trim();
  const parents = git(directory, ['rev-list', '--parents', '-n', '1', head], env, deadline).trim().split(' ');
  if (parents.length !== 2 || parents[0] !== head) refuse('V39_INTEGRATION_UNIQUE_PARENT_REQUIRED');
  if (head === V39_INTEGRATION_FAILED_SOURCE1) refuse('V39_INTEGRATION_FAILED_SOURCE1_CANNOT_QUALIFY');
  if (head === V39_INTEGRATION_FAILED_SOURCE2) refuse('V39_INTEGRATION_FAILED_SOURCE2_CANNOT_QUALIFY');
  const admission = parents[1] === V39_INTEGRATION_SOURCE_PARENT
    ? inspectV39IntegrationAdmission(directory, env, { deadline }) : inspectV39IntegrationReportAdmission(directory, env, { deadline });
  const repairRole = parents[1] === V39_INTEGRATION_SOURCE_PARENT ? 'source' : 'report';
  if (admission.task !== V39_INTEGRATION_TASK || admission.branch !== V39_INTEGRATION_BRANCH || admission.repairRole !== repairRole
    || admission.headAtAdmission !== head || admission.exactSourceFiles !== V39_INTEGRATION_SOURCE_FILES.length
    || admission.exactSourceDeltaFiles !== V39_INTEGRATION_SOURCE_DELTA_FILES.length || admission.sourceParentSha !== V39_INTEGRATION_SOURCE_PARENT
    || admission.failedSource1Preserved !== true || admission.failedSource2Preserved !== true || !admission.sourceCorrection || typeof admission.sourceCorrection !== 'object'
    || admission.sourceCorrectionSha256 !== v39IntegrationCanonicalPin(admission.sourceCorrection).sha256
    || admission.sealedBaselinePreserved !== true || admission.offlineTapeDonorVerified !== true || admission.currentProductSoftwareRequired !== true
    || !Array.isArray(admission.sourcePins) || admission.sourcePins.length !== V39_INTEGRATION_SOURCE_FILES.length)
    refuse('V39_INTEGRATION_CURRENT_ADMISSION_REQUIRED');
  const identity = { head, parent:parents[1], tree: git(directory, ['rev-parse', 'HEAD^{tree}'], env, deadline).trim(),
    branch: git(directory, ['branch', '--show-current'], env, deadline).trim(),
    status: git(directory, ['status', '--porcelain=v1', '--untracked-files=all'], env, deadline),
    gitDir: git(directory, ['rev-parse', '--path-format=absolute', '--git-dir'], env, deadline).trim(),
    commonDir: git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env, deadline).trim() };
  if (identity.status !== '' || identity.branch !== V39_INTEGRATION_BRANCH || identity.gitDir !== path.join(directory, '.git')
    || identity.commonDir !== identity.gitDir) refuse('V39_INTEGRATION_INDEPENDENT_CLEAN_SOURCE_REQUIRED');
  const sourcePaths = V39_INTEGRATION_SOURCE_FILES.map(row => typeof row === 'string' ? row : row.path);
  const reportPaths = V39_INTEGRATION_REPORT_PATHS.map(row => typeof row === 'string' ? row : row.path);
  const originalTests = CI_REPORT_MIRROR_ORIGINAL_TESTS.map(row => {
    const actual = leaf(directory, row.path, deadline);
    if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256 || actual.mode !== '100644') refuse('V39_INTEGRATION_ORIGINAL_173_INPUT_DRIFT');
    return { ...actual, expectedTests: row.expectedTests };
  });
  for (const historical of ['cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f', '99c89519f3357f4018b32930e8179b66719f99e7']) {
    // 实际依赖SHA以原闭集测试读取；不自动fetch缺失对象。
    git(directory, ['cat-file', '-e', historical + '^{commit}'], env, deadline);
  }
  const currentFiles = [...new Set([...sourcePaths, ...(repairRole === 'report' ? reportPaths : [])])].sort().map(p => leaf(directory, p, deadline));
  return { identity, admission, originalTests, currentFiles, productInputs: productInputs(directory, env, deadline) };
}

export function parseV39IntegrationTap(bytes, expectedNames = null, permittedSkips = []) {
  const text = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : String(bytes);
  const counts = {};
  for (const name of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'gmu'))];
    if (matches.length !== 1) refuse('V39_INTEGRATION_TAP_NOT_COMPLETE'); counts[name] = Number(matches[0][1]);
  }
  const plans = [...text.matchAll(/^1\.\.(\d+)\s*$/gmu)], cases = [...text.matchAll(/^(ok|not ok) (\d+) - (.*)$/gmu)].map(m => {
    const skip = / # SKIP(?: (.*))?$/u.exec(m[3]);
    return { status: m[1], ordinal: Number(m[2]), name: skip ? m[3].slice(0, skip.index) : m[3], skip: skip?.[1] ?? null };
  });
  if (plans.length !== 1 || Number(plans[0][1]) !== cases.length || counts.tests !== cases.length
    || counts.suites !== 0 || counts.fail !== 0 || counts.cancelled !== 0 || counts.todo !== 0
    || cases.some((row, i) => row.status !== 'ok' || row.ordinal !== i + 1)
    || counts.skipped !== cases.filter(row => row.skip !== null).length || counts.pass + counts.skipped !== counts.tests)
    refuse('V39_INTEGRATION_TAP_NOT_COMPLETE');
  if (expectedNames && (!equal([...cases.map(row => row.name)].sort(), [...expectedNames].sort())
    || new Set(cases.map(row => row.name)).size !== expectedNames.length)) refuse('V39_INTEGRATION_TAP_CASES_MISMATCH');
  if (!equal(cases.filter(row => row.skip !== null).map(row => ({ name: row.name, reason: row.skip })).sort((a,b) => a.name.localeCompare(b.name)),
    [...permittedSkips].sort((a,b) => a.name.localeCompare(b.name)))) refuse('V39_INTEGRATION_TAP_SKIP_NOT_DECLARED');
  return { counts, cases, complete: true };
}
export function inspectV39StandardRaw(bytes, exits) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 16 * 1024 * 1024
    || !Array.isArray(exits) || exits.length !== 2 || exits.some(value => value !== 0)) refuse('V39_INTEGRATION_STANDARD_FAILED');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), labels = ['tests','suites','pass','fail','cancelled','skipped','todo'];
  const headers = [...text.matchAll(/^TAP version 13[ \t]*\r?$/gmu)], skippedCases = [];
  if (headers.length !== 4 || !/fresh-contracts-compiler/u.test(text) || !/fresh-core-compiler/u.test(text) || !/fresh-fixed-metadata-worker/u.test(text)
    || !/electron-vite build/u.test(text) || !/built in/u.test(text)) refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
  const tapRuns = headers.map((header, index) => {
    const section = text.slice(header.index + header[0].length, headers[index + 1]?.index ?? text.length),
      counts = Object.fromEntries(labels.map(label => {
        const values = [...section.matchAll(new RegExp('^# ' + label + ' (\\d+)[ \\t]*\\r?$', 'gmu'))];
        if (values.length !== 1) refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
        return [label, Number(values[0][1])];
      }));
    const stack = [{ indent: 0, cases: 0, plan: null }]; let allCases = 0, allSkipped = 0;
    // Node的总tests包含嵌套子测试；各层1..N只统计本层，逐scope验证后再核完整总数。
    const scope = indentation => {
      if (indentation.includes('\t') || indentation.length % 4) refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
      const indent = indentation.length;
      while (stack.at(-1).indent > indent) {
        const closed = stack.pop();
        if (closed.plan === null || closed.plan !== closed.cases) refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
      }
      if (stack.at(-1).indent < indent) {
        if (indent !== stack.at(-1).indent + 4 || stack.at(-1).plan !== null) refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
        stack.push({ indent, cases: 0, plan: null });
      }
      return stack.at(-1);
    };
    for (const line of section.split(/\r?\n/u)) {
      const point = /^([ \t]*)(ok|not ok) (\d+) - (.*)$/u.exec(line), plan = /^([ \t]*)1\.\.(\d+)[ \t]*$/u.exec(line);
      if (point) {
        const current = scope(point[1]), skip = / # SKIP(?: (.*))?$/u.exec(point[4]);
        if (current.plan !== null || point[2] !== 'ok' || Number(point[3]) !== current.cases + 1 || / # TODO(?: |$)/u.test(point[4]))
          refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
        current.cases += 1; allCases += 1;
        if (skip) { allSkipped += 1; skippedCases.push({ name: point[4].slice(0, skip.index), reason: skip[1] ?? '' }); }
      } else if (plan) {
        const current = scope(plan[1]);
        if (current.plan !== null || Number(plan[2]) !== current.cases) refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
        current.plan = Number(plan[2]);
      } else if (/^[ \t]*Bail out!/u.test(line)) refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
    }
    if (stack.length !== 1 || stack[0].plan === null || stack[0].plan !== stack[0].cases || allCases !== counts.tests
      || counts.tests <= 0 || counts.suites !== 0 || counts.fail !== 0 || counts.cancelled !== 0 || counts.todo !== 0
      || counts.pass + counts.skipped !== counts.tests || allSkipped !== counts.skipped)
      refuse('V39_INTEGRATION_STANDARD_NOT_COMPLETE');
    return counts;
  });
  return { complete: true, tapRuns,
    totals: Object.fromEntries(labels.map(key => [key,tapRuns.reduce((sum,row) => sum + row[key],0)])), skippedCases,
    typesTestsAndBuildsNaturallySucceeded: true, mergedStandardRaw: true };
}

export function validateV39IntegrationGateArguments(argv, env = process.env) {
  if (!Array.isArray(argv) || argv.length % 2 || argv.some(value => typeof value !== 'string')) refuse('V39_INTEGRATION_ARGUMENTS_INVALID');
  const allowed = ['--output-root','--standard-verify-log','--standard-verify-receipt','--reader-preparation-receipt'], map = new Map();
  for (let at = 0; at < argv.length; at += 2) {
    if (!allowed.includes(argv[at]) || map.has(argv[at]) || !path.isAbsolute(argv[at+1]) || path.resolve(argv[at+1]) !== argv[at+1]
      || /[\r\n\0]/u.test(argv[at+1])) refuse('V39_INTEGRATION_ARGUMENTS_INVALID'); map.set(argv[at], argv[at+1]);
  }
  if (!map.has('--output-root') || map.has('--standard-verify-log') !== map.has('--standard-verify-receipt')) refuse('V39_INTEGRATION_ARGUMENTS_INVALID');
  if (!['linux','darwin'].includes(process.platform) || process.versions.node.split('.')[0] !== '22'
    || env.NODE_OPTIONS || env.NODE_PATH) refuse('V39_INTEGRATION_NODE22_POSIX_REQUIRED');
  const storage = buildStoragePolicy({ env }), outputRoot = storage.check(map.get('--output-root'));
  if (!storage.hosted && (storage.root !== external || statSync('/Volumes/LifeWeave').dev === statSync('/').dev
    || !within(outputRoot,path.join(external,'tmp')))) refuse('V39_INTEGRATION_EXTERNAL_VOLUME_REQUIRED');
  if (existsSync(outputRoot) || lstatSync(outputRoot,{throwIfNoEntry:false})) refuse('V39_INTEGRATION_OUTPUT_ALREADY_EXISTS');
  const parent = path.dirname(outputRoot), info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(parent) !== parent) refuse('V39_INTEGRATION_OUTPUT_PARENT_INVALID');
  // Source标准失败时receipt可能未产生；路径先核归属，缺件在独有root里留下失败证据。
  for (const flag of allowed.slice(1)) if (map.has(flag)) storage.check(map.get(flag),{kind:'file'});
  return { outputRoot, storage, standardLog: map.get('--standard-verify-log'), standardReceipt: map.get('--standard-verify-receipt'),
    readerReceipt: map.get('--reader-preparation-receipt') };
}
function readerDirectories(env) {
  const root = buildStoragePolicy({env}).check(env.TMPDIR,{mustExist:true});
  return readdirSync(root).filter(name => /^musicbridge-core-reader-[a-f0-9-]+$/u.test(name)).sort().map(name => path.join(root,name));
}
export function beginV39StandardVerification(directory = repository, env = process.env) {
  const startedAtMs = Date.now(), deadline = performance.now() + 180_000;
  const before = inspectV39IntegrationGateInputs(directory,env,deadline);
  if (before.admission.repairRole !== 'source') refuse('V39_INTEGRATION_STANDARD_SOURCE_ONLY');
  return { schema:'musicbridge.v39.integration.standard-before.v1', startedAtMs, directory,
    source:before, readerDirectories:readerDirectories(env) };
}
async function freshReader(filename, directory, env, deadline) {
  const storage = buildStoragePolicy({env}); storage.check(filename,{mustExist:true,kind:'file'});
  const raw = whole(filename,deadline), receipt = JSON.parse(raw.bytes), bindingFile = path.join(path.dirname(filename),'reader-build-binding.json');
  const bindingRaw = whole(bindingFile,deadline), binding = JSON.parse(bindingRaw.bytes);
  if (receipt.schema !== 'core-test.reader-preparation.v1' || receipt.status !== 'FRESH_READER_PREPARED'
    || receipt.inputsUnchanged !== true || receipt.outputsUnchanged !== true || receipt.readerBindingSha256 !== bindingRaw.pin.sha256
    || !Array.isArray(receipt.stages) || !equal(receipt.stages.map(row=>row.name),['fresh-contracts-compiler','fresh-core-compiler','fresh-fixed-metadata-worker'])
    || receipt.stages.some(row=>row.compilerExit !== 0 || !Number.isFinite(row.startedMs) || row.finishedMs < row.startedMs)
    || !Array.isArray(receipt.sourceInputs) || !receipt.sourceInputs.length || !Array.isArray(receipt.outputs) || !receipt.outputs.length)
    refuse('V39_INTEGRATION_FRESH_READER_INVALID');
  const tracked = tree(directory,env,deadline);
  for (const row of receipt.sourceInputs) {
    const actual=leaf(directory,row.path,deadline), expected=tracked.get(row.path);
    if (!expected || actual.blob!==expected.blob || actual.mode!==expected.mode || row.bytes!==actual.bytes || row.sha256!==actual.sha256)
      refuse('V39_INTEGRATION_READER_INPUT_NOT_CURRENT_SOURCE');
  }
  const currentOutputs = receipt.outputs.map(row => leaf(directory,row.path,deadline));
  // 标准入口在tests后再次build。旧准备时间只属于当次编译，不冒充最后build的mtime。
  for (const row of currentOutputs) if (!row.path.endsWith('.bundle.build.json')) {
    const declared=receipt.outputs.find(x=>x.path===row.path);
    if (row.bytes!==declared.bytes || row.sha256!==declared.sha256) refuse('V39_INTEGRATION_READER_OUTPUT_BYTES_CHANGED');
  }
  const fixed=await readFixedMetadataWorkerBundle(path.join(directory,'packages/bridge-core'),()=>check(deadline));
  const fixedRaw=whole(path.join(directory,'packages/bridge-core/dist/library/metadata-reader-worker.bundle.build.json'),deadline);
  return { receipt, binding, receiptPin:raw.pin, bindingPin:bindingRaw.pin,
    fixedWorkerReceipt:fixed.manifest, fixedWorkerReceiptPin:fixedRaw.pin, currentOutputs,
    sourceInputsIndependentlyMatchedToActualGit:receipt.sourceInputs.length, currentOutputBytesChecked:true,
    preparationIntervalsClaimedOnlyForTheirOriginalStages:true, currentWorkerIndependentlyVerified:true };
}
export async function finishV39StandardVerification(before, options, env = process.env) {
  const deadline=performance.now()+180_000;
  if (before?.schema!=='musicbridge.v39.integration.standard-before.v1' || before.directory!==repository
    || !Number.isFinite(before.startedAtMs) || before.startedAtMs>Date.now()) refuse('V39_INTEGRATION_STANDARD_BEFORE_INVALID');
  const after=inspectV39IntegrationGateInputs(repository,env,deadline), log=whole(options.logPath,deadline);
  const rawProof=inspectV39StandardRaw(log.bytes,[options.verifyExit,options.teeExit]);
  if (!equal(before.source,after)) refuse('V39_INTEGRATION_STANDARD_SOURCE_CHANGED');
  const readers=readerDirectories(env).filter(p=>!before.readerDirectories.includes(p));
  if (readers.length!==1) refuse('V39_INTEGRATION_CURRENT_STANDARD_READER_NOT_UNIQUE');
  const reader=await freshReader(path.join(readers[0],'preparation-receipt.json'),repository,env,deadline);
  if (reader.receipt.stages.some(row=>row.startedMs<before.startedAtMs || row.finishedMs>Date.now())) refuse('V39_INTEGRATION_READER_OUTSIDE_STANDARD_RUN');
  return { schema:'musicbridge.v39.integration.standard-verification.v1',status:'PASSED_CURRENT_SOURCE_STANDARD_VERIFICATION',
    task:V39_INTEGRATION_TASK,sourceSha:after.admission.sourceSha,scopeSha256:after.admission.scopeSha256,
    startedAtMs:before.startedAtMs,finishedAtMs:Date.now(),before:before.source,after,
    verifyExit:options.verifyExit,teeExit:options.teeExit,pipelineNaturallyEnded:true,
    physicalClosureClaim:'NATURAL_PNPM_AND_TEE_PIPELINE_EXIT_NOT_TOOL_GATE_PID_ATTESTATION',
    raw:log.pin,...rawProof,freshReader:reader };
}
export function retainV39StandardVerificationFiles(outputRoot, options, deadline) {
  const reads={log:null,receiptRaw:null,receipt:null,logFailure:null,receiptFailure:null};
  for(const [field,filename,target,failureField] of [['log',options.logPath,'verify.log','logFailure'],
    ['receiptRaw',options.receiptPath,'standard-verification.json','receiptFailure']]) {
    try {
      const raw=whole(filename,deadline);writeFileSync(path.join(outputRoot,target),raw.bytes,{flag:'wx',mode:0o600});reads[field]=raw;
    } catch(error) {
      reads[failureField]=error?.code==='ENOENT'?'V39_INTEGRATION_STANDARD_INPUT_MISSING':code(error);
    }
  }
  if(reads.receiptRaw) {
    try {reads.receipt=JSON.parse(reads.receiptRaw.bytes);}
    catch {reads.receiptFailure='V39_INTEGRATION_STANDARD_RECEIPT_INVALID_JSON';}
  } else {
    // 缺失原receipt时保存明确失败诊断；它不声明标准执行成功，也不能替代原producer收据。
    writeJson(outputRoot,'standard-verification.json',{
      schema:'musicbridge.v39.integration.standard-failure.v1',status:'FAILED_CURRENT_SOURCE_STANDARD_VERIFICATION',
      originalReceiptAvailable:false,pipelineExitCodesAttested:false,productVerificationRepeated:false,
      raw:reads.log?{path:'verify.log',bytes:reads.log.pin.bytes,sha256:reads.log.pin.sha256}:null,
      logFailure:reads.logFailure,receiptFailure:reads.receiptFailure,
      physicalClosureClaim:'NOT_ATTESTED_MISSING_OR_UNREADABLE_STANDARD_RECEIPT'});
  }
  const artifactReceipt=whole(path.join(outputRoot,'standard-verification.json'),deadline).pin;
  return {...reads,artifactRaw:reads.log?{path:'verify.log',bytes:reads.log.pin.bytes,sha256:reads.log.pin.sha256}:null,
    artifactReceipt:{path:'standard-verification.json',bytes:artifactReceipt.bytes,sha256:artifactReceipt.sha256}};
}
function stageOkay(stage) {
  return stage.passed===true && stage.exitCode===0 && stage.signal===null && stage.exitObserved===true && stage.closeObserved===true
    && stage.physicalShutdown?.pidAbsent===true && stage.physicalShutdown?.processGroupAbsent===true && stage.observedDescendantsAbsent===true
    && stage.rawCaptureComplete===true && ['timedOut','overflow','spawnFailed','interrupted','cleanupFailed','terminationRequested','lingeringOwnedGroup',
      'descendantScanFailed','rawForcedClosed','boundedSettleObserved','unexpectedPipeHolder'].every(key=>stage[key]===false)
    && stage.observedDescendants.every(row=>row.physicallyAbsent===true);
}
export function inspectV39IntegrationSafetyRaw(bytes, role) {
  if (!['source','report'].includes(role)) refuse('V39_INTEGRATION_ROLE_INVALID');
  return parseV39IntegrationTap(bytes,V39_INTEGRATION_SAFETY_CASE_NAMES,role==='report'
    ? V39_INTEGRATION_SAFETY_CASE_NAMES.slice(0,3).map(name=>({name,reason:V39_INTEGRATION_REPORT_SKIP})) : []);
}
// 只组织本次已取得的事实，不签发Source、Report或CI资格；真实运行和受控消费者fixture使用同一shape。
export function buildV39IntegrationGateSummary(input) {
  const {sourceBefore,sourceAfter,freshReader:reader,standardVerification,stages,temporaryCleanup:cleanup,
    startedAtMs,finishedAtMs,durationMs,artifactFiles}=input;
  let failure=input.failureCode;
  if(!Number.isFinite(durationMs)||durationMs<0||durationMs>=V39_INTEGRATION_GATE_LIMITS.wholeMs
    ||!Number.isFinite(startedAtMs)||!Number.isFinite(finishedAtMs)||finishedAtMs<startedAtMs)
    failure='V39_INTEGRATION_WHOLE_TIMEOUT';
  const role=sourceBefore?.admission?.repairRole??null;
  return {schema:'musicbridge.v39.integration.software-gate.v1',status:failure?'FAILED_CURRENT_SOFTWARE_GATE':'PASSED_CURRENT_SOFTWARE_GATE',
    task:V39_INTEGRATION_TASK,branch:V39_INTEGRATION_BRANCH,baseSha:V39_INTEGRATION_BASE,
    sourceParentSha:sourceBefore?.admission?.sourceParentSha??null,
    sourceCorrection:sourceBefore?.admission?.sourceCorrection??null,
    sourceCorrectionSha256:sourceBefore?.admission?.sourceCorrectionSha256??null,
    failedSource1Preserved:sourceBefore?.admission?.failedSource1Preserved===true,
    failedSource2Preserved:sourceBefore?.admission?.failedSource2Preserved===true,
    head:sourceBefore?.identity?.head??null,sourceSha:sourceBefore?.admission?.sourceSha??null,repairRole:role,
    startedAtMs,finishedAtMs,durationMs,limits:V39_INTEGRATION_GATE_LIMITS,effectiveCaptureStageMs:V39_INTEGRATION_EFFECTIVE_CAPTURE_MS,
    sourceBefore,sourceAfter,sourceUnchanged:Boolean(sourceBefore&&sourceAfter&&equal(sourceBefore,sourceAfter)),
    currentProductTestsRepeated:role==='source'&&stages.some(stage=>stage.name==='tape-74'),historicalResultsUsedAsCurrentPass:false,
    standardVerification,freshReader:reader,stages,originalTests:173,tapeTests:role==='source'?74:0,integrationTests:10,admissionTests:20,
    currentSoftwareGateExitCode:failure===null?0:1,expectedRegisteredTests:role==='source'?277:role==='report'?203:null,
    expectedPassedTests:role==='source'?277:role==='report'?200:null,expectedSkippedTests:role==='report'?3:0,
    temporaryCleanup:cleanup,failureCode:failure,passed:failure===null,artifactFiles,
    softwareEvidenceLayer:'SYNTHETIC_CURRENT_SOURCE_ONLY',realAppDeviceAudioOwner:'NOT_RUN'};
}
export async function runV39IntegrationGate(argv=process.argv.slice(2),env=process.env) {
  const began=performance.now(),startedAtMs=Date.now(),deadline=began+480_000;
  let config,sourceBefore,sourceAfter,reader=null,standardVerification=null,failure=null,temporaryIdentity=null,cleanup=null;
  const stages=[];
  try {
    config=validateV39IntegrationGateArguments(argv,env);
    mkdirSync(config.outputRoot,{mode:0o700}); const temporary=path.join(config.outputRoot,'tmp');mkdirSync(temporary,{mode:0o700});
    temporaryIdentity=lstatSync(temporary,{bigint:true});
    let standardFiles=null;
    if(config.standardLog) {
      standardFiles=retainV39StandardVerificationFiles(config.outputRoot,{logPath:config.standardLog,receiptPath:config.standardReceipt},deadline);
      standardVerification={status:'RAW_RETAINED_PENDING_CURRENT_SOURCE_VALIDATION',
        artifactRaw:standardFiles.artifactRaw,artifactReceipt:standardFiles.artifactReceipt,
        logFailure:standardFiles.logFailure,receiptFailure:standardFiles.receiptFailure};
    }
    sourceBefore=inspectV39IntegrationGateInputs(repository,env,deadline);
    const role=sourceBefore.admission.repairRole;
    if (role==='report' && (config.standardLog || config.readerReceipt)) refuse('V39_INTEGRATION_REPORT_PRODUCT_RERUN_REJECTED');
    if (role==='source') {
      if (config.standardLog) {
        if(standardFiles.logFailure||standardFiles.receiptFailure) refuse(standardFiles.logFailure??standardFiles.receiptFailure);
        const {log,receiptRaw:raw,receipt}=standardFiles;
        inspectV39StandardRaw(log.bytes,[receipt.verifyExit,receipt.teeExit]);
        if (receipt.schema!=='musicbridge.v39.integration.standard-verification.v1' || receipt.status!=='PASSED_CURRENT_SOURCE_STANDARD_VERIFICATION'
          || receipt.sourceSha!==sourceBefore.admission.sourceSha || receipt.scopeSha256!==sourceBefore.admission.scopeSha256
          || receipt.pipelineNaturallyEnded!==true || receipt.raw.bytes!==log.pin.bytes || receipt.raw.sha256!==log.pin.sha256
          || !equal(receipt.before,receipt.after) || !equal(receipt.after,sourceBefore)) refuse('V39_INTEGRATION_STANDARD_RECEIPT_NOT_CURRENT');
        reader=await freshReader(receipt.freshReader.receiptPin.path,repository,env,deadline);
        if (!equal(reader,receipt.freshReader)) refuse('V39_INTEGRATION_STANDARD_READER_CHANGED');
        standardVerification={status:'PASSED_CURRENT_SOURCE_STANDARD_VERIFICATION',receipt,receiptPin:raw.pin,
          artifactRaw:{path:'verify.log',bytes:log.pin.bytes,sha256:log.pin.sha256},artifactReceipt:{path:'standard-verification.json',bytes:raw.pin.bytes,sha256:raw.pin.sha256}};
      } else {
        if (config.storage.hosted || !config.readerReceipt) refuse('V39_INTEGRATION_CURRENT_STANDARD_OR_LOCAL_READER_REQUIRED');
        reader=await freshReader(config.readerReceipt,repository,env,deadline);
        standardVerification={status:'NOT_PROVIDED_LOCAL_GATE_CURRENT_SOURCE_LEAF_AND_COMPOSITION_ONLY',currentSourceStandardCiRequired:true};
      }
      sourceBefore={...sourceBefore,freshReader:reader};writeJson(config.outputRoot,'fresh-reader.json',reader);
    } else standardVerification={status:'NOT_REPEATED_EXACT_PARENT_CURRENT_PRODUCT_REUSE',sourceSha:sourceBefore.admission.sourceSha,
      currentReportStandardRepeated:false,parentSourceReceiptValidatedByActualAdmission:true};
    writeJson(config.outputRoot,'source-before.json',sourceBefore);
    const childEnv={...env,TMPDIR:path.join(config.outputRoot,'tmp'),NODE_ENV:'test',COREPACK_ENABLE_NETWORK:'0',
      V39_INTEGRATION_GATE_ROLE:role,V39_INTEGRATION_GATE_SOURCE_SHA:sourceBefore.admission.sourceSha,
      V39_INTEGRATION_GATE_DEADLINE:String(Date.now()+Math.max(1,deadline-performance.now()))};
    const require=createRequire(path.join(repository,'packages/bridge-core/package.json'));
    const loader=role==='source'?pathToFileURL(require.resolve('tsx/esm')).href:null;
    const capture=async(name,args,expectedTests=null,expectedCaseNames=null)=>{
      check(deadline);
      const result=await captureCiReportMirrorStage({directory:repository,outputRoot:config.outputRoot,name,args,env:childEnv,
        deadline,timeoutMs:90_000,expectedTests,expectedCaseNames});stages.push(result);
      if (!stageOkay(result)) refuse('V39_INTEGRATION_STAGE_NOT_COMPLETE');return result;
    };
    await capture('original-173',['--test','--test-reporter=tap',...CI_REPORT_MIRROR_ORIGINAL_TESTS.map(row=>row.path)],173);
    if (role==='source') await capture('tape-74',['--import',loader,'--test','--test-reporter=tap','--test-concurrency=1',
      ...V39_INTEGRATION_TAPE_TESTS.map(row=>row.path)],74,V39_INTEGRATION_TAPE_TESTS.flatMap(row=>row.expectedCaseNames));
    const safety=await capture('integration-safety',[...(loader?['--import',loader]:[]),'--test','--test-reporter=tap',
      '--test-concurrency=1','scripts/ci/test/v39-integration-gate.test.mjs'],role==='source'?10:null,role==='source'?V39_INTEGRATION_SAFETY_CASE_NAMES:null);
    const safetyRead=whole(path.join(config.outputRoot,safety.raw.stdout.path),deadline),safetyProof=inspectV39IntegrationSafetyRaw(safetyRead.bytes,role);
    writeJson(config.outputRoot,'integration-case-proof.json',{schema:'musicbridge.v39.integration.current-composition-cases.v1',
      role,sourceSha:sourceBefore.admission.sourceSha,raw:safety.raw.stdout,...safetyProof,
      sourceControlledProductCases:role==='source'?3:0,inheritedSourceProductCases:role==='report'?3:0,
      actualDeviceProviderAudioOwnerAcceptance:'NOT_RUN'});
    await capture('admission-safety',['--test','--test-reporter=tap','--test-concurrency=1',
      'scripts/ci/test/v39-integration-admission.test.mjs','scripts/ci/test/v39-integration-report-only.test.mjs'],20,
      [...V39_INTEGRATION_ADMISSION_CASE_NAMES,...V39_INTEGRATION_REPORT_CASE_NAMES]);
    const admissionStage=stages.at(-1);parseV39IntegrationTap(whole(path.join(config.outputRoot,admissionStage.raw.stdout.path),deadline).bytes,
      [...V39_INTEGRATION_ADMISSION_CASE_NAMES,...V39_INTEGRATION_REPORT_CASE_NAMES]);
    for (const [name,script,label] of [['control-plane','verify-control-plane.mjs','CONTROL_PLANE'],
      ['boundaries','verify-boundaries.mjs','BOUNDARIES'],['cycles','verify-cycles.mjs','CYCLES']]) {
      const stage=await capture(name,['scripts/ci/'+script]),raw=whole(path.join(config.outputRoot,stage.raw.stdout.path),deadline);
      if (!raw.bytes.toString('utf8').startsWith(label+'=PASS') || stage.raw.stderr.bytes!==0) refuse('V39_INTEGRATION_STATIC_CONTROL_FAILED');
    }
    if (role==='source') {
      const tape=stages.find(row=>row.name==='tape-74');parseV39IntegrationTap(whole(path.join(config.outputRoot,tape.raw.stdout.path),deadline).bytes,
        V39_INTEGRATION_TAPE_TESTS.flatMap(row=>row.expectedCaseNames));
      const afterReader=await freshReader(reader.receiptPin.path,repository,env,deadline);
      if (!equal(reader,afterReader)) refuse('V39_INTEGRATION_FRESH_READER_CHANGED_DURING_GATE');
    }
    sourceAfter=inspectV39IntegrationGateInputs(repository,env,deadline);
    if(role==='source')sourceAfter={...sourceAfter,freshReader:reader};writeJson(config.outputRoot,'source-after.json',sourceAfter);
    if (!equal(sourceBefore,sourceAfter)) refuse('V39_INTEGRATION_SOURCE_CHANGED_DURING_GATE');
    const current=lstatSync(path.join(config.outputRoot,'tmp'),{bigint:true});
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev!==temporaryIdentity.dev || current.ino!==temporaryIdentity.ino
      || (current.mode&0o777n)!==0o700n || realpathSync(path.join(config.outputRoot,'tmp'))!==path.join(config.outputRoot,'tmp')
      || !stages.every(stageOkay)) refuse('V39_INTEGRATION_OWNED_TMP_CLEANUP_NOT_QUALIFIED');
    check(deadline);rmSync(path.join(config.outputRoot,'tmp'),{recursive:true});check(deadline);
    cleanup={ownedFreshTemporaryRoot:true,allStageProcessesPhysicallyClosed:true,removed:true,sourceAndEvidenceNeverDeleted:true};
  } catch(error) {
    failure=code(error);
    if(standardVerification?.status==='RAW_RETAINED_PENDING_CURRENT_SOURCE_VALIDATION')
      standardVerification={...standardVerification,status:'FAILED_CURRENT_SOURCE_STANDARD_VERIFICATION',failureCode:failure};
    if(config&&existsSync(config.outputRoot)&&sourceBefore&&!existsSync(path.join(config.outputRoot,'source-before.json')))
      writeJson(config.outputRoot,'source-before.json',sourceBefore);
  }
  const durationMs=performance.now()-began;
  if (durationMs>=480_000) failure='V39_INTEGRATION_WHOLE_TIMEOUT';
  if (!config || !existsSync(config.outputRoot)) { console.error(failure??'V39_INTEGRATION_GATE_FAILED');return 1; }
  const result=buildV39IntegrationGateSummary({sourceBefore,sourceAfter,freshReader:reader,standardVerification,stages,temporaryCleanup:cleanup,
    failureCode:failure,startedAtMs,finishedAtMs:Date.now(),durationMs,
    artifactFiles:V39_INTEGRATION_EXPORT_ROOT_FILES.filter(name=>existsSync(path.join(config.outputRoot,name))||name==='summary.json')});
  writeJson(config.outputRoot,'summary.json',result);
  console.log('V39_INTEGRATION_GATE='+(result.passed?'PASS':'FAIL')+(failure?' code='+failure:''));return result.passed?0:1;
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  runV39IntegrationGate().then(value=>{process.exitCode=value;}).catch(()=>{console.error('V39_INTEGRATION_GATE_FAILED');process.exitCode=1;});
