import { Injectable } from '@nestjs/common';

export class PlayerActivityError extends Error {
  readonly code = 'PLAYER_BUSY';
}

/** Shared by namespaces on the current single Nest replica. Persisted sources
 * remain authoritative after restarts; this queue only fences check/write races.
 */
@Injectable()
export class PlayerActivityService {
  private tail: Promise<void> = Promise.resolve();
  private readonly sources = new Map<
    string,
    (userIds: number[]) => Promise<number[]>
  >();
  private readonly listeners = new Set<() => void>();

  register(name: string, source: (userIds: number[]) => Promise<number[]>) {
    this.sources.set(name, source);
  }

  async busyUsers(userIds: number[], names?: string[]): Promise<number[]> {
    const busy = new Set<number>();
    for (const [name, source] of this.sources) {
      if (names && !names.includes(name)) continue;
      for (const userId of await source(userIds)) busy.add(userId);
    }
    return [...busy];
  }

  async assertAvailable(userIds: number[]) {
    if ((await this.busyUsers(userIds)).length)
      throw new PlayerActivityError(
        'El jugador tiene una batalla o compra pendiente. Espera a que termine y se guarde.',
      );
  }

  runExclusive<T>(_userIds: number[], operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed() {
    for (const listener of this.listeners) listener();
  }
}
