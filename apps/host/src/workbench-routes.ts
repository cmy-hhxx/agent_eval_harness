export interface WorkbenchProxyPorts { data: number; automation: number; runs: number }
export interface WorkbenchProxyTarget { port: number; path: string }

/** Map the two public regions to the three loopback services without exposing old top-level routes. */
export function workbenchProxyTarget(pathname: string, ports: WorkbenchProxyPorts): WorkbenchProxyTarget | undefined {
  if (pathname === "/data" || pathname.startsWith("/data/")) return { port: ports.data, path: pathname };
  if (pathname.startsWith("/runtime/automation-assets/"))
    return { port: ports.automation, path: "/" + pathname.slice("/runtime/automation-assets/".length) };
  if (pathname === "/runtime/" || pathname === "/runtime/errors")
    return { port: ports.automation, path: pathname.slice("/runtime".length) || "/" };
  if (pathname.startsWith("/runtime/api/dashboard"))
    return { port: ports.runs, path: "/api/dashboard" + pathname.slice("/runtime/api/dashboard".length) };
  if (pathname.startsWith("/runtime/run-assets/"))
    return { port: ports.runs, path: "/" + pathname.slice("/runtime/run-assets/".length) };
  if (pathname === "/runtime/runs" || pathname === "/runtime/runs/") return { port: ports.runs, path: "/" };
  if (pathname === "/runtime/problems") return { port: ports.runs, path: "/problems" };
  if (pathname === "/runtime/reference") return { port: ports.runs, path: "/reference" };
  if (pathname.startsWith("/runtime/api/")) return { port: ports.automation, path: pathname.slice("/runtime".length) };
  return undefined;
}
