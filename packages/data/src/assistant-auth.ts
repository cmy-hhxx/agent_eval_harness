import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { readJson, runLock } from "./files.js";

export interface AssistantAccount { id: string; username: string; role: "admin" | "member"; disabled: boolean }
interface Account extends AssistantAccount { password: string }
interface Login { id: string; userId: string; expiresAt: number }
interface Accounts { users: Account[]; logins: Login[]; internalKey: string }
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value));
});
export const ASSISTANT_LOGIN_MS = 7 * 24 * 60 * 60_000;
const publicAccount = ({ password: _password, ...account }: Account): AssistantAccount => account;
function username(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error("用户名须为 1–64 位字母、数字、下划线或短横线");
  return value;
}
async function passwordHash(password: string) {
  if (typeof password !== "string" || password.length < 6 || password.length > 256) throw new Error("密码长度须为 6–256 位");
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
async function matches(password: string, encoded: string) {
  const [, salt, expected] = encoded.split("$");
  if (typeof password !== "string" || password.length > 256 || !salt || !expected) return false;
  const actual = await derive(password, salt);
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

/** Passwords and opaque login identities live outside the checkout, under one writer lock. */
export class AssistantAccounts {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private now = Date.now) {}
  private get file() { return path.join(this.directory, "accounts.json"); }
  private async load() {
    if ((await stat(this.file)).mode & 0o077) throw new Error("Eris accounts file must have mode 600");
    const value = await readJson<Accounts>(this.file);
    if (!Array.isArray(value.users) || !Array.isArray(value.logins) || typeof value.internalKey !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(value.internalKey) ||
        new Set(value.users.map(user => user.id)).size !== value.users.length ||
        new Set(value.users.map(user => user.username)).size !== value.users.length ||
        value.logins.some(login => typeof login.id !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(login.id) || !Number.isSafeInteger(login.expiresAt) || !value.users.some(user => user.id === login.userId)) ||
        value.users.some(user => typeof user.id !== "string" || !/^[a-f0-9-]{36}$/.test(user.id) || typeof user.username !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(user.username) || !["admin", "member"].includes(user.role) || typeof user.disabled !== "boolean" || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(user.password)))
      throw new Error("Invalid Eris account store");
    return value;
  }
  private async save(value: Accounts) {
    const temporary = path.join(this.directory, `.accounts-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  private change<T>(operation: (value: Accounts) => Promise<T> | T): Promise<T> {
    const task = this.pending.then(async () => {
      const release = await runLock(this.directory);
      try {
        const value = await this.load();
        value.logins = value.logins.filter(login => login.expiresAt > this.now());
        const result = await operation(value);
        await this.save(value);
        return result;
      } finally { await release(); }
    });
    this.pending = task.catch(() => {});
    return task;
  }
  async initialize(admin: string, password?: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const release = await runLock(this.directory);
    try {
      try { await this.load(); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!password) throw new Error("ERIS_ADMIN_PASSWORD is required for first initialization");
      await this.save({ users: [{ id: randomUUID(), username: username(admin), role: "admin", disabled: false, password: await passwordHash(password) }], logins: [], internalKey: randomBytes(32).toString("base64url") });
    } finally { await release(); }
  }
  async list() { return (await this.load()).users.map(publicAccount); }
  async internalKey() { return (await this.load()).internalKey; }
  async account(id: string) { const user = (await this.load()).users.find(user => user.id === id && !user.disabled); return user && publicAccount(user); }
  async authenticate(id: string | undefined) {
    if (!id) return;
    const value = await this.load(), login = value.logins.find(login => login.id === id && login.expiresAt > this.now());
    const user = login && value.users.find(user => user.id === login.userId && !user.disabled);
    return user && login ? { user: publicAccount(user), loginId: login.id, expiresAt: login.expiresAt } : undefined;
  }
  async login(name: string, password: string) {
    const current = (await this.load()).users.find(user => user.username === name);
    // Equal-cost verification also applies to an unknown or disabled account.
    const encoded = current?.password ?? `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
    if (!await matches(password, encoded) || !current || current.disabled) throw new Error("用户名或密码错误");
    return this.change(value => {
      const user = value.users.find(user => user.id === current.id && user.password === encoded && !user.disabled);
      if (!user) throw new Error("用户名或密码错误");
      const login = { id: randomBytes(32).toString("base64url"), userId: user.id, expiresAt: this.now() + ASSISTANT_LOGIN_MS };
      value.logins.push(login);
      return { user: publicAccount(user), loginId: login.id, expiresAt: login.expiresAt };
    });
  }
  logout(id: string) { return this.change(value => { value.logins = value.logins.filter(login => login.id !== id); }); }
  logoutAll(userId: string) { return this.change(value => { value.logins = value.logins.filter(login => login.userId !== userId); }); }
  async create(name: string, password: string) {
    username(name);
    const hash = await passwordHash(password);
    return this.change(value => {
      if (value.users.some(user => user.username === name)) throw new Error("用户名已存在");
      const user: Account = { id: randomUUID(), username: name, role: "member", disabled: false, password: hash };
      value.users.push(user); return publicAccount(user);
    });
  }
  update(id: string, disabled: boolean) {
    return this.change(value => {
      const user = value.users.find(user => user.id === id);
      if (!user) throw new Error("用户不存在");
      if (disabled && user.role === "admin" && !value.users.some(other => other.id !== id && other.role === "admin" && !other.disabled)) throw new Error("不能停用最后一位管理员");
      user.disabled = disabled;
      if (disabled) value.logins = value.logins.filter(login => login.userId !== id);
      return publicAccount(user);
    });
  }
  async password(id: string, password: string, currentPassword?: string) {
    const user = (await this.load()).users.find(user => user.id === id);
    if (!user || currentPassword !== undefined && !await matches(currentPassword, user.password)) throw new Error("当前密码错误或用户不存在");
    const hash = await passwordHash(password);
    await this.change(value => {
      const current = value.users.find(item => item.id === id);
      if (!current || current.password !== user.password) throw new Error("账户已变更，请重试");
      current.password = hash;
      value.logins = value.logins.filter(login => login.userId !== id);
    });
  }
}
