import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  HeaderRule,
  GroupModel,
  RequestLogModel,
  TaskStatus,
  UpstreamInfo,
  ApiKeyModel,
} from "../types/models.js";
import {
  buildPagination,
  hashKey,
  maskKey,
  nowIso,
  parseJson,
  pickWeighted,
  safeNumber,
  splitKeys,
  splitProxyKeys,
  toJson,
} from "../lib/utils.js";
import {
  decryptWithKey,
  encryptWithKey,
  isEncryptedValue,
  transformEncryption,
} from "../lib/encryption.js";
import type { SharedStore } from "../store/store.js";

type RawGroupRow = {
  id: number;
  name: string;
  display_name: string;
  description: string;
  group_type: "standard" | "aggregate";
  channel_type: "openai" | "openai-response" | "gemini" | "anthropic";
  sort: number;
  test_model: string;
  validation_endpoint: string;
  upstreams: string;
  config: string;
  param_overrides: string;
  model_redirect_rules: string;
  model_redirect_strict: number;
  header_rules: string;
  proxy_keys: string;
  created_at: string;
  updated_at: string;
};

type GlobalTaskState = {
  current: TaskStatus | null;
};

type ConfigEventType =
  | "settings.updated"
  | "groups.created"
  | "groups.updated"
  | "groups.deleted"
  | "keys.changed";

type ConfigEventPayload = {
  type: ConfigEventType;
  at: string;
  data?: Record<string, unknown>;
};

export class AppService {
  private readonly db: Database.Database;
  private readonly runtimeEncryptionKey: string;
  private readonly sharedStore: SharedStore;
  private readonly configEventChannel = "gpt-load:config:events";

  private readonly taskState: GlobalTaskState = { current: null };

  constructor(db: Database.Database, runtimeEncryptionKey = "", sharedStore?: SharedStore) {
    this.db = db;
    this.runtimeEncryptionKey = runtimeEncryptionKey;
    this.sharedStore =
      sharedStore ??
      ({
        get: async () => null,
        set: async () => {},
        del: async () => {},
        setNx: async () => true,
        publish: async () => {},
        subscribe: async () => async () => {},
        close: async () => {},
      } satisfies SharedStore);
  }

  private getEncryptionKey(): string {
    return this.runtimeEncryptionKey;
  }

  getConfigEventChannel(): string {
    return this.configEventChannel;
  }

  async publishConfigEvent(type: ConfigEventType, data?: Record<string, unknown>): Promise<void> {
    const payload: ConfigEventPayload = {
      type,
      at: nowIso(),
      data,
    };
    await this.sharedStore.publish(this.configEventChannel, JSON.stringify(payload));
  }

  handleConfigEvent(rawMessage: string): void {
    const payload = parseJson<ConfigEventPayload | null>(rawMessage, null);
    if (!payload) {
      return;
    }
    if (payload.type.startsWith("settings") || payload.type.startsWith("groups")) {
      this.taskState.current = null;
    }
  }

  private encryptForStorage(plainText: string): string {
    const key = this.getEncryptionKey();
    if (!key) {
      return plainText;
    }
    if (isEncryptedValue(plainText)) {
      return plainText;
    }
    return encryptWithKey(plainText, key);
  }

  private decryptFromStorage(value: string): string {
    if (!isEncryptedValue(value)) {
      return value;
    }
    const key = this.getEncryptionKey();
    if (!key) {
      throw new Error("encryption key is required but not configured");
    }
    return decryptWithKey(value, key);
  }

  getSettingValue(key: string, fallback: string): string {
    const row = this.db.prepare("SELECT setting_value FROM settings WHERE setting_key = ?").get(key) as
      | { setting_value: string }
      | undefined;
    if (!row) {
      return fallback;
    }
    return row.setting_value;
  }

