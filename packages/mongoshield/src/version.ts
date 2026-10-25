import pkg from "../package.json" with { type: "json" };

/** The installed MongoShield version, recorded in every manifest as `mongoshield@<version>`. */
export const version: string = pkg.version;
