import crypto from "node:crypto";

const PREFIX = "enc:v1:";

const deriveKey = (password: string): Buffer => {
  return crypto.createHash("sha256").update(password).digest();
};

export const isEncryptedValue = (value: string): boolean => {
  return typeof value === "string" && value.startsWith(PREFIX);
};

export const encryptWithKey = (plainText: string, password: string): string => {
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${encrypted.toString("base64")}:${tag.toString("base64")}`;
};

export const decryptWithKey = (encryptedText: string, password: string): string => {
  if (!isEncryptedValue(encryptedText)) {
    return encryptedText;
  }
  const raw = encryptedText.slice(PREFIX.length);
  const [ivB64, dataB64, tagB64] = raw.split(":");
  if (!ivB64 || !dataB64 || !tagB64) {
    throw new Error("invalid encrypted payload format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const key = deriveKey(password);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
};

export const transformEncryption = (
  value: string,
  fromKey: string,
  toKey: string,
): string => {
  let plain = value;
  if (fromKey) {
    plain = decryptWithKey(value, fromKey);
  } else if (isEncryptedValue(value)) {
    throw new Error("source key is required to decrypt existing encrypted data");
  }

  if (!toKey) {
    return plain;
  }
  return encryptWithKey(plain, toKey);
};

