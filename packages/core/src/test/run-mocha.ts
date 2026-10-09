import Mocha from 'mocha';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type TestResult = {
  title: string;
  fullTitle: string;
  state: 'passed' | 'failed';
  duration?: number;
  error?: string;
};
const [serialized] = process.argv.slice(2);
const input = JSON.parse(serialized) as { specs: string[]; grep?: string; runDirectory: string };
const mocha = new Mocha({ timeout: 60_000, grep: input.grep });
for (const spec of input.specs) mocha.addFile(spec);
await mocha.loadFilesAsync();
const tests: TestResult[] = [];
const failures = await new Promise<number>((resolve) => {
  const runner = mocha.run(resolve);
  runner.on('pass', (test) =>
    tests.push({
      title: test.title,
      fullTitle: test.fullTitle(),
      state: 'passed',
      duration: test.duration,
    }),
  );
  runner.on('fail', (test, error) =>
    tests.push({
      title: test.title,
      fullTitle: test.fullTitle(),
      state: 'failed',
      duration: test.duration,
      error: error.stack ?? error.message,
    }),
  );
});
await mkdir(path.join(input.runDirectory, 'report'), { recursive: true });
const result = { passed: failures === 0, failures, tests };
await writeFile(
  path.join(input.runDirectory, 'result.json'),
  JSON.stringify(result, null, 2) + '\n',
);
const evidenceRoot = path.join(input.runDirectory, 'cases');
const caseDirectories = await readdir(evidenceRoot, { withFileTypes: true }).catch(() => []);
const evidenceLinks = new Map<string, string>();
for (const entry of caseDirectories.filter((candidate) => candidate.isDirectory())) {
  const relative = `../cases/${encodeURIComponent(entry.name)}/evidence.json`;
  const evidence = await readFile(path.join(evidenceRoot, entry.name, 'evidence.json'), 'utf8')
    .then(
      (text) =>
        JSON.parse(text) as {
          items?: Array<{ name?: string; reason?: string; status?: string }>;
        },
    )
    .catch(() => ({ items: [] }));
  const counts = new Map<string, number>();
  for (const item of evidence.items ?? [])
    counts.set(item.status ?? 'captured', (counts.get(item.status ?? 'captured') ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([status, count]) => `${escape(status)}: ${count}`)
    .join(' · ');
  const missing = (evidence.items ?? [])
    .filter((item) => item.status && item.status !== 'captured')
    .map(
      (item) =>
        `<li><strong>${escape(item.status!)}</strong>${item.name ? ` · ${escape(item.name)}` : ''}${item.reason ? ` — ${escape(item.reason)}` : ''}</li>`,
    )
    .join('');
  evidenceLinks.set(
    entry.name,
    `<a href="${relative}">Evidence</a>${summary ? `<div>${summary}</div>` : ''}${missing ? `<ul>${missing}</ul>` : ''}`,
  );
}
const rows = tests
  .map(
    (test) =>
      `<tr><td>${escape(test.fullTitle)}</td><td class="${test.state}">${test.state}</td><td>${test.duration ?? ''}ms</td><td>${evidenceLinks.get(test.title) ?? ''}</td><td><pre>${escape(test.error ?? '')}</pre></td></tr>`,
  )
  .join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Maat Report</title><style>body{font:14px system-ui;margin:32px;background:#0d2027;color:#dce8eb}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #36505a;text-align:left}.passed{color:#64d98b}.failed{color:#ff7b72}a{color:#75c7ff}pre{white-space:pre-wrap}</style></head><body><h1>Maat Test Report</h1><p>${tests.length} tests · ${failures} failures</p><table><thead><tr><th>Case</th><th>Status</th><th>Duration</th><th>Evidence</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
await writeFile(path.join(input.runDirectory, 'report/index.html'), html);
process.exit(failures ? 1 : 0);

function escape(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!,
  );
}
