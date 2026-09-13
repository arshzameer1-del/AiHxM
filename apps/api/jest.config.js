module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  setupFiles: ["<rootDir>/test-setup.ts"],
  // Real Postgres integration tests (RLS is the point — mocking `pg`
  // would test nothing about it), so keep them from trampling each other
  // when creating/deleting shared-key fixtures like companies/roles.
  maxWorkers: 1,
  // ts-jest's preset only transforms our own .ts sources. otplib's
  // dependency chain (@scure/base, @noble/hashes) ships ES modules, which
  // Node's CJS require() can't parse — anything that transitively imports
  // AuthModule (any full-app e2e test) needs those specific packages
  // transformed too. See babel.config.js.
  transform: {
    "^.+\\.tsx?$": "ts-jest",
    // Explicit configFile, not just "babel-jest": this is a Turborepo
    // monorepo, so otplib's dependency chain resolves from the HOISTED
    // node_modules at the repo root, one directory above this package.
    // Babel's default config search is root-relative to cwd (this
    // package) and silently finds nothing for a file outside that tree —
    // babel-jest then "transforms" with zero presets applied, and the
    // ESM `export` syntax reaches Node's CJS loader untouched. Pointing
    // babel-jest at the config file directly sidesteps that search.
    "^.+\\.jsx?$": ["babel-jest", { configFile: require.resolve("./babel.config.js") }],
  },
  transformIgnorePatterns: ["node_modules/(?!(otplib|@otplib|@scure|@noble)/)"],
};
