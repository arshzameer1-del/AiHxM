import test from "node:test";
import assert from "node:assert/strict";
import { tenantBaseDomains, tenantSlugFromHost } from "./tenantHost";

test("the first label of a company address is the company slug", () => {
  assert.equal(tenantSlugFromHost("leadhcm.aihxm.com"), "leadhcm");
  assert.equal(tenantSlugFromHost("Acme-Textiles.AIHXM.com"), "acme-textiles");
  assert.equal(tenantSlugFromHost("acme.aihxm.com."), "acme");
});

test("platform hosts and the bare domain are not companies", () => {
  for (const h of ["aihxm.com", "www.aihxm.com", "app.aihxm.com", "api.aihxm.com", "qa.aihxm.com", "staging.aihxm.com"]) {
    assert.equal(tenantSlugFromHost(h), null, h);
  }
});

test("other domains, pages.dev previews and nested names are not companies", () => {
  assert.equal(tenantSlugFromHost("aihxm.pages.dev"), null);
  assert.equal(tenantSlugFromHost("acme.example.com"), null);
  assert.equal(tenantSlugFromHost("a.b.aihxm.com"), null);
  assert.equal(tenantSlugFromHost("evilaihxm.com"), null);
  assert.equal(tenantSlugFromHost("acme.aihxm.com.evil.io"), null);
});

test("acme.localhost works for local development, bare localhost does not", () => {
  assert.equal(tenantSlugFromHost("acme.localhost"), "acme");
  assert.equal(tenantSlugFromHost("localhost"), null);
});

test("the base domain list can be configured and always keeps localhost", () => {
  assert.deepEqual(tenantBaseDomains("example.pk, .Foo.com"), ["example.pk", "foo.com", "localhost"]);
  assert.equal(tenantSlugFromHost("acme.example.pk", tenantBaseDomains("example.pk")), "acme");
  assert.equal(tenantSlugFromHost("acme.aihxm.com", tenantBaseDomains("example.pk")), null);
});
