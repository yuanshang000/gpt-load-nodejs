import { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";
import { fetch, Headers, ProxyAgent } from "undici";

import { failByCode, ok } from "../lib/response.js";
import { parseJson, safeNumber } from "../lib/utils.js";
import type { AppService } from "../services/app-service.js";
import type { GroupModel } from "../types/models.js";
import { checkProxyAccess } from "./api.js";

const proxyAgentCache = new Map<string, ProxyAgent>();

const getProxyAgent = (proxyUrl: string): ProxyAgent => {
  let agent = proxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
};

const normalizeHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }
    if (["host", "content-length", "authorization", "x-api-key", "x-goog-api-key"].includes(key.toLowerCase())) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
};

const getSanitizedInboundUrl = (requestUrl: string): URL => {
  const inboundUrl = new URL(requestUrl, "http://localhost");
  inboundUrl.searchParams.delete("key");
  return inboundUrl;
};

const buildSanitizedRequestPath = (url: URL): string => {
  return `${url.pathname}${url.search}`;
};

const applyBodyOverrides = (
  maybeBody: unknown,
  modelRedirectRules: Record<string, string>,
  strictRedirect: boolean,
  paramOverrides: Record<string, unknown>,
): { body: string | Buffer | undefined; model: string; stream: boolean } => {
  if (typeof maybeBody === "undefined" || maybeBody === null) {
    return { body: undefined, model: "", stream: false };
  }
  if (Buffer.isBuffer(maybeBody)) {
    const text = maybeBody.toString("utf-8");
    const parsed = parseJson<Record<string, unknown>>(text, {});
    const withOverride = { ...parsed, ...paramOverrides };
    const currentModel = typeof withOverride.model === "string" ? withOverride.model : "";
    if (currentModel && modelRedirectRules[currentModel]) {
      withOverride.model = modelRedirectRules[currentModel];
    } else if (strictRedirect && currentModel && Object.keys(modelRedirectRules).length > 0) {
      withOverride.model = Object.values(modelRedirectRules)[0];
    }
    return {
      body: Buffer.from(JSON.stringify(withOverride)),
      model: typeof withOverride.model === "string" ? withOverride.model : "",
      stream: Boolean(withOverride.stream),
    };
  }
  if (typeof maybeBody === "string") {
    return applyBodyOverrides(Buffer.from(maybeBody), modelRedirectRules, strictRedirect, paramOverrides);
  }
  if (typeof maybeBody === "object") {
    const parsed = maybeBody as Record<string, unknown>;
    const withOverride = { ...parsed, ...paramOverrides };
    const currentModel = typeof withOverride.model === "string" ? withOverride.model : "";
    if (currentModel && modelRedirectRules[currentModel]) {
      withOverride.model = modelRedirectRules[currentModel];
    } else if (strictRedirect && currentModel && Object.keys(modelRedirectRules).length > 0) {
      withOverride.model = Object.values(modelRedirectRules)[0];
    }
    return {
      body: Buffer.from(JSON.stringify(withOverride)),
      model: typeof withOverride.model === "string" ? withOverride.model : "",
      stream: Boolean(withOverride.stream),
    };
  }
  return { body: undefined, model: "", stream: false };
};

const getDefaultChannelPath = (channelType: string): string => {
  if (channelType === "openai-response") {
    return "v1/responses";
  }
  if (channelType === "anthropic") {
    return "v1/messages";
  }
  if (channelType === "gemini") {
    return "v1beta/models";
  }
  return "v1/chat/completions";
};

const shouldInterceptModelList = (method: string, path: string): boolean => {
  if (method.toUpperCase() !== "GET") {
    return false;
  }
  return path.endsWith("/v1/models") || path.endsWith("/v1beta/models") || path.includes("/v1beta/openai/v1/models");
};

const buildConfiguredOpenAIModels = (redirectRules: Record<string, string>): unknown[] => {
  return Object.keys(redirectRules).map((sourceModel) => ({
    id: sourceModel,
    object: "model",
    created: 0,
    owned_by: "system",
  }));
};

