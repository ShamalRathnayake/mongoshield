/** Application entry point. */

import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);
// Runs onApplicationShutdown on SIGTERM, so MongoShield's storage client is closed.
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? 3000);
