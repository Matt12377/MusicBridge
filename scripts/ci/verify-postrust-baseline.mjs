import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordRoot = 'docs/postrust/MBRS-000';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const base = '044e6b24edf81b64030d4c96741082670532971c';
// 原v1.2包独立固定摘要，不能跟随待审台账同步重封。
const packAcceptanceSha256 = '19edef0a2a16c8516517d1262396414e25569898e6eb40d58fb1b2032c2d75a4';
const packTaskboardSha256 = 'b26a933bc7ef84a80c32f417a6a39af9386c6e35f9af9a87c6bc01f6c2a8deec';

// 只校验记录、来源和结构；此入口不执行应用、不判断授权真实性。
export function schemaErrors(value, schema, at = '$') {
  const errors = [];
  const fail = reason => errors.push(`${at}：${reason}`);
  const isType = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (schema.type && ![].concat(schema.type).some(isType)) { fail('类型不匹配'); return errors; }
  if ('const' in schema && value !== schema.const) fail('常量不匹配');
  if (schema.enum && !schema.enum.includes(value)) fail('枚举不匹配');
  if (schema.anyOf && !schema.anyOf.some(candidate => schemaErrors(value, candidate, at).length === 0)) fail('不满足anyOf');
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('字符串过短');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('字符串过长');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('格式不匹配');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('数组过短');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('数组过长');
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${at}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) fail(`缺少${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaErrors(item, schema.properties[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) fail(`多余字段${key}`);
    }
  }
  for (const clause of schema.allOf ?? []) {
    if (!clause.if || schemaErrors(value, clause.if, at).length === 0) errors.push(...schemaErrors(value, clause.then ?? clause, at));
    else if (clause.else) errors.push(...schemaErrors(value, clause.else, at));
  }
  return errors;
}

export function loadRecords(directory = root) {
  const json = relative => JSON.parse(readFileSync(path.join(directory, relative), 'utf8'));
  const source = `${recordRoot}/`;
  return {
    admission: json(source + 'ADMISSION_DECISION.json'), schema: json(source + 'ADMISSION_SCHEMA.json'),
    inputs: json(source + 'BASELINE_INPUTS.json'), reuse: json(source + 'REUSE_MAP_RESOLVED.json'),
    carry: json(source + 'RUST_TO_MBRS_RESOLVED.json'), plan: json('project/POSTRUST_PLAN.json'),
    frozenTasks: json(source + 'PACK_TASKBOARD.json'), frozenAcceptance: json(source + 'PACK_ACCEPTANCE.json'),
    todoLines: execFileSync('git', ['show', `${base}:project/RUST_CORE_TODO.md`], { cwd: directory, encoding: 'utf8' }).split('\n'),
  };
}

export function validateRecords(records) {
  const { admission, schema, inputs, reuse, carry, plan, frozenTasks, frozenAcceptance, todoLines } = records;
  const errors = schemaErrors(admission, schema);
  const check = (condition, code) => { if (!condition) errors.push(code); };
  check(inputs.base_sha === base && plan.base_sha === base && carry.base_sha === base, 'BASE_IDENTITY');
  check(plan.source_acceptance_sha256 === packAcceptanceSha256 && plan.source_taskboard_sha256 === packTaskboardSha256, 'PACK_SOURCE_PIN');
  check(admission.final_report_commit === base && admission.implementation_commit === inputs.implementation_commit, 'COMMIT_IDENTITY');
  check(admission.kind === 'HANDOFF_RECORD_NOT_AUTHORIZATION' && !admission.is_synthetic, 'REAL_RECORD_REQUIRED');
  check(!admission.full_rust_migration_completed && !carry.full_rust_migration_completed, 'FULL_MIGRATION_NOT_COMPLETED');
  check(admission.mode === 'EXPLICIT_PHASE_HANDOFF' && plan.g0_mode === admission.mode, 'PHASE_HANDOFF_SCOPE');
  check(admission.decision === plan.g0_decision, 'G0_DECISION_MISMATCH');
  check(admission.exit_items.length > 0, 'EXIT_ITEMS_REQUIRED');
  if (admission.exit_items.some(item => item.required_for_admission && item.status !== 'PASS')) check(admission.decision === 'NOT_ADMITTED', 'OPEN_PREREQUISITE_BLOCKS_G0');
  check(admission.exit_items.some(item => item.id === 'R15-C06' && item.required_for_admission && item.status === 'OPEN'), 'C06_REMAINS_OPEN');
  const databaseOwners = new Map();
  for (const owner of admission.component_owners) {
    if (!owner.database_id) continue;
    check(Boolean(owner.writer_id), 'DATABASE_REQUIRES_WRITER');
    check(!databaseOwners.has(owner.database_id), 'DATABASE_DUPLICATE_OWNER');
    databaseOwners.set(owner.database_id, owner.writer_id);
  }
  check(databaseOwners.get('owned-dataset-sqlite') === 'node-dataset-owner-worker', 'NODE_WRITER_PRESERVED');
  check(databaseOwners.get('backup-maintenance.v1.sqlite') === 'node-dataset-owner-worker', 'BACKUP_WRITER_PRESERVED');
  check(databaseOwners.get('command-outbox.v1.sqlite') === 'electron-main-command-outbox-store', 'MAIN_OUTBOX_WRITER_PRESERVED');
  check(admission.component_owners.filter(owner => owner.language === 'Rust').every(owner => owner.writer_id === null && owner.database_id === null), 'RUST_READONLY');
  const actualOpen = todoLines.flatMap((line, index) => /^- \[ \] /.test(line) ? [{ line: index + 1, text: line }] : []);
  check(carry.source_open_checkbox_count === actualOpen.length && carry.entries.length === actualOpen.length, 'ALL_OPEN_TODO_COUNT');
  check(new Set(carry.entries.map(item => item.source.line)).size === carry.entries.length, 'TODO_UNIQUE_SOURCE_LINE');
  for (const source of actualOpen) check(carry.entries.some(item => item.source.line === source.line && item.source.text === source.text), 'ALL_OPEN_TODO_COVERAGE');
  for (const item of carry.entries) {
    check(typeof item.primary_task === 'string' && item.primary_task.length > 0 && item.primary_task !== 'RUST_TRACK', 'UNIQUE_RESOLVED_PRIMARY_TASK');
    check(item.acceptance_owner === item.primary_task, 'ACCEPTANCE_OWNER_MISMATCH');
    check(item.transfer_is_completion === false && item.status === 'OPEN', 'TRANSFER_NOT_COMPLETION');
    if (item.g0_prerequisite === 'YES') check(!/^MBRS-00[2-9]|^MBRS-01[0-7]/.test(item.primary_task), 'G0_REVERSE_DEPENDENCY');
    check(item.source.base_sha === base && item.source.git_blob === carry.source.git_blob && item.source.sha256 === carry.source.sha256, 'TODO_SOURCE_IDENTITY');
    if (item.primary_task.startsWith('RUST-0')) {
      const registration = carry.planned_task_registry.find(task => task.task === item.primary_task);
      check(Boolean(registration && registration.source_items.includes(item.id) && registration.scope && registration.status === 'PLANNED_NOT_STARTED_REQUIRES_FROZEN_TASK'), 'PLANNED_TASK_REGISTRATION');
    }
  }
  check(reuse.entries.length === 12 && new Set(reuse.entries.map(item => item.id)).size === 12, 'REUSE_COMPLETE_UNIQUE');
  for (let i = 1; i <= 12; i++) check(reuse.entries.some(item => item.id === `REUSE-${String(i).padStart(2, '0')}`), 'REUSE_ID_COVERAGE');
  for (const item of reuse.entries) {
    check(Boolean(item.primary_task && item.minimal_delta && item.do_not_rebuild), 'REUSE_BOUNDARY_REQUIRED');
    check(item.base_sha === base && item.resolved_files.length > 0, 'REUSE_SOURCE_REQUIRED');
    check(item.resolved_files.some(file => file.exports.length > 0), 'REUSE_SYMBOL_REQUIRED');
    for (const file of item.resolved_files) {
      const frozen = inputs.source_inputs.find(input => input.path === file.path);
      check(Boolean(frozen && frozen.git_blob === file.git_blob && frozen.sha256 === file.sha256 && frozen.bytes === file.bytes), 'REUSE_BLOB_IDENTITY');
    }
  }
  check(plan.tasks.length === 18 && new Set(plan.tasks.map(task => task.id)).size === 18, 'TASK_COUNT_IDENTITY');
  check(plan.acceptance_count === 156 && plan.acceptance_cases.length === 156, 'ACCEPTANCE_COUNT');
  check(new Set(plan.acceptance_cases.map(item => item.id)).size === 156, 'ACCEPTANCE_UNIQUE');
  for (const original of frozenAcceptance.cases) {
    const current = plan.acceptance_cases.find(item => item.id === original.id);
    check(Boolean(current && ['task', 'kind', 'requirement', 'release_scope', 'introduced_in'].every(key => current[key] === original[key])), 'ACCEPTANCE_ASSERTION_PRESERVED');
    if (current) {
      check(['NOT_TESTED', 'PASS', 'PARTIAL', 'BLOCKED_ENV', 'FAIL', 'NEEDS_REVIEW'].includes(current.status), 'CASE_STATUS_VALID');
      if (current.status === 'PASS') check(current.evidence_refs.length > 0, 'CASE_PASS_REQUIRES_EVIDENCE');
      check(current.app_status === 'NOT_RUN' && current.live_status === 'NOT_RUN' && current.owner_status === 'NOT_RUN', 'BASELINE_NOT_APP_LIVE_OWNER');
    }
  }
  for (const original of frozenTasks.tasks) {
    const current = plan.tasks.find(task => task.id === original.id);
    check(Boolean(current && JSON.stringify(current.depends_on) === JSON.stringify(original.depends_on) && JSON.stringify(current.acceptance_ids) === JSON.stringify(original.acceptance_ids)), 'TASK_DEPENDENCY_PRESERVED');
  }
  const edges = plan.tasks.flatMap(task => task.depends_on.map(before => [before, task.id]));
  for (const edge of carry.dependency_edges) edges.push([edge.prerequisite, edge.dependent]);
  for (const task of carry.planned_task_registry) for (const prerequisite of task.depends_on) edges.push([prerequisite, task.task]);
  const active = new Set(), done = new Set();
  function visit(node) {
    if (active.has(node)) { errors.push('DEPENDENCY_CYCLE'); return; }
    if (done.has(node)) return;
    active.add(node); for (const [from, to] of edges) if (from === node) visit(to);
    active.delete(node); done.add(node);
  }
  for (const [from] of edges) visit(from);
  check(plan.new_local_playback_route === 'roon_audio_input' && plan.preserve_existing_recording_output === true, 'PLAYBACK_SCOPE_PRESERVED');
  check(plan.evidence_layers.length === 5 && new Set(plan.evidence_layers).size === 5, 'EVIDENCE_LAYERS_SEPARATE');
  return errors;
}

export function verifyGitSources(records, directory = root) {
  const errors = [];
  for (const file of records.inputs.source_inputs) {
    const bytes = execFileSync('git', ['show', `${base}:${file.path}`], { cwd: directory });
    const blob = execFileSync('git', ['rev-parse', `${base}:${file.path}`], { cwd: directory, encoding: 'utf8' }).trim();
    if (file.base_sha !== base || digest(bytes) !== file.sha256 || bytes.length !== file.bytes || blob !== file.git_blob) errors.push(`GIT_SOURCE_MISMATCH:${file.path}`);
    const current = readFileSync(path.join(directory, file.path));
    // 主控最终可以更新状态、旧TODO与有效AGENTS；产品源码必须仍匹配基线。
    if (!['AGENTS.md', 'project/STATUS.json', 'project/RUST_CORE_TODO.md', 'tasks/00_TASK_INDEX.md'].includes(file.path) && digest(current) !== file.sha256) errors.push(`CURRENT_PRODUCT_SOURCE_CHANGED:${file.path}`);
  }
  for (const [file, expected] of [['PACK_TASKBOARD.json', packTaskboardSha256], ['PACK_ACCEPTANCE.json', packAcceptanceSha256]]) {
    if (digest(readFileSync(path.join(directory, recordRoot, file))) !== expected) errors.push(`FROZEN_PACK_MISMATCH:${file}`);
  }
  for (const item of records.reuse.entries) for (const file of item.resolved_files) {
    const lines = execFileSync('git', ['show', `${base}:${file.path}`], { cwd: directory, encoding: 'utf8' }).split('\n');
    for (const declaration of file.exports) if (lines[declaration.line - 1]?.trim() !== declaration.declaration.trim()) errors.push(`SYMBOL_MISMATCH:${file.path}:${declaration.line}`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const records = loadRecords();
    const errors = [...validateRecords(records), ...verifyGitSources(records)];
    process.stdout.write(JSON.stringify({ kind: 'POSTRUST_BASELINE_STRUCTURE_NOT_APP_ACCEPTANCE', base_sha: base,
      status: errors.length ? 'FAIL' : 'PASS', task_count: records.plan.tasks.length, acceptance_count: records.plan.acceptance_cases.length,
      open_todo_count: records.carry.entries.length, reuse_count: records.reuse.entries.length,
      g0_decision: records.admission.decision, errors }, null, 2) + '\n');
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) { process.stderr.write(`基线结构Gate准备失败：${error.message}\n`); process.exitCode = 1; }
}
