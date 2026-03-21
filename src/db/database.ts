import fs from "node:fs";
import path from "node:path";

import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";

import { nowIso } from "../lib/utils.js";
import type { DatabaseLike, StatementLike } from "./sqlite-like.js";

const SQLITE_MAGIC = "SQLite format 3\u0000";

const normalizeParams = (args: unknown[]): unknown[] | Record<string, unknown> => {
  if (args.length === 0) {
    return [];
  }
  if (args.length === 1) {
    const first = args[0];
    if (Array.isArray(first)) {
      return first;
    }
    if (first !== null && typeof first === "object" && !Buffer.isBuffer(first) && !ArrayBuffer.isView(first)) {
      return first as Record<string, unknown>;
    }
    return [first];
  }
  return args;
};

const normalizeNamedBindings = (bindings: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(bindings)) {
    const key = rawKey.replace(/^[:@$]/, "");
    normalized[key] = value;
    normalized[`:${key}`] = value;
    normalized[`@${key}`] = value;
    normalized[`$${key}`] = value;
  }
  return normalized;
};

class SqlJsPreparedStatement implements StatementLike {
  private readonly db: SqlJsDatabase;
  private readonly sql: string;
  private readonly onMutate: () => void;

  constructor(db: SqlJsDatabase, sql: string, onMutate: () => void) {
    this.db = db;
    this.sql = sql;
    this.onMutate = onMutate;
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    const statement = this.db.prepare(this.sql);
    try {
      const params = normalizeParams(args);
      if (Array.isArray(params)) {
        if (params.length > 0) {
          statement.bind(params as any);
        }
      } else {
        statement.bind(normalizeNamedBindings(params as Record<string, unknown>) as any);
      }
      if (!statement.step()) {
        return undefined;
      }
      return statement.getAsObject() as Record<string, unknown>;
    } finally {
      statement.free();
    }
  }

  all(...args: unknown[]): Array<Record<string, unknown>> {
    const statement = this.db.prepare(this.sql);
    try {
      const params = normalizeParams(args);
      if (Array.isArray(params)) {
        if (params.length > 0) {
          statement.bind(params as any);
        }
      } else {
        statement.bind(normalizeNamedBindings(params as Record<string, unknown>) as any);
      }

      const rows: Array<Record<string, unknown>> = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as Record<string, unknown>);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    const statement = this.db.prepare(this.sql);
    try {
      const params = normalizeParams(args);
      if (Array.isArray(params)) {
        statement.run(params as any);
      } else {
        statement.run(normalizeNamedBindings(params as Record<string, unknown>) as any);
      }
    } finally {
      statement.free();
    }

    this.onMutate();

    const changesRow = this.db.exec("SELECT changes() AS value");
    const changesRaw = changesRow[0]?.values?.[0]?.[0];
    const lastIdRow = this.db.exec("SELECT last_insert_rowid() AS value");
    const lastIdRaw = lastIdRow[0]?.values?.[0]?.[0];

    return {
      changes: Number(changesRaw ?? 0),
      lastInsertRowid: Number(lastIdRaw ?? 0),
    };
  }
}

class SqlJsCompatDatabase implements DatabaseLike {
  private readonly db: SqlJsDatabase;
  private readonly onMutate: () => void;

  constructor(db: SqlJsDatabase, onMutate: () => void) {
    this.db = db;
    this.onMutate = onMutate;
  }

  prepare(sql: string): StatementLike {
    return new SqlJsPreparedStatement(this.db, sql, this.onMutate);
  }

  exec(sql: string): void {
    this.db.exec(sql);
    const normalized = sql.trim().toUpperCase();
    if (
      normalized.startsWith("INSERT") ||
      normalized.startsWith("UPDATE") ||
      normalized.startsWith("DELETE") ||
      normalized.startsWith("CREATE") ||
      normalized.startsWith("ALTER") ||
      normalized.startsWith("DROP") ||
      normalized.startsWith("REPLACE") ||
      normalized.startsWith("BEGIN") ||
      normalized.startsWith("COMMIT") ||
      normalized.startsWith("ROLLBACK")
    ) {
      this.onMutate();
    }
  }

