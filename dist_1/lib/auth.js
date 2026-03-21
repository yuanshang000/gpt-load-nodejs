"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdminAuth = exports.extractAuthKey = exports.extractBearer = void 0;
const response_js_1 = require("./response.js");
const readQueryKey = (request) => {
    const query = request.query;
    const key = query?.key;
    if (typeof key === "string" && key.trim()) {
        return key.trim();
    }
    return null;
};
const extractBearer = (request) => {
    const header = request.headers.authorization;
    if (!header) {
        return null;
    }
    const [schema, token] = header.split(" ");
    if (!schema || !token || schema.toLowerCase() !== "bearer") {
        return null;
    }
    return token.trim();
};
exports.extractBearer = extractBearer;
const extractAuthKey = (request) => {
    const queryKey = readQueryKey(request);
    if (queryKey) {
        return queryKey;
    }
    const bearer = (0, exports.extractBearer)(request);
    if (bearer) {
        return bearer;
    }
    const xApiKey = request.headers["x-api-key"];
    if (typeof xApiKey === "string" && xApiKey.trim()) {
        return xApiKey.trim();
    }
    const xGoogApiKey = request.headers["x-goog-api-key"];
    if (typeof xGoogApiKey === "string" && xGoogApiKey.trim()) {
        return xGoogApiKey.trim();
    }
    return null;
};
exports.extractAuthKey = extractAuthKey;
const requireAdminAuth = async (request, reply, authKey) => {
    const token = (0, exports.extractAuthKey)(request);
    if (!token || token !== authKey) {
        return (0, response_js_1.fail)(reply, 401, "UNAUTHORIZED", "Unauthorized");
    }
};
exports.requireAdminAuth = requireAdminAuth;
