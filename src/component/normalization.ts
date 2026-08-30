export type Scalar = null | boolean | number | string;

export function normalizeNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Numbers must be finite");
  return Object.is(value, -0) ? 0 : value;
}

export function normalizeScalar(value: Scalar): Scalar {
  return typeof value === "number" ? normalizeNumber(value) : value;
}

export function normalizeIndexSlots(
  fieldIds: readonly string[],
  values: Readonly<Record<string, Scalar>>,
): [Scalar, Scalar, Scalar] {
  const slots = fieldIds.map((fieldId) =>
    Object.prototype.hasOwnProperty.call(values, fieldId)
      ? normalizeScalar(values[fieldId] ?? null)
      : null,
  );
  return [slots[0] ?? null, slots[1] ?? null, slots[2] ?? null];
}

const typeOrder = (value: Scalar): number => {
  if (value === null) return 0;
  if (typeof value === "number") return 1;
  if (typeof value === "boolean") return 2;
  return 3;
};

export function compareScalar(left: Scalar, right: Scalar): number {
  const leftRank = typeOrder(left);
  const rightRank = typeOrder(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number")
    return left < right ? -1 : 1;
  if (typeof left === "boolean" && typeof right === "boolean")
    return left ? 1 : -1;
  if (typeof left === "string" && typeof right === "string")
    return left < right ? -1 : 1;
  return 0;
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number")
      return JSON.stringify(normalizeNumber(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`)
    .join(",")}}`;
}

export function requestHash(value: unknown): string {
  const input = canonicalStringify(value);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export async function secureRequestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
