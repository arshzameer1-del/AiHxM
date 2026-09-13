/**
 * Split into its own file so DatabaseModule and DatabaseService don't
 * import each other directly (a circular import between them left
 * PG_POOL undefined at module-evaluation time under Nest's CJS loader).
 */
export const PG_POOL = "PG_POOL";
