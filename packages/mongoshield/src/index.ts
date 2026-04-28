/**
 * MongoShield — The main entry point.
 *
 * This package re-exports the high-level MongoShield wrapper class
 * and all public APIs from @mongoshield/core for convenience.
 */

// Re-export everything from @mongoshield/core so users only need one import
export * from "@mongoshield/core";
// Logger
export { logger } from "./logger";
export type { MongoShieldConfig } from "./MongoShield";
// High-level wrapper
export { MongoShield, MongoShieldConfigSchema } from "./MongoShield";
