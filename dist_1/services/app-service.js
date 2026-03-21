"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppService = void 0;
const node_crypto_1 = require("node:crypto");
const utils_js_1 = require("../lib/utils.js");
const encryption_js_1 = require("../lib/encryption.js");
class AppService {
    db;
    runtimeEncryptionKey;
    sharedStore;
    configEventChannel = "gpt-load:config:events";
    taskState = { current: null };
    constructor(db, runtimeEncryptionKey = "", sharedStore) {
        this.db = db;
        this.runtimeEncryptionKey = runtimeEncryptionKey;
        this.sharedStore =
            sharedStore ??
                {
                    get: async () => null,
                    set: async () => { },
                    del: async () => { },
                    setNx: async () => true,
                    publish: async () => { },
                    subscribe: async () => async () => { },
                    close: async () => { },
                };
    }
    getEncryptionKey() {
        return this.runtimeEncryptionKey;
    }
    getConfigEventChannel() {
        return this.configEventChannel;
    }
    async publishConfigEvent(type, data) {
        const payload = {
            type,
            at: (0, utils_js_1.nowIso)(),
            data,
        };
        await this.sharedStore.publish(this.configEventChannel, JSON.stringify(payload));
    }
    handleConfigEvent(rawMessage) {
        const payload = (0, utils_js_1.parseJson)(rawMessage, null);
        if (!payload) {
            return;
        }
        if (payload.type.startsWith("settings") || payload.type.startsWith("groups")) {
            this.taskState.current = null;
        }
    }
    encryptForStorage(plainText) {
        const key = this.getEncryptionKey();
        if (!key) {
            return plainText;
        }
        if ((0, encryption_js_1.isEncryptedValue)(plainText)) {
            return plainText;
        }
        return (0, encryption_js_1.encryptWithKey)(plainText, key);
    }
    decryptFromStorage(value) {
        if (!(0, encryption_js_1.isEncryptedValue)(value)) {
            return value;
        }
        const key = this.getEncryptionKey();
        if (!key) {
            throw new Error("encryption key is required but not configured");
        }
        return (0, encryption_js_1.decryptWithKey)(value, key);
    }
    getSettingValue(key, fallback) {
        const row = this.db.prepare("SELECT setting_value FROM settings WHERE setting_key = ?").get(key);
        if (!row) {
            return fallback;
        }
        return row.setting_value;
    }
    getSettingsCategories() {
        const rows = this.db
            .prepare("SELECT setting_key, setting_value, setting_type, name, description, category, required, min_value FROM settings ORDER BY category, setting_key")
            .all();
        const grouped = new Map();
        for (const row of rows) {
            if (!grouped.has(row.category)) {
                grouped.set(row.category, []);
            }
            const value = row.setting_type === "int"
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
    updateSettings(payload) {
        const stmt = this.db.prepare("UPDATE settings SET setting_value = ?, updated_at = ? WHERE setting_key = ?");
        const tx = this.db.transaction(() => {
            for (const [key, value] of Object.entries(payload)) {
                if (typeof value === "undefined") {
                    continue;
                }
                let saveValue;
                if (typeof value === "boolean") {
                    saveValue = String(value);
                }
                else if (typeof value === "number") {
                    saveValue = String(value);
                }
                else {
                    saveValue = String(value ?? "");
                }
                if (key === "proxy_keys") {
                    saveValue = (0, utils_js_1.splitProxyKeys)(saveValue).join(",");
                }
                stmt.run(saveValue, (0, utils_js_1.nowIso)(), key);
            }
        });
        tx();
        void this.publishConfigEvent("settings.updated");
    }
    getChannelTypes() {
        return ["openai", "openai-response", "gemini", "anthropic"];
    }
    getAllowedGroupConfigKeys() {
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
    sanitizeGroupConfig(config) {
        const allowedKeys = new Set(this.getAllowedGroupConfigKeys());
        const sanitized = {};
        for (const [key, value] of Object.entries(config)) {
            if (!allowedKeys.has(key)) {
                throw new Error(`unknown config field: '${key}'`);
            }
            sanitized[key] = value;
        }
        return sanitized;
    }
    rowToGroup(row) {
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
            upstreams: (0, utils_js_1.parseJson)(row.upstreams, []),
            config: (0, utils_js_1.parseJson)(row.config, {}),
            param_overrides: (0, utils_js_1.parseJson)(row.param_overrides, {}),
            model_redirect_rules: (0, utils_js_1.parseJson)(row.model_redirect_rules, {}),
            model_redirect_strict: row.model_redirect_strict === 1,
            header_rules: (0, utils_js_1.parseJson)(row.header_rules, []),
            proxy_keys: row.proxy_keys,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
    listGroups() {
        const rows = this.db.prepare("SELECT * FROM groups ORDER BY sort ASC, id ASC").all();
        return rows.map((row) => this.rowToGroup(row));
    }
    listGroupSimple() {
        return this.db
            .prepare("SELECT id, name, display_name FROM groups ORDER BY sort ASC, id ASC")
            .all();
    }
    getGroupById(groupId) {
        const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId);
        return row ? this.rowToGroup(row) : null;
    }
    getGroupByName(name) {
        const row = this.db.prepare("SELECT * FROM groups WHERE name = ?").get(name);
        return row ? this.rowToGroup(row) : null;
    }
    normalizeGroupPayload(payload, existing) {
        const now = (0, utils_js_1.nowIso)();
        const upstreams = payload.upstreams ?? existing?.upstreams ?? [];
        const incomingConfig = payload.config;
        const channelType = payload.channel_type ?? existing?.channel_type ?? "openai";
        const groupType = payload.group_type ?? existing?.group_type ?? "standard";
        const validationEndpoint = payload.validation_endpoint ??
            existing?.validation_endpoint ??
            (channelType === "openai-response"
                ? "/v1/responses"
                : channelType === "anthropic"
                    ? "/v1/messages"
                    : channelType === "gemini"
                        ? "/v1beta/models"
                        : "/v1/chat/completions");
        return {
            name: payload.name ?? existing?.name ?? "",
            display_name: payload.display_name ?? existing?.display_name ?? "",
            description: payload.description ?? existing?.description ?? "",
            group_type: groupType,
            channel_type: channelType,
            sort: (0, utils_js_1.safeNumber)(payload.sort, existing?.sort ?? 0),
            test_model: payload.test_model ?? existing?.test_model ?? "gpt-4o-mini",
            validation_endpoint: validationEndpoint,
            upstreams,
            config: incomingConfig
                ? this.sanitizeGroupConfig(incomingConfig)
                : existing?.config ?? {},
            param_overrides: payload.param_overrides ?? existing?.param_overrides ?? {},
            model_redirect_rules: payload.model_redirect_rules ?? existing?.model_redirect_rules ?? {},
            model_redirect_strict: payload.model_redirect_strict ?? existing?.model_redirect_strict ?? false,
            header_rules: payload.header_rules ?? existing?.header_rules ?? [],
            proxy_keys: (0, utils_js_1.splitProxyKeys)(payload.proxy_keys ?? existing?.proxy_keys ?? "").join(","),
            created_at: existing?.created_at ?? now,
            updated_at: now,
        };
    }
    createGroup(payload) {
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
        const result = stmt.run(normalized.name, normalized.display_name, normalized.description, normalized.group_type, normalized.channel_type, normalized.sort, normalized.test_model, normalized.validation_endpoint, (0, utils_js_1.toJson)(normalized.upstreams), (0, utils_js_1.toJson)(normalized.config), (0, utils_js_1.toJson)(normalized.param_overrides), (0, utils_js_1.toJson)(normalized.model_redirect_rules), normalized.model_redirect_strict ? 1 : 0, (0, utils_js_1.toJson)(normalized.header_rules), normalized.proxy_keys, normalized.created_at, normalized.updated_at);
        const group = this.getGroupById(Number(result.lastInsertRowid));
        if (!group) {
            throw new Error("failed to load created group");
        }
        void this.publishConfigEvent("groups.created", { group_id: group.id, group_name: group.name });
        return group;
    }
    updateGroup(groupId, payload) {
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
        stmt.run(normalized.name, normalized.display_name, normalized.description, normalized.group_type, normalized.channel_type, normalized.sort, normalized.test_model, normalized.validation_endpoint, (0, utils_js_1.toJson)(normalized.upstreams), (0, utils_js_1.toJson)(normalized.config), (0, utils_js_1.toJson)(normalized.param_overrides), (0, utils_js_1.toJson)(normalized.model_redirect_rules), normalized.model_redirect_strict ? 1 : 0, (0, utils_js_1.toJson)(normalized.header_rules), normalized.proxy_keys, normalized.updated_at, groupId);
        const updated = this.getGroupById(groupId);
        if (!updated) {
            throw new Error("group not found");
        }
        void this.publishConfigEvent("groups.updated", { group_id: updated.id, group_name: updated.name });
        return updated;
    }
    deleteGroup(groupId) {
        const existing = this.getGroupById(groupId);
        this.db.prepare("DELETE FROM groups WHERE id = ?").run(groupId);
        void this.publishConfigEvent("groups.deleted", { group_id: groupId, group_name: existing?.name ?? "" });
    }
    copyGroup(groupId, copyKeys) {
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
                .all(groupId);
            const stmt = this.db.prepare("INSERT INTO api_keys (key_value, key_hash, group_id, status, notes, request_count, failure_count, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)");
            const tx = this.db.transaction(() => {
                for (const key of sourceKeys) {
                    stmt.run(key.key_value, key.key_hash, copied.id, key.status, key.notes, (0, utils_js_1.nowIso)(), (0, utils_js_1.nowIso)());
                }
            });
            tx();
        }
        return copied;
    }
    getGroupConfigOptions() {
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
    getSubGroups(aggregateGroupId) {
        const rows = this.db
            .prepare(`
        SELECT gs.sub_group_id, gs.weight
        FROM group_sub_groups gs
        WHERE gs.group_id = ?
        ORDER BY gs.id ASC
      `)
            .all(aggregateGroupId);
        return rows
            .map((row) => {
            const group = this.getGroupById(row.sub_group_id);
            if (!group) {
                return null;
            }
            const stat = this.db
                .prepare(`
            SELECT
              COUNT(*) AS total_keys,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_keys,
              SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid_keys
            FROM api_keys
            WHERE group_id = ?
          `)
                .get(group.id);
            return {
                group,
                weight: row.weight,
                total_keys: stat.total_keys ?? 0,
                active_keys: stat.active_keys ?? 0,
                invalid_keys: stat.invalid_keys ?? 0,
            };
        })
            .filter((item) => item !== null);
    }
    addSubGroups(aggregateGroupId, subGroups) {
        const stmt = this.db.prepare(`
      INSERT INTO group_sub_groups (group_id, sub_group_id, weight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_id, sub_group_id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at
    `);
        const tx = this.db.transaction(() => {
            for (const item of subGroups) {
                stmt.run(aggregateGroupId, item.group_id, (0, utils_js_1.safeNumber)(item.weight, 1), (0, utils_js_1.nowIso)(), (0, utils_js_1.nowIso)());
            }
        });
        tx();
    }
    updateSubGroupWeight(aggregateGroupId, subGroupId, weight) {
        this.db
            .prepare("UPDATE group_sub_groups SET weight = ?, updated_at = ? WHERE group_id = ? AND sub_group_id = ?")
            .run(weight, (0, utils_js_1.nowIso)(), aggregateGroupId, subGroupId);
    }
    deleteSubGroup(aggregateGroupId, subGroupId) {
        this.db
            .prepare("DELETE FROM group_sub_groups WHERE group_id = ? AND sub_group_id = ?")
            .run(aggregateGroupId, subGroupId);
    }
    getParentAggregateGroups(groupId) {
        return this.db
            .prepare(`
      SELECT g.id AS group_id, g.name, g.display_name, gs.weight
      FROM group_sub_groups gs
      JOIN groups g ON g.id = gs.group_id
      WHERE gs.sub_group_id = ?
      ORDER BY g.sort ASC, g.id ASC
    `)
            .all(groupId);
    }
    loadGroupKeyStats(groupId) {
        const row = this.db
            .prepare(`
        SELECT
          COUNT(*) AS total_keys,
          SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_keys,
          SUM(CASE WHEN status='invalid' THEN 1 ELSE 0 END) AS invalid_keys
        FROM api_keys
        WHERE group_id = ?
      `)
            .get(groupId);
        return {
            total_keys: row.total_keys ?? 0,
            active_keys: row.active_keys ?? 0,
            invalid_keys: row.invalid_keys ?? 0,
        };
    }
    loadRequestStats(groupId, sinceHours) {
        const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
        const row = this.db
            .prepare(`
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) AS failed_requests
      FROM request_logs
      WHERE group_id = ? AND timestamp >= ?
    `)
            .get(groupId, since);
        const total = row.total_requests ?? 0;
        const failed = row.failed_requests ?? 0;
        return {
            total_requests: total,
            failed_requests: failed,
            failure_rate: total === 0 ? 0 : Number(((failed / total) * 100).toFixed(2)),
        };
    }
    getGroupStats(groupId) {
        return {
            key_stats: this.loadGroupKeyStats(groupId),
            stats_24_hour: this.loadRequestStats(groupId, 24),
            stats_7_day: this.loadRequestStats(groupId, 24 * 7),
            stats_30_day: this.loadRequestStats(groupId, 24 * 30),
        };
    }
    listKeys(params) {
        const page = Math.max(1, params.page);
        const pageSize = Math.max(1, Math.min(200, params.page_size));
        const offset = (page - 1) * pageSize;
        const whereParts = ["group_id = @group_id"];
        const bindings = { group_id: params.group_id };
        if (params.status && (params.status === "active" || params.status === "invalid")) {
            whereParts.push("status = @status");
            bindings.status = params.status;
        }
        if (params.key_value) {
            whereParts.push("key_hash = @key_hash");
            bindings.key_hash = (0, utils_js_1.hashKey)(params.key_value);
        }
        const whereSql = whereParts.join(" AND ");
        const total = this.db
            .prepare(`SELECT COUNT(*) AS count FROM api_keys WHERE ${whereSql}`)
            .get(bindings);
        const rows = this.db
            .prepare(`
      SELECT * FROM api_keys
      WHERE ${whereSql}
      ORDER BY id DESC
      LIMIT @limit OFFSET @offset
    `)
            .all({ ...bindings, limit: pageSize, offset });
        const decodedRows = rows.map((row) => {
            try {
                return { ...row, key_value: this.decryptFromStorage(row.key_value) };
            }
            catch {
                return { ...row, key_value: "failed-to-decrypt" };
            }
        });
        return { items: decodedRows, pagination: (0, utils_js_1.buildPagination)(page, pageSize, total.count ?? 0) };
    }
    ensureGroupExists(groupId) {
        const group = this.getGroupById(groupId);
        if (!group) {
            throw new Error("group not found");
        }
    }
    addMultipleKeys(groupId, keysText) {
        this.ensureGroupExists(groupId);
        const keys = (0, utils_js_1.splitKeys)(keysText);
        if (keys.length === 0) {
            throw new Error("no valid keys found in the input text");
        }
        const insert = this.db.prepare("INSERT OR IGNORE INTO api_keys (key_value, key_hash, group_id, status, notes, request_count, failure_count, last_used_at, created_at, updated_at) VALUES (?, ?, ?, 'active', '', 0, 0, NULL, ?, ?)");
        let added = 0;
        const tx = this.db.transaction(() => {
            for (const key of keys) {
                const info = insert.run(this.encryptForStorage(key), (0, utils_js_1.hashKey)(key), groupId, (0, utils_js_1.nowIso)(), (0, utils_js_1.nowIso)());
                if (info.changes > 0) {
                    added += 1;
                }
            }
        });
        tx();
        const totalInGroup = this.db
            .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE group_id = ?")
            .get(groupId);
        void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "add" });
        return { added_count: added, ignored_count: keys.length - added, total_in_group: totalInGroup.count ?? 0 };
    }
    deleteMultipleKeys(groupId, keysText) {
        this.ensureGroupExists(groupId);
        const keys = (0, utils_js_1.splitKeys)(keysText);
        if (keys.length === 0) {
            throw new Error("no valid keys found in the input text");
        }
        const del = this.db.prepare("DELETE FROM api_keys WHERE group_id = ? AND key_hash = ?");
        let deleted = 0;
        const tx = this.db.transaction(() => {
            for (const key of keys) {
                const info = del.run(groupId, (0, utils_js_1.hashKey)(key));
                deleted += info.changes;
            }
        });
        tx();
        const totalInGroup = this.db
            .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE group_id = ?")
            .get(groupId);
        void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "delete" });
        return {
            deleted_count: deleted,
            ignored_count: Math.max(0, keys.length - deleted),
            total_in_group: totalInGroup.count ?? 0,
        };
    }
    restoreMultipleKeys(groupId, keysText) {
        this.ensureGroupExists(groupId);
        const keys = (0, utils_js_1.splitKeys)(keysText);
        if (keys.length === 0) {
            throw new Error("no valid keys found in the input text");
        }
        const up = this.db.prepare("UPDATE api_keys SET status='active', updated_at = ? WHERE group_id = ? AND key_hash = ?");
        let restored = 0;
        const tx = this.db.transaction(() => {
            for (const key of keys) {
                restored += up.run((0, utils_js_1.nowIso)(), groupId, (0, utils_js_1.hashKey)(key)).changes;
            }
        });
        tx();
        const totalInGroup = this.db
            .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE group_id = ?")
            .get(groupId);
        void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "restore" });
        return {
            restored_count: restored,
            ignored_count: Math.max(0, keys.length - restored),
            total_in_group: totalInGroup.count ?? 0,
        };
    }
    restoreAllInvalidKeys(groupId) {
        this.ensureGroupExists(groupId);
        const changed = this.db
            .prepare("UPDATE api_keys SET status='active', updated_at = ? WHERE group_id = ? AND status='invalid'")
            .run((0, utils_js_1.nowIso)(), groupId).changes;
        void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "restore-invalid-all" });
        return changed;
    }
    clearAllInvalidKeys(groupId) {
        this.ensureGroupExists(groupId);
        const changed = this.db.prepare("DELETE FROM api_keys WHERE group_id = ? AND status='invalid'").run(groupId).changes;
        void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "clear-invalid-all" });
        return changed;
    }
    clearAllKeys(groupId) {
        this.ensureGroupExists(groupId);
        const changed = this.db.prepare("DELETE FROM api_keys WHERE group_id = ?").run(groupId).changes;
        void this.publishConfigEvent("keys.changed", { group_id: groupId, action: "clear-all" });
        return changed;
    }
    updateKeyNotes(keyId, notes) {
        this.db
            .prepare("UPDATE api_keys SET notes = ?, updated_at = ? WHERE id = ?")
            .run(notes.trim().slice(0, 255), (0, utils_js_1.nowIso)(), keyId);
        void this.publishConfigEvent("keys.changed", { key_id: keyId, action: "update-notes" });
    }
    exportKeys(groupId, status) {
        let rows;
        if (status === "all") {
            rows = this.db.prepare("SELECT key_value FROM api_keys WHERE group_id = ? ORDER BY id DESC").all(groupId);
        }
        else {
            rows = this.db
                .prepare("SELECT key_value FROM api_keys WHERE group_id = ? AND status = ? ORDER BY id DESC")
                .all(groupId, status);
        }
        const output = rows.map((item) => {
            try {
                return this.decryptFromStorage(item.key_value);
            }
            catch {
                return "failed-to-decrypt";
            }
        });
        return output.join("\n");
    }
    taskStatusKey() {
        return "gpt-load:task:global";
    }
    taskLockKey() {
        return "gpt-load:task:lock";
    }
    async startTask(taskType, groupName, total) {
        const current = await this.getTaskStatus();
        if ("is_running" in current && current.is_running) {
            throw new Error("a task is already running, please wait");
        }
        const lockAcquired = await this.sharedStore.setNx(this.taskLockKey(), (0, utils_js_1.nowIso)(), 60 * 60 * 24);
        if (!lockAcquired) {
            throw new Error("a task is already running, please wait");
        }
        const task = {
            task_type: taskType,
            is_running: true,
            group_name: groupName,
            processed: 0,
            total,
            started_at: (0, utils_js_1.nowIso)(),
        };
        this.taskState.current = task;
        await this.saveTaskStatus(task);
        return task;
    }
    async saveTaskStatus(task) {
        this.db
            .prepare("INSERT INTO task_status (task_key, payload, updated_at) VALUES ('global', ?, ?) ON CONFLICT(task_key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at")
            .run(JSON.stringify(task), (0, utils_js_1.nowIso)());
        await this.sharedStore.set(this.taskStatusKey(), JSON.stringify(task), 60 * 60 * 24);
    }
    async updateTaskProgress(processed) {
        if (!this.taskState.current || !this.taskState.current.is_running) {
            return;
        }
        this.taskState.current.processed = processed;
        await this.saveTaskStatus(this.taskState.current);
    }
    async finishTask(result, error) {
        if (!this.taskState.current) {
            return;
        }
        const finishedAt = (0, utils_js_1.nowIso)();
        this.taskState.current.is_running = false;
        this.taskState.current.finished_at = finishedAt;
        const start = new Date(this.taskState.current.started_at).getTime();
        this.taskState.current.duration_seconds = Number(((Date.now() - start) / 1000).toFixed(3));
        if (error) {
            this.taskState.current.error = error;
        }
        else {
            this.taskState.current.result = result;
        }
        await this.saveTaskStatus(this.taskState.current);
        await this.sharedStore.del(this.taskLockKey());
    }
    async getTaskStatus() {
        if (this.taskState.current) {
            return this.taskState.current;
        }
        const fromStore = await this.sharedStore.get(this.taskStatusKey());
        if (fromStore) {
            return (0, utils_js_1.parseJson)(fromStore, {
                task_type: "KEY_IMPORT",
                is_running: false,
                processed: 0,
                total: 0,
                started_at: (0, utils_js_1.nowIso)(),
            });
        }
        const row = this.db.prepare("SELECT payload FROM task_status WHERE task_key='global'").get();
        if (!row) {
            return { is_running: false };
        }
        return (0, utils_js_1.parseJson)(row.payload, {
            task_type: "KEY_IMPORT",
            is_running: false,
            processed: 0,
            total: 0,
            started_at: (0, utils_js_1.nowIso)(),
        });
    }
    async runImportTask(groupId, keysText) {
        const group = this.getGroupById(groupId);
        if (!group) {
            throw new Error("group not found");
        }
        const keys = (0, utils_js_1.splitKeys)(keysText);
        const task = await this.startTask("KEY_IMPORT", group.name, keys.length);
        const insert = this.db.prepare("INSERT OR IGNORE INTO api_keys (key_value, key_hash, group_id, status, notes, request_count, failure_count, last_used_at, created_at, updated_at) VALUES (?, ?, ?, 'active', '', 0, 0, NULL, ?, ?)");
        setImmediate(async () => {
            let added = 0;
            try {
                for (let index = 0; index < keys.length; index += 1) {
                    const key = keys[index];
                    const info = insert.run(this.encryptForStorage(key), (0, utils_js_1.hashKey)(key), groupId, (0, utils_js_1.nowIso)(), (0, utils_js_1.nowIso)());
                    if (info.changes > 0) {
                        added += 1;
                    }
                    await this.updateTaskProgress(index + 1);
                }
                await this.finishTask({ added_count: added, ignored_count: keys.length - added });
            }
            catch (error) {
                await this.finishTask(null, error instanceof Error ? error.message : "unknown error");
            }
        });
        return task;
    }
    async runDeleteTask(groupId, keysText) {
        const group = this.getGroupById(groupId);
        if (!group) {
            throw new Error("group not found");
        }
        const keys = (0, utils_js_1.splitKeys)(keysText);
        const task = await this.startTask("KEY_DELETE", group.name, keys.length);
        const del = this.db.prepare("DELETE FROM api_keys WHERE group_id = ? AND key_hash = ?");
        setImmediate(async () => {
            let deleted = 0;
            try {
                for (let index = 0; index < keys.length; index += 1) {
                    const key = keys[index];
                    deleted += del.run(groupId, (0, utils_js_1.hashKey)(key)).changes;
                    await this.updateTaskProgress(index + 1);
                }
                await this.finishTask({ deleted_count: deleted, ignored_count: Math.max(0, keys.length - deleted) });
            }
            catch (error) {
                await this.finishTask(null, error instanceof Error ? error.message : "unknown error");
            }
        });
        return task;
    }
    getValidationEndpoint(group) {
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
    buildValidationRequest(group, apiKey) {
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
    async validateKeyAgainstUpstream(group, apiKey) {
        try {
            const requestConfig = this.buildValidationRequest(group, apiKey);
            const startedAt = Date.now();
            if (process.env.NODE_ENV !== "production") {
                console.info(`[key-validation] request group=${group.name} method=${requestConfig.method} url=${requestConfig.url}`);
            }
            const timeoutSeconds = (0, utils_js_1.safeNumber)(group.config.key_validation_timeout_seconds ?? undefined, Number(this.getSettingValue("key_validation_timeout_seconds", "20")));
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);
            let response;
            try {
                response = await fetch(requestConfig.url, {
                    method: requestConfig.method,
                    headers: requestConfig.headers,
                    body: requestConfig.body,
                    signal: controller.signal,
                });
            }
            finally {
                clearTimeout(timer);
            }
            if (response.status < 400) {
                if (process.env.NODE_ENV !== "production") {
                    console.info(`[key-validation] response group=${group.name} status=${response.status} duration_ms=${Date.now() - startedAt}`);
                }
                return { isValid: true, error: "" };
            }
            const bodyText = await response.text();
            if (process.env.NODE_ENV !== "production") {
                console.info(`[key-validation] response group=${group.name} status=${response.status} duration_ms=${Date.now() - startedAt}`);
            }
            return {
                isValid: false,
                error: bodyText ? bodyText.slice(0, 255) : `status:${response.status}`,
            };
        }
        catch (error) {
            if (process.env.NODE_ENV !== "production") {
                const message = error instanceof Error ? error.message : "validation error";
                console.info(`[key-validation] error group=${group.name} message=${message}`);
            }
            return {
                isValid: false,
                error: error instanceof Error ? error.message.slice(0, 255) : "validation error",
            };
        }
    }
    async runValidateTask(groupId, status) {
        const group = this.getGroupById(groupId);
        if (!group) {
            throw new Error("group not found");
        }
        const rows = this.db
            .prepare(status
            ? "SELECT id, key_value FROM api_keys WHERE group_id = ? AND status = ? ORDER BY id"
            : "SELECT id, key_value FROM api_keys WHERE group_id = ? ORDER BY id")
            .all(status ? [groupId, status] : [groupId]);
        const task = await this.startTask("KEY_VALIDATION", group.name, rows.length);
        setImmediate(async () => {
            try {
                let processed = 0;
                let invalid = 0;
                let cursor = 0;
                const concurrency = Math.max(1, (0, utils_js_1.safeNumber)(group.config.key_validation_concurrency ?? undefined, Number(this.getSettingValue("key_validation_concurrency", "10"))));
                const workerCount = Math.min(concurrency, Math.max(1, rows.length));
                const worker = async () => {
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
                        }
                        catch {
                            plainKey = "";
                        }
                        let isValid = false;
                        let validationError = "invalid key format";
                        if (plainKey.trim().length > 0) {
                            const checkResult = await this.validateKeyAgainstUpstream(group, plainKey);
                            isValid = checkResult.isValid;
                            validationError = checkResult.error;
                        }
                        this.db
                            .prepare("UPDATE api_keys SET status = ?, notes = ?, updated_at = ? WHERE id = ?")
                            .run(isValid ? "active" : "invalid", isValid ? "" : validationError, (0, utils_js_1.nowIso)(), row.id);
                        if (!isValid) {
                            invalid += 1;
                        }
                        processed += 1;
                        await this.updateTaskProgress(processed);
                    }
                };
                await Promise.all(Array.from({ length: workerCount }, () => worker()));
                await this.finishTask({ invalid_keys: invalid, total_keys: rows.length, valid_keys: rows.length - invalid });
            }
            catch (error) {
                await this.finishTask(null, error instanceof Error ? error.message : "unknown error");
            }
        });
        return task;
    }
    async testKeys(groupId, keysText) {
        const group = this.getGroupById(groupId);
        if (!group) {
            throw new Error("group not found");
        }
        const start = Date.now();
        const keys = (0, utils_js_1.splitKeys)(keysText);
        const results = await Promise.all(keys.map(async (key) => {
            let isValid = false;
            let error = "invalid key format";
            if (key.trim().length > 0) {
                const checkResult = await this.validateKeyAgainstUpstream(group, key);
                isValid = checkResult.isValid;
                error = checkResult.error;
            }
            return {
                key_value: (0, utils_js_1.maskKey)(key),
                is_valid: isValid,
                error: isValid ? "" : error,
            };
        }));
        return { results, total_duration: Date.now() - start };
    }
    canAccessGroupByProxyKey(group, key) {
        const groupKeys = (0, utils_js_1.splitProxyKeys)(group.proxy_keys);
        const globalKeys = (0, utils_js_1.splitProxyKeys)(this.getSettingValue("proxy_keys", ""));
        return groupKeys.includes(key) || globalKeys.includes(key);
    }
    getDefaultValidationEndpoint(channelType) {
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
    isCustomOpenAIChannel(group) {
        if (group.channel_type !== "openai" && group.channel_type !== "openai-response") {
            return false;
        }
        if (!group.validation_endpoint) {
            return false;
        }
        return group.validation_endpoint !== this.getDefaultValidationEndpoint(group.channel_type);
    }
    getIntegrationInfo(proxyKey) {
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
    getGroupIntegrationInfo(groupName, proxyKey) {
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
    selectProxyGroup(groupName) {
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
        const selected = (0, utils_js_1.pickWeighted)(subGroups.map((item) => ({ group: item.group, weight: item.weight })));
        return { originalGroup, effectiveGroup: selected.group };
    }
    selectActiveApiKeys(groupId) {
        const rows = this.db
            .prepare("SELECT * FROM api_keys WHERE group_id = ? AND status = 'active' ORDER BY failure_count ASC, id ASC")
            .all(groupId);
        return rows
            .map((row) => {
            try {
                return { ...row, key_value: this.decryptFromStorage(row.key_value) };
            }
            catch {
                return null;
            }
        })
            .filter((row) => row !== null);
    }
    markKeyResult(keyId, okResult, errorMessage = "") {
        if (okResult) {
            this.db
                .prepare("UPDATE api_keys SET request_count = request_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?")
                .run((0, utils_js_1.nowIso)(), (0, utils_js_1.nowIso)(), keyId);
            return;
        }
        const threshold = Number(this.getSettingValue("blacklist_threshold", "3"));
        const current = this.db
            .prepare("SELECT failure_count FROM api_keys WHERE id = ?")
            .get(keyId);
        const nextFailureCount = (current?.failure_count ?? 0) + 1;
        const status = nextFailureCount >= threshold ? "invalid" : "active";
        this.db
            .prepare("UPDATE api_keys SET failure_count = ?, status = ?, last_used_at = ?, updated_at = ?, notes = CASE WHEN ? = '' THEN notes ELSE ? END WHERE id = ?")
            .run(nextFailureCount, status, (0, utils_js_1.nowIso)(), (0, utils_js_1.nowIso)(), errorMessage, errorMessage.slice(0, 255), keyId);
    }
    addRequestLog(log) {
        this.db
            .prepare(`
      INSERT INTO request_logs
      (id, timestamp, group_id, group_name, parent_group_id, parent_group_name, key_value, key_hash, model,
       is_success, source_ip, status_code, request_path, duration_ms, error_message, user_agent, request_type,
       upstream_addr, is_stream, request_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
            .run((0, node_crypto_1.randomUUID)(), (0, utils_js_1.nowIso)(), log.group_id, log.group_name, log.parent_group_id, log.parent_group_name, log.key_value ? this.encryptForStorage(log.key_value) : null, log.key_hash, log.model, log.is_success, log.source_ip, log.status_code, log.request_path, log.duration_ms, log.error_message, log.user_agent, log.request_type, log.upstream_addr, log.is_stream, log.request_body);
    }
    listLogs(filters) {
        const page = Math.max(1, Number(filters.page ?? 1));
        const pageSize = Math.max(1, Math.min(200, Number(filters.page_size ?? 20)));
        const offset = (page - 1) * pageSize;
        const where = [];
        const params = {};
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
            params.key_hash = (0, utils_js_1.hashKey)(filters.key_value);
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
            .get(params);
        const rows = this.db
            .prepare(`
      SELECT * FROM request_logs
      ${whereSql}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `)
            .all({ ...params, limit: pageSize, offset });
        const decodedRows = rows.map((row) => {
            if (!row.key_value) {
                return row;
            }
            try {
                return { ...row, key_value: this.decryptFromStorage(row.key_value) };
            }
            catch {
                return { ...row, key_value: "failed-to-decrypt" };
            }
        });
        return {
            items: decodedRows,
            pagination: (0, utils_js_1.buildPagination)(page, pageSize, total.count ?? 0),
        };
    }
    exportLogs(filters) {
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
    getDashboardStats() {
        const totalKeysRow = this.db.prepare("SELECT COUNT(*) AS count FROM api_keys").get();
        const invalidKeysRow = this.db
            .prepare("SELECT COUNT(*) AS count FROM api_keys WHERE status = 'invalid'")
            .get();
        const now = Date.now();
        const last24h = new Date(now - 24 * 3600 * 1000).toISOString();
        const prev24h = new Date(now - 48 * 3600 * 1000).toISOString();
        const logsLast = this.db
            .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ?")
            .get(last24h);
        const logsPrev = this.db
            .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN is_success = 0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ? AND timestamp < ?")
            .get(prev24h, last24h);
        const reqNow = logsLast.total ?? 0;
        const reqPrev = logsPrev.total ?? 0;
        const failedNow = logsLast.failed ?? 0;
        const failedPrev = logsPrev.failed ?? 0;
        const rpmValue = Number((reqNow / (24 * 60)).toFixed(2));
        const errorRateNow = reqNow === 0 ? 0 : Number(((failedNow / reqNow) * 100).toFixed(2));
        const errorRatePrev = reqPrev === 0 ? 0 : Number(((failedPrev / reqPrev) * 100).toFixed(2));
        const trend = (current, prev) => {
            if (prev === 0 && current === 0) {
                return 0;
            }
            if (prev === 0) {
                return 100;
            }
            return Number((((current - prev) / prev) * 100).toFixed(2));
        };
        const warnings = [];
        const authKey = this.getSettingValue("proxy_keys", "");
        if ((0, utils_js_1.splitProxyKeys)(authKey).length < 1) {
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
    getDashboardChart(groupId) {
        const labels = [];
        const success = [];
        const failed = [];
        for (let hoursAgo = 23; hoursAgo >= 0; hoursAgo -= 1) {
            const start = new Date(Date.now() - hoursAgo * 3600 * 1000);
            start.setMinutes(0, 0, 0);
            const end = new Date(start.getTime() + 3600 * 1000);
            labels.push(`${String(start.getHours()).padStart(2, "0")}:00`);
            const query = groupId
                ? this.db.prepare("SELECT SUM(CASE WHEN is_success=1 THEN 1 ELSE 0 END) AS success, SUM(CASE WHEN is_success=0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ? AND timestamp < ? AND group_id = ?")
                : this.db.prepare("SELECT SUM(CASE WHEN is_success=1 THEN 1 ELSE 0 END) AS success, SUM(CASE WHEN is_success=0 THEN 1 ELSE 0 END) AS failed FROM request_logs WHERE timestamp >= ? AND timestamp < ?");
            const row = (groupId ? query.get(start.toISOString(), end.toISOString(), groupId) : query.get(start.toISOString(), end.toISOString()));
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
    getEncryptionStatus() {
        const encryptionKey = this.getEncryptionKey();
        const sample = this.db
            .prepare("SELECT key_value FROM api_keys ORDER BY id DESC LIMIT 1")
            .get();
        if (!sample) {
            return {
                has_mismatch: false,
                scenario_type: "none",
                message: "No key data found",
                suggestion: "",
            };
        }
        const encrypted = (0, encryption_js_1.isEncryptedValue)(sample.key_value);
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
                (0, encryption_js_1.decryptWithKey)(sample.key_value, encryptionKey);
            }
            catch {
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
    migrateEncryptionKeys(fromKey, toKey) {
        const keyRows = this.db.prepare("SELECT id, key_value FROM api_keys ORDER BY id ASC").all();
        const logRows = this.db.prepare("SELECT id, key_value FROM request_logs WHERE key_value IS NOT NULL ORDER BY timestamp ASC").all();
        const updateKey = this.db.prepare("UPDATE api_keys SET key_value = ?, updated_at = ? WHERE id = ?");
        const updateLog = this.db.prepare("UPDATE request_logs SET key_value = ? WHERE id = ?");
        const tx = this.db.transaction(() => {
            for (const row of keyRows) {
                const transformed = (0, encryption_js_1.transformEncryption)(row.key_value, fromKey, toKey);
                updateKey.run(transformed, (0, utils_js_1.nowIso)(), row.id);
            }
            for (const row of logRows) {
                const transformed = (0, encryption_js_1.transformEncryption)(row.key_value, fromKey, toKey);
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
    async runScheduledKeyValidation() {
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
                    .all(group.id);
                for (const row of rows) {
                    let plain = "";
                    try {
                        plain = this.decryptFromStorage(row.key_value);
                    }
                    catch {
                        plain = "";
                    }
                    if (!plain) {
                        continue;
                    }
                    const check = await this.validateKeyAgainstUpstream(group, plain);
                    this.db
                        .prepare("UPDATE api_keys SET status = ?, notes = ?, updated_at = ? WHERE id = ?")
                        .run(check.isValid ? "active" : "invalid", check.isValid ? "" : check.error, (0, utils_js_1.nowIso)(), row.id);
                }
            }
            await this.sharedStore.set(lastRunKey, String(now), intervalMinutes * 60 * 2);
        }
        finally {
            await this.sharedStore.del(lockKey);
        }
    }
    async cleanupExpiredLogs() {
        const retentionDays = Number(this.getSettingValue("request_log_retention_days", "7"));
        if (retentionDays <= 0) {
            return 0;
        }
        const lockKey = "gpt-load:log-cleanup:lock";
        const lock = await this.sharedStore.setNx(lockKey, (0, utils_js_1.nowIso)(), 55);
        if (!lock) {
            return 0;
        }
        const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
        try {
            const result = this.db.prepare("DELETE FROM request_logs WHERE timestamp < ?").run(cutoff);
            return result.changes;
        }
        finally {
            await this.sharedStore.del(lockKey);
        }
    }
}
exports.AppService = AppService;
