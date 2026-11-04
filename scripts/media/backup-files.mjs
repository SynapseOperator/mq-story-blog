import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const backupError = code => Object.assign(new Error(code), { code });
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only local operator-selected paths; no links, repository ancestors or public
 * tree. This is not protection against a compromised same-privilege OS user. */
export async function privatePath(path, { directory = true, privateMode = true } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) throw backupError("BACKUP_PATH_REJECTED");
  const full = resolve(path), volume = parse(full).root;
  let current = volume;
  for (const part of relative(volume, full).split(sep).filter(Boolean)) {
    current = join(current, part);
    const item = await lstat(current);
    if (item.isSymbolicLink() || (current !== full && !item.isDirectory())) throw backupError("BACKUP_PATH_REJECTED");
  }
  const item = await lstat(full);
  if ((directory ? !item.isDirectory() : !item.isFile()) || resolve(await realpath(full)).toLowerCase() !== full.toLowerCase()) {
    throw backupError("BACKUP_PATH_REJECTED");
  }
  for (let ancestor = directory ? full : dirname(full); ; ancestor = dirname(ancestor)) {
    try { await lstat(join(ancestor, ".git")); throw backupError("BACKUP_PATH_REJECTED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(ancestor) === ancestor) break;
  }
  if (privateMode && process.platform !== "win32" && (item.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw backupError("BACKUP_PERMISSIONS_REJECTED");
  }
  return full;
}

async function windowsAcl(path, create) {
  if (process.platform !== "win32") return;
  // Only newly created backup/restore child directories receive a new DACL.
  // Existing roots and system policy are never modified.
  const script = `$ErrorActionPreference='Stop'; $p=$env:MQ_BACKUP_ACL_PATH;
    $who=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $allowed=@($who.Value,'S-1-5-18','S-1-5-32-544');
    ${create ? `$acl=New-Object System.Security.AccessControl.DirectorySecurity;
    $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($who);
    foreach($sid in $allowed) {
      $identity=New-Object System.Security.Principal.SecurityIdentifier($sid);
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
      $acl.AddAccessRule($rule);
    }; Set-Acl -LiteralPath $p -AclObject $acl;` : ""}
    $actual=Get-Acl -LiteralPath $p;
    foreach($rule in $actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'unsafe'; }
    };
    if($actual.Owner -ne $who.Value -and $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $who.Value) { throw 'owner'; }`;
  await new Promise((accept, reject) => {
    const env = { ...process.env, MQ_BACKUP_ACL_PATH: path };
    // Windows PowerShell must resolve its own modules, not inherit a PowerShell
    // 7 PSModulePath. This changes only this short-lived child environment.
    delete env.PSModulePath;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env, stdio: "ignore", windowsHide: true,
    });
    child.once("error", () => reject(backupError("BACKUP_PERMISSIONS_REJECTED")));
    child.once("exit", code => code === 0 ? accept() : reject(backupError("BACKUP_PERMISSIONS_REJECTED")));
  });
}

export async function createPrivateChild(parent, prefix) {
  await privatePath(parent, { privateMode: false });
  const child = join(parent, `${prefix}${randomUUID()}`);
  await mkdir(child, { mode: 0o700 });
  await windowsAcl(child, true);
  return child;
}

export async function verifyPrivateFile(path, maxBytes, { read = true } = {}) {
  await privatePath(path, { directory: false });
  await windowsAcl(path, false);
  const stat = await lstat(path);
  if (stat.size <= 0 || stat.size > maxBytes) throw backupError("BACKUP_FILE_REJECTED");
  return read ? readFile(path) : stat.size;
}

export async function writePrivate(path, bytes) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

export async function verifyPrivateDirectory(path) {
  await privatePath(path);
  await windowsAcl(path, false);
}
