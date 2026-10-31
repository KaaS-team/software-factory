// Typed run artifacts. A closed set of kinds; a link is stored only if it is an absolute http(s) URL,
// so javascript:, data: and file: never reach a board or report page.

export const ARTIFACT_KINDS = ["report", "log", "screenshot", "pull-request", "preview"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface TypedArtifact {
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly url: string;
}

export type ArtifactResult =
  | { readonly ok: true; readonly artifact: TypedArtifact }
  | { readonly ok: false; readonly error: string };

// Returns the normalized URL, or undefined when it is not an absolute http or https URL.
export function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.hostname === "") return undefined;
  return u.href;
}

export function parseArtifact(input: unknown): ArtifactResult {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { ok: false, error: "artifact must be an object" };
  const o = input as Record<string, unknown>;
  const kind = ARTIFACT_KINDS.find((k) => k === o.kind);
  if (!kind) return { ok: false, error: `kind must be one of ${ARTIFACT_KINDS.join(", ")}` };
  if (typeof o.title !== "string" || o.title.trim() === "")
    return { ok: false, error: "title must be a non-empty string" };
  const url = safeHttpUrl(o.url);
  if (!url) return { ok: false, error: "url must be an absolute http or https URL" };
  return { ok: true, artifact: { kind, title: o.title.trim(), url } };
}
