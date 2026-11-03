import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import type { Provider, ProviderId } from "./types.ts";

export const PROVIDERS: Record<ProviderId, Provider> = { claude, cursor, codex };
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}
