import crypto from "node:crypto";

export const nowIso = (): string => new Date().toISOString();

export const hashKey = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

export const splitKeys = (text: string): string[] =>
  text
    .split(/\r?\n|,|\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

export const splitProxyKeys = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const toJson = (value: unknown): string => JSON.stringify(value ?? {});

export const pickWeighted = <T extends { weight: number }>(items: T[]): T => {
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

export const buildPagination = (page: number, pageSize: number, totalItems: number) => {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
  return {
    page,
    page_size: pageSize,
    total_items: totalItems,
    total_pages: totalPages,
  };
};

export const maskKey = (value: string): string => {
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
};

export const safeNumber = (value: unknown, fallback: number): number => {
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

