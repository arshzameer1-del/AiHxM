// Only used by Jest, and only for the handful of node_modules files below
// that ship as ES modules (otplib's dependency chain: @scure/base,
// @noble/hashes) — ts-jest transforms our own .ts sources directly and
// doesn't touch node_modules at all, so without this, requiring anything
// that imports otplib inside a test fails with "Unexpected token 'export'".
// See jest.config.js's transformIgnorePatterns for the matching allowlist.
module.exports = {
  presets: [["@babel/preset-env", { targets: { node: "current" } }]],
};
