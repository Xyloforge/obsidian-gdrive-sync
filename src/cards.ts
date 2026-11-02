/** Pure helpers for Home cards (pin order, cover file names). */

export function nextPin(values: readonly unknown[]): number {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function coverFileName(noteName: string, ext: string, now: Date): string {
  const slug = noteName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "note";
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `card-${slug}-${stamp}.${ext.toLowerCase()}`;
}
