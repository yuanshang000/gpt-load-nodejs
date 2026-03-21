"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const static_1 = __importDefault(require("@fastify/static"));
const config_js_1 = require("./config.js");
const migrate_keys_js_1 = require("./commands/migrate-keys.js");
const database_js_1 = require("./db/database.js");
const api_js_1 = require("./routes/api.js");
const proxy_js_1 = require("./routes/proxy.js");
const app_service_js_1 = require("./services/app-service.js");
const factory_js_1 = require("./store/factory.js");
const start = async () => {
    const database = new database_js_1.AppDatabase(config_js_1.config.dbPath);
    const sharedStore = await (0, factory_js_1.createSharedStore)(config_js_1.config.redisUrl);
    const service = new app_service_js_1.AppService(database.db, config_js_1.config.encryptionKey, sharedStore);
    const app = (0, fastify_1.default)({ logger: true, bodyLimit: 50 * 1024 * 1024 });
    await app.register(helmet_1.default, {
        global: true,
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
    });
    await app.register(rate_limit_1.default, {
        max: config_js_1.config.rateLimitMax,
        timeWindow: config_js_1.config.rateLimitWindow,
        addHeaders: {
            "x-ratelimit-limit": true,
            "x-ratelimit-remaining": true,
            "x-ratelimit-reset": true,
        },
    });
    await app.register(cors_1.default, {
        origin: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "Accept-Language"],
    });
    await app.register(multipart_1.default);
    const startedAt = Date.now();
    app.get("/health", async () => ({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: `${Math.floor((Date.now() - startedAt) / 1000)}s`,
    }));
    await (0, api_js_1.registerApiRoutes)(app, service, config_js_1.config.authKey);
    await (0, proxy_js_1.registerProxyRoutes)(app, service);
    const unsubscribeConfigEvents = await sharedStore.subscribe(service.getConfigEventChannel(), (message) => {
        service.handleConfigEvent(message);
        app.log.info({ message }, "received config broadcast");
    });
    const webDistExists = node_fs_1.default.existsSync(config_js_1.config.webDistPath);
    if (webDistExists) {
        app.addHook("onSend", async (request, reply, payload) => {
            const pathOnly = request.url.split("?")[0] ?? "";
            if (pathOnly.startsWith("/assets/") ||
                /\.(js|css|ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|webp|avif|map)$/i.test(pathOnly)) {
                reply.header("Cache-Control", "public, max-age=2592000, immutable");
                reply.header("Expires", new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString());
            }
            return payload;
        });
        await app.register(static_1.default, {
            root: config_js_1.config.webDistPath,
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
                .send(node_fs_1.default.readFileSync(node_path_1.default.join(config_js_1.config.webDistPath, "index.html"), "utf-8"));
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
    await app.listen({ host: config_js_1.config.host, port: config_js_1.config.port });
};
const runCommand = () => {
    const [command, ...args] = process.argv.slice(2);
    if (!command) {
        return -1;
    }
    const database = new database_js_1.AppDatabase(config_js_1.config.dbPath);
    try {
        const service = new app_service_js_1.AppService(database.db, config_js_1.config.encryptionKey);
        if (command === "migrate-keys") {
            return (0, migrate_keys_js_1.runMigrateKeys)(service, args);
        }
        if (["help", "--help", "-h"].includes(command)) {
            console.log("Available commands:");
            console.log("  migrate-keys   Migrate encryption keys for stored data");
            return 0;
        }
        console.error(`Unknown command: ${command}`);
        console.error("Use --help for usage.");
        return 1;
    }
    finally {
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