  pragma(sql: string): void {
    this.db.exec(`PRAGMA ${sql};`);
  }

  transaction<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: unknown[]) => {
      this.db.exec("BEGIN");
      try {
        const result = fn(...args);
        this.db.exec("COMMIT");
        this.onMutate();
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }) as T;
  }

  close(): void {
    this.db.close();
  }

  export(): Uint8Array {
    return this.db.export();
  }
}

const SNAPSHOT_TABLES = ["settings", "groups", "group_sub_groups", "api_keys", "request_logs", "task_status"] as const;
type SnapshotTableName = (typeof SNAPSHOT_TABLES)[number];

type DbSnapshot = {
  version: number;
  updated_at: string;
  tables: Record<SnapshotTableName, Array<Record<string, unknown>>>;
};

export class AppDatabase {
  private readonly sqlite: SqlJsCompatDatabase;
  private readonly dataPath: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private suspendFlush = true;

  private constructor(dataPath: string, sqlJs: SqlJsStatic) {
    this.dataPath = dataPath;
    const dir = path.dirname(dataPath);
    fs.mkdirSync(dir, { recursive: true });

    const runtimeDatabase = this.createRuntimeDatabase(sqlJs, dataPath);
    this.sqlite = new SqlJsCompatDatabase(runtimeDatabase, () => {
      if (!this.suspendFlush) {
        this.scheduleFlush();
      }
    });

    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.initSchema();
    this.loadFromJsonSnapshot();
    this.seedDefaults();

    this.suspendFlush = false;
    this.flushToDisk();
  }

  static async create(dbPath: string): Promise<AppDatabase> {
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
    return new AppDatabase(dbPath, SQL);
  }

  private createRuntimeDatabase(sqlJs: SqlJsStatic, dataPath: string): SqlJsDatabase {
    if (!fs.existsSync(dataPath)) {
      return new sqlJs.Database();
    }

    try {
      const raw = fs.readFileSync(dataPath);
      const magic = raw.subarray(0, SQLITE_MAGIC.length).toString("utf8");
      if (magic === SQLITE_MAGIC) {
        return new sqlJs.Database(new Uint8Array(raw));
      }
    } catch {
      return new sqlJs.Database();
    }

    return new sqlJs.Database();
  }

