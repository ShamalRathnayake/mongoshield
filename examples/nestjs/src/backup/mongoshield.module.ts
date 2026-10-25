/**
 * A NestJS module that provides one shared `MongoShield` instance.
 *
 *   @Module({
 *     imports: [
 *       MongoShieldModule.forRootAsync({
 *         inject: [ConfigService],
 *         useFactory: (config: ConfigService) => ({
 *           source: { uri: config.getOrThrow("MONGODB_URI") },
 *           storage: s3Storage({ bucket: config.getOrThrow("BACKUP_BUCKET") }),
 *           encryption: { recipients: [config.getOrThrow("BACKUP_PUBLIC_KEY")] },
 *         }),
 *       }),
 *     ],
 *   })
 *   export class AppModule {}
 *
 * Inject it anywhere with `@InjectMongoShield() private readonly shield: MongoShield`.
 * The storage client is closed when the application shuts down.
 */

import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { MongoShield, type MongoShieldOptions } from "mongoshield";

/** Injection token for the shared MongoShield instance. */
export const MONGOSHIELD = Symbol("MONGOSHIELD");

/** Shorthand for `@Inject(MONGOSHIELD)`. */
export const InjectMongoShield = (): ParameterDecorator => Inject(MONGOSHIELD);

/** Options for `forRootAsync`: build MongoShield's options from other providers. */
export interface MongoShieldModuleAsyncOptions {
  /** Providers passed to `useFactory`, e.g. `[ConfigService]`. */
  readonly inject?: readonly (string | symbol | (abstract new (...args: never[]) => unknown))[];
  /** Modules that export the injected providers. */
  readonly imports?: DynamicModule["imports"];
  readonly useFactory: (...args: never[]) => MongoShieldOptions | Promise<MongoShieldOptions>;
}

/** Closes MongoShield's storage client on shutdown (enable `app.enableShutdownHooks()`). */
@Injectable()
class MongoShieldLifecycle implements OnApplicationShutdown {
  constructor(@InjectMongoShield() private readonly shield: MongoShield) {}

  async onApplicationShutdown(): Promise<void> {
    await this.shield.close();
  }
}

// @Global: one instance for the whole app, so feature modules need not import it again.
@Global()
@Module({})
export class MongoShieldModule {
  /** Static options. */
  static forRoot(options: MongoShieldOptions): DynamicModule {
    return {
      module: MongoShieldModule,
      providers: [
        { provide: MONGOSHIELD, useValue: new MongoShield(options) },
        MongoShieldLifecycle,
      ],
      exports: [MONGOSHIELD],
    };
  }

  /** Options built from other providers (ConfigService, your MongoClient...). */
  static forRootAsync(options: MongoShieldModuleAsyncOptions): DynamicModule {
    return {
      module: MongoShieldModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: MONGOSHIELD,
          inject: [...(options.inject ?? [])],
          useFactory: async (...args: never[]) =>
            new MongoShield(await options.useFactory(...args)),
        },
        MongoShieldLifecycle,
      ],
      exports: [MONGOSHIELD],
    };
  }
}
