import type { RuntimeRequirement, TestSession } from '../platforms/contracts.ts';
import type { PlatformRegistry } from '../platforms/registry.ts';

export class SessionPool {
  private readonly registry: PlatformRegistry;
  private readonly sessions = new Map<string, TestSession>();
  private readonly requirements = new Map<string, RuntimeRequirement>();
  constructor(registry: PlatformRegistry, requirements: RuntimeRequirement[]) {
    this.registry = registry;
    for (const requirement of requirements)
      this.requirements.set(requirement.adapterId, requirement);
  }

  async setup(): Promise<void> {
    try {
      for (const adapterId of this.requirements.keys()) {
        const session = await this.acquire(adapterId);
        await session.setup();
      }
    } catch (error) {
      await this.teardown().catch(() => {});
      throw error;
    }
  }

  async acquire(adapterId: string): Promise<TestSession> {
    const existing = this.sessions.get(adapterId);
    if (existing) return existing;
    const adapter = this.registry.get(adapterId);
    if (!adapter) throw new Error(`Case requires unavailable Adapter: ${adapterId}`);
    await adapter.initialize();
    const session = await adapter.createTestSession(this.requirements.get(adapterId));
    this.sessions.set(adapterId, session);
    return session;
  }

  entries(): Array<[string, TestSession]> {
    return [...this.sessions.entries()];
  }

  async teardown(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.teardown()),
    );
    this.sessions.clear();
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
