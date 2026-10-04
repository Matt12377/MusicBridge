import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 项目工作流采用顶层jobs下两个空格job、四个空格字段。
// 此检查专门覆盖已确认的GitHub job.env上下文失败，不冒称完整Actions执行。
function jobEnvironmentBlocks(source) {
  const blocks = []; let current;
  for (const line of source.split('\n')) {
    if (/^    env:\s*$/.test(line)) { current = []; blocks.push(current); continue; }
    if (current && /^ {6}\S/.test(line)) current.push(line);
    else if (current && line.trim() !== '' && !/^\s*#/.test(line)) current = undefined;
  }
  return blocks.flat().join('\n');
}
test('RUST016 Rust工作流job.env不能使用runner上下文，目录选择放到合法step', () => {
  const source = readFileSync(new URL('../../../.github/workflows/rust-core.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(jobEnvironmentBlocks(source), /\$\{\{\s*runner\./u);
  assert.match(source, /RUSTUP_TOOLCHAIN:\s*'1\.95\.0'/u);
  assert.match(source, /run:\s*corepack pnpm@10\.17\.1 run verify:rust/u);
});
