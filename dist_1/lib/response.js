"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.failByCode = exports.fail = exports.ok = void 0;
const messages = {
    UNAUTHORIZED: { zh: "未授权", en: "Unauthorized" },
    VALIDATION_ERROR: { zh: "参数校验失败", en: "Validation error" },
    RESOURCE_NOT_FOUND: { zh: "资源不存在", en: "Resource not found" },
    TASK_IN_PROGRESS: { zh: "有任务正在执行", en: "Task is already running" },
    UPSTREAM_ERROR: { zh: "上游服务错误", en: "Upstream service error" },
    NO_KEYS_AVAILABLE: { zh: "没有可用密钥", en: "No available keys" },
    NOT_IMPLEMENTED: { zh: "功能未实现", en: "Not implemented" },
};
const pickLocale = (acceptLanguage) => {
    if (!acceptLanguage) {
        return "en";
    }
    return acceptLanguage.toLowerCase().includes("zh") ? "zh" : "en";
};
const ok = (reply, data, message = "success") => {
    return reply.send({ code: 0, message, data });
};
exports.ok = ok;
const fail = (reply, statusCode, code, message) => {
    return reply.status(statusCode).send({ code, message });
};
exports.fail = fail;
const failByCode = (reply, statusCode, code, acceptLanguage, customMessage) => {
    const locale = pickLocale(acceptLanguage);
    const msg = customMessage || messages[code]?.[locale] || messages[code]?.en || code;
    return reply.status(statusCode).send({ code, message: msg });
};
exports.failByCode = failByCode;
