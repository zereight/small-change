import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { muse } from "./muse.ts";
import { pi } from "./pi.ts";
import type { Provider, ProviderId } from "./types.ts";

export const PROVIDERS: Record<ProviderId, Provider> = { claude, cursor, codex, pi, muse };
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}
