/**
 * What the end-to-end tests share: fixed test values (users, passwords, the seeded
 * data) and the run's environment handed over by global-setup.ts in `E2E_*`
 * variables (the console's URL, the MongoDB URI, the server log).
 */

/** MONGOSHIELD_SECRET of the console under test (≥ 32 characters, as the server insists). */
export const E2E_SECRET = "e2e-secret-0123456789abcdef0123456789abcdef";

/** The MongoDB root user mongodb-memory-server creates (authentication is on). */
export const E2E_MONGO_USER = "e2e-root";
/** Its password: the secret that must never appear in the console once saved. */
export const E2E_MONGO_PASSWORD = "Mongo-Pw-7f3a9c-never-shown";

/** The first admin, created through the setup page. */
export const ADMIN = { username: "admin", password: "admin password for e2e tests" } as const;
/** Users the role tests create (one per role below admin). */
export const OPERATOR = { username: "olivia", password: "operator password e2e" } as const;
export const VIEWER = { username: "victor", password: "viewer password for e2e" } as const;

/** Names of the records the journey creates; later specs rely on them. */
export const NAMES = {
  production: "Production shop",
  scratch: "Scratch",
  storage: "Local backups",
  storagePath: "backups",
  plan: "Shop nightly",
} as const;

/** The data global-setup.ts seeds. */
export const SEED = {
  database: "shop",
  orders: "orders",
  orderCount: 120,
  customers: "customers",
  customerCount: 8,
} as const;

/** One `E2E_*` variable; global setup always sets them, so a missing one is a harness bug. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set: run the tests with \`playwright test\` (global setup).`);
  }
  return value;
}

/** The console's URL, e.g. `http://localhost:51234`. */
export const baseUrl = (): string => required("E2E_BASE_URL");
/** Connection string of the test mongod, with the root user's password. */
export const mongoUri = (): string => required("E2E_MONGO_URI");
/** The console's stdout and stderr. */
export const serverLog = (): string => required("E2E_SERVER_LOG");
