import type { SpecModel } from './spec-model.ts';

function comment(title: string, values: string[]): string[] {
  return [
    ` * ${title}:`,
    ...(values.length
      ? values.map((value, index) => ` * ${index + 1}. ${value.replaceAll('*/', '* /')}`)
      : [' * None.']),
    ' *',
  ];
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .trim()
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

export function renderSpec(model: SpecModel, fixtureImport: string): string {
  const adapters = [...new Set(model.steps.map((step) => step.adapterId))];
  const documentation = [
    '/**',
    ` * Case ID: ${model.id}`,
    ` * Name: ${model.name}`,
    ` * @maat-adapters ${adapters.join(' ')}`,
    ' *',
    ` * ${model.description}`,
    ' *',
    ...comment('Preconditions', model.preconditions),
    ...comment('Action steps', model.actionSteps),
    ...comment('Test objectives', model.objectives),
    ' */',
  ].join('\n');
  const labels = [
    ...model.tags.map((tag) => `@${tag}`),
    ...model.suites.map((suite) => `@suite:${suite}`),
  ].join(' ');
  const steps = model.steps
    .map((step) =>
      [
        '',
        `    await maat.step(${JSON.stringify(step.name)}, ${JSON.stringify(step.adapterId)}, async ({ ${step.bindings.join(', ')} }) => {`,
        indent(step.code, 6),
        '    });',
      ].join('\n'),
    )
    .join('');
  return [
    documentation,
    '',
    `import { afterEach, beforeEach, describe, it } from 'mocha';`,
    `import { createMaatTest, type MaatTest } from ${JSON.stringify(fixtureImport)};`,
    '',
    `describe(${JSON.stringify(`${model.name} ${labels}`.trim())}, () => {`,
    '  let maat: MaatTest;',
    '',
    '  beforeEach(async () => {',
    `    maat = await createMaatTest(${JSON.stringify(model.id)}, ${JSON.stringify(model.requirements, null, 2)});`,
    '    await maat.setup();',
    '  });',
    '',
    '  afterEach(async function () {',
    `    await maat.teardown({ passed: this.currentTest?.state === 'passed' });`,
    '  });',
    '',
    `  it(${JSON.stringify(model.id)}, async () => {`,
    steps.replace(/^\n/, ''),
    '  });',
    '});',
    '',
  ].join('\n');
}
