import { randomUUID } from "node:crypto";

export function resolveAccessToken(env: {
  COUNCIL_ACCESS_TOKEN?: string;
}): {
  accessToken: string;
  generated: boolean;
} {
  const configured = env.COUNCIL_ACCESS_TOKEN?.trim();
  if (configured) {
    return { accessToken: configured, generated: false };
  }

  return { accessToken: randomUUID(), generated: true };
}
