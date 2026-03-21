import fs from "node:fs";
import path from "node:path";

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";

import { config } from "./config.js";
import { runMigrateKeys } from "./commands/migrate-keys.js";
import { AppDatabase } from "./db/database.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { AppService } from "./services/app-service.js";
import { createSharedStore } from "./store/factory.js";

const start = async (): Promise<void> => {
  const database = new AppDatabase(config.dbPath);
  const sharedStore = await createSharedStore(config.redisUrl);
  const service = new AppService(database.db, config.encryptionKey, sharedStore);

  const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });
  await app.register(helmet, {
    global: true,
  });

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
  });

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept-Language"],
  });
  await app.register(multipart);

  const startedAt = Date.now();
  app.get("/health", async () => ({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor((Date.now() - startedAt) / 1000)}s`,
  }));

  await registerApiRoutes(app, service, config.authKey);
  await registerProxyRoutes(app, service);

  const unsubscribeConfigEvents = await sharedStore.subscribe(service.getConfigEventChannel(), (message) => {
    service.handleConfigEvent(message);
    app.log.info({ message }, "received config broadcast");
  });

  const webDistExists = fs.existsSync(config.webDistPath);
  if (webDistExists) {
    app.addHook("onSend", async (request, reply, payload) => {
      const pathOnly = request.url.split("?")[0] ?? "";
      if (
        pathOnly.startsWith("/assets/") ||
        /\.(js|css|ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|webp|avif|map)$/i.test(pathOnly)
      ) {
        reply.header("Cache-Control", "public, max-age=2592000, immutable");
        reply.header("Expires", new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString());
      }
      return payload;
    });

    await app.register(fastifyStatic, {
      root: config.webDistPath,
      prefix: "/",
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/proxy") || request.url.startsWith("/health")) {
        return reply.status(404).send({ message: "Not Found", error: "Not Found", statusCode: 404 });
      }
      return reply
        .header("Cache-Control", "no-cache, no-store, must-revalidate")
        .header("Pragma", "no-cache")
        .header("Expires", "0")
        .type("text/html; charset=utf-8")
        .send(fs.readFileSync(path.join(config.webDistPath, "index.html"), "utf-8"));
    });
  }

  const cleanupTimer = setInterval(() => {
    service.cleanupExpiredLogs().then((deleted) => {
      if (deleted > 0) {
        app.log.info({ deleted }, "cleaned expired request logs");
      }
    }).catch((error) => {
      app.log.warn({ error }, "log cleanup failed");
    });
  }, 60 * 1000);

  const validationTimer = setInterval(() => {
    service.runScheduledKeyValidation().catch((error) => {
      app.log.warn({ error }, "scheduled key validation failed");
    });
  }, 60 * 1000);

  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    clearInterval(validationTimer);
    await unsubscribeConfigEvents();
    await sharedStore.close();
    database.close();
  });

  await app.listen({ host: config.host, port: config.port });
};

const runCommand = (): number => {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    return -1;
  }

  const database = new AppDatabase(config.dbPath);
  try {
    const service = new AppService(database.db, config.encryptionKey);
    if (command === "migrate-keys") {
      return runMigrateKeys(service, args);
    }
    if (["help", "--help", "-h"].includes(command)) {
      console.log("Available commands:");
      console.log("  migrate-keys   Migrate encryption keys for stored data");
      return 0;
    }
    console.error(`Unknown command: ${command}`);
    console.error("Use --help for usage.");
    return 1;
  } finally {
    database.close();
  }
};

const exitCode = runCommand();
if (exitCode >= 0) {
  process.exit(exitCode);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
