import type { FastifyReply, FastifyRequest } from "fastify";

import { fail } from "./response.js";

const readQueryKey = (request: FastifyRequest): string | null => {
  const query = request.query as Record<string, unknown> | undefined;
  const key = query?.key;
  if (typeof key === "string" && key.trim()) {
    return key.trim();
  }
  return null;
};

export const extractBearer = (request: FastifyRequest): string | null => {
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

export const extractAuthKey = (request: FastifyRequest): string | null => {
  const queryKey = readQueryKey(request);
  if (queryKey) {
    return queryKey;
  }

  const bearer = extractBearer(request);
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

export const requireAdminAuth = async (
  request: FastifyRequest,
  reply: FastifyReply,
  authKey: string,
) => {
  const token = extractAuthKey(request);
  if (!token || token !== authKey) {
    return fail(reply, 401, "UNAUTHORIZED", "Unauthorized");
  }
};
