import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUDGETS, clampEffort, isBudget, retargetSlug } from "../src/llm/budget.ts";

describe("budgets", () => {
  it("maps each budget to the effort pstack uses", () => {
    assert.deepEqual(BUDGETS, { unlimited: "max", large: "xhigh", medium: "high", small: "medium" });
  });

  it("recognizes only budget names, not Object.prototype keys", () => {
    assert.equal(isBudget("large"), true);
    assert.equal(isBudget("toString"), false);
    assert.equal(isBudget("huge"), false);
  });
});

describe("clampEffort", () => {
  it("keeps a supported effort", () => {
    assert.equal(clampEffort("high", ["low", "medium", "high"]), "high");
  });

  it("falls back to the highest supported effort below the target", () => {
    assert.equal(clampEffort("max", ["low", "medium", "high"]), "high");
    assert.equal(clampEffort("xhigh", ["low", "high", "max"]), "high");
  });

  it("is undefined when every supported effort is above the target", () => {
    assert.equal(clampEffort("low", ["high", "xhigh"]), undefined);
  });
});

describe("retargetSlug", () => {
  const detected = [
    "auto",
    "grok-4.7-low",
    "grok-4.7-medium",
    "grok-4.7-high",
    "grok-4.7-xhigh",
    "grok-4.7-high-fast",
    "grok-4.7-medium-fast",
    "composer-2.5",
  ];

  it("moves the effort token to the target", () => {
    assert.equal(retargetSlug("grok-4.7-low", "xhigh", detected), "grok-4.7-xhigh");
  });

  it("keeps the fast suffix", () => {
    assert.equal(retargetSlug("grok-4.7-medium-fast", "high", detected), "grok-4.7-high-fast");
  });

  it("uses the highest detected effort at or below the target when the exact one is missing", () => {
    assert.equal(retargetSlug("grok-4.7-low", "max", detected), "grok-4.7-xhigh");
    assert.equal(retargetSlug("grok-4.7-low-fast", "xhigh", detected), "grok-4.7-high-fast");
  });

  it("is undefined when no variant is at or below the target", () => {
    assert.equal(retargetSlug("grok-4.7-high", "low", ["grok-4.7-high", "grok-4.7-xhigh"]), undefined);
  });

  it("leaves a slug without an effort token alone, if it was detected", () => {
    assert.equal(retargetSlug("composer-2.5", "xhigh", detected), "composer-2.5");
    assert.equal(retargetSlug("unknown-model", "xhigh", detected), undefined);
  });

  it("does not mix model families", () => {
    assert.equal(retargetSlug("gemini-3.7-low", "high", detected), undefined);
  });

  it("lifts a slug from the rungs below low", () => {
    const slugs = ["gpt-5.6-sol-none", "gpt-5.6-sol-low", "gpt-5.6-sol-medium", "gpt-5.6-sol-max"];
    assert.equal(retargetSlug("gpt-5.6-sol-none", "high", slugs), "gpt-5.6-sol-medium");
    assert.equal(retargetSlug("gpt-5.6-sol-max", "medium", slugs), "gpt-5.6-sol-medium");
  });

  it("reads extra-high as xhigh", () => {
    const slugs = ["gpt-5.5-low", "gpt-5.5-high", "gpt-5.5-extra-high", "gpt-5.5-extra-high-fast"];
    assert.equal(retargetSlug("gpt-5.5-high", "xhigh", slugs), "gpt-5.5-extra-high");
    assert.equal(retargetSlug("gpt-5.5-extra-high", "high", slugs), "gpt-5.5-high");
    assert.equal(retargetSlug("gpt-5.5-extra-high-fast", "max", slugs), "gpt-5.5-extra-high-fast");
  });

  it("leaves a slug whose effort token is not last alone", () => {
    const slugs = ["claude-4.6-opus-high-thinking", "claude-4.6-opus-max-thinking"];
    assert.equal(retargetSlug("claude-4.6-opus-high-thinking", "medium", slugs), "claude-4.6-opus-high-thinking");
  });
});
