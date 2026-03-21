import path from "node:path";

import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  appUrl: string;
  authKey: string;
  encryptionKey: string;
  dbPath: string;
  webDistPath: string;
  redisUrl: string;
  rateLimitMax: number;
  rateLimitWindow: string;
}

const resolveDbPath = (dbPath: string): string => {
  if (path.isAbsolute(dbPath)) {
    return dbPath;
  }
  return path.resolve(process.cwd(), dbPath);
};

export const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
  appUrl: process.env.APP_URL ?? "http://localhost:3001",
  authKey: process.env.AUTH_KEY ?? "sk-prod-change-this",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  dbPath: resolveDbPath(process.env.DB_PATH ?? "./data/gpt-load.db"),
  webDistPath: path.resolve(process.cwd(), "web/dist"),
  redisUrl: process.env.REDIS_URL ?? "",
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 500),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
};
