import { MemoryStore } from "./memory-store.js";
import { RedisStore } from "./redis-store.js";
import type { SharedStore } from "./store.js";

export const createSharedStore = async (redisUrl: string): Promise<SharedStore> => {
  if (!redisUrl) {
    return new MemoryStore();
  }

  try {
    return await RedisStore.create(redisUrl);
  } catch {
    return new MemoryStore();
  }
};