const mergeOpenAIModels = (upstreamModels: unknown[], configuredModels: unknown[]): unknown[] => {
  const upstreamIds = new Set<string>();
  for (const item of upstreamModels) {
    if (typeof item === "object" && item && "id" in item && typeof (item as { id?: unknown }).id === "string") {
      upstreamIds.add((item as { id: string }).id);
    }
  }
  const merged = [...upstreamModels];
  for (const item of configuredModels) {
    if (typeof item === "object" && item && "id" in item && typeof (item as { id?: unknown }).id === "string") {
      const id = (item as { id: string }).id;
      if (!upstreamIds.has(id)) {
        merged.push(item);
      }
    }
  }
  return merged;
};

const buildConfiguredGeminiModels = (redirectRules: Record<string, string>): unknown[] => {
  return Object.keys(redirectRules).map((sourceModel) => ({
    name: sourceModel.startsWith("models/") ? sourceModel : `models/${sourceModel}`,
    displayName: sourceModel,
    supportedGenerationMethods: ["generateContent"],
  }));
};

const mergeGeminiModels = (upstreamModels: unknown[], configuredModels: unknown[]): unknown[] => {
  const upstreamNames = new Set<string>();
  for (const item of upstreamModels) {
    if (typeof item === "object" && item && "name" in item && typeof (item as { name?: unknown }).name === "string") {
      const name = (item as { name: string }).name;
      upstreamNames.add(name);
      upstreamNames.add(name.replace(/^models\//, ""));
    }
  }

  const merged = [...upstreamModels];
  for (const item of configuredModels) {
    if (typeof item === "object" && item && "name" in item && typeof (item as { name?: unknown }).name === "string") {
      const name = (item as { name: string }).name;
      const cleanName = name.replace(/^models\//, "");
      if (!upstreamNames.has(name) && !upstreamNames.has(cleanName)) {
        merged.push(item);
      }
    }
  }

  return merged;
};

const transformModelListPayload = (
  payload: Record<string, unknown>,
  group: GroupModel,
  targetUrl: URL,
): Record<string, unknown> => {
  const redirectRules = group.model_redirect_rules ?? {};

  if (Array.isArray(payload.data)) {
    const configuredModels = buildConfiguredOpenAIModels(redirectRules);
    return {
      ...payload,
      data: group.model_redirect_strict
        ? configuredModels
        : mergeOpenAIModels(payload.data as unknown[], configuredModels),
    };
  }

  if (Array.isArray(payload.models)) {
    const configuredModels = buildConfiguredGeminiModels(redirectRules);
    const isFirstPage = !targetUrl.searchParams.get("pageToken");
    const models = group.model_redirect_strict
      ? configuredModels
      : isFirstPage
        ? mergeGeminiModels(payload.models as unknown[], configuredModels)
        : (payload.models as unknown[]);

    const nextPayload: Record<string, unknown> = {
      ...payload,
      models,
    };
    if (group.model_redirect_strict) {
      delete nextPayload.nextPageToken;
    }
    return nextPayload;
  }

  return payload;
};

const tryTransformModelList = async (
  response: Awaited<ReturnType<typeof fetch>>,
  group: GroupModel,
  targetUrl: URL,
): Promise<Record<string, unknown> | null> => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  const payload = parseJson<Record<string, unknown> | null>(text, null);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return transformModelListPayload(payload, group, targetUrl);
};

export const registerProxyRoutes = async (app: FastifyInstance, service: AppService): Promise<void> => {
  const proxyHandler = async (request: any, reply: any) => {
    const startedAt = Date.now();
    const params = request.params as { group_name: string; "*"?: string };
    const groupName = params.group_name;
    const subPath = (params["*"] ?? "").replace(/^\/+/, "");

    if (subPath === "api/integration/info") {
      const query = request.query as { key?: string };
      if (!query.key) {
        return failByCode(
          reply,
          400,
          "VALIDATION_ERROR",
          request.headers["accept-language"] as string | undefined,
          "Proxy key is required",
        );
      }
      const group = service.getGroupByName(groupName);
      if (!group) {
        return failByCode(
          reply,
          404,
          "RESOURCE_NOT_FOUND",
          request.headers["accept-language"] as string | undefined,
          "Group not found",
        );
      }
      const data = service.getGroupIntegrationInfo(groupName, query.key);
      if (data.length === 0) {
        return failByCode(
          reply,
          401,
          "UNAUTHORIZED",
          request.headers["accept-language"] as string | undefined,
          "Invalid or unauthorized proxy key",
        );
      }
      return ok(reply, data);
    }

    let originalGroup;
    let effectiveGroup;
    try {
      const selected = service.selectProxyGroup(groupName);
      originalGroup = selected.originalGroup;
      effectiveGroup = selected.effectiveGroup;
    } catch (error) {
      return failByCode(
        reply,
        404,
        "RESOURCE_NOT_FOUND",
        request.headers["accept-language"] as string | undefined,
        error instanceof Error ? error.message : "group not found",
      );
    }

    const token = checkProxyAccess(request, reply, service, originalGroup);
    if (!token) {
      return;
    }

    const keys = service.selectActiveApiKeys(effectiveGroup.id);
    if (keys.length === 0) {
      return failByCode(reply, 503, "NO_KEYS_AVAILABLE", request.headers["accept-language"] as string | undefined, "no active key in group");
    }

    const requestBody = applyBodyOverrides(
      request.body,
      effectiveGroup.model_redirect_rules,
      effectiveGroup.model_redirect_strict,
      effectiveGroup.param_overrides,
    );

    const maxRetries = safeNumber((effectiveGroup.config.max_retries as number | undefined) ?? undefined, Number(service.getSettingValue("max_retries", "3")));
    const maxAttempts = Math.min(keys.length, Math.max(1, maxRetries + 1));
    const requestTimeoutSeconds = safeNumber(
      (effectiveGroup.config.request_timeout as number | undefined) ?? undefined,
      Number(service.getSettingValue("request_timeout", "600")),
    );

    const inboundUrl = getSanitizedInboundUrl(request.url);
    const requestPathForLog = buildSanitizedRequestPath(inboundUrl);

    let lastError = "";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const apiKey = keys[attempt];
      const upstream = effectiveGroup.upstreams.length > 0 ? effectiveGroup.upstreams[attempt % effectiveGroup.upstreams.length] : null;
      if (!upstream) {
        lastError = "no upstream configured";
        break;
      }

      const resolvedPath = subPath || getDefaultChannelPath(effectiveGroup.channel_type);
      const targetUrl = new URL(resolvedPath, upstream.url.endsWith("/") ? upstream.url : `${upstream.url}/`);
      targetUrl.search = inboundUrl.search;

      if (effectiveGroup.channel_type === "gemini") {
        targetUrl.searchParams.set("key", apiKey.key_value);
      }

      const outboundHeaders = normalizeHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (effectiveGroup.channel_type !== "gemini") {
        outboundHeaders.authorization = `Bearer ${apiKey.key_value}`;
      }

      const proxyUrl =
        (effectiveGroup.config.proxy_url as string | undefined) ||
        service.getSettingValue("proxy_url", "") ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        "";

      if (effectiveGroup.channel_type === "anthropic") {
        delete outboundHeaders.authorization;
        outboundHeaders["x-api-key"] = apiKey.key_value;
        if (!outboundHeaders["anthropic-version"]) {
          outboundHeaders["anthropic-version"] = "2023-06-01";
        }
      }

      for (const rule of effectiveGroup.header_rules) {
        if (rule.action === "remove") {
          delete outboundHeaders[rule.key];
        }
        if (rule.action === "set") {
          outboundHeaders[rule.key] = rule.value;
        }
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutSeconds) * 1000);
        let response;
        try {
          response = await fetch(targetUrl.toString(), {
            method: request.method,
            headers: new Headers(outboundHeaders),
            body: requestBody.body,
            duplex: "half",
            signal: controller.signal,
            ...(proxyUrl ? { dispatcher: getProxyAgent(proxyUrl) } : {}),
          });
        } finally {
          clearTimeout(timeout);
        }

        const isSuccess = response.status < 400;
        service.markKeyResult(apiKey.id, isSuccess, isSuccess ? "" : `status:${response.status}`);

        const requestType = attempt + 1 >= maxAttempts || isSuccess ? "final" : "retry";
        const enableBodyLogging =
          (effectiveGroup.config.enable_request_body_logging as boolean | undefined) ??
          service.getSettingValue("enable_request_body_logging", "false") === "true";
        const requestBodyToLog = enableBodyLogging
          ? typeof request.body === "string"
            ? request.body
            : requestBody.body?.toString("utf-8") ?? null
          : null;
        service.addRequestLog({
          group_id: effectiveGroup.id,
          group_name: effectiveGroup.name,
          parent_group_id: originalGroup.id === effectiveGroup.id ? null : originalGroup.id,
          parent_group_name: originalGroup.id === effectiveGroup.id ? null : originalGroup.name,
          key_value: apiKey.key_value,
          key_hash: apiKey.key_hash,
          model: requestBody.model,
          is_success: isSuccess ? 1 : 0,
          source_ip: request.ip,
          status_code: response.status,
          request_path: requestPathForLog,
          duration_ms: Date.now() - startedAt,
          error_message: isSuccess ? null : `upstream ${response.status}`,
          user_agent: request.headers["user-agent"] as string | null,
          request_type: requestType,
          upstream_addr: targetUrl.origin,
          is_stream: requestBody.stream ? 1 : 0,
          request_body: requestBodyToLog,
        });

        if (!isSuccess && attempt + 1 < maxAttempts) {
          lastError = `upstream status ${response.status}`;
          continue;
        }

        if (isSuccess && shouldInterceptModelList(request.method, targetUrl.pathname)) {
          const transformed = await tryTransformModelList(response.clone(), effectiveGroup, targetUrl);
          if (transformed) {
            reply.status(response.status);
            for (const [name, value] of response.headers.entries()) {
              const lower = name.toLowerCase();
              if (["transfer-encoding", "content-length", "content-encoding"].includes(lower)) {
                continue;
              }
              reply.header(name, value);
            }
            reply.header("content-type", "application/json; charset=utf-8");
            return reply.send(transformed);
          }
        }

        reply.status(response.status);
        for (const [name, value] of response.headers.entries()) {
          if (name.toLowerCase() === "transfer-encoding") {
            continue;
          }
          reply.header(name, value);
        }

        if (!response.body) {
          return reply.send();
        }
        const nodeStream = Readable.fromWeb(response.body as any);
        return reply.send(nodeStream);
      } catch (error) {
        lastError = error instanceof Error ? error.message : "network error";
        service.markKeyResult(apiKey.id, false, lastError);
        const requestType = attempt + 1 >= maxAttempts ? "final" : "retry";
        service.addRequestLog({
          group_id: effectiveGroup.id,
          group_name: effectiveGroup.name,
          parent_group_id: originalGroup.id === effectiveGroup.id ? null : originalGroup.id,
          parent_group_name: originalGroup.id === effectiveGroup.id ? null : originalGroup.name,
          key_value: apiKey.key_value,
          key_hash: apiKey.key_hash,
          model: requestBody.model,
          is_success: 0,
          source_ip: request.ip,
          status_code: 500,
          request_path: requestPathForLog,
          duration_ms: Date.now() - startedAt,
          error_message: lastError,
          user_agent: request.headers["user-agent"] as string | null,
          request_type: requestType,
          upstream_addr: upstream.url,
          is_stream: requestBody.stream ? 1 : 0,
          request_body:
            (effectiveGroup.config.enable_request_body_logging as boolean | undefined) ??
            service.getSettingValue("enable_request_body_logging", "false") === "true"
              ? typeof request.body === "string"
                ? request.body
                : requestBody.body?.toString("utf-8") ?? null
              : null,
        });
        if (attempt + 1 >= maxAttempts) {
          return failByCode(reply, 502, "UPSTREAM_ERROR", request.headers["accept-language"] as string | undefined, lastError);
        }
      }
    }
    return failByCode(
      reply,
      502,
      "UPSTREAM_ERROR",
      request.headers["accept-language"] as string | undefined,
      lastError || "proxy failed",
    );
  };

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/proxy/:group_name",
    handler: proxyHandler,
  });

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/proxy/:group_name/*",
    handler: proxyHandler,
  });
};

