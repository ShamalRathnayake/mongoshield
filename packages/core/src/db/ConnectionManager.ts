import { MongoClient, type MongoClientOptions } from "mongodb";
import type { ConnectionOptions } from "../config";

export class ConnectionManager {
  private client: MongoClient | null = null;
  private readonly config: ConnectionOptions;

  constructor(config: ConnectionOptions) {
    this.config = config;
  }

  public async connect(): Promise<MongoClient> {
    if (this.client) {
      return this.client;
    }

    const {
      host,
      port,
      username,
      password,
      authenticationDatabase,
      authenticationMechanism,
      tls,
      tlsCertificateKeyFile,
      tlsCertificateKeyFilePassword,
      tlsCAFile,
      tlsAllowInvalidCertificates,
      directConnection,
    } = this.config;

    let credentials = "";
    if (username && password) {
      credentials = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
    }

    // Construct base URI
    let uri = `mongodb://${credentials}${host}:${port}`;

    // Construct Options
    const options: MongoClientOptions = {};

    const queryParams = new URLSearchParams();

    if (authenticationDatabase)
      queryParams.set("authSource", authenticationDatabase);
    if (authenticationMechanism)
      queryParams.set("authMechanism", authenticationMechanism);

    if (tls !== undefined) options.tls = tls;
    if (tlsCertificateKeyFile)
      options.tlsCertificateKeyFile = tlsCertificateKeyFile;
    if (tlsCertificateKeyFilePassword)
      options.tlsCertificateKeyFilePassword = tlsCertificateKeyFilePassword;
    if (tlsCAFile) options.tlsCAFile = tlsCAFile;
    if (tlsAllowInvalidCertificates !== undefined)
      options.tlsAllowInvalidCertificates = tlsAllowInvalidCertificates;
    if (directConnection !== undefined)
      options.directConnection = directConnection;

    const qs = queryParams.toString();
    if (qs) {
      uri += `/?${qs}`;
    }

    this.client = new MongoClient(uri, options);
    await this.client.connect();

    return this.client;
  }

  public getClient(): MongoClient {
    if (!this.client) {
      throw new Error(
        "ConnectionManager: client is not connected. Call connect() first.",
      );
    }
    return this.client;
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
