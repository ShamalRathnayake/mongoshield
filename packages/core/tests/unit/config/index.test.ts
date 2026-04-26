import { describe, expect, it } from "vitest";
import {
  BackupConfigSchema,
  ConnectionOptionsSchema,
  OutputOptionsSchema,
  TargetOptionsSchema,
  validateConfig,
} from "../../../src/config";

describe("Config Schemas", () => {
  describe("ConnectionOptionsSchema", () => {
    it("applies defaults correctly", () => {
      const result = ConnectionOptionsSchema.parse({});
      expect(result.host).toBe("127.0.0.1");
      expect(result.port).toBe(27017);
    });

    it("accepts full configuration", () => {
      const fullConfig = {
        host: "localhost",
        port: 27018,
        username: "user",
        password: "password",
        authenticationDatabase: "admin",
        authenticationMechanism: "SCRAM-SHA-256" as const,
        tls: true,
        tlsCertificateKeyFile: "/path/to/cert",
        tlsCertificateKeyFilePassword: "pass",
        tlsCAFile: "/path/to/ca",
        tlsAllowInvalidCertificates: false,
        directConnection: true,
      };
      const result = ConnectionOptionsSchema.parse(fullConfig);
      expect(result).toEqual(fullConfig);
    });

    it("rejects negative ports", () => {
      const result = ConnectionOptionsSchema.safeParse({ port: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe("TargetOptionsSchema", () => {
    it("applies defaults correctly", () => {
      const result = TargetOptionsSchema.parse({});
      expect(result.viewsAsCollections).toBe(false);
      expect(result.dumpDbUsersAndRoles).toBe(false);
    });

    it("accepts full configuration", () => {
      const fullConfig = {
        dbName: "testdb",
        collections: ["col1", "col2"],
        excludeCollections: ["col3"],
        excludeCollectionsWithPrefix: ["temp_"],
        query: { active: true },
        queryFile: "/path/to/query.json",
        readPreference: "secondaryPreferred" as const,
        viewsAsCollections: true,
        dumpDbUsersAndRoles: true,
      };
      const result = TargetOptionsSchema.parse(fullConfig);
      expect(result).toEqual(fullConfig);
    });
  });

  describe("OutputOptionsSchema", () => {
    it("applies defaults correctly", () => {
      const result = OutputOptionsSchema.parse({});
      expect(result.outPath).toBe("dump");
      expect(result.gzip).toBe(false);
      expect(result.numParallelCollections).toBe(4);
      expect(result.oplog).toBe(false);
    });

    it("accepts valid encryptionKey", () => {
      const validKey = "a".repeat(64);
      const result = OutputOptionsSchema.parse({ encryptionKey: validKey });
      expect(result.encryptionKey).toBe(validKey);
    });

    it("rejects encryptionKey with wrong length", () => {
      const invalidKey = "a".repeat(63);
      const result = OutputOptionsSchema.safeParse({
        encryptionKey: invalidKey,
      });
      expect(result.success).toBe(false);
    });

    it("rejects encryptionKey with non-hex characters", () => {
      const invalidKey = "z".repeat(64);
      const result = OutputOptionsSchema.safeParse({
        encryptionKey: invalidKey,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("BackupConfigSchema and validateConfig", () => {
    it("applies top-level defaults", () => {
      const result = validateConfig({});
      expect(result.connection.host).toBe("127.0.0.1");
      expect(result.target.viewsAsCollections).toBe(false);
      expect(result.output.outPath).toBe("dump");
    });

    it("validates custom config", () => {
      const customConfig = {
        connection: { host: "remote", port: 1234 },
        target: { dbName: "prod" },
        output: {
          outPath: "/backups",
          gzip: true,
          numParallelCollections: 8,
          oplog: true,
        },
      };
      const result = validateConfig(customConfig);
      expect(result.connection.host).toBe("remote");
      expect(result.connection.port).toBe(1234);
      expect(result.target.dbName).toBe("prod");
      expect(result.output.gzip).toBe(true);
    });

    it("throws on invalid config", () => {
      expect(() => validateConfig({ connection: { port: -1 } })).toThrow();
    });
  });
});
