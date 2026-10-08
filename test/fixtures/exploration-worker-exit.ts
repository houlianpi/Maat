import { writeSync } from 'node:fs';

writeSync(2, 'fixture runtime failed during import\n');
process.exit(23);
