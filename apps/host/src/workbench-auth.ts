import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export interface WorkbenchSecrets { adminUser: string; passwordHash: string; relayToken: string }
export interface Session { user: string; expiresAt: number }
const SESSION_MS = 8 * 60 * 60_000;

export async function loadWorkbenchSecrets(file: string): Promise<WorkbenchSecrets> {
  const mode = (await stat(file)).mode & 0o777;
  if (mode & 0o077) throw new Error(`Workbench secrets file must not be accessible by group/others: ${file}`);
  const values: Record<string, string> = {};
  for (const [index, raw] of (await readFile(file, "utf8")).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid workbench secrets line ${index + 1}`);
    values[match[1]] = match[2];
  }
  const allowed = ["WORKBENCH_ADMIN_USER", "WORKBENCH_PASSWORD_HASH", "WORKBENCH_RELAY_TOKEN"];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error("Workbench secrets file contains an unknown key");
  for (const key of allowed) if (!values[key]) throw new Error(`Missing ${key} in workbench secrets file`);
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(values.WORKBENCH_PASSWORD_HASH))
    throw new Error("WORKBENCH_PASSWORD_HASH must use scrypt$salt$hash");
  return { adminUser: values.WORKBENCH_ADMIN_USER, passwordHash: values.WORKBENCH_PASSWORD_HASH, relayToken: values.WORKBENCH_RELAY_TOKEN };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, salt, expected] = encoded.split("$");
  if (!salt || !expected) return false;
  const actual = await scrypt(password, Buffer.from(salt, "hex"), 64) as Buffer;
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  create(user: string): string {
    const id = randomBytes(32).toString("base64url"), now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    this.sessions.set(id, { user, expiresAt: now + SESSION_MS });
    return id;
  }
  read(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) { this.sessions.delete(id); return undefined; }
    return session;
  }
  delete(id: string | undefined): void { if (id) this.sessions.delete(id); }
}

export function sessionCookie(id: string, maxAgeSeconds = SESSION_MS / 1000): string {
  return `workbench_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeSeconds)}`;
}
export function clearSessionCookie(): string { return "workbench_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"; }
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const item of (header ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator >= 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}
