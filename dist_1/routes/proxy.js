"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerProxyRoutes = void 0;
const node_stream_1 = require("node:stream");
const undici_1 = require("undici");
const response_js_1 = require("../lib/response.js");
const utils_js_1 = require("../lib/utils.js");
const api_js_1 = require("./api.js");
const proxyAgentCache = new Map();
const getProxyAgent = (proxyUrl) => {
    let agent = proxyAgentCache.get(proxyUrl);
    if (!agent) {
        agent = new undici_1.ProxyAgent(proxyUrl);
        proxyAgentCache.set(proxyUrl, agent);
    }
    return agent;
};
const normalizeHeaders = (headers) => {
    const out = {};
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
const getSanitizedInboundUrl = (requestUrl) => {
    const inboundUrl = new URL(requestUrl, "http://localhost");
    inboundUrl.searchParams.delete("key");
    return inboundUrl;
};
const buildSanitizedRequestPath = (url) => {
    return `${url.pathname}${url.search}`;
};
const applyBodyOverrides = (maybeBody, modelRedirectRules, strictRedirect, paramOverrides) => {
    if (typeof maybeBody === "undefined" || maybeBody === null) {
        return { body: undefined, model: "", stream: false };
    }
    if (Buffer.isBuffer(maybeBody)) {
        const text = maybeBody.toString("utf-8");
        const parsed = (0, utils_js_1.parseJson)(text, {});
        const withOverride = { ...parsed, ...paramOverrides };
        const currentModel = typeof withOverride.model === "string" ? withOverride.model : "";
        if (currentModel && modelRedirectRules[currentModel]) {
            withOverride.model = modelRedirectRules[currentModel];
        }
        else if (strictRedirect && currentModel && Object.keys(modelRedirectRules).length > 0) {
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
        const parsed = maybeBody;
        const withOverride = { ...parsed, ...paramOverrides };
        const currentModel = typeof withOverride.model === "string" ? withOverride.model : "";
        if (currentModel && modelRedirectRules[currentModel]) {
            withOverride.model = modelRedirectRules[currentModel];
        }
        else if (strictRedirect && currentModel && Object.keys(modelRedirectRules).length > 0) {
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
const getDefaultChannelPath = (channelType) => {
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
const shouldInterceptModelList = (method, path) => {
    if (method.toUpperCase() !== "GET") {
        return false;
    }
    return path.endsWith("/v1/models") || path.endsWith("/v1beta/models") || path.includes("/v1beta/openai/v1/models");
};
const buildConfiguredOpenAIModels = (redirectRules) => {
    return Object.keys(redirectRules).map((sourceModel) => ({
        id: sourceModel,
        object: "model",
        created: 0,
        owned_by: "system",
    }));
};
const mergeOpenAIModels = (upstreamModels, configuredModels) => {
    const upstreamIds = new Set();
    for (const item of upstreamModels) {
        if (typeof item === "object" && item && "id" in item && typeof item.id === "string") {
            upstreamIds.add(item.id);
        }
    }
    const merged = [...upstreamModels];
    for (const item of configuredModels) {
        if (typeof item === "object" && item && "id" in item && typeof item.id === "string") {
            const id = item.id;
            if (!upstreamIds.has(id)) {
                merged.push(item);
            }
        }
    }
    return merged;
};
const buildConfiguredGeminiModels = (redirectRules) => {
    return Object.keys(redirectRules).map((sourceModel) => ({
        name: sourceModel.startsWith("models/") ? sourceModel : `models/${sourceModel}`,
        displayName: sourceModel,
        supportedGenerationMethods: ["generateContent"],
    }));
};
const mergeGeminiModels = (upstreamModels, configuredModels) => {
    const upstreamNames = new Set();
    for (const item of upstreamModels) {
        if (typeof item === "object" && item && "name" in item && typeof item.name === "string") {
            const name = item.name;
            upstreamNames.add(name);
            upstreamNames.add(name.replace(/^models\//, ""));
        }
    }
    const merged = [...upstreamModels];
    for (const item of configuredModels) {
        if (typeof item === "object" && item && "name" in item && typeof item.name === "string") {
            const name = item.name;
            const cleanName = name.replace(/^models\//, "");
            if (!upstreamNames.has(name) && !upstreamNames.has(cleanName)) {
                merged.push(item);
            }
        }
    }
    return merged;
};
const transformModelListPayload = (payload, group, targetUrl) => {
    const redirectRules = group.model_redirect_rules ?? {};
    if (Array.isArray(payload.data)) {
        const configuredModels = buildConfiguredOpenAIModels(redirectRules);
        return {
            ...payload,
            data: group.model_redirect_strict
                ? configuredModels
                : mergeOpenAIModels(payload.data, configuredModels),
        };
    }
    if (Array.isArray(payload.models)) {
        const configuredModels = buildConfiguredGeminiModels(redirectRules);
        const isFirstPage = !targetUrl.searchParams.get("pageToken");
        const models = group.model_redirect_strict
            ? configuredModels
            : isFirstPage
                ? mergeGeminiModels(payload.models, configuredModels)
                : payload.models;
        const nextPayload = {
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
const tryTransformModelList = async (response, group, targetUrl) => {
    const text = await response.text();
    if (!text) {
        return null;
    }
    const payload = (0, utils_js_1.parseJson)(text, null);
    if (!payload || typeof payload !== "object") {
        return null;
    }
    return transformModelListPayload(payload, group, targetUrl);
};
const registerProxyRoutes = async (app, service) => {
    const proxyHandler = async (request, reply) => {
        const startedAt = Date.now();
        const params = request.params;
        const groupName = params.group_name;
        const subPath = (params["*"] ?? "").replace(/^\/+/, "");
        if (subPath === "api/integration/info") {
            const query = request.query;
            if (!query.key) {
                return (0, response_js_1.failByCode)(reply, 400, "VALIDATION_ERROR", request.headers["accept-language"], "Proxy key is required");
            }
            const group = service.getGroupByName(groupName);
            if (!group) {
                return (0, response_js_1.failByCode)(reply, 404, "RESOURCE_NOT_FOUND", request.headers["accept-language"], "Group not found");
            }
            const data = service.getGroupIntegrationInfo(groupName, query.key);
            if (data.length === 0) {
                return (0, response_js_1.failByCode)(reply, 401, "UNAUTHORIZED", request.headers["accept-language"], "Invalid or unauthorized proxy key");
            }
            return (0, response_js_1.ok)(reply, data);
        }
        let originalGroup;
        let effectiveGroup;
        try {
            const selected = service.selectProxyGroup(groupName);
            originalGroup = selected.originalGroup;
            effectiveGroup = selected.effectiveGroup;
        }
        catch (error) {
            return (0, response_js_1.failByCode)(reply, 404, "RESOURCE_NOT_FOUND", request.headers["accept-language"], error instanceof Error ? error.message : "group not found");
        }
        const token = (0, api_js_1.checkProxyAccess)(request, reply, service, originalGroup);
        if (!token) {
            return;
        }
        const keys = service.selectActiveApiKeys(effectiveGroup.id);
        if (keys.length === 0) {
            return (0, response_js_1.failByCode)(reply, 503, "NO_KEYS_AVAILABLE", request.headers["accept-language"], "no active key in group");
        }
        const requestBody = applyBodyOverrides(request.body, effectiveGroup.model_redirect_rules, effectiveGroup.model_redirect_strict, effectiveGroup.param_overrides);
        const maxRetries = (0, utils_js_1.safeNumber)(effectiveGroup.config.max_retries ?? undefined, Number(service.getSettingValue("max_retries", "3")));
        const maxAttempts = Math.min(keys.length, Math.max(1, maxRetries + 1));
        const requestTimeoutSeconds = (0, utils_js_1.safeNumber)(effectiveGroup.config.request_timeout ?? undefined, Number(service.getSettingValue("request_timeout", "600")));
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
            const outboundHeaders = normalizeHeaders(request.headers);
            if (effectiveGroup.channel_type !== "gemini") {
                outboundHeaders.authorization = `Bearer ${apiKey.key_value}`;
            }
            const proxyUrl = effectiveGroup.config.proxy_url ||
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
                    response = await (0, undici_1.fetch)(targetUrl.toString(), {
                        method: request.method,
                        headers: new undici_1.Headers(outboundHeaders),
                        body: requestBody.body,
                        duplex: "half",
                        signal: controller.signal,
                        ...(proxyUrl ? { dispatcher: getProxyAgent(proxyUrl) } : {}),
                    });
                }
                finally {
                    clearTimeout(timeout);
                }
                const isSuccess = response.status < 400;
                service.markKeyResult(apiKey.id, isSuccess, isSuccess ? "" : `status:${response.status}`);
                const requestType = attempt + 1 >= maxAttempts || isSuccess ? "final" : "retry";
                const enableBodyLogging = effectiveGroup.config.enable_request_body_logging ??
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
                    user_agent: request.headers["user-agent"],
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
                const nodeStream = node_stream_1.Readable.fromWeb(response.body);
                return reply.send(nodeStream);
            }
            catch (error) {
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
                    user_agent: request.headers["user-agent"],
                    request_type: requestType,
                    upstream_addr: upstream.url,
                    is_stream: requestBody.stream ? 1 : 0,
                    request_body: effectiveGroup.config.enable_request_body_logging ??
                        service.getSettingValue("enable_request_body_logging", "false") === "true"
                        ? typeof request.body === "string"
                            ? request.body
                            : requestBody.body?.toString("utf-8") ?? null
                        : null,
                });
                if (attempt + 1 >= maxAttempts) {
                    return (0, response_js_1.failByCode)(reply, 502, "UPSTREAM_ERROR", request.headers["accept-language"], lastError);
                }
            }
        }
        return (0, response_js_1.failByCode)(reply, 502, "UPSTREAM_ERROR", request.headers["accept-language"], lastError || "proxy failed");
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
exports.registerProxyRoutes = registerProxyRoutes;
