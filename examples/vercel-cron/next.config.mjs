/**
 * Next.js config. MongoShield and the MongoDB driver are kept out of the bundle and
 * loaded from node_modules at runtime: they load optional modules (cloud SDKs,
 * driver add-ons) on demand, which a bundler would otherwise try to resolve at build time.
 *
 * @type {import("next").NextConfig}
 */
const nextConfig = {
  serverExternalPackages: ["mongoshield", "mongodb"],
};

export default nextConfig;
