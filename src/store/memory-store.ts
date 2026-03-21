import type { SharedStore } from "./store.js";

type Subscriber = (message: string) => void;

type MemoryValue = {
  value: string;
  expiresAt: number;
};

export class MemoryStore implements SharedStore {
  private readonly values = new Map<string, MemoryValue>();
  private readonly subscriptions = new Map<string, Set<Subscriber>>();

  private sweepExpired(key: string): void {
    const item = this.values.get(key);
    if (!item) {
      return;
    }
    if (item.expiresAt > 0 && Date.now() > item.expiresAt) {
      this.values.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.sweepExpired(key);
    return this.values.get(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds = 0): Promise<void> {
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    this.values.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async setNx(key: string, value: string, ttlSeconds = 0): Promise<boolean> {
    this.sweepExpired(key);
    if (this.values.has(key)) {
      return false;
    }
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    this.values.set(key, { value, expiresAt });
    return true;
  }

  async publish(channel: string, message: string): Promise<void> {
    const handlers = this.subscriptions.get(channel);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {
      }
    }
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel)?.add(handler);

    return async () => {
      this.subscriptions.get(channel)?.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.values.clear();
    this.subscriptions.clear();
  }
}