  get db(): DatabaseLike {
    return this.sqlite;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushToDisk();
    }, 1000);
  }

  private loadFromJsonSnapshot(): void {
    if (!fs.existsSync(this.dataPath)) {
      return;
    }

    let parsed: DbSnapshot | null = null;
    try {
      const raw = fs.readFileSync(this.dataPath, "utf8").trim();
      if (!raw.startsWith("{")) {
        return;
      }
      const json = JSON.parse(raw) as Partial<DbSnapshot>;
      if (!json || typeof json !== "object" || !json.tables || typeof json.tables !== "object") {
        return;
      }

      parsed = {
        version: Number(json.version ?? 1),
        updated_at: typeof json.updated_at === "string" ? json.updated_at : nowIso(),
        tables: {
          settings: Array.isArray(json.tables.settings) ? json.tables.settings : [],
          groups: Array.isArray(json.tables.groups) ? json.tables.groups : [],
          group_sub_groups: Array.isArray(json.tables.group_sub_groups) ? json.tables.group_sub_groups : [],
          api_keys: Array.isArray(json.tables.api_keys) ? json.tables.api_keys : [],
          request_logs: Array.isArray(json.tables.request_logs) ? json.tables.request_logs : [],
          task_status: Array.isArray(json.tables.task_status) ? json.tables.task_status : [],
        },
      };
    } catch {
      return;
    }

    if (!parsed) {
      return;
    }

    const tx = this.sqlite.transaction(() => {
      for (const table of SNAPSHOT_TABLES) {
        const rows = parsed.tables[table];
        if (!Array.isArray(rows) || rows.length === 0) {
          continue;
        }
        this.sqlite.prepare(`DELETE FROM ${table}`).run();
        for (const row of rows) {
          if (!row || typeof row !== "object") {
            continue;
          }
          const entries = Object.entries(row as Record<string, unknown>);
          if (entries.length === 0) {
            continue;
          }
          const columns = entries.map(([key]) => key);
          const placeholders = columns.map(() => "?").join(",");
          const values = entries.map(([, value]) => value);
          this.sqlite.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`).run(...values);
        }
      }
    });
    tx();
  }

  private buildSnapshot(): DbSnapshot {
    return {
      version: 1,
      updated_at: nowIso(),
      tables: {
        settings: this.sqlite.prepare("SELECT * FROM settings").all() as Array<Record<string, unknown>>,
        groups: this.sqlite.prepare("SELECT * FROM groups").all() as Array<Record<string, unknown>>,
        group_sub_groups: this.sqlite.prepare("SELECT * FROM group_sub_groups").all() as Array<Record<string, unknown>>,
        api_keys: this.sqlite.prepare("SELECT * FROM api_keys").all() as Array<Record<string, unknown>>,
        request_logs: this.sqlite.prepare("SELECT * FROM request_logs").all() as Array<Record<string, unknown>>,
        task_status: this.sqlite.prepare("SELECT * FROM task_status").all() as Array<Record<string, unknown>>,
      },
    };
  }

  private flushToDisk(): void {
    const snapshot = this.buildSnapshot();
    fs.writeFileSync(this.dataPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushToDisk();
    this.sqlite.close();
  }

  private initSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        setting_type TEXT NOT NULL DEFAULT 'string',
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 0,
        min_value INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        group_type TEXT NOT NULL DEFAULT 'standard',
        channel_type TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        test_model TEXT NOT NULL,
        validation_endpoint TEXT NOT NULL,
        upstreams TEXT NOT NULL,
        config TEXT NOT NULL,
        param_overrides TEXT NOT NULL,
        model_redirect_rules TEXT NOT NULL,
        model_redirect_strict INTEGER NOT NULL DEFAULT 0,
        header_rules TEXT NOT NULL,
        proxy_keys TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_sub_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        sub_group_id INTEGER NOT NULL,
        weight INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(group_id, sub_group_id),
        FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY(sub_group_id) REFERENCES groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_value TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT NOT NULL DEFAULT '',
        request_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(group_id, key_hash),
        FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        group_name TEXT NOT NULL,
        parent_group_id INTEGER,
        parent_group_name TEXT,
        key_value TEXT,
        key_hash TEXT,
        model TEXT,
        is_success INTEGER NOT NULL,
        source_ip TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        request_path TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_message TEXT,
        user_agent TEXT,
        request_type TEXT NOT NULL,
        upstream_addr TEXT,
        is_stream INTEGER NOT NULL,
        request_body TEXT
      );

      CREATE TABLE IF NOT EXISTS task_status (
        task_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_group_status ON api_keys(group_id, status);
      CREATE INDEX IF NOT EXISTS idx_request_logs_group_ts ON request_logs(group_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(timestamp);
    `);
  }

  private seedDefaults(): void {
    const now = nowIso();
    const defaults = [
      {
        key: "app_url",
        value: process.env.APP_URL ?? "http://localhost:3001",
        type: "string",
        name: "App URL",
        description: "Base URL of management app",
        category: "Basic",
        required: 1,
        min_value: null,
      },
      {
        key: "proxy_keys",
        value: process.env.AUTH_KEY ?? "sk-prod-change-this",
        type: "string",
        name: "Global Proxy Keys",
        description: "Comma-separated global proxy keys",
        category: "Basic",
        required: 1,
        min_value: null,
      },
      {
        key: "request_timeout",
        value: "600",
        type: "int",
        name: "Request Timeout",
        description: "Request timeout in seconds",
        category: "Request",
        required: 1,
        min_value: 1,
      },
      {
        key: "connect_timeout",
        value: "15",
        type: "int",
        name: "Connect Timeout",
        description: "Connection timeout in seconds",
        category: "Request",
        required: 1,
        min_value: 1,
      },
      {
        key: "max_retries",
        value: "3",
        type: "int",
        name: "Max Retries",
        description: "Retry times for key failover",
        category: "Keys",
        required: 1,
        min_value: 0,
      },
      {
        key: "blacklist_threshold",
        value: "3",
        type: "int",
        name: "Blacklist Threshold",
        description: "Failures before marking key invalid",
        category: "Keys",
        required: 1,
        min_value: 1,
      },
      {
        key: "key_validation_concurrency",
        value: "10",
        type: "int",
        name: "Key Validation Concurrency",
        description: "Concurrent workers for manual key validation",
        category: "Keys",
        required: 1,
        min_value: 1,
      },
      {
        key: "key_validation_timeout_seconds",
        value: "20",
        type: "int",
        name: "Key Validation Timeout",
        description: "Single key validation timeout in seconds",
        category: "Keys",
        required: 1,
        min_value: 1,
      },
      {
        key: "key_validation_interval_minutes",
        value: "60",
        type: "int",
        name: "Key Validation Interval",
        description: "Background key validation interval in minutes",
        category: "Keys",
        required: 1,
        min_value: 1,
      },
      {
        key: "enable_request_body_logging",
        value: "false",
        type: "bool",
        name: "Enable Request Body Logging",
        description: "Whether to log request body into request_logs",
        category: "Logging",
        required: 1,
        min_value: null,
      },
      {
        key: "request_log_retention_days",
        value: "7",
        type: "int",
        name: "Request Log Retention Days",
        description: "Delete logs older than N days",
        category: "Logging",
        required: 1,
        min_value: 0,
      },
      {
        key: "request_log_write_interval_minutes",
        value: "1",
        type: "int",
        name: "Request Log Write Interval",
        description: "Reserved compatibility field for batched log writes",
        category: "Logging",
        required: 1,
        min_value: 0,
      },
      {
        key: "idle_conn_timeout",
        value: "120",
        type: "int",
        name: "Idle Connection Timeout",
        description: "Idle upstream connection timeout in seconds",
        category: "Request",
        required: 1,
        min_value: 1,
      },
      {
        key: "response_header_timeout",
        value: "600",
        type: "int",
        name: "Response Header Timeout",
        description: "Upstream response header timeout in seconds",
        category: "Request",
        required: 1,
        min_value: 1,
      },
      {
        key: "max_idle_conns",
        value: "100",
        type: "int",
        name: "Max Idle Connections",
        description: "Maximum total idle upstream connections",
        category: "Request",
        required: 1,
        min_value: 1,
      },
      {
        key: "max_idle_conns_per_host",
        value: "50",
        type: "int",
        name: "Max Idle Connections Per Host",
        description: "Maximum idle upstream connections per host",
        category: "Request",
        required: 1,
        min_value: 1,
      },
      {
        key: "proxy_url",
        value: "",
        type: "string",
        name: "Proxy URL",
        description: "Global upstream HTTP(S) proxy URL",
        category: "Request",
        required: 0,
        min_value: null,
      },
    ];

    const stmt = this.sqlite.prepare(`
      INSERT INTO settings
      (setting_key, setting_value, setting_type, name, description, category, required, min_value, updated_at)
      VALUES (@key, @value, @type, @name, @description, @category, @required, @min_value, @updated_at)
      ON CONFLICT(setting_key) DO NOTHING
    `);

    const tx = this.sqlite.transaction(() => {
      for (const item of defaults) {
        stmt.run({ ...item, updated_at: now });
      }
    });
    tx();
  }
}

