/**
 * The MongoDB layer: connecting, describing the deployment, discovering namespaces with
 * their full creation specs, and checking privileges. Engines import from here.
 */

export {
  type MongoConnection,
  type OpenConnectionOptions,
  openConnection,
  toConnectionError,
} from "./connection.ts";
export {
  type DeploymentInfo,
  describeDeployment,
  type Topology,
  topologyFromHello,
} from "./deployment.ts";
export {
  type CollectionSpec,
  type CollectionType,
  compileNamespaceFilter,
  type DiscoverNamespacesOptions,
  discoverNamespaces,
  type NamespaceFilter,
  type NamespaceFilterOptions,
  orderForRestore,
  splitNamespace,
} from "./namespaces.ts";
export {
  assertPrivileges,
  checkPrivileges,
  type PrivilegeCheckOptions,
  type PrivilegeCheckResult,
  type PrivilegedOperation,
} from "./privileges.ts";
