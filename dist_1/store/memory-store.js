"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryStore = void 0;
class MemoryStore {
    values = new Map();
    subscriptions = new Map();
    sweepExpired(key) {
        const item = this.values.get(key);
        if (!item) {
            return;
        }
        if (item.expiresAt > 0 && Date.now() > item.expiresAt) {
            this.values.delete(key);
        }
    }
    async get(key) {
        this.sweepExpired(key);
        return this.values.get(key)?.value ?? null;
    }
    async set(key, value, ttlSeconds = 0) {
        const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
        this.values.set(key, { value, expiresAt });
    }
    async del(key) {
        this.values.delete(key);
    }
    async setNx(key, value, ttlSeconds = 0) {
        this.sweepExpired(key);
        if (this.values.has(key)) {
            return false;
        }
        const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
        this.values.set(key, { value, expiresAt });
        return true;
    }
    async publish(channel, message) {
        const handlers = this.subscriptions.get(channel);
        if (!handlers) {
            return;
        }
        for (const handler of handlers) {
            try {
                handler(message);
            }
            catch {
            }
        }
    }
    async subscribe(channel, handler) {
        if (!this.subscriptions.has(channel)) {
            this.subscriptions.set(channel, new Set());
        }
        this.subscriptions.get(channel)?.add(handler);
        return async () => {
            this.subscriptions.get(channel)?.delete(handler);
        };
    }
    async close() {
        this.values.clear();
        this.subscriptions.clear();
    }
}
exports.MemoryStore = MemoryStore;
