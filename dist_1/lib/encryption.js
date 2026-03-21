"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformEncryption = exports.decryptWithKey = exports.encryptWithKey = exports.isEncryptedValue = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const PREFIX = "enc:v1:";
const deriveKey = (password) => {
    return node_crypto_1.default.createHash("sha256").update(password).digest();
};
const isEncryptedValue = (value) => {
    return typeof value === "string" && value.startsWith(PREFIX);
};
exports.isEncryptedValue = isEncryptedValue;
const encryptWithKey = (plainText, password) => {
    const iv = node_crypto_1.default.randomBytes(12);
    const key = deriveKey(password);
    const cipher = node_crypto_1.default.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${encrypted.toString("base64")}:${tag.toString("base64")}`;
};
exports.encryptWithKey = encryptWithKey;
const decryptWithKey = (encryptedText, password) => {
    if (!(0, exports.isEncryptedValue)(encryptedText)) {
        return encryptedText;
    }
    const raw = encryptedText.slice(PREFIX.length);
    const [ivB64, dataB64, tagB64] = raw.split(":");
    if (!ivB64 || !dataB64 || !tagB64) {
        throw new Error("invalid encrypted payload format");
    }
    const iv = Buffer.from(ivB64, "base64");
    const key = deriveKey(password);
    const decipher = node_crypto_1.default.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return decrypted.toString("utf8");
};
exports.decryptWithKey = decryptWithKey;
const transformEncryption = (value, fromKey, toKey) => {
    let plain = value;
    if (fromKey) {
        plain = (0, exports.decryptWithKey)(value, fromKey);
    }
    else if ((0, exports.isEncryptedValue)(value)) {
        throw new Error("source key is required to decrypt existing encrypted data");
    }
    if (!toKey) {
        return plain;
    }
    return (0, exports.encryptWithKey)(plain, toKey);
};
exports.transformEncryption = transformEncryption;
