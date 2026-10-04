import { runAgent } from '../hosts/agent/run-agent.ts';
import { parseAgentOptions } from './agent-options.ts';

try {
  const options = parseAgentOptions(process.argv.slice(2));
  await runAgent(options.prompt, options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
