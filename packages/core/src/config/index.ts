import { z } from "zod";

export const ConnectionOptionsSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(27017),
  username: z.string().optional(),
  password: z.string().optional(),
  authenticationDatabase: z.string().optional(),
  authenticationMechanism: z
    .enum([
      "DEFAULT",
      "GSSAPI",
      "PLAIN",
      "MONGODB-X509",
      "SCRAM-SHA-1",
      "SCRAM-SHA-256",
      "MONGODB-AWS",
    ])
    .optional(),
  tls: z.boolean().optional(),
  tlsCertificateKeyFile: z.string().optional(),
  tlsCertificateKeyFilePassword: z.string().optional(),
  tlsCAFile: z.string().optional(),
  tlsAllowInvalidCertificates: z.boolean().optional(),
  directConnection: z.boolean().optional(),
});

export const TargetOptionsSchema = z.object({
  dbName: z.string().optional(),
  collections: z.array(z.string()).optional(),
  excludeCollections: z.array(z.string()).optional(),
  excludeCollectionsWithPrefix: z.array(z.string()).optional(),
  query: z.record(z.string(), z.any()).optional(),
  queryFile: z.string().optional(),
  readPreference: z
    .enum([
      "primary",
      "primaryPreferred",
      "secondary",
      "secondaryPreferred",
      "nearest",
    ])
    .optional(),
  viewsAsCollections: z.boolean().default(false),
  dumpDbUsersAndRoles: z.boolean().default(false),
});

export const OutputOptionsSchema = z.object({
  outPath: z.string().default("dump"),
  archivePath: z.string().optional(),
  gzip: z.boolean().default(false),
  numParallelCollections: z.number().int().positive().default(4),
  oplog: z.boolean().default(false),
  encryptionKey: z
    .string()
    .length(64, "Encryption key must be exactly 64 characters long")
    .regex(/^[0-9a-fA-F]+$/, "Encryption key must be a valid hex string")
    .optional(), // AES-256-GCM hex key
  batchSize: z.number().int().positive().optional(),
});

export const BackupConfigSchema = z.object({
  connection: ConnectionOptionsSchema.default({
    host: "127.0.0.1",
    port: 27017,
  }),
  target: TargetOptionsSchema.default({
    viewsAsCollections: false,
    dumpDbUsersAndRoles: false,
  }),
  output: OutputOptionsSchema.default({
    outPath: "dump",
    gzip: false,
    numParallelCollections: 4,
    oplog: false,
  }),
});

export type ConnectionOptions = z.infer<typeof ConnectionOptionsSchema>;
export type TargetOptions = z.infer<typeof TargetOptionsSchema>;
export type OutputOptions = z.infer<typeof OutputOptionsSchema>;
export type BackupConfig = z.infer<typeof BackupConfigSchema>;
export type BackupConfigInput = z.input<typeof BackupConfigSchema>;

export function validateConfig(config: unknown): BackupConfig {
  return BackupConfigSchema.parse(config);
}
