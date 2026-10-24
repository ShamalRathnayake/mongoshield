#!/usr/bin/env node
/**
 * Entry point of the operator process (`mongoshield-operator`, the container's
 * command).
 *
 * Reads the settings from the environment, connects with the in-cluster service
 * account (or ~/.kube/config when run on a workstation), starts the operator and
 * handles signals:
 *   - SIGTERM / SIGINT: graceful shutdown, exit 0,
 *   - a second signal: exit immediately (exit 130, as for an interrupted command),
 *   - lost leadership or a startup error: exit 1, so Kubernetes restarts the pod.
 */

import { KubeConfig } from "@kubernetes/client-node";
import { RestKubeClient } from "./kube/rest-client.ts";
import { createLogger } from "./logger.ts";
import { Operator } from "./operator.ts";
import { readSettings } from "./settings.ts";
import { OPERATOR_VERSION } from "./version.ts";

async function main(): Promise<void> {
  const settings = readSettings(process.env);
  const logger = createLogger(settings.logLevel, undefined, { component: "mongoshield-operator" });
  logger.info("starting", { version: OPERATOR_VERSION, identity: settings.identity });

  // loadFromDefault: in a pod, the service account; elsewhere, KUBECONFIG or ~/.kube/config.
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const operator = new Operator({
    client: new RestKubeClient(kubeConfig),
    settings,
    logger,
    serveHttp: true,
    onFatal: (reason) => {
      logger.error("exiting", { reason });
      process.exit(1);
    },
  });

  let signals = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signals += 1;
    if (signals > 1) process.exit(130);
    logger.info("received signal", { signal });
    operator.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("shutdown failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  await operator.start();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `mongoshield-operator: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
