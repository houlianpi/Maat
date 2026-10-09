import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class EvidenceStore {
  private readonly directory: string;
  private sequence = 0;
  private readonly records: Array<{
    step: string;
    adapterId: string;
    name: string;
    status: 'captured' | 'unavailable' | 'required-but-missing' | 'skipped-by-user';
    path?: string;
    reason?: string;
  }> = [];
  constructor(directory: string) {
    this.directory = directory;
  }

  async image(
    step: string,
    adapterId: string,
    name: string,
    data: string,
    mimeType = 'image/png',
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `${String(++this.sequence).padStart(3, '0')}-${adapterId}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}.${extension}`;
    await writeFile(
      path.join(this.directory, filename),
      Buffer.from(data.replace(/^data:image\/[^;]+;base64,/, ''), 'base64'),
    );
    this.records.push({ step, adapterId, name, status: 'captured', path: filename });
  }

  unavailable(
    step: string,
    adapterId: string,
    name: string,
    reason: string,
    required: boolean,
    skipped = false,
  ): void {
    this.records.push({
      step,
      adapterId,
      name,
      status: skipped ? 'skipped-by-user' : required ? 'required-but-missing' : 'unavailable',
      reason,
    });
  }

  hasCapturedImage(): boolean {
    return this.records.some((record) => record.status === 'captured' && record.path);
  }

  async finish(passed: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(
      path.join(this.directory, 'evidence.json'),
      JSON.stringify({ passed, items: this.records }, null, 2) + '\n',
    );
  }
}
