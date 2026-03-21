"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSharedStore = void 0;
const memory_store_js_1 = require("./memory-store.js");
const redis_store_js_1 = require("./redis-store.js");
const createSharedStore = async (redisUrl) => {
    if (!redisUrl) {
        return new memory_store_js_1.MemoryStore();
    }
    try {
        return await redis_store_js_1.RedisStore.create(redisUrl);
    }
    catch {
        return new memory_store_js_1.MemoryStore();
    }
};
exports.createSharedStore = createSharedStore;
