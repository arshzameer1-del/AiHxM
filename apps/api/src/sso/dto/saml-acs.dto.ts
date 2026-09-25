import { IsOptional, IsString } from "class-validator";

/**
 * The body of the SAML IdP's HTTP-POST-bound `<form>` submission to
 * `POST /auth/sso/saml/acs` — a real browser auto-submits this form (see
 * `test-mock-saml-idp.ts`'s own doc comment for what that looks like),
 * never a `fetch()`, which is why `SsoController.samlAcs()` 302s the
 * browser onward exactly like every other route in that file rather than
 * returning JSON.
 *
 * Both fields are `@IsOptional()` — deliberately, not an oversight: a
 * malformed or IdP-misconfigured POST missing one of them should still
 * reach `SsoService.handleSamlAcs()`'s own "Malformed SAML response"
 * handling and become a friendly `#error=` redirect, the exact same
 * posture `SsoController.callback()`'s optional `@Query()` params already
 * give OIDC's equivalent failure case — never a raw Nest `400` JSON body,
 * which the browser has nowhere sensible to show mid-redirect. The global
 * `ValidationPipe`'s `forbidNonWhitelisted` (see main.ts) is what strips
 * anything else a malicious POST might add; `handleSamlAcs()` is what
 * validates these two fields' actual SAML content.
 */
export class SamlAcsDto {
  @IsOptional()
  @IsString()
  SAMLResponse?: string;

  @IsOptional()
  @IsString()
  RelayState?: string;
}
