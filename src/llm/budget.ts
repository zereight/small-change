import { EFFORTS, type Effort } from "./types.ts";

/** How much reasoning a review may spend, by name, and the effort each name stands for. */
export const BUDGETS = {
  unlimited: "max",
  large: "xhigh",
  medium: "high",
  small: "medium",
} as const satisfies Record<string, Effort>;

export type Budget = keyof typeof BUDGETS;
export const BUDGET_NAMES = Object.keys(BUDGETS) as Budget[];

/** What the setup menu shows for each budget. */
export const BUDGET_LABELS: Record<Budget, string> = {
  unlimited: "unlimited — max reasoning",
  large: "large — xhigh reasoning",
  medium: "medium — high reasoning",
  small: "small — medium reasoning",
};

export function isBudget(value: string): value is Budget {
  return Object.hasOwn(BUDGETS, value);
}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

const rank = (effort: Effort) => EFFORTS.indexOf(effort);

/**
 * The highest of `supported` efforts at or below `target`, or undefined when every supported
 * effort is above it (the caller then has to ask for a choice).
 */
export function clampEffort(target: Effort, supported: readonly Effort[]): Effort | undefined {
  return supported
    .filter((effort) => rank(effort) <= rank(target))
    .sort((a, b) => rank(b) - rank(a))[0];
}

/** The effort tokens a model slug may carry: the ladder, plus the lower rungs only slugs have. */
const SLUG_LADDER: readonly string[] = ["none", "minimal", ...EFFORTS];

interface ParsedSlug {
  /** The slug without its effort token and trailing `fast`. */
  family: string;
  /** A rung of {@link SLUG_LADDER}; undefined when the slug carries none. */
  effort: string | undefined;
  fast: boolean;
}

/**
 * Splits a model slug such as `grok-4.7-xhigh-fast`. The effort token is the last token, or the
 * one before a trailing `fast`, when it is on the ladder. `extra-high` is the ladder's `xhigh`.
 */
function parseSlug(slug: string): ParsedSlug {
  const tokens = slug.split("-");
  const fast = tokens.at(-1) === "fast";
  if (fast) {
    tokens.pop();
  }
  let effort: string | undefined;
  if (tokens.at(-1) === "high" && tokens.at(-2) === "extra") {
    effort = "xhigh";
    tokens.splice(-2);
  } else {
    const last = tokens.at(-1);
    if (last !== undefined && SLUG_LADDER.includes(last)) {
      effort = last;
      tokens.pop();
    }
  }
  return { family: tokens.join("-"), effort, fast };
}

/**
 * Moves a model slug's effort to `target`, for agents that encode the effort in the slug: the
 * same family's `detected` slug (with the same `fast` suffix) with the highest effort at or below
 * `target`. A slug without an effort token stays as it is, if it was detected. Undefined when
 * nothing fits.
 */
export function retargetSlug(
  slug: string,
  target: Effort,
  detected: readonly string[],
): string | undefined {
  const parsed = parseSlug(slug);
  if (parsed.effort === undefined) {
    return detected.includes(slug) ? slug : undefined;
  }
  const ceiling = SLUG_LADDER.indexOf(target);
  return detected
    .map((candidate) => ({ candidate, parsed: parseSlug(candidate) }))
    .filter(
      ({ parsed: other }) =>
        other.family === parsed.family &&
        other.fast === parsed.fast &&
        other.effort !== undefined &&
        SLUG_LADDER.indexOf(other.effort) <= ceiling,
    )
    .sort(
      (a, b) =>
        SLUG_LADDER.indexOf(b.parsed.effort as string) - SLUG_LADDER.indexOf(a.parsed.effort as string),
    )[0]?.candidate;
}
