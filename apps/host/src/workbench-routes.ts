export interface WorkbenchProxyPorts { data: number; automation: number; runs: number }
export interface WorkbenchProxyTarget { port: number; path: string }

/** The workbench exposes one page; these routes only transport data and assets. */
export function workbenchProxyTarget(pathname: string, ports: WorkbenchProxyPorts): WorkbenchProxyTarget | undefined {
  if (/^\/data\/workbench\/(catalog|tasks|assign|clean|batches\/[a-f0-9-]+\/(report|sample))$/.test(pathname))
    return { port: ports.data, path: pathname };
  if (/^\/data\/workbench\/tasks\/[a-f0-9-]+\/clean(?:\/(?:stop|cancel))?$/.test(pathname))
    return { port: ports.data, path: pathname };
  if (/^\/data\/[^/]+\/(dashboard-data|processing-status|records\/[^/]+\/[^/]+)$/.test(pathname))
    return { port: ports.data, path: pathname };
  if (pathname.startsWith("/runtime/api/dashboard"))
    return { port: ports.runs, path: "/api/dashboard" + pathname.slice("/runtime/api/dashboard".length) };
  if (pathname.startsWith("/runtime/api/")) return { port: ports.automation, path: pathname.slice("/runtime".length) };
  return undefined;
}
