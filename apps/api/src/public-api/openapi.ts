/** The contract of the read-only public API, served as JSON so any tool can import it. */
export const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "AI HXM public API",
    version: "1.0.0",
    description:
      "Read-only. Create a key under Admin > Developer and send it as `Authorization: Bearer <key>`. A key only reads what its scopes allow. " +
      "No contact details, identity numbers, bank details or pay figures are ever returned. Requests are limited per address.",
  },
  servers: [{ url: "/api/public-api/v1" }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  security: [{ bearer: [] }],
  paths: {
    "/employees": {
      get: {
        summary: "List employees (scope employees.read)",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "terminated", "all"], default: "active" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        responses: {
          "200": { description: "A page of employees: id, employeeNumber, firstName, lastName, status, dateOfJoining, terminationDate, orgUnit, positionTitle" },
          "401": { description: "Missing, unknown or revoked key" },
          "403": { description: "The key lacks the scope" },
        },
      },
    },
    "/org-units": {
      get: { summary: "List departments and other units (scope org.read)", responses: { "200": { description: "id, name, type" }, "401": { description: "Missing or invalid key" }, "403": { description: "The key lacks the scope" } } },
    },
  },
} as const;
