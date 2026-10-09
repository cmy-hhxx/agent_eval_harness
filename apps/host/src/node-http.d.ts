import "node:http";

// Node 24.14's API is newer than the workspace's @types/node 24.10 declarations.
declare module "node:http" {
  export function setGlobalProxyFromEnv(env?: NodeJS.ProcessEnv): () => void;
}
