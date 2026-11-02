/**
 * A vault-relative path we are willing to write. Paths coming from Drive are
 * treated as untrusted: no absolute paths, no "..", no hidden folders
 * (config dir, .trash, .git), no backslashes.
 */
export function isSafePath(path: string, configDir: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (isSnippetPath(path, configDir)) return true;
  if (parts[0] === configDir || parts.some((p) => p.startsWith("."))) return false;
  return true;
}

/** The one exception inside the config folder: CSS snippets, e.g. ".obsidian/snippets/home.css". */
export function snippetDir(configDir: string): string {
  return `${configDir}/snippets`;
}

export function isSnippetPath(path: string, configDir: string): boolean {
  const prefix = `${snippetDir(configDir)}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return name.endsWith(".css") && !name.includes("/") && !name.startsWith(".") && name.length > 4;
}

const pad = (n: number): string => String(n).padStart(2, "0");

function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** "Folder/Note.md" -> "Folder/Note (conflict 2026-11-02 1430).md" */
export function conflictPath(path: string, now: Date): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const [name, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
  return `${dir}${name} (conflict ${stamp(now)})${ext}`;
}
