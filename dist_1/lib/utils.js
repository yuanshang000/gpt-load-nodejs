"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeNumber = exports.maskKey = exports.buildPagination = exports.pickWeighted = exports.toJson = exports.parseJson = exports.splitProxyKeys = exports.splitKeys = exports.hashKey = exports.nowIso = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const nowIso = () => new Date().toISOString();
exports.nowIso = nowIso;
const hashKey = (value) => node_crypto_1.default.createHash("sha256").update(value).digest("hex");
exports.hashKey = hashKey;
const splitKeys = (text) => text
    .split(/\r?\n|,|\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
exports.splitKeys = splitKeys;
const splitProxyKeys = (value) => value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
exports.splitProxyKeys = splitProxyKeys;
const parseJson = (value, fallback) => {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
};
exports.parseJson = parseJson;
const toJson = (value) => JSON.stringify(value ?? {});
exports.toJson = toJson;
const pickWeighted = (items) => {
    if (items.length === 1) {
        return items[0];
    }
    const totalWeight = items.reduce((sum, item) => sum + Math.max(item.weight, 0), 0);
    if (totalWeight <= 0) {
        return items[0];
    }
    let target = Math.random() * totalWeight;
    for (const item of items) {
        target -= Math.max(item.weight, 0);
        if (target <= 0) {
            return item;
        }
    }
    return items[items.length - 1];
};
exports.pickWeighted = pickWeighted;
const buildPagination = (page, pageSize, totalItems) => {
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
    return {
        page,
        page_size: pageSize,
        total_items: totalItems,
        total_pages: totalPages,
    };
};
exports.buildPagination = buildPagination;
const maskKey = (value) => {
    if (value.length <= 10) {
        return "***";
    }
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
};
exports.maskKey = maskKey;
const safeNumber = (value, fallback) => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
};
exports.safeNumber = safeNumber;