  getSettingsCategories(): Array<{ category_name: string; settings: Array<Record<string, unknown>> }> {
    const rows = this.db
      .prepare(
        "SELECT setting_key, setting_value, setting_type, name, description, category, required, min_value FROM settings ORDER BY category, setting_key",
      )
      .all() as Array<{
      setting_key: string;
      setting_value: string;
      setting_type: "int" | "string" | "bool";
      name: string;
      description: string;
      category: string;
      required: number;
      min_value: number | null;
    }>;

    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      if (!grouped.has(row.category)) {
        grouped.set(row.category, []);
      }
      const value =
        row.setting_type === "int"
          ? Number(row.setting_value)
          : row.setting_type === "bool"
            ? row.setting_value === "true"
            : row.setting_value;
      grouped.get(row.category)?.push({
        key: row.setting_key,
        name: row.name,
        value,
        type: row.setting_type,
        min_value: row.min_value ?? undefined,
        description: row.description,
        required: row.required === 1,
      });
    }
    return [...grouped.entries()].map(([category_name, settings]) => ({ category_name, settings }));
  }

  updateSettings(payload: Record<string, unknown>): void {
    const stmt = this.db.prepare("UPDATE settings SET setting_value = ?, updated_at = ? WHERE setting_key = ?");
    const tx = this.db.transaction(() => {
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "undefined") {
          continue;
        }
        let saveValue: string;
        if (typeof value === "boolean") {
          saveValue = String(value);
        } else if (typeof value === "number") {
          saveValue = String(value);
        } else {
          saveValue = String(value ?? "");
        }
        if (key === "proxy_keys") {
          saveValue = splitProxyKeys(saveValue).join(",");
        }
        stmt.run(saveValue, nowIso(), key);
      }
    });
    tx();
    void this.publishConfigEvent("settings.updated");
  }

  getChannelTypes(): string[] {
    return ["openai", "openai-response", "gemini", "anthropic"];
  }

  private getAllowedGroupConfigKeys(): string[] {
    return [
      "request_timeout",
      "idle_conn_timeout",
      "connect_timeout",
      "max_idle_conns",
      "max_idle_conns_per_host",
      "response_header_timeout",
      "proxy_url",
      "max_retries",
      "blacklist_threshold",
      "key_validation_interval_minutes",
      "key_validation_concurrency",
      "key_validation_timeout_seconds",
      "enable_request_body_logging",
    ];
  }

  private sanitizeGroupConfig(config: Record<string, unknown>): Record<string, unknown> {
    const allowedKeys = new Set(this.getAllowedGroupConfigKeys());
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`unknown config field: '${key}'`);
      }
      sanitized[key] = value;
    }
    return sanitized;
  }

  private rowToGroup(row: RawGroupRow): GroupModel {
    return {
      id: row.id,
      name: row.name,
      display_name: row.display_name,
      description: row.description,
      group_type: row.group_type,
      channel_type: row.channel_type,
      sort: row.sort,
      test_model: row.test_model,
      validation_endpoint: row.validation_endpoint,
      upstreams: parseJson<UpstreamInfo[]>(row.upstreams, []),
      config: parseJson<Record<string, unknown>>(row.config, {}),
      param_overrides: parseJson<Record<string, unknown>>(row.param_overrides, {}),
      model_redirect_rules: parseJson<Record<string, string>>(row.model_redirect_rules, {}),
      model_redirect_strict: row.model_redirect_strict === 1,
      header_rules: parseJson<HeaderRule[]>(row.header_rules, []),
      proxy_keys: row.proxy_keys,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  listGroups(): GroupModel[] {
    const rows = this.db.prepare("SELECT * FROM groups ORDER BY sort ASC, id ASC").all() as RawGroupRow[];
    return rows.map((row) => this.rowToGroup(row));
  }

  listGroupSimple(): Array<{ id: number; name: string; display_name: string }> {
    return this.db
      .prepare("SELECT id, name, display_name FROM groups ORDER BY sort ASC, id ASC")
      .all() as Array<{ id: number; name: string; display_name: string }>;
  }

  getGroupById(groupId: number): GroupModel | null {
    const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as RawGroupRow | undefined;
    return row ? this.rowToGroup(row) : null;
  }

  getGroupByName(name: string): GroupModel | null {
    const row = this.db.prepare("SELECT * FROM groups WHERE name = ?").get(name) as RawGroupRow | undefined;
    return row ? this.rowToGroup(row) : null;
  }

  private normalizeGroupPayload(payload: Record<string, unknown>, existing?: GroupModel): Omit<GroupModel, "id"> {
    const now = nowIso();
    const upstreams = (payload.upstreams as UpstreamInfo[] | undefined) ?? existing?.upstreams ?? [];
    const incomingConfig = payload.config as Record<string, unknown> | undefined;
    const channelType =
      (payload.channel_type as GroupModel["channel_type"] | undefined) ?? existing?.channel_type ?? "openai";
    const groupType = (payload.group_type as GroupModel["group_type"] | undefined) ?? existing?.group_type ?? "standard";
    const validationEndpoint =
      (payload.validation_endpoint as string | undefined) ??
      existing?.validation_endpoint ??
      (channelType === "openai-response"
        ? "/v1/responses"
        : channelType === "anthropic"
          ? "/v1/messages"
          : channelType === "gemini"
            ? "/v1beta/models"
            : "/v1/chat/completions");

    return {
      name: (payload.name as string | undefined) ?? existing?.name ?? "",
      display_name: (payload.display_name as string | undefined) ?? existing?.display_name ?? "",
      description: (payload.description as string | undefined) ?? existing?.description ?? "",
      group_type: groupType,
      channel_type: channelType,
      sort: safeNumber(payload.sort, existing?.sort ?? 0),
      test_model: (payload.test_model as string | undefined) ?? existing?.test_model ?? "gpt-4o-mini",
      validation_endpoint: validationEndpoint,
      upstreams,
      config: incomingConfig
        ? this.sanitizeGroupConfig(incomingConfig)
        : existing?.config ?? {},
      param_overrides:
        (payload.param_overrides as Record<string, unknown> | undefined) ?? existing?.param_overrides ?? {},
      model_redirect_rules:
        (payload.model_redirect_rules as Record<string, string> | undefined) ?? existing?.model_redirect_rules ?? {},
      model_redirect_strict:
        (payload.model_redirect_strict as boolean | undefined) ?? existing?.model_redirect_strict ?? false,
      header_rules: (payload.header_rules as HeaderRule[] | undefined) ?? existing?.header_rules ?? [],
      proxy_keys: splitProxyKeys((payload.proxy_keys as string | undefined) ?? existing?.proxy_keys ?? "").join(","),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
  }

  createGroup(payload: Record<string, unknown>): GroupModel {
    const normalized = this.normalizeGroupPayload(payload);
    if (!normalized.name) {
      throw new Error("group name is required");
    }
    if (!normalized.display_name) {
      normalized.display_name = normalized.name;
    }
    if (normalized.upstreams.length === 0 && normalized.group_type !== "aggregate") {
      throw new Error("at least one upstream is required");
    }
    const stmt = this.db.prepare(`
      INSERT INTO groups
      (name, display_name, description, group_type, channel_type, sort, test_model, validation_endpoint, upstreams, config,
       param_overrides, model_redirect_rules, model_redirect_strict, header_rules, proxy_keys, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      normalized.name,
      normalized.display_name,
      normalized.description,
      normalized.group_type,
      normalized.channel_type,
      normalized.sort,
      normalized.test_model,
      normalized.validation_endpoint,
      toJson(normalized.upstreams),
      toJson(normalized.config),
      toJson(normalized.param_overrides),
      toJson(normalized.model_redirect_rules),
      normalized.model_redirect_strict ? 1 : 0,
      toJson(normalized.header_rules),
      normalized.proxy_keys,
      normalized.created_at,
      normalized.updated_at,
    );
    const group = this.getGroupById(Number(result.lastInsertRowid));
    if (!group) {
      throw new Error("failed to load created group");
    }
    void this.publishConfigEvent("groups.created", { group_id: group.id, group_name: group.name });
    return group;
  }

  updateGroup(groupId: number, payload: Record<string, unknown>): GroupModel {
    const existing = this.getGroupById(groupId);
    if (!existing) {
      throw new Error("group not found");
    }
    const normalized = this.normalizeGroupPayload(payload, existing);
    const stmt = this.db.prepare(`
      UPDATE groups
      SET name = ?, display_name = ?, description = ?, group_type = ?, channel_type = ?, sort = ?, test_model = ?,
          validation_endpoint = ?, upstreams = ?, config = ?, param_overrides = ?, model_redirect_rules = ?,
          model_redirect_strict = ?, header_rules = ?, proxy_keys = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      normalized.name,
      normalized.display_name,
      normalized.description,
      normalized.group_type,
      normalized.channel_type,
      normalized.sort,
      normalized.test_model,
      normalized.validation_endpoint,
      toJson(normalized.upstreams),
      toJson(normalized.config),
      toJson(normalized.param_overrides),
      toJson(normalized.model_redirect_rules),
      normalized.model_redirect_strict ? 1 : 0,
      toJson(normalized.header_rules),
      normalized.proxy_keys,
      normalized.updated_at,
      groupId,
    );
    const updated = this.getGroupById(groupId);
    if (!updated) {
      throw new Error("group not found");
    }
    void this.publishConfigEvent("groups.updated", { group_id: updated.id, group_name: updated.name });
    return updated;
  }

  deleteGroup(groupId: number): void {
    const existing = this.getGroupById(groupId);
    this.db.prepare("DELETE FROM groups WHERE id = ?").run(groupId);
    void this.publishConfigEvent("groups.deleted", { group_id: groupId, group_name: existing?.name ?? "" });
  }

  copyGroup(groupId: number, copyKeys: "none" | "valid_only" | "all"): GroupModel {
    const group = this.getGroupById(groupId);
    if (!group) {
      throw new Error("group not found");
    }
    const copiedName = `${group.name}-copy-${Date.now().toString().slice(-6)}`;
    const copied = this.createGroup({
      ...group,
      name: copiedName,
      display_name: `${group.display_name} Copy`,
    });
    if (copyKeys !== "none") {
      const filter = copyKeys === "valid_only" ? "AND status = 'active'" : "";
      const sourceKeys = this.db
        .prepare(`SELECT key_value, key_hash, status, notes FROM api_keys WHERE group_id = ? ${filter}`)
        .all(groupId) as Array<{ key_value: string; key_hash: string; status: string; notes: string }>;
      const stmt = this.db.prepare(
        "INSERT INTO api_keys (key_value, key_hash, group_id, status, notes, request_count, failure_count, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)",
      );
      const tx = this.db.transaction(() => {
        for (const key of sourceKeys) {
          stmt.run(key.key_value, key.key_hash, copied.id, key.status, key.notes, nowIso(), nowIso());
        }
      });
      tx();
    }
    return copied;
  }

  getGroupConfigOptions(): Array<{ key: string; name: string; description: string; default_value: unknown }> {
    const options = [
      {
        key: "request_timeout",
        name: "Request Timeout",
        description: "Request timeout in seconds",
        default_value: Number(this.getSettingValue("request_timeout", "600")),
      },
      {
        key: "idle_conn_timeout",
        name: "Idle Connection Timeout",
        description: "Idle upstream connection timeout in seconds",
        default_value: Number(this.getSettingValue("idle_conn_timeout", "120")),
      },
      {
        key: "connect_timeout",
        name: "Connect Timeout",
        description: "Connection timeout in seconds",
        default_value: Number(this.getSettingValue("connect_timeout", "15")),
      },
      {
        key: "max_idle_conns",
        name: "Max Idle Connections",
        description: "Maximum total idle upstream connections",
        default_value: Number(this.getSettingValue("max_idle_conns", "100")),
      },
      {
        key: "max_idle_conns_per_host",
        name: "Max Idle Connections Per Host",
        description: "Maximum idle upstream connections per host",
        default_value: Number(this.getSettingValue("max_idle_conns_per_host", "50")),
      },
      {
        key: "response_header_timeout",
        name: "Response Header Timeout",
        description: "Response header timeout in seconds",
        default_value: Number(this.getSettingValue("response_header_timeout", "600")),
      },
      {
        key: "proxy_url",
        name: "Proxy URL",
        description: "Global upstream HTTP(S) proxy URL",
        default_value: this.getSettingValue("proxy_url", ""),
      },
      {
        key: "max_retries",
        name: "Max Retries",
        description: "Maximum retry times",
        default_value: Number(this.getSettingValue("max_retries", "3")),
      },
      {
        key: "blacklist_threshold",
        name: "Blacklist Threshold",
        description: "Failures before marking key invalid",
        default_value: Number(this.getSettingValue("blacklist_threshold", "3")),
      },
      {
        key: "key_validation_interval_minutes",
        name: "Key Validation Interval",
        description: "Background invalid key validation interval in minutes",
        default_value: Number(this.getSettingValue("key_validation_interval_minutes", "60")),
      },
      {
        key: "key_validation_concurrency",
        name: "Key Validation Concurrency",
        description: "Concurrent workers for key validation",
        default_value: Number(this.getSettingValue("key_validation_concurrency", "10")),
      },
      {
        key: "key_validation_timeout_seconds",
        name: "Key Validation Timeout",
        description: "Timeout for validating a single key in seconds",
        default_value: Number(this.getSettingValue("key_validation_timeout_seconds", "20")),
      },
      {
        key: "enable_request_body_logging",
        name: "Enable Request Body Logging",
        description: "Enable request body logging in request logs",
        default_value: this.getSettingValue("enable_request_body_logging", "false") === "true",
      },
    ];
    return options;
  }

  getSubGroups(aggregateGroupId: number): Array<{
    group: GroupModel;
    weight: number;
    total_keys: number;
    active_keys: number;
    invalid_keys: number;
  }> {
    const rows = this.db
      .prepare(
        `
        SELECT gs.sub_group_id, gs.weight
        FROM group_sub_groups gs
        WHERE gs.group_id = ?
        ORDER BY gs.id ASC
      `,
      )
      .all(aggregateGroupId) as Array<{ sub_group_id: number; weight: number }>;
    return rows
      .map((row) => {
        const group = this.getGroupById(row.sub_group_id);
        if (!group) {
          return null;
        }
        const stat = this.db
          .prepare(
            `
            SELECT
              COUNT(*) AS total_keys,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_keys,
              SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid_keys
            FROM api_keys
            WHERE group_id = ?
          `,
          )
          .get(group.id) as { total_keys: number; active_keys: number | null; invalid_keys: number | null };
        return {
          group,
          weight: row.weight,
          total_keys: stat.total_keys ?? 0,
          active_keys: stat.active_keys ?? 0,
          invalid_keys: stat.invalid_keys ?? 0,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  addSubGroups(aggregateGroupId: number, subGroups: Array<{ group_id: number; weight: number }>): void {
    const stmt = this.db.prepare(
      `
      INSERT INTO group_sub_groups (group_id, sub_group_id, weight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_id, sub_group_id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at
    `,
    );
    const tx = this.db.transaction(() => {
      for (const item of subGroups) {
        stmt.run(aggregateGroupId, item.group_id, safeNumber(item.weight, 1), nowIso(), nowIso());
      }
    });
    tx();
  }

  updateSubGroupWeight(aggregateGroupId: number, subGroupId: number, weight: number): void {
    this.db
      .prepare("UPDATE group_sub_groups SET weight = ?, updated_at = ? WHERE group_id = ? AND sub_group_id = ?")
      .run(weight, nowIso(), aggregateGroupId, subGroupId);
  }

  deleteSubGroup(aggregateGroupId: number, subGroupId: number): void {
    this.db
      .prepare("DELETE FROM group_sub_groups WHERE group_id = ? AND sub_group_id = ?")
      .run(aggregateGroupId, subGroupId);
  }

  getParentAggregateGroups(groupId: number): Array<{ group_id: number; name: string; display_name: string; weight: number }> {
    return this.db
      .prepare(
        `
      SELECT g.id AS group_id, g.name, g.display_name, gs.weight
      FROM group_sub_groups gs
      JOIN groups g ON g.id = gs.group_id
      WHERE gs.sub_group_id = ?
      ORDER BY g.sort ASC, g.id ASC
    `,
      )
      .all(groupId) as Array<{ group_id: number; name: string; display_name: string; weight: number }>;
  }

  private loadGroupKeyStats(groupId: number): { total_keys: number; active_keys: number; invalid_keys: number } {
    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_keys,
          SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_keys,
          SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid_keys
        FROM api_keys
        WHERE group_id = ?
      `,
      )
      .get(groupId) as { total_keys: number; active_keys: number | null; invalid_keys: number | null };
    return {
      total_keys: row.total_keys ?? 0,
      active_keys: row.active_keys ?? 0,
      invalid_keys: row.invalid_keys ?? 0,
    };
  }

  private loadRequestStats(groupId: number, sinceHours: number): { total_requests: number; failed_requests: number; failure_rate: number } {
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const row = this.db
      .prepare(
        `
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) AS failed_requests
      FROM request_logs
      WHERE group_id = ? AND timestamp >= ?
    `,
      )
      .get(groupId, since) as { total_requests: number; failed_requests: number | null };
    const total = row.total_requests ?? 0;
    const failed = row.failed_requests ?? 0;
    return {
      total_requests: total,
      failed_requests: failed,
      failure_rate: total === 0 ? 0 : Number(((failed / total) * 100).toFixed(2)),
    };
  }

  getGroupStats(groupId: number): {
    key_stats: { total_keys: number; active_keys: number; invalid_keys: number };
    stats_24_hour: { total_requests: number; failed_requests: number; failure_rate: number };
    stats_7_day: { total_requests: number; failed_requests: number; failure_rate: number };
    stats_30_day: { total_requests: number; failed_requests: number; failure_rate: number };
  } {
    return {
      key_stats: this.loadGroupKeyStats(groupId),
      stats_24_hour: this.loadRequestStats(groupId, 24),
      stats_7_day: this.loadRequestStats(groupId, 24 * 7),
      stats_30_day: this.loadRequestStats(groupId, 24 * 30),
    };
  }

  listKeys(params: {
    group_id: number;
    page: number;
    page_size: number;
    status?: string;
    key_value?: string;
  }): { items: ApiKeyModel[]; pagination: ReturnType<typeof buildPagination> } {
    const page = Math.max(1, params.page);
    const pageSize = Math.max(1, Math.min(200, params.page_size));
    const offset = (page - 1) * pageSize;
    const whereParts = ["group_id = @group_id"];
    const bindings: Record<string, unknown> = { group_id: params.group_id };

    if (params.status && (params.status === "active" || params.status === "invalid")) {
      whereParts.push("status = @status");
      bindings.status = params.status;
    }
    if (params.key_value) {
      whereParts.push("key_hash = @key_hash");
      bindings.key_hash = hashKey(params.key_value);
    }

    const whereSql = whereParts.join(" AND ");
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM api_keys WHERE ${whereSql}`)
      .get(bindings) as { count: number };
    const rows = this.db
      .prepare(
        `
      SELECT * FROM api_keys
      WHERE ${whereSql}
      ORDER BY id DESC
      LIMIT @limit OFFSET @offset
    `,
      )
      .all({ ...bindings, limit: pageSize, offset }) as ApiKeyModel[];

    const decodedRows = rows.map((row) => {
      try {
        return { ...row, key_value: this.decryptFromStorage(row.key_value) };
      } catch {
        return { ...row, key_value: "failed-to-decrypt" };
      }
    });

    return { items: decodedRows, pagination: buildPagination(page, pageSize, total.count ?? 0) };
  }

  private ensureGroupExists(groupId: number): void {
    const group = this.getGroupById(groupId);
    if (!group) {
      throw new Error("group not found");
    }
  }

  addMultipleKeys(groupId: number, keysText: string): { added_count: number; ignored_count: number; total_in_group: number } {
    this.ensureGroupExists(groupId);
    const keys = splitKeys(keysText);
    if (keys.length === 0) {
      throw new Error("no valid keys found in the input text");
    }
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO api_keys (key_value, key_hash, group_id, status, notes, request_count, failure_count, last_used_at, created_at, updated_at) VALUES (?, ?, ?, 'active', '', 0, 0, NULL, ?, ?)",
    );
    let added = 0;
    const tx = this.db.transaction(() => {
      for (const key of keys) {
        const info = insert.run(this.encryptForStorage(key), hashKey(key), groupId, nowIso(), nowIso());
        if (info.changes > 0) {
          added += 1;
        }
      }
    });
    tx();

    const totalInGroup = this.db
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE group_id = ?")
      .get(groupId) as { count: number };
    void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "add" });
    return { added_count: added, ignored_count: keys.length - added, total_in_group: totalInGroup.count ?? 0 };
  }

  deleteMultipleKeys(groupId: number, keysText: string): { deleted_count: number; ignored_count: number; total_in_group: number } {
    this.ensureGroupExists(groupId);
    const keys = splitKeys(keysText);
    if (keys.length === 0) {
      throw new Error("no valid keys found in the input text");
    }
    const del = this.db.prepare("DELETE FROM api_keys WHERE group_id = ? AND key_hash = ?");
    let deleted = 0;
    const tx = this.db.transaction(() => {
      for (const key of keys) {
        const info = del.run(groupId, hashKey(key));
        deleted += info.changes;
      }
    });
    tx();
    const totalInGroup = this.db
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE group_id = ?")
      .get(groupId) as { count: number };
    void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "delete" });
    return {
      deleted_count: deleted,
      ignored_count: Math.max(0, keys.length - deleted),
      total_in_group: totalInGroup.count ?? 0,
    };
  }

  restoreMultipleKeys(groupId: number, keysText: string): { restored_count: number; ignored_count: number; total_in_group: number } {
    this.ensureGroupExists(groupId);
    const keys = splitKeys(keysText);
    if (keys.length === 0) {
      throw new Error("no valid keys found in the input text");
    }
    const up = this.db.prepare("UPDATE api_keys SET status='active', updated_at = ? WHERE group_id = ? AND key_hash = ?");
    let restored = 0;
    const tx = this.db.transaction(() => {
      for (const key of keys) {
        restored += up.run(nowIso(), groupId, hashKey(key)).changes;
      }
    });
    tx();
    const totalInGroup = this.db
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE group_id = ?")
      .get(groupId) as { count: number };
    void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "restore" });
    return {
      restored_count: restored,
      ignored_count: Math.max(0, keys.length - restored),
      total_in_group: totalInGroup.count ?? 0,
    };
  }

  restoreAllInvalidKeys(groupId: number): number {
    this.ensureGroupExists(groupId);
    const changed = this.db
      .prepare("UPDATE api_keys SET status='active', updated_at = ? WHERE group_id = ? AND status='invalid'")
      .run(nowIso(), groupId).changes;
    void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "restore-invalid-all" });
    return changed;
  }

  clearAllInvalidKeys(groupId: number): number {
    this.ensureGroupExists(groupId);
    const changed = this.db.prepare("DELETE FROM api_keys WHERE group_id = ? AND status='invalid'").run(groupId).changes;
    void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "clear-invalid-all" });
    return changed;
  }

  clearAllKeys(groupId: number): number {
    this.ensureGroupExists(groupId);
    const changed = this.db.prepare("DELETE FROM api_keys WHERE group_id = ?").run(groupId).changes;
    void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "clear-all" });
    return changed;
  }

  updateKeyNotes(keyId: number, notes: string): void {
    this.db
      .prepare("UPDATE api_keys SET notes = ?, updated_at = ? WHERE id = ?")
      .run(notes.trim().slice(0, 255), nowIso(), keyId);
    void this.publishConfigEvent("keys.changed", { key_id: keyId, action: "update-notes" });
  }

  exportKeys(groupId: number, status: "all" | "active" | "invalid"): string {
    let rows: Array<{ key_value: string }>;
    if (status === "all") {
      rows = this.db.prepare("SELECT key_value FROM api_keys WHERE group_id = ? ORDER BY id DESC").all(groupId) as Array<{
        key_value: string;
      }>;
    } else {
      rows = this.db
        .prepare("SELECT key_value FROM api_keys WHERE group_id = ? AND status = ? ORDER BY id DESC")
        .all(groupId, status) as Array<{ key_value: string }>;
    }
    const output = rows.map((item) => {
      try {
        return this.decryptFromStorage(item.key_value);
      } catch {
        return "failed-to-decrypt";
      }
    });
    return output.join("\n");
  }

  private taskStatusKey(): string {
    return "gpt-load:task:global";
  }

  private taskLockKey(): string {
    return "gpt-load:task:lock";
  }

  async startTask(taskType: TaskStatus["task_type"], groupName: string, total: number): Promise<TaskStatus> {
    const current = await this.getTaskStatus();
    if ("is_running" in current && current.is_running) {
      throw new Error("a task is already running, please wait");
    }

    const lockAcquired = await this.sharedStore.setNx(this.taskLockKey(), nowIso(), 60 * 60 * 24);
    if (!lockAcquired) {
      throw new Error("a task is already running, please wait");
    }

    const task: TaskStatus = {
      task_type: taskType,
      is_running: true,
      group_name: groupName,
      processed: 0,
      total,
      started_at: nowIso(),
    };
    this.taskState.current = task;
    await this.saveTaskStatus(task);
    return task;
  }

  private async saveTaskStatus(task: TaskStatus): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO task_status (task_key, payload, updated_at) VALUES ('global', ?, ?) ON CONFLICT(task_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
      )
      .run(JSON.stringify(task), nowIso());
    await this.sharedStore.set(this.taskStatusKey(), JSON.stringify(task), 60 * 60 * 24);
  }

  async updateTaskProgress(processed: number): Promise<void> {
    if (!this.taskState.current || !this.taskState.current.is_running) {
      return;
    }
    this.taskState.current.processed = processed;
    await this.saveTaskStatus(this.taskState.current);
  }

  async finishTask(result: unknown, error?: string): Promise<void> {
    if (!this.taskState.current) {
      return;
    }
    const finishedAt = nowIso();
    this.taskState.current.is_running = false;
    this.taskState.current.finished_at = finishedAt;
    const start = new Date(this.taskState.current.started_at).getTime();
    this.taskState.current.duration_seconds = Number(((Date.now() - start) / 1000).toFixed(3));
    if (error) {
      this.taskState.current.error = error;
    } else {
      this.taskState.current.result = result;
    }
    await this.saveTaskStatus(this.taskState.current);
    await this.sharedStore.del(this.taskLockKey());
  }

  async getTaskStatus(): Promise<TaskStatus | { is_running: false }> {
    if (this.taskState.current) {
      return this.taskState.current;
    }

    const fromStore = await this.sharedStore.get(this.taskStatusKey());
    if (fromStore) {
      return parseJson<TaskStatus>(fromStore, {
        task_type: "KEY_IMPORT",
        is_running: false,
        processed: 0,
        total: 0,
        started_at: nowIso(),
      });
    }

    const row = this.db.prepare("SELECT payload FROM task_status WHERE task_key='global'").get() as
      | { payload: string }
      | undefined;
    if (!row) {
      return { is_running: false };
    }
    return parseJson<TaskStatus>(row.payload, {
      task_type: "KEY_IMPORT",
      is_running: false,
      processed: 0,
      total: 0,
      started_at: nowIso(),
    });
  }

  async runImportTask(groupId: number, keysText: string): Promise<TaskStatus> {
    const group = this.getGroupById(groupId);
    if (!group) {
      throw new Error("group not found");
    }
    const keys = splitKeys(keysText);
    const task = await this.startTask("KEY_IMPORT", group.name, keys.length);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO api_keys (key_value, key_hash, group_id, status, notes, request_count, failure_count, last_used_at, created_at, updated_at) VALUES (?, ?, ?, 'active', '', 0, 0, NULL, ?, ?)",
    );
    setImmediate(async () => {
      let added = 0;
      try {
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          const info = insert.run(this.encryptForStorage(key), hashKey(key), groupId, nowIso(), nowIso());
          if (info.changes > 0) {
            added += 1;
          }
          await this.updateTaskProgress(index + 1);
        }
        await this.finishTask({ added_count: added, ignored_count: keys.length - added });
      } catch (error) {
        await this.finishTask(null, error instanceof Error ? error.message : "unknown error");
      }
    });
    return task;
  }

  async runDeleteTask(groupId: number, keysText: string): Promise<TaskStatus> {
    const group = this.getGroupById(groupId);
    if (!group) {
      throw new Error("group not found");
    }
    const keys = splitKeys(keysText);
    const task = await this.startTask("KEY_DELETE", group.name, keys.length);
    const del = this.db.prepare("DELETE FROM api_keys WHERE group_id = ? AND key_hash = ?");
    setImmediate(async () => {
      let deleted = 0;
      try {
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          deleted += del.run(groupId, hashKey(key)).changes;
          await this.updateTaskProgress(index + 1);
        }
        await this.finishTask({ deleted_count: deleted, ignored_count: Math.max(0, keys.length - deleted) });
      } catch (error) {
        await this.finishTask(null, error instanceof Error ? error.message : "unknown error");
      }
    });
    return task;
  }

  private getValidationEndpoint(group: GroupModel): string {
    if (group.validation_endpoint) {
      return group.validation_endpoint;
    }
    if (group.channel_type === "openai-response") {
      return "/v1/responses";
    }
    if (group.channel_type === "anthropic") {
      return "/v1/messages";
    }
    if (group.channel_type === "gemini") {
      return "/v1beta/models";
    }
    return "/v1/chat/completions";
  }

  private buildValidationRequest(group: GroupModel, apiKey: string): {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  } {
    const upstream = group.upstreams[0];
    if (!upstream) {
      throw new Error("no upstream configured");
    }

    const endpoint = this.getValidationEndpoint(group);
    const baseUrl = upstream.url.endsWith("/") ? upstream.url : `${upstream.url}/`;
    const targetUrl = new URL(endpoint.replace(/^\//, ""), baseUrl);

    if (group.channel_type === "gemini") {
      targetUrl.searchParams.set("key", apiKey);
      if (endpoint.includes("/models")) {
        return { url: targetUrl.toString(), method: "GET", headers: {} };
      }
      return {
        url: targetUrl.toString(),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
        }),
      };
    }

    if (group.channel_type === "anthropic") {
      return {
        url: targetUrl.toString(),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: group.test_model || "claude-3-5-haiku-latest",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      };
    }

    if (endpoint.includes("/models")) {
      return {
        url: targetUrl.toString(),
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      };
    }

    if (group.channel_type === "openai-response") {
      return {
        url: targetUrl.toString(),
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: group.test_model || "gpt-4o-mini",
          input: "ping",
          max_output_tokens: 1,
        }),
      };
    }

    return {
      url: targetUrl.toString(),
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: group.test_model || "gpt-4o-mini",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    };
  }

  private async validateKeyAgainstUpstream(group: GroupModel, apiKey: string): Promise<{ isValid: boolean; error: string }> {
    try {
      const requestConfig = this.buildValidationRequest(group, apiKey);
      const timeoutSeconds = safeNumber(
        (group.config.key_validation_timeout_seconds as number | undefined) ?? undefined,
        Number(this.getSettingValue("key_validation_timeout_seconds", "20")),
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);
      let response: Response;
      try {
        response = await fetch(requestConfig.url, {
          method: requestConfig.method,
          headers: requestConfig.headers,
          body: requestConfig.body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status < 400) {
        return { isValid: true, error: "" };
      }

      const bodyText = await response.text();
      return {
        isValid: false,
        error: bodyText ? bodyText.slice(0, 255) : `status:${response.status}`,
      };
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message.slice(0, 255) : "validation error",
      };
    }
  }

  async runValidateTask(groupId: number, status?: "active" | "invalid"): Promise<TaskStatus> {
    const group = this.getGroupById(groupId);
    if (!group) {
      throw new Error("group not found");
    }
    const rows = this.db
      .prepare(
        status
          ? "SELECT id, key_value FROM api_keys WHERE group_id = ? AND status = ? ORDER BY id"
          : "SELECT id, key_value FROM api_keys WHERE group_id = ? ORDER BY id",
      )
      .all(status ? [groupId, status] : [groupId]) as Array<{ id: number; key_value: string }>;
    const task = await this.startTask("KEY_VALIDATION", group.name, rows.length);
    setImmediate(async () => {
      try {
        let processed = 0;
        let invalid = 0;
        let cursor = 0;

        const concurrency = Math.max(
          1,
          safeNumber(
            (group.config.key_validation_concurrency as number | undefined) ?? undefined,
            Number(this.getSettingValue("key_validation_concurrency", "10")),
          ),
        );

        const workerCount = Math.min(concurrency, Math.max(1, rows.length));

        const worker = async (): Promise<void> => {
          while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= rows.length) {
              return;
            }

            const row = rows[index];
            let plainKey = "";
            try {
              plainKey = this.decryptFromStorage(row.key_value);
            } catch {
              plainKey = "";
            }

            let isValid = false;
            let validationError = "invalid key format";
            if (plainKey.length > 12) {
              const checkResult = await this.validateKeyAgainstUpstream(group, plainKey);
              isValid = checkResult.isValid;
              validationError = checkResult.error;
            }

            this.db
              .prepare("UPDATE api_keys SET status = ?, notes = ?, updated_at = ? WHERE id = ?")
              .run(isValid ? "active" : "invalid", isValid ? "" : validationError, nowIso(), row.id);
            if (!isValid) {
              invalid += 1;
            }

            processed += 1;
            await this.updateTaskProgress(processed);
          }
        };

        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        await this.finishTask({ invalid_keys: invalid, total_keys: rows.length, valid_keys: rows.length - invalid });
      } catch (error) {
        await this.finishTask(null, error instanceof Error ? error.message : "unknown error");
      }
    });
    return task;
  }

  async testKeys(groupId: number, keysText: string): Promise<{ results: Array<{ key_value: string; is_valid: boolean; error: string }>; total_duration: number }> {
    const group = this.getGroupById(groupId);
    if (!group) {
      throw new Error("group not found");
    }
    const start = Date.now();
    const keys = splitKeys(keysText);
    const results = await Promise.all(keys.map(async (key) => {
      let isValid = false;
      let error = "invalid key format";
      if (key.length > 12) {
        const checkResult = await this.validateKeyAgainstUpstream(group, key);
        isValid = checkResult.isValid;
        error = checkResult.error;
      }
      return {
        key_value: maskKey(key),
        is_valid: isValid,
        error: isValid ? "" : error,
      };
    }));
    return { results, total_duration: Date.now() - start };
  }

  canAccessGroupByProxyKey(group: GroupModel, key: string): boolean {
    const groupKeys = splitProxyKeys(group.proxy_keys);
    const globalKeys = splitProxyKeys(this.getSettingValue("proxy_keys", ""));
    return groupKeys.includes(key) || globalKeys.includes(key);
  }

  private getDefaultValidationEndpoint(channelType: GroupModel["channel_type"]): string {
    if (channelType === "openai-response") {
      return "/v1/responses";
    }
    if (channelType === "anthropic") {
      return "/v1/messages";
    }
    if (channelType === "gemini") {
      return "/v1beta/models";
    }
    return "/v1/chat/completions";
  }

  private isCustomOpenAIChannel(group: GroupModel): boolean {
    if (group.channel_type !== "openai" && group.channel_type !== "openai-response") {
      return false;
    }
    if (!group.validation_endpoint) {
      return false;
    }
    return group.validation_endpoint !== this.getDefaultValidationEndpoint(group.channel_type);
  }

  getIntegrationInfo(proxyKey: string): Array<{ name: string; display_name: string; channel_type: string; path: string }> {
    const groups = this.listGroups().filter((group) => this.canAccessGroupByProxyKey(group, proxyKey));
    return groups.map((group) => ({
      channel_type: this.isCustomOpenAIChannel(group) ? "custom" : group.channel_type,
      name: group.name,
      display_name: group.display_name,
      path: this.isCustomOpenAIChannel(group)
        ? `/proxy/${group.name}${group.validation_endpoint.startsWith("/") ? group.validation_endpoint : `/${group.validation_endpoint}`}`
        : `/proxy/${group.name}`,
    }));
  }

  getGroupIntegrationInfo(
    groupName: string,
    proxyKey: string,
  ): Array<{ name: string; display_name: string; channel_type: string; path: string }> {
    const group = this.getGroupByName(groupName);
    if (!group) {
      throw new Error("group not found");
    }
    if (!this.canAccessGroupByProxyKey(group, proxyKey)) {
      return [];
    }
    const isCustom = this.isCustomOpenAIChannel(group);
    return [
      {
        name: group.name,
        display_name: group.display_name,
        channel_type: isCustom ? "custom" : group.channel_type,
        path: isCustom
          ? group.validation_endpoint.startsWith("/")
            ? group.validation_endpoint
            : `/${group.validation_endpoint}`
          : "",
      },
    ];
  }

  selectProxyGroup(groupName: string): { originalGroup: GroupModel; effectiveGroup: GroupModel } {
    const originalGroup = this.getGroupByName(groupName);
    if (!originalGroup) {
      throw new Error("group not found");
    }
    if (originalGroup.group_type !== "aggregate") {
      return { originalGroup, effectiveGroup: originalGroup };
    }
    const subGroups = this.getSubGroups(originalGroup.id);
    if (subGroups.length === 0) {
      throw new Error("no available sub-groups");
    }
    const selected = pickWeighted(subGroups.map((item) => ({ group: item.group, weight: item.weight })));
    return { originalGroup, effectiveGroup: selected.group };
  }

  selectActiveApiKeys(groupId: number): ApiKeyModel[] {
    const rows = this.db
      .prepare("SELECT * FROM api_keys WHERE group_id = ? AND status = 'active' ORDER BY failure_count ASC, id ASC")
      .all(groupId) as ApiKeyModel[];
    return rows
      .map((row) => {
        try {
          return { ...row, key_value: this.decryptFromStorage(row.key_value) };
        } catch {
          return null;
        }
      })
      .filter((row): row is ApiKeyModel => row !== null);
  }

  markKeyResult(keyId: number, okResult: boolean, errorMessage = ""): void {
    if (okResult) {
      this.db
        .prepare("UPDATE api_keys SET request_count = request_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?")
        .run(nowIso(), nowIso(), keyId);
      return;
    }
    const threshold = Number(this.getSettingValue("blacklist_threshold", "3"));
    const current = this.db
      .prepare("SELECT failure_count FROM api_keys WHERE id = ?")
      .get(keyId) as { failure_count: number } | undefined;
    const nextFailureCount = (current?.failure_count ?? 0) + 1;
    const status = nextFailureCount >= threshold ? "invalid" : "active";
    this.db
      .prepare(
        "UPDATE api_keys SET failure_count = ?, status = ?, last_used_at = ?, updated_at = ?, notes = CASE WHEN ? = '' THEN notes ELSE ? END WHERE id = ?",
      )
      .run(nextFailureCount, status, nowIso(), nowIso(), errorMessage, errorMessage.slice(0, 255), keyId);
  }

  addRequestLog(log: Omit<RequestLogModel, "id" | "timestamp">): void {
    this.db
      .prepare(
        `
      INSERT INTO request_logs
      (id, timestamp, group_id, group_name, parent_group_id, parent_group_name, key_value, key_hash, model,
       is_success, source_ip, status_code, request_path, duration_ms, error_message, user_agent, request_type,
       upstream_addr, is_stream, request_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        randomUUID(),
        nowIso(),
        log.group_id,
        log.group_name,
        log.parent_group_id,
        log.parent_group_name,
        log.key_value ? this.encryptForStorage(log.key_value) : null,
        log.key_hash,
        log.model,
        log.is_success,
        log.source_ip,
        log.status_code,
        log.request_path,
        log.duration_ms,
        log.error_message,
        log.user_agent,
        log.request_type,
        log.upstream_addr,
        log.is_stream,
        log.request_body,
      );
  }

  listLogs(filters: Record<string, unknown>): { items: RequestLogModel[]; pagination: ReturnType<typeof buildPagination> } {
    const page = Math.max(1, Number(filters.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Number(filters.page_size ?? 20)));
    const offset = (page - 1) * pageSize;
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (typeof filters.group_name === "string" && filters.group_name) {
      where.push("group_name = @group_name");
      params.group_name = filters.group_name;
    }
    if (typeof filters.parent_group_name === "string" && filters.parent_group_name) {
      where.push("parent_group_name = @parent_group_name");
      params.parent_group_name = filters.parent_group_name;
    }
    if (typeof filters.key_value === "string" && filters.key_value) {
      where.push("key_hash = @key_hash");
      params.key_hash = hashKey(filters.key_value);
    }
    if (typeof filters.model === "string" && filters.model) {
      where.push("model LIKE @model");
      params.model = `%${filters.model}%`;
    }
    if (typeof filters.is_success === "string" && filters.is_success.length > 0) {
      where.push("is_success = @is_success");
      params.is_success = filters.is_success === "true" ? 1 : 0;
    }
    if (typeof filters.status_code === "string" && filters.status_code) {
      where.push("status_code = @status_code");
      params.status_code = Number(filters.status_code);
    }
    if (typeof filters.error_contains === "string" && filters.error_contains) {
      where.push("error_message LIKE @error_contains");
      params.error_contains = `%${filters.error_contains}%`;
    }
    if (typeof filters.start_time === "string" && filters.start_time) {
      where.push("timestamp >= @start_time");
      params.start_time = filters.start_time;
    }
    if (typeof filters.end_time === "string" && filters.end_time) {
      where.push("timestamp <= @end_time");
      params.end_time = filters.end_time;
    }
    if (typeof filters.request_type === "string" && filters.request_type) {
      where.push("request_type = @request_type");
      params.request_type = filters.request_type;
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM request_logs ${whereSql}`)
      .get(params) as { count: number };
    const rows = this.db
      .prepare(
        `
      SELECT * FROM request_logs
      ${whereSql}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `,
      )
      .all({ ...params, limit: pageSize, offset }) as RequestLogModel[];

    const decodedRows = rows.map((row) => {
      if (!row.key_value) {
        return row;
      }
      try {
        return { ...row, key_value: this.decryptFromStorage(row.key_value) };
      } catch {
        return { ...row, key_value: "failed-to-decrypt" };
      }
    });

    return {
      items: decodedRows,
      pagination: buildPagination(page, pageSize, total.count ?? 0),
    };
  }

  exportLogs(filters: Record<string, unknown>): string {
    const result = this.listLogs({ ...filters, page: 1, page_size: 100000 });
    const header = [
      "timestamp",
      "group_name",
      "parent_group_name",
      "status_code",
      "is_success",
      "model",
      "request_path",
      "duration_ms",
      "error_message",
      "source_ip",
      "request_type",
    ];
    const lines = result.items.map((item) => {
      const row = [
        item.timestamp,
        item.group_name,
        item.parent_group_name ?? "",
        String(item.status_code),
        String(item.is_success),
        item.model ?? "",
        item.request_path,
        String(item.duration_ms),
        item.error_message ?? "",
        item.source_ip,
        item.request_type,
      ];
      return row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",");
    });
    return [header.join(","), ...lines].join("\n");
  }

  getDashboardStats(): {
    key_count: { value: number; sub_value: number; sub_value_tip: string; trend: number; trend_is_growth: boolean };
    rpm: { value: number; trend: number; trend_is_growth: boolean };
    request_count: { value: number; trend: number; trend_is_growth: boolean };
    error_rate: { value: number; trend: number; trend_is_growth: boolean };
    security_warnings: Array<{ type: string; message: string; severity: string; suggestion: string }>;
  } {
    const totalKeysRow = this.db.prepare("SELECT COUNT(*) AS count FROM api_keys").get() as { count: number };
    const invalidKeysRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE status = 'invalid'")
      .get() as { count: number };

    const now = Date.now();
    const last24h = new Date(now - 24 * 3600 * 1000).toISOString();
    const prev24h = new Date(now - 48 * 3600 * 1000).toISOString();
    const logsLast = this.db
      .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ?")
      .get(last24h) as { total: number; failed: number | null };
    const logsPrev = this.db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ? AND timestamp < ?",
      )
      .get(prev24h, last24h) as { total: number; failed: number | null };

    const reqNow = logsLast.total ?? 0;
    const reqPrev = logsPrev.total ?? 0;
    const failedNow = logsLast.failed ?? 0;
    const failedPrev = logsPrev.failed ?? 0;
    const rpmValue = Number((reqNow / (24 * 60)).toFixed(2));
    const errorRateNow = reqNow === 0 ? 0 : Number(((failedNow / reqNow) * 100).toFixed(2));
    const errorRatePrev = reqPrev === 0 ? 0 : Number(((failedPrev / reqPrev) * 100).toFixed(2));

    const trend = (current: number, prev: number) => {
      if (prev === 0 && current === 0) {
        return 0;
      }
      if (prev === 0) {
        return 100;
      }
      return Number((((current - prev) / prev) * 100).toFixed(2));
    };

    const warnings: Array<{ type: string; message: string; severity: string; suggestion: string }> = [];
    const authKey = this.getSettingValue("proxy_keys", "");
    if (splitProxyKeys(authKey).length < 1) {
      warnings.push({
        type: "auth_key",
        message: "Global proxy key is empty",
        severity: "high",
        suggestion: "Set proxy_keys in settings",
      });
    }
    if ((invalidKeysRow.count ?? 0) > 0) {
      warnings.push({
        type: "invalid_keys",
        message: `${invalidKeysRow.count} keys are invalid`,
        severity: "medium",
        suggestion: "Validate or clean invalid keys",
      });
    }

    return {
      key_count: {
        value: totalKeysRow.count ?? 0,
        sub_value: invalidKeysRow.count ?? 0,
        sub_value_tip: "invalid",
        trend: 0,
        trend_is_growth: true,
      },
      rpm: {
        value: rpmValue,
        trend: trend(rpmValue, Number((reqPrev / (24 * 60)).toFixed(2))),
        trend_is_growth: true,
      },
      request_count: {
        value: reqNow,
        trend: trend(reqNow, reqPrev),
        trend_is_growth: true,
      },
      error_rate: {
        value: errorRateNow,
        trend: trend(errorRateNow, errorRatePrev),
        trend_is_growth: false,
      },
      security_warnings: warnings,
    };
  }

  getDashboardChart(groupId?: number): { labels: string[]; datasets: Array<{ label: string; data: number[]; color: string }> } {
    const labels: string[] = [];
    const success: number[] = [];
    const failed: number[] = [];

    for (let hoursAgo = 23; hoursAgo >= 0; hoursAgo -= 1) {
      const start = new Date(Date.now() - hoursAgo * 3600 * 1000);
      start.setMinutes(0, 0, 0);
      const end = new Date(start.getTime() + 3600 * 1000);
      labels.push(`${String(start.getHours()).padStart(2, "0")}:00`);
      const query = groupId
        ? this.db.prepare(
            "SELECT SUM(CASE WHEN is_success=1 THEN 1 ELSE 0 END) AS success, SUM(CASE WHEN is_success=0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ? AND timestamp < ? AND group_id = ?",
          )
        : this.db.prepare(
            "SELECT SUM(CASE WHEN is_success=1 THEN 1 ELSE 0 END) AS success, SUM(CASE WHEN is_success=0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ? AND timestamp < ?",
          );
      const row = (groupId ? query.get(start.toISOString(), end.toISOString(), groupId) : query.get(start.toISOString(), end.toISOString())) as {
        success: number | null;
        failed: number | null;
      };
      success.push(row.success ?? 0);
      failed.push(row.failed ?? 0);
    }
    return {
      labels,
      datasets: [
        { label: "Success", data: success, color: "#18a058" },
        { label: "Failed", data: failed, color: "#d03050" },
      ],
    };
  }

  getEncryptionStatus(): { has_mismatch: boolean; scenario_type: string; message: string; suggestion: string } {
    const encryptionKey = this.getEncryptionKey();
    const sample = this.db
      .prepare("SELECT key_value FROM api_keys ORDER BY id DESC LIMIT 1")
      .get() as { key_value: string } | undefined;

    if (!sample) {
      return {
        has_mismatch: false,
        scenario_type: "none",
        message: "No key data found",
        suggestion: "",
      };
    }

    const encrypted = isEncryptedValue(sample.key_value);
    if (!encrypted && encryptionKey) {
      return {
        has_mismatch: true,
        scenario_type: "data_not_encrypted",
        message: "ENCRYPTION_KEY is configured but stored key data is plaintext",
        suggestion: "Run migrate-keys --to <new-key> to encrypt existing data",
      };
    }

    if (encrypted && !encryptionKey) {
      return {
        has_mismatch: true,
        scenario_type: "missing_encryption_key",
        message: "Stored key data is encrypted but ENCRYPTION_KEY is not configured",
        suggestion: "Set ENCRYPTION_KEY or run migrate-keys with --from to decrypt data",
      };
    }

    if (encrypted && encryptionKey) {
      try {
        decryptWithKey(sample.key_value, encryptionKey);
      } catch {
        return {
          has_mismatch: true,
          scenario_type: "key_mismatch",
          message: "ENCRYPTION_KEY does not match encrypted data",
          suggestion: "Use the correct key or run migrate-keys --from <old> --to <new>",
        };
      }
    }

    return {
      has_mismatch: false,
      scenario_type: "none",
      message: "Encryption config and data state are consistent",
      suggestion: "",
    };
  }

  migrateEncryptionKeys(fromKey: string, toKey: string): {
    total_keys: number;
    migrated_keys: number;
    migrated_logs: number;
  } {
    const keyRows = this.db.prepare("SELECT id, key_value FROM api_keys ORDER BY id ASC").all() as Array<{
      id: number;
      key_value: string;
    }>;
    const logRows = this.db.prepare("SELECT id, key_value FROM request_logs WHERE key_value IS NOT NULL ORDER BY timestamp ASC").all() as Array<{
      id: string;
      key_value: string;
    }>;

    const updateKey = this.db.prepare("UPDATE api_keys SET key_value = ?, updated_at = ? WHERE id = ?");
    const updateLog = this.db.prepare("UPDATE request_logs SET key_value = ? WHERE id = ?");

    const tx = this.db.transaction(() => {
      for (const row of keyRows) {
        const transformed = transformEncryption(row.key_value, fromKey, toKey);
        updateKey.run(transformed, nowIso(), row.id);
      }
      for (const row of logRows) {
        const transformed = transformEncryption(row.key_value, fromKey, toKey);
        updateLog.run(transformed, row.id);
      }
    });
    tx();

    return {
      total_keys: keyRows.length,
      migrated_keys: keyRows.length,
      migrated_logs: logRows.length,
    };
  }

  async runScheduledKeyValidation(): Promise<void> {
    const intervalMinutes = Math.max(1, Number(this.getSettingValue("key_validation_interval_minutes", "60")));
    const lastRunKey = "gpt-load:key-validation:last-run";
    const lockKey = "gpt-load:key-validation:lock";
    const now = Date.now();

    const lastRunValue = await this.sharedStore.get(lastRunKey);
    const lastRunTs = lastRunValue ? Number(lastRunValue) : 0;
    if (lastRunTs > 0 && now - lastRunTs < intervalMinutes * 60 * 1000) {
      return;
    }

    const lock = await this.sharedStore.setNx(lockKey, String(now), intervalMinutes * 60);
    if (!lock) {
      return;
    }

    try {
      const groups = this.listGroups().filter((group) => group.group_type === "standard");
      for (const group of groups) {
        const rows = this.db
          .prepare("SELECT id, key_value FROM api_keys WHERE group_id = ? AND status = 'invalid' ORDER BY id ASC")
          .all(group.id) as Array<{ id: number; key_value: string }>;
        for (const row of rows) {
          let plain = "";
          try {
            plain = this.decryptFromStorage(row.key_value);
          } catch {
            plain = "";
          }
          if (!plain) {
            continue;
          }
          const check = await this.validateKeyAgainstUpstream(group, plain);
          this.db
            .prepare("UPDATE api_keys SET status = ?, notes = ?, updated_at = ? WHERE id = ?")
            .run(check.isValid ? "active" : "invalid", check.isValid ? "" : check.error, nowIso(), row.id);
        }
      }
      await this.sharedStore.set(lastRunKey, String(now), intervalMinutes * 60 * 2);
    } finally {
      await this.sharedStore.del(lockKey);
    }
  }

  async cleanupExpiredLogs(): Promise<number> {
    const retentionDays = Number(this.getSettingValue("request_log_retention_days", "7"));
    if (retentionDays <= 0) {
      return 0;
    }
    const lockKey = "gpt-load:log-cleanup:lock";
    const lock = await this.sharedStore.setNx(lockKey, nowIso(), 55);
    if (!lock) {
      return 0;
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
    try {
      const result = this.db.prepare("DELETE FROM request_logs WHERE timestamp < ?").run(cutoff);
      return result.changes;
    } finally {
      await this.sharedStore.del(lockKey);
    }
  }
}
