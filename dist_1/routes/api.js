"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkProxyAccess = exports.registerApiRoutes = void 0;
const node_url_1 = require("node:url");
const auth_js_1 = require("../lib/auth.js");
const response_js_1 = require("../lib/response.js");
const utils_js_1 = require("../lib/utils.js");
const groupToResponse = (group, appUrl) => {
    let endpoint = "";
    try {
        const url = new node_url_1.URL(appUrl);
        url.pathname = `${url.pathname.replace(/\/$/, "")}/proxy/${group.name}`;
        endpoint = url.toString();
    }
    catch {
        endpoint = `${appUrl.replace(/\/$/, "")}/proxy/${group.name}`;
    }
    return {
        ...group,
        endpoint,
    };
};
const getProxyToken = (request) => {
    return (0, auth_js_1.extractAuthKey)(request);
};
const registerApiRoutes = async (app, service, authKey) => {
    app.post("/api/auth/login", async (request, reply) => {
        const body = (request.body ?? {});
        if (!body.auth_key) {
            return reply.status(400).send({ success: false, message: "invalid request" });
        }
        if (body.auth_key !== authKey) {
            return reply.status(401).send({ success: false, message: "authentication failed" });
        }
        return reply.send({ success: true, message: "authentication successful" });
    });
    app.get("/api/integration/info", async (request, reply) => {
        const query = request.query;
        if (!query.key) {
            return (0, response_js_1.failByCode)(reply, 400, "VALIDATION_ERROR", request.headers["accept-language"], "Proxy key is required");
        }
        const data = service.getIntegrationInfo(query.key);
        if (data.length === 0) {
            return (0, response_js_1.failByCode)(reply, 401, "UNAUTHORIZED", request.headers["accept-language"], "Invalid or unauthorized proxy key");
        }
        return (0, response_js_1.ok)(reply, data);
    });
    app.get("/api/channel-types", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, service.getChannelTypes());
    });
    app.get("/api/settings", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, service.getSettingsCategories());
    });
    app.put("/api/settings", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        service.updateSettings((request.body ?? {}));
        return (0, response_js_1.ok)(reply, null, "settings updated");
    });
    app.get("/api/groups", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
        const data = service.listGroups().map((group) => groupToResponse(group, appUrl));
        return (0, response_js_1.ok)(reply, data);
    });
    app.get("/api/groups/list", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, service.listGroupSimple());
    });
    app.post("/api/groups", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        try {
            const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
            const group = service.createGroup((request.body ?? {}));
            return (0, response_js_1.ok)(reply, groupToResponse(group, appUrl));
        }
        catch (error) {
            return (0, response_js_1.fail)(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "create group failed");
        }
    });
    app.put("/api/groups/:id", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        try {
            const id = Number(request.params.id);
            const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
            const group = service.updateGroup(id, (request.body ?? {}));
            return (0, response_js_1.ok)(reply, groupToResponse(group, appUrl));
        }
        catch (error) {
            return (0, response_js_1.fail)(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "update group failed");
        }
    });
    app.delete("/api/groups/:id", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const id = Number(request.params.id);
        service.deleteGroup(id);
        return (0, response_js_1.ok)(reply, null, "group deleted");
    });
    app.get("/api/groups/config-options", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, service.getGroupConfigOptions());
    });
    app.get("/api/groups/:id/stats", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const id = Number(request.params.id);
        return (0, response_js_1.ok)(reply, service.getGroupStats(id));
    });
    app.post("/api/groups/:id/copy", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const id = Number(request.params.id);
        const body = (request.body ?? {});
        try {
            const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
            const group = service.copyGroup(id, body.copy_keys ?? "none");
            return (0, response_js_1.ok)(reply, { group: groupToResponse(group, appUrl) });
        }
        catch (error) {
            return (0, response_js_1.fail)(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "copy group failed");
        }
    });
    app.get("/api/groups/:id/sub-groups", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const id = Number(request.params.id);
        return (0, response_js_1.ok)(reply, service.getSubGroups(id));
    });
    app.post("/api/groups/:id/sub-groups", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const id = Number(request.params.id);
        const body = (request.body ?? {});
        service.addSubGroups(id, body.sub_groups ?? []);
        return (0, response_js_1.ok)(reply, null);
    });
    app.put("/api/groups/:id/sub-groups/:subGroupId/weight", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const params = request.params;
        const body = (request.body ?? {});
        service.updateSubGroupWeight(Number(params.id), Number(params.subGroupId), Number(body.weight ?? 1));
        return (0, response_js_1.ok)(reply, null);
    });
    app.delete("/api/groups/:id/sub-groups/:subGroupId", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const params = request.params;
        service.deleteSubGroup(Number(params.id), Number(params.subGroupId));
        return (0, response_js_1.ok)(reply, null);
    });
    app.get("/api/groups/:id/parent-aggregate-groups", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const id = Number(request.params.id);
        return (0, response_js_1.ok)(reply, service.getParentAggregateGroups(id));
    });
    app.get("/api/keys", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const query = request.query;
        const groupId = Number(query.group_id ?? 0);
        if (!groupId) {
            return (0, response_js_1.failByCode)(reply, 400, "VALIDATION_ERROR", request.headers["accept-language"], "group_id is required");
        }
        const result = service.listKeys({
            group_id: groupId,
            page: Number(query.page ?? 1),
            page_size: Number(query.page_size ?? 20),
            status: query.status,
            key_value: query.key_value,
        });
        return (0, response_js_1.ok)(reply, result);
    });
    app.post("/api/keys/add-multiple", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        try {
            const result = service.addMultipleKeys(Number(body.group_id), body.keys_text ?? "");
            return (0, response_js_1.ok)(reply, result);
        }
        catch (error) {
            return (0, response_js_1.failByCode)(reply, 400, "VALIDATION_ERROR", request.headers["accept-language"], error instanceof Error ? error.message : "add keys failed");
        }
    });
    app.post("/api/keys/add-async", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        let groupId = 0;
        let keysText = "";
        if (request.isMultipart()) {
            const parts = request.parts();
            for await (const part of parts) {
                if (part.type === "field" && part.fieldname === "group_id") {
                    groupId = Number(part.value);
                }
                if (part.type === "file") {
                    const chunks = [];
                    for await (const chunk of part.file) {
                        chunks.push(chunk);
                    }
                    keysText = Buffer.concat(chunks).toString("utf-8");
                }
            }
        }
        else {
            const body = (request.body ?? {});
            groupId = Number(body.group_id ?? 0);
            keysText = body.keys_text ?? "";
        }
        try {
            const task = await service.runImportTask(groupId, keysText);
            return (0, response_js_1.ok)(reply, task);
        }
        catch (error) {
            return (0, response_js_1.failByCode)(reply, 409, "TASK_IN_PROGRESS", request.headers["accept-language"], error instanceof Error ? error.message : "task error");
        }
    });
    app.post("/api/keys/delete-multiple", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        try {
            const result = service.deleteMultipleKeys(Number(body.group_id), body.keys_text ?? "");
            return (0, response_js_1.ok)(reply, result);
        }
        catch (error) {
            return (0, response_js_1.fail)(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "delete keys failed");
        }
    });
    app.post("/api/keys/delete-async", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        try {
            const task = await service.runDeleteTask(Number(body.group_id), body.keys_text ?? "");
            return (0, response_js_1.ok)(reply, task);
        }
        catch (error) {
            return (0, response_js_1.failByCode)(reply, 409, "TASK_IN_PROGRESS", request.headers["accept-language"], error instanceof Error ? error.message : "task error");
        }
    });
    app.post("/api/keys/restore-multiple", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        try {
            const result = service.restoreMultipleKeys(Number(body.group_id), body.keys_text ?? "");
            return (0, response_js_1.ok)(reply, result);
        }
        catch (error) {
            return (0, response_js_1.fail)(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "restore keys failed");
        }
    });
    app.post("/api/keys/restore-all-invalid", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        const count = service.restoreAllInvalidKeys(Number(body.group_id));
        return (0, response_js_1.ok)(reply, { message: `restored ${count} keys` });
    });
    app.post("/api/keys/clear-all-invalid", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        const count = service.clearAllInvalidKeys(Number(body.group_id));
        return (0, response_js_1.ok)(reply, { message: `cleared ${count} invalid keys` });
    });
    app.post("/api/keys/clear-all", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        const count = service.clearAllKeys(Number(body.group_id));
        return (0, response_js_1.ok)(reply, { message: `cleared ${count} keys` });
    });
    app.post("/api/keys/validate-group", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        try {
            const task = await service.runValidateTask(Number(body.group_id), body.status);
            return (0, response_js_1.ok)(reply, task);
        }
        catch (error) {
            return (0, response_js_1.failByCode)(reply, 409, "TASK_IN_PROGRESS", request.headers["accept-language"], error instanceof Error ? error.message : "task error");
        }
    });
    app.post("/api/keys/test-multiple", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const body = (request.body ?? {});
        try {
            const result = await service.testKeys(Number(body.group_id), body.keys_text ?? "");
            return (0, response_js_1.ok)(reply, result);
        }
        catch (error) {
            return (0, response_js_1.fail)(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "test keys failed");
        }
    });
    app.put("/api/keys/:id/notes", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const id = Number(request.params.id);
        const body = (request.body ?? {});
        service.updateKeyNotes(id, body.notes ?? "");
        return (0, response_js_1.ok)(reply, null);
    });
    app.get("/api/keys/export", async (request, reply) => {
        const query = request.query;
        const token = query.key ?? getProxyToken(request);
        if (!token || token !== authKey) {
            return (0, response_js_1.fail)(reply, 401, "UNAUTHORIZED", "Unauthorized");
        }
        const groupId = Number(query.group_id ?? 0);
        if (!groupId) {
            return (0, response_js_1.fail)(reply, 400, "VALIDATION_ERROR", "group_id is required");
        }
        const status = query.status ?? "all";
        const text = service.exportKeys(groupId, status);
        const filename = `keys-group_${groupId}-${status}-${Date.now()}.txt`;
        reply.header("Content-Type", "text/plain; charset=utf-8");
        reply.header("Content-Disposition", `attachment; filename=${filename}`);
        return reply.send(text);
    });
    app.get("/api/tasks/status", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, await service.getTaskStatus());
    });
    app.get("/api/dashboard/stats", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, service.getDashboardStats());
    });
    app.get("/api/dashboard/chart", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        const query = request.query;
        const groupId = query.groupId ? Number(query.groupId) : undefined;
        return (0, response_js_1.ok)(reply, service.getDashboardChart(groupId));
    });
    app.get("/api/dashboard/encryption-status", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, service.getEncryptionStatus());
    });
    app.get("/api/logs", async (request, reply) => {
        const guard = await (0, auth_js_1.requireAdminAuth)(request, reply, authKey);
        if (guard) {
            return guard;
        }
        return (0, response_js_1.ok)(reply, service.listLogs(request.query));
    });
    app.get("/api/logs/export", async (request, reply) => {
        const query = request.query;
        const token = query.key ?? getProxyToken(request);
        if (!token || token !== authKey) {
            return (0, response_js_1.fail)(reply, 401, "UNAUTHORIZED", "Unauthorized");
        }
        const csv = service.exportLogs(query);
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", `attachment; filename=logs-${Date.now()}.csv`);
        return reply.send(csv);
    });
};
exports.registerApiRoutes = registerApiRoutes;
const checkProxyAccess = (request, reply, service, group) => {
    const token = getProxyToken(request);
    if (!token) {
        (0, response_js_1.failByCode)(reply, 401, "UNAUTHORIZED", request.headers["accept-language"], "Proxy key required");
        return null;
    }
    const globalAdminTokens = (0, utils_js_1.splitProxyKeys)(service.getSettingValue("proxy_keys", ""));
    const allow = globalAdminTokens.includes(token) || service.canAccessGroupByProxyKey(group, token);
    if (!allow) {
        (0, response_js_1.failByCode)(reply, 401, "UNAUTHORIZED", request.headers["accept-language"], "Invalid proxy key");
        return null;
    }
    return token;
};
exports.checkProxyAccess = checkProxyAccess;
