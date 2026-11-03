import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { affectedServices, serviceOf } from "../src/services.ts";

describe("serviceOf", () => {
  it("takes the first `depth` directories", () => {
    assert.equal(serviceOf("services/payments/src/a.ts", 2), "services/payments");
    assert.equal(serviceOf("services/payments/src/a.ts", 1), "services");
    assert.equal(serviceOf("services/payments/src/a.ts", 3), "services/payments/src");
  });

  it("uses the containing directory for a file closer to the root than `depth`", () => {
    assert.equal(serviceOf("services/a.ts", 2), "services");
    assert.equal(serviceOf("services/payments/a.ts", 5), "services/payments");
  });

  it("puts a root file in `.`", () => {
    assert.equal(serviceOf("README.md", 2), ".");
  });
});

describe("affectedServices", () => {
  it("returns the distinct services, sorted", () => {
    assert.deepEqual(
      affectedServices(["b/x/1.ts", "a/y/2.ts", "b/x/3.ts", "README.md"], 2),
      [".", "a/y", "b/x"],
    );
  });

  it("returns nothing for no paths", () => {
    assert.deepEqual(affectedServices([], 2), []);
  });
});
