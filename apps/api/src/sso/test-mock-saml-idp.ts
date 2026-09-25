import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { inflateRawSync } from "zlib";
import { randomUUID } from "crypto";
import * as forge from "node-forge";
import { SignedXml } from "xml-crypto";

export type MockSamlIdentity = {
  nameId: string;
  /** Defaults to "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" — override to test a non-email NameID. */
  nameIdFormat?: string;
  groups?: string[];
  /** Extra assertion attributes beyond NameID/groups, e.g. a separate email attribute for the `emailAttribute` config path. */
  attributes?: Record<string, string>;
  /** Set true to have the assertion carry a signature that does NOT verify against `certificatePem` — for the "tampered assertion" test. */
  corruptSignature?: boolean;
};

/**
 * A genuine, from-scratch minimal SAML 2.0 Identity Provider for e2e
 * testing `SsoService`'s SAML Service Provider flow — the SAML sibling of
 * `test-mock-oidc-issuer.ts`, built to the same standard: a real,
 * self-signed X.509 certificate (via `node-forge`, since Node's own
 * `crypto` can parse but not ISSUE an X.509 cert — confirmed by hand
 * before reaching for a library at all), a real XML-DSig signature (via
 * `xml-crypto`, the exact library `@node-saml/node-saml` itself uses to
 * VERIFY one — see its own README's signing example, which this mirrors),
 * and the real HTTP-Redirect binding a browser actually uses to reach an
 * IdP. Only the identity-provider side of the protocol stands in for a
 * real IdP like Okta or Azure AD.
 *
 * Deliberately signs only the `<Assertion>`, never the enclosing
 * `<Response>` — see `SsoService.buildSamlClient()`'s doc comment for why
 * that (Okta's own default SAML app behavior) is exactly the interop case
 * worth covering, not simplified away. A mock IdP that signed the whole
 * response would never have caught the real bug that posture avoids.
 *
 * Supertest only drives requests against the API's own HTTP server (see
 * `sso.e2e.spec.ts`'s own doc comment on this), so this runs a genuine,
 * separate local HTTP server the test's own `fetch` hits directly, in the
 * exact shape a real IdP's "SSO URL" responds with: a GET carrying a
 * deflated, base64, URL-encoded `SAMLRequest` (HTTP-Redirect binding)
 * answered with an HTML auto-submit form carrying `SAMLResponse` +
 * `RelayState` (HTTP-POST binding) — the same form a real browser would
 * silently auto-submit to the SP's ACS URL. There's no headless browser
 * in this test to execute that auto-submit, so the test extracts the two
 * hidden field values from the returned HTML itself and POSTs them to the
 * ACS endpoint directly, mirroring the manual redirect-chasing this
 * file's OIDC sibling already does for its own binding.
 */
export class MockSamlIdp {
  private server: Server | null = null;
  private readonly forgeKeyPair = forge.pki.rsa.generateKeyPair(2048);
  private readonly certificate = this.generateSelfSignedCertificate();

  readonly entityId = `https://mock-saml-idp.test/${randomUUID()}`;
  nextIdentity: MockSamlIdentity = { nameId: "placeholder@example.com" };
  /** Set to make the next login return an IdP-side failure (no assertion at all) instead of a signed one — the SAML equivalent of OIDC's `error`/`error_description` callback params. */
  nextStatusError: { message: string } | null = null;

