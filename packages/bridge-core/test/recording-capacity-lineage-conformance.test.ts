import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateProcessFailureLineage, type ProcessFailureLineageCase } from './helpers/recording-capacity-phases.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const corpusPath = path.join(root, 'packages/bridge-core/test/fixtures/capacity-process-failure-lineage-v1.json');
const contractPath = path.join(root, 'packages/contracts/capacity-process-failure-lineage-v1.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { cases: Array<{ name: string; expected: unknown } & Record<string, unknown>> };
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

test('PROCESS_EXIT golden corpus 覆盖合同声明的全部 verdict', () => {
  const observed = [...new Set(corpus.cases.map(value => (value.expected as { verdict: string }).verdict))].sort();
  assert.deepEqual(observed, [...contract.verdicts].sort());
});

function python(entry: string): unknown[] {
  const program = `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('entry',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ncontract=json.load(open(sys.argv[2]));corpus=json.load(open(sys.argv[3]));print(json.dumps([m.evaluate_process_failure_lineage(case,contract) for case in corpus['cases']]))`;
  const result = spawnSync('/usr/bin/python3', ['-c', program, entry, contractPath, corpusPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout) as unknown[];
}

test('issuer、installed supervisor 与 TypeScript consumer 共享 PROCESS_EXIT golden corpus', () => {
  const issuer = python(path.join(root, 'scripts/ci/issue-v3-capacity-queued-stop-window.py'));
  const supervisor = python(path.join(root, 'scripts/ci/capacity-phase-supervisor-v2.py'));
  const consumer = corpus.cases.map(value => evaluateProcessFailureLineage(value as unknown as ProcessFailureLineageCase, contract));
  const expected = corpus.cases.map(value => value.expected);
  assert.deepEqual(issuer, expected);
  assert.deepEqual(supervisor, expected);
  assert.deepEqual(consumer, expected);
});
