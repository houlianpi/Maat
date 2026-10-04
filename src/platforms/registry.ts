import type { PlatformAdapter } from './contracts.ts';

export class PlatformRegistry {
  private readonly adapters: Map<string, PlatformAdapter>;
  private active: PlatformAdapter;

  constructor(adapters: PlatformAdapter[], defaultId = 'web') {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    if (this.adapters.size !== adapters.length)
      throw new Error('Platform adapter IDs must be unique.');
    const initial = this.adapters.get(defaultId);
    if (!initial) throw new Error(`Default platform adapter is not registered: ${defaultId}`);
    this.active = initial;
  }

  get current(): PlatformAdapter {
    return this.active;
  }
  list(): PlatformAdapter[] {
    return [...this.adapters.values()];
  }
  get(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id);
  }

  async select(id: string): Promise<PlatformAdapter> {
    const next = this.adapters.get(id);
    if (!next)
      throw new Error(
        `Unknown platform: ${id}. Available: ${[...this.adapters.keys()].join(', ')}`,
      );
    await next.initialize();
    this.active = next;
    return next;
  }

  async close(): Promise<void> {
    await Promise.all(this.list().map((adapter) => adapter.close()));
  }
}