  private generateSelfSignedCertificate(): forge.pki.Certificate {
    const cert = forge.pki.createCertificate();
    cert.publicKey = this.forgeKeyPair.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 3_600_000);
    const attrs = [{ name: "commonName", value: "mock-saml-idp.test" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(this.forgeKeyPair.privateKey, forge.md.sha256.create());
    return cert;
  }

  /** PEM-encoded X.509 cert — exactly what a real admin would paste into `SamlSsoConfig.idpCertificate`. */
  get certificatePem(): string {
    return forge.pki.certificateToPem(this.certificate);
  }

  private get privateKeyPem(): string {
    return forge.pki.privateKeyToPem(this.forgeKeyPair.privateKey);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get baseUrl(): string {
    const port = (this.server?.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  /** What a `SamlSsoConfig.idpSsoUrl` for this mock IdP looks like. */
  get ssoUrl(): string {
    return `${this.baseUrl}/sso`;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", this.baseUrl);
    if (url.pathname !== "/sso") {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const html = this.handleAuthnRequest(url);
      res.writeHead(200, { "Content-Type": "text/html" }).end(html);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end((err as Error).message);
    }
  }

  /** Inflates the HTTP-Redirect-bound `SAMLRequest`, reads its `ID`, and builds a signed assertion in response to it. */
  private handleAuthnRequest(url: URL): string {
    const samlRequestParam = url.searchParams.get("SAMLRequest");
    const relayState = url.searchParams.get("RelayState") ?? "";
    if (!samlRequestParam) throw new Error("Missing SAMLRequest");

    const deflated = Buffer.from(samlRequestParam, "base64");
    const requestXml = inflateRawSync(deflated).toString("utf8");
    const idMatch = requestXml.match(/AuthnRequest[^>]*\bID="([^"]+)"/);
    const acsUrlMatch = requestXml.match(/AssertionConsumerServiceURL="([^"]+)"/);
    const inResponseTo = idMatch?.[1];
    const acsUrl = acsUrlMatch?.[1];
    if (!inResponseTo || !acsUrl) {
      throw new Error("Could not read AuthnRequest ID / AssertionConsumerServiceURL");
    }

    const samlResponse = this.buildSignedSamlResponse(inResponseTo, acsUrl);
    const encoded = Buffer.from(samlResponse, "utf8").toString("base64");

    // A real HTTP-POST-binding response page: an auto-submitting form.
    // The test itself extracts these two hidden values instead of running
    // this script — see this class's own doc comment.
    return `<!DOCTYPE html><html><body onload="document.forms[0].submit()">
      <form method="post" action="${acsUrl}">
        <input type="hidden" name="SAMLResponse" value="${encoded}" />
        <input type="hidden" name="RelayState" value="${escapeHtmlAttr(relayState)}" />
      </form>
    </body></html>`;
  }

  private buildSignedSamlResponse(inResponseTo: string, acsUrl: string): string {
    const now = new Date();
    const responseId = `_${randomUUID()}`;

    // An IdP-side failure (the person cancelled, an admin disabled their
    // account at the IdP, etc.) — no assertion at all, just a failure
    // status. Real IdPs commonly leave this unsigned, which is exactly
    // why `@node-saml/node-saml` itself doesn't require a valid signature
    // before surfacing this particular error (see its own
    // `validatePostResponseAsync` — "we're not requiring a valid
    // signature before this logic... since some providers don't sign
    // error results").
    if (this.nextStatusError) {
      return (
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
        `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
        `ID="${responseId}" InResponseTo="${escapeXml(inResponseTo)}" IssueInstant="${now.toISOString()}" ` +
        `Version="2.0" Destination="${escapeXml(acsUrl)}">` +
        `<saml:Issuer>${escapeXml(this.entityId)}</saml:Issuer>` +
        `<samlp:Status>` +
        `<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder">` +
        `<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"/>` +
        `</samlp:StatusCode>` +
        `<samlp:StatusMessage>${escapeXml(this.nextStatusError.message)}</samlp:StatusMessage>` +
        `</samlp:Status>` +
        `</samlp:Response>`
      );
    }

    const identity = this.nextIdentity;
    const notOnOrAfter = new Date(now.getTime() + 5 * 60_000);
    const assertionId = `_${randomUUID()}`;
    const nameIdFormat = identity.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

    const attributeStatements = Object.entries({ ...identity.attributes }).map(
      ([name, value]) =>
        `<saml:Attribute Name="${escapeXml(name)}"><saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue></saml:Attribute>`
    );
    if (identity.groups?.length) {
      attributeStatements.push(
        `<saml:Attribute Name="groups">${identity.groups
          .map((g) => `<saml:AttributeValue>${escapeXml(g)}</saml:AttributeValue>`)
          .join("")}</saml:Attribute>`
      );
    }
    const attributeStatementXml = attributeStatements.length
      ? `<saml:AttributeStatement>${attributeStatements.join("")}</saml:AttributeStatement>`
      : "";

    // The assertion carries its own `ID` — this, not the enclosing
    // Response's ID, is what gets referenced by the `<Signature>` we sign
    // below (an "enveloped" signature over the whole Assertion element).
    const assertionXml =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${assertionId}" IssueInstant="${now.toISOString()}" Version="2.0">` +
      `<saml:Issuer>${escapeXml(this.entityId)}</saml:Issuer>` +
      `<saml:Subject>` +
      `<saml:NameID Format="${escapeXml(nameIdFormat)}">${escapeXml(identity.nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData InResponseTo="${escapeXml(inResponseTo)}" NotOnOrAfter="${notOnOrAfter.toISOString()}" Recipient="${escapeXml(acsUrl)}"/>` +
      `</saml:SubjectConfirmation>` +
      `</saml:Subject>` +
      `<saml:Conditions NotBefore="${now.toISOString()}" NotOnOrAfter="${notOnOrAfter.toISOString()}">` +
      `<saml:AudienceRestriction><saml:Audience>${escapeXml(SP_ENTITY_ID_FOR_TESTS)}</saml:Audience></saml:AudienceRestriction>` +
      `</saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext>` +
      `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
      `</saml:AuthnContext></saml:AuthnStatement>` +
      attributeStatementXml +
      `</saml:Assertion>`;

    const signedAssertionXml = identity.corruptSignature
      ? this.signXmlWithWrongKey(assertionXml, assertionId)
      : this.signXml(assertionXml, assertionId);

    return (
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${responseId}" InResponseTo="${escapeXml(inResponseTo)}" IssueInstant="${now.toISOString()}" ` +
      `Version="2.0" Destination="${escapeXml(acsUrl)}">` +
      `<saml:Issuer>${escapeXml(this.entityId)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      signedAssertionXml +
      `</samlp:Response>`
    );
  }

  /** Real XML-DSig: exclusive C14N, RSA-SHA256, enveloped signature over the whole referenced element, placed right after its `<Issuer>` per the SAML profile. */
  private signXml(xml: string, referenceId: string): string {
    const sig = new SignedXml({
      privateKey: this.privateKeyPem,
      publicCert: this.certificatePem,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: `//*[local-name(.)='Assertion'][@ID='${referenceId}']`,
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    });
    sig.computeSignature(xml, {
      location: { reference: "//*[local-name(.)='Issuer']", action: "after" },
    });
    return sig.getSignedXml();
  }

  /** Same shape as `signXml`, but signed with a throwaway key — the SP must reject this. */
  private signXmlWithWrongKey(xml: string, referenceId: string): string {
    const wrongKeyPair = forge.pki.rsa.generateKeyPair(2048);
    const sig = new SignedXml({
      privateKey: forge.pki.privateKeyToPem(wrongKeyPair.privateKey),
      publicCert: this.certificatePem, // claims to be the real cert, but wasn't used to sign
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: `//*[local-name(.)='Assertion'][@ID='${referenceId}']`,
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    });
    sig.computeSignature(xml, {
      location: { reference: "//*[local-name(.)='Issuer']", action: "after" },
    });
    return sig.getSignedXml();
  }
}

// The one SP Entity ID `SsoService.samlSpEntityId()` uses by default (no
// `SAML_SP_ENTITY_ID` env override in tests) — kept as one named constant
// here so a change to that default only needs updating in one obvious
// place for the test suite to keep passing.
export const SP_ENTITY_ID_FOR_TESTS = "urn:aihxm:sp";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttr(value: string): string {
  return escapeXml(value);
}
