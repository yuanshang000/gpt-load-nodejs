import { createClient } from "redis";

import type { SharedStore } from "./store.js";

export class RedisStore implements SharedStore {
  private readonly client: any;
  private readonly subscriber: any;

  private constructor(client: any, subscriber: any) {
    this.client = client;
    this.subscriber = subscriber;
  }

  static async create(redisUrl: string): Promise<RedisStore> {
    const client = createClient({ url: redisUrl });
    await client.connect();
    const subscriber = client.duplicate();
    await subscriber.connect();
    return new RedisStore(client, subscriber);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds = 0): Promise<void> {
    if (ttlSeconds > 0) {
      await this.client.set(key, value, { EX: ttlSeconds });
      return;
    }
    await this.client.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async setNx(key: string, value: string, ttlSeconds = 0): Promise<boolean> {
    const result = await this.client.set(key, value, {
      NX: true,
      ...(ttlSeconds > 0 ? { EX: ttlSeconds } : {}),
    });
    return result === "OK";
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    await this.subscriber.subscribe(channel, (message: string) => {
      handler(message);
    });

    return async () => {
      await this.subscriber.unsubscribe(channel);
    };
  }

  async close(): Promise<void> {
    try {
      await this.subscriber.quit();
    } catch {
    }
    await this.client.quit();
  }
}
