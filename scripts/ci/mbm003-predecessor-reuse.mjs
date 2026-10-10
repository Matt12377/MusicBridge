import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateMobileDsdReportTask } from './report-only-mbm003.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const receiptPath = 'docs/postrust/MBM-003/PREDECESSOR_SOFTWARE_REUSE.json';
const receiptSha = '87cb1fcc67dc74013b7780cdf01e3ff0d44d756ee964938c23b0e37c266e1d4c';
const source = '7ec898d9f26cbafb5e01f5483bfaccf14ca61d27';
const report = 'd5189ecba0aaf266e7fa375613a7a99beffabc2e';
const base = 'b1a8de728086e7994bb69d7dee10782f646886dd';
const sha = b => createHash('sha256').update(b).digest('hex');
function whole(filename) {
  if (realpathSync(filename) !== filename) throw new Error('前序证据不能沿符号链。');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd, { bigint: true });
    if (!a.isFile() || a.size < 1n || a.size > 8n * 1024n * 1024n) throw new Error('前序证据不是有界普通文件。');
    const bytes = Buffer.alloc(Number(a.size)); let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length-at, null); if (!n) throw new Error('前序证据截短。'); at += n; }
    const same = b => ['dev','ino','size','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || !same(fstatSync(fd,{bigint:true})) || !same(lstatSync(filename,{bigint:true}))) throw new Error('前序证据读取时漂移。');
    return bytes;
  } finally { closeSync(fd); }
}
/** 只复用原 Source/R 软件证明；新任务仍必须运行自己的 Gate 和标准验证。 */
export function inspectMbm003PredecessorReuse(directory = root, env = process.env) {
  const json = name => JSON.parse(whole(path.join(directory, name)));
  const status = json('project/STATUS.json'), plan = json('project/POSTRUST_PLAN.json');
  const tasks = [status.currentMobileTask, status.mobileFrontloading20261008?.currentTask, plan.execution_schedule?.current_task];
  if (!tasks.includes('MBM-003')) return { task: 'legacy', oldGateEvidenceReused: false };
  if (locateMobileDsdReportTask(status, plan) !== 'MBM-003') throw new Error('003 authority、lane、schedule 或双表不一致。');
  const bytes = whole(path.join(directory, receiptPath));
  if (bytes.length !== 3058 || sha(bytes) !== receiptSha) throw new Error('003 前序复用收据身份不符。');
  const receipt = JSON.parse(bytes);
  if (receipt.source !== source || receipt.directReport !== report || receipt.base !== base || receipt.directReportSingleParent !== source
    || receipt.oldGatesRerun !== false || receipt.new003SourceGateRequired !== true || receipt.new003DeviceAudioOwnerProven !== false) throw new Error('003 前序复用边界错误。');
  for (const pin of receipt.frozenFiles) {
    const current = whole(path.join(directory,pin.path));
    if (current.length !== pin.bytes || sha(current) !== pin.sha256) throw new Error('原冻结 Gate 或报告已变，不能复用：'+pin.path);
  }
  const predecessor = json('docs/postrust/MBM-003/PREDECESSOR_DELIVERY.json');
  if (predecessor.macSource !== source || predecessor.macDirectSoftwareReport !== report || predecessor.macFinalMetadataHead !== base
    || predecessor.sourceAndDirectReportCi !== 'PASS_EXACT_FIRST_NATURAL_REUSED_UNCHANGED') throw new Error('003 前序绑定错误。');
  const git = args => execFileSync('git',args,{cwd:directory,encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim();
  if (git(['rev-list','--parents','-n','1',report]) !== report+' '+source) throw new Error('原 R 不是精确 Source 的唯一直接子提交。');
  git(['merge-base','--is-ancestor',base,'HEAD']);
  const branch = git(['branch','--show-current']) || env.GITHUB_REF_NAME;
  if (branch !== 'codex/mbm-003-lossless-dsd-transport') throw new Error('003 分支不符。');
  return { schema:'musicbridge.mbm003.predecessor-reuse-check.v1',task:'MBM-003',state:'EXACT_PREDECESSOR_SOFTWARE_REUSED',
    predecessorSource:source,predecessorDirectReport:report,predecessorFinalMetadata:base,receiptSha256:receiptSha,
    frozenFilesRead:receipt.frozenFiles.length,oldGateEvidenceReused:true,oldExecutionSha:source,
    current003SoftwareGateRequired:true,current003AppDeviceOwnerProven:false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectMbm003PredecessorReuse();
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,'task='+result.task+'\n',{flag:'a'});
  console.log(JSON.stringify(result));
}
