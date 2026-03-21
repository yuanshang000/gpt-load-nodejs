import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { nowIso } from "../lib/utils.js";

export class AppDatabase {
  private readonly sqlite: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.initSchema();
    this.seedDefaults();
  }

  get db(): Database.Database {
    return this.sqlite;
  }

  close(): void {
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
