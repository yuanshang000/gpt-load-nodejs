"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const node_path_1 = __importDefault(require("node:path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const resolveDbPath = (dbPath) => {
    if (node_path_1.default.isAbsolute(dbPath)) {
        return dbPath;
    }
    return node_path_1.default.resolve(process.cwd(), dbPath);
};
exports.config = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3001),
    appUrl: process.env.APP_URL ?? "http://localhost:3001",
    authKey: process.env.AUTH_KEY ?? "sk-prod-change-this",
    encryptionKey: process.env.ENCRYPTION_KEY ?? "",
    dbPath: resolveDbPath(process.env.DB_PATH ?? "./data/gpt-load.db"),
    webDistPath: node_path_1.default.resolve(process.cwd(), "web/dist"),
    redisUrl: process.env.REDIS_URL ?? "",
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 500),
    rateLimitWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
};
