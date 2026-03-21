"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisStore = void 0;
const redis_1 = require("redis");
class RedisStore {
    client;
    subscriber;
    constructor(client, subscriber) {
        this.client = client;
        this.subscriber = subscriber;
    }
    static async create(redisUrl) {
        const client = (0, redis_1.createClient)({ url: redisUrl });
        await client.connect();
        const subscriber = client.duplicate();
        await subscriber.connect();
        return new RedisStore(client, subscriber);
    }
    async get(key) {
        return this.client.get(key);
    }
    async set(key, value, ttlSeconds = 0) {
        if (ttlSeconds > 0) {
            await this.client.set(key, value, { EX: ttlSeconds });
            return;
        }
        await this.client.set(key, value);
    }
    async del(key) {
        await this.client.del(key);
    }
    async setNx(key, value, ttlSeconds = 0) {
        const result = await this.client.set(key, value, {
            NX: true,
            ...(ttlSeconds > 0 ? { EX: ttlSeconds } : {}),
        });
        return result === "OK";
    }
    async publish(channel, message) {
        await this.client.publish(channel, message);
    }
    async subscribe(channel, handler) {
        await this.subscriber.subscribe(channel, (message) => {
            handler(message);
        });
        return async () => {
            await this.subscriber.unsubscribe(channel);
        };
    }
    async close() {
        try {
            await this.subscriber.quit();
        }
        catch {
        }
        await this.client.quit();
    }
}
exports.RedisStore = RedisStore;
