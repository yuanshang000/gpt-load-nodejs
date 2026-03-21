import { URL } from "node:url";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { extractAuthKey, requireAdminAuth } from "../lib/auth.js";
import { fail, failByCode, ok } from "../lib/response.js";
import { splitProxyKeys } from "../lib/utils.js";
import type { AppService } from "../services/app-service.js";
import type { GroupModel } from "../types/models.js";

const groupToResponse = (group: GroupModel, appUrl: string) => {
  let endpoint = "";
  try {
    const url = new URL(appUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/proxy/${group.name}`;
    endpoint = url.toString();
  } catch {
    endpoint = `${appUrl.replace(/\/$/, "")}/proxy/${group.name}`;
  }
  return {
    ...group,
    endpoint,
  };
};

const getProxyToken = (request: FastifyRequest): string | null => {
  return extractAuthKey(request);
};

export const registerApiRoutes = async (
  app: FastifyInstance,
  service: AppService,
  authKey: string,
): Promise<void> => {
  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as { auth_key?: string };
    if (!body.auth_key) {
      return reply.status(400).send({ success: false, message: "invalid request" });
    }
    if (body.auth_key !== authKey) {
      return reply.status(401).send({ success: false, message: "authentication failed" });
    }
    return reply.send({ success: true, message: "authentication successful" });
  });

  app.get("/api/integration/info", async (request, reply) => {
    const query = request.query as { key?: string };
    if (!query.key) {
      return failByCode(reply, 400, "VALIDATION_ERROR", request.headers["accept-language"] as string | undefined, "Proxy key is required");
    }
    const data = service.getIntegrationInfo(query.key);
    if (data.length === 0) {
      return failByCode(reply, 401, "UNAUTHORIZED", request.headers["accept-language"] as string | undefined, "Invalid or unauthorized proxy key");
    }
    return ok(reply, data);
  });

  app.get("/api/channel-types", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, service.getChannelTypes());
  });

  app.get("/api/settings", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, service.getSettingsCategories());
  });

  app.put("/api/settings", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    service.updateSettings((request.body ?? {}) as Record<string, unknown>);
    return ok(reply, null, "settings updated");
  });

  app.get("/api/groups", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
    const data = service.listGroups().map((group) => groupToResponse(group, appUrl));
    return ok(reply, data);
  });

  app.get("/api/groups/list", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, service.listGroupSimple());
  });

  app.post("/api/groups", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    try {
      const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
      const group = service.createGroup((request.body ?? {}) as Record<string, unknown>);
      return ok(reply, groupToResponse(group, appUrl));
    } catch (error) {
      return fail(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "create group failed");
    }
  });

  app.put("/api/groups/:id", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    try {
      const id = Number((request.params as { id: string }).id);
      const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
      const group = service.updateGroup(id, (request.body ?? {}) as Record<string, unknown>);
      return ok(reply, groupToResponse(group, appUrl));
    } catch (error) {
      return fail(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "update group failed");
    }
  });

  app.delete("/api/groups/:id", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const id = Number((request.params as { id: string }).id);
    service.deleteGroup(id);
    return ok(reply, null, "group deleted");
  });

  app.get("/api/groups/config-options", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, service.getGroupConfigOptions());
  });

  app.get("/api/groups/:id/stats", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const id = Number((request.params as { id: string }).id);
    return ok(reply, service.getGroupStats(id));
  });

  app.post("/api/groups/:id/copy", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { copy_keys?: "none" | "valid_only" | "all" };
    try {
      const appUrl = service.getSettingValue("app_url", "http://localhost:3001");
      const group = service.copyGroup(id, body.copy_keys ?? "none");
      return ok(reply, { group: groupToResponse(group, appUrl) });
    } catch (error) {
      return fail(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "copy group failed");
    }
  });

  app.get("/api/groups/:id/sub-groups", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const id = Number((request.params as { id: string }).id);
    return ok(reply, service.getSubGroups(id));
  });

  app.post("/api/groups/:id/sub-groups", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { sub_groups?: Array<{ group_id: number; weight: number }> };
    service.addSubGroups(id, body.sub_groups ?? []);
    return ok(reply, null);
  });

  app.put("/api/groups/:id/sub-groups/:subGroupId/weight", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const params = request.params as { id: string; subGroupId: string };
    const body = (request.body ?? {}) as { weight?: number };
    service.updateSubGroupWeight(Number(params.id), Number(params.subGroupId), Number(body.weight ?? 1));
    return ok(reply, null);
  });

  app.delete("/api/groups/:id/sub-groups/:subGroupId", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const params = request.params as { id: string; subGroupId: string };
    service.deleteSubGroup(Number(params.id), Number(params.subGroupId));
    return ok(reply, null);
  });

  app.get("/api/groups/:id/parent-aggregate-groups", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const id = Number((request.params as { id: string }).id);
    return ok(reply, service.getParentAggregateGroups(id));
  });

  app.get("/api/keys", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const query = request.query as {
      group_id?: string;
      page?: string;
      page_size?: string;
      status?: string;
      key_value?: string;
    };
    const groupId = Number(query.group_id ?? 0);
    if (!groupId) {
      return failByCode(reply, 400, "VALIDATION_ERROR", request.headers["accept-language"] as string | undefined, "group_id is required");
    }
    const result = service.listKeys({
      group_id: groupId,
      page: Number(query.page ?? 1),
      page_size: Number(query.page_size ?? 20),
      status: query.status,
      key_value: query.key_value,
    });
    return ok(reply, result);
  });

  app.post("/api/keys/add-multiple", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number; keys_text?: string };
    try {
      const result = service.addMultipleKeys(Number(body.group_id), body.keys_text ?? "");
      return ok(reply, result);
    } catch (error) {
      return failByCode(reply, 400, "VALIDATION_ERROR", request.headers["accept-language"] as string | undefined, error instanceof Error ? error.message : "add keys failed");
    }
  });

  app.post("/api/keys/add-async", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
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
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          keysText = Buffer.concat(chunks).toString("utf-8");
        }
      }
    } else {
      const body = (request.body ?? {}) as { group_id?: number; keys_text?: string };
      groupId = Number(body.group_id ?? 0);
      keysText = body.keys_text ?? "";
    }
    try {
      const task = await service.runImportTask(groupId, keysText);
      return ok(reply, task);
    } catch (error) {
      return failByCode(reply, 409, "TASK_IN_PROGRESS", request.headers["accept-language"] as string | undefined, error instanceof Error ? error.message : "task error");
    }
  });

  app.post("/api/keys/delete-multiple", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number; keys_text?: string };
    try {
      const result = service.deleteMultipleKeys(Number(body.group_id), body.keys_text ?? "");
      return ok(reply, result);
    } catch (error) {
      return fail(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "delete keys failed");
    }
  });

  app.post("/api/keys/delete-async", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number; keys_text?: string };
    try {
      const task = await service.runDeleteTask(Number(body.group_id), body.keys_text ?? "");
      return ok(reply, task);
    } catch (error) {
      return failByCode(reply, 409, "TASK_IN_PROGRESS", request.headers["accept-language"] as string | undefined, error instanceof Error ? error.message : "task error");
    }
  });

  app.post("/api/keys/restore-multiple", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number; keys_text?: string };
    try {
      const result = service.restoreMultipleKeys(Number(body.group_id), body.keys_text ?? "");
      return ok(reply, result);
    } catch (error) {
      return fail(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "restore keys failed");
    }
  });

  app.post("/api/keys/restore-all-invalid", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number };
    const count = service.restoreAllInvalidKeys(Number(body.group_id));
    return ok(reply, { message: `restored ${count} keys` });
  });

  app.post("/api/keys/clear-all-invalid", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number };
    const count = service.clearAllInvalidKeys(Number(body.group_id));
    return ok(reply, { message: `cleared ${count} invalid keys` });
  });

  app.post("/api/keys/clear-all", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number };
    const count = service.clearAllKeys(Number(body.group_id));
    return ok(reply, { message: `cleared ${count} keys` });
  });

  app.post("/api/keys/validate-group", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number; status?: "active" | "invalid" };
    try {
      const task = await service.runValidateTask(Number(body.group_id), body.status);
      return ok(reply, task);
    } catch (error) {
      return failByCode(reply, 409, "TASK_IN_PROGRESS", request.headers["accept-language"] as string | undefined, error instanceof Error ? error.message : "task error");
    }
  });

  app.post("/api/keys/test-multiple", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const body = (request.body ?? {}) as { group_id?: number; keys_text?: string };
    try {
      const result = await service.testKeys(Number(body.group_id), body.keys_text ?? "");
      return ok(reply, result);
    } catch (error) {
      return fail(reply, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "test keys failed");
    }
  });

  app.put("/api/keys/:id/notes", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const id = Number((request.params as { id: string }).id);
    const body = (request.body ?? {}) as { notes?: string };
    service.updateKeyNotes(id, body.notes ?? "");
    return ok(reply, null);
  });

  app.get("/api/keys/export", async (request, reply) => {
    const query = request.query as { group_id?: string; status?: "all" | "active" | "invalid"; key?: string };
    const token = query.key ?? getProxyToken(request);
    if (!token || token !== authKey) {
      return fail(reply, 401, "UNAUTHORIZED", "Unauthorized");
    }
    const groupId = Number(query.group_id ?? 0);
    if (!groupId) {
      return fail(reply, 400, "VALIDATION_ERROR", "group_id is required");
    }
    const status = query.status ?? "all";
    const text = service.exportKeys(groupId, status);
    const filename = `keys-group_${groupId}-${status}-${Date.now()}.txt`;
    reply.header("Content-Type", "text/plain; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename=${filename}`);
    return reply.send(text);
  });

  app.get("/api/tasks/status", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, await service.getTaskStatus());
  });

  app.get("/api/dashboard/stats", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, service.getDashboardStats());
  });

  app.get("/api/dashboard/chart", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    const query = request.query as { groupId?: string };
    const groupId = query.groupId ? Number(query.groupId) : undefined;
    return ok(reply, service.getDashboardChart(groupId));
  });

  app.get("/api/dashboard/encryption-status", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, service.getEncryptionStatus());
  });

  app.get("/api/logs", async (request, reply) => {
    const guard = await requireAdminAuth(request, reply, authKey);
    if (guard) {
      return guard;
    }
    return ok(reply, service.listLogs(request.query as Record<string, unknown>));
  });

  app.get("/api/logs/export", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const token = query.key ?? getProxyToken(request);
    if (!token || token !== authKey) {
      return fail(reply, 401, "UNAUTHORIZED", "Unauthorized");
    }
    const csv = service.exportLogs(query);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename=logs-${Date.now()}.csv`);
    return reply.send(csv);
  });

};

export const checkProxyAccess = (
  request: FastifyRequest,
  reply: FastifyReply,
  service: AppService,
  group: GroupModel,
): string | null => {
  const token = getProxyToken(request);
  if (!token) {
    failByCode(reply, 401, "UNAUTHORIZED", request.headers["accept-language"] as string | undefined, "Proxy key required");
    return null;
  }
  const globalAdminTokens = splitProxyKeys(service.getSettingValue("proxy_keys", ""));
  const allow = globalAdminTokens.includes(token) || service.canAccessGroupByProxyKey(group, token);
  if (!allow) {
    failByCode(reply, 401, "UNAUTHORIZED", request.headers["accept-language"] as string | undefined, "Invalid proxy key");
    return null;
  }
  return token;
};
