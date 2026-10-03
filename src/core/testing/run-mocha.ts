import Mocha from 'mocha';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type TestResult = { title: string; fullTitle: string; state: 'passed' | 'failed'; duration?: number; error?: string };
const [serialized] = process.argv.slice(2);
const input = JSON.parse(serialized) as { specs: string[]; grep?: string; runDirectory: string };
const mocha = new Mocha({ timeout: 60_000, grep: input.grep });
for (const spec of input.specs) mocha.addFile(spec);
await mocha.loadFilesAsync();
const tests: TestResult[] = [];
const failures = await new Promise<number>(resolve => {
  const runner = mocha.run(resolve);
  runner.on('pass', test => tests.push({ title: test.title, fullTitle: test.fullTitle(), state: 'passed', duration: test.duration }));
  runner.on('fail', (test, error) => tests.push({ title: test.title, fullTitle: test.fullTitle(), state: 'failed', duration: test.duration, error: error.stack ?? error.message }));
});
await mkdir(path.join(input.runDirectory, 'report'), { recursive: true });
const result = { passed: failures === 0, failures, tests };
await writeFile(path.join(input.runDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const evidenceRoot = path.join(input.runDirectory, 'cases');
const caseDirectories = await readdir(evidenceRoot, { withFileTypes: true }).catch(() => []);
const evidenceLinks = new Map(caseDirectories.filter(entry => entry.isDirectory()).map(entry => [entry.name, `<a href="../cases/${encodeURIComponent(entry.name)}/evidence.json">Evidence</a>`]));
const rows = tests.map(test => `<tr><td>${escape(test.fullTitle)}</td><td class="${test.state}">${test.state}</td><td>${test.duration ?? ''}ms</td><td>${evidenceLinks.get(test.title) ?? ''}</td><td><pre>${escape(test.error ?? '')}</pre></td></tr>`).join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Maat Report</title><style>body{font:14px system-ui;margin:32px;background:#0d2027;color:#dce8eb}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #36505a;text-align:left}.passed{color:#64d98b}.failed{color:#ff7b72}a{color:#75c7ff}pre{white-space:pre-wrap}</style></head><body><h1>Maat Test Report</h1><p>${tests.length} tests · ${failures} failures</p><table><thead><tr><th>Case</th><th>Status</th><th>Duration</th><th>Evidence</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
await writeFile(path.join(input.runDirectory, 'report/index.html'), html);
process.exit(failures ? 1 : 0);

function escape(value: string): string { return value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!); }
