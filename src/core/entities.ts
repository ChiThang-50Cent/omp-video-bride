// Domain entities (plain data) and small pure helpers.

export interface Project {
  id: string;
  name: string;
  pipeline: string;
  /** Pipeline-specific look shared by every scene (style, format, voice, ...). */
  spec: Record<string, unknown>;
  brief: string;
  brand: { logoAsset?: string; colors?: string[]; fonts?: string[] };
  timeline: { order: string[]; transitions: Record<string, "cut" | "fade">; bgm?: { asset: string; volume: number } };
  final: FinalOutput | null;
  createdAt: string;
}

export interface FinalOutput {
  state: "running" | "done" | "failed";
  jobId: string;
  video?: string;
  captions?: string;
  durationSec?: number;
  scenes: string[];
  /** Scene versions that went into this file, to detect staleness. */
  versions: Record<string, string>;
  error?: string;
  at: string;
}

export interface Scene {
  id: string;
  projectId: string;
  n: number;
  title: string;
  topic: string;
  brief: string;
  durationSec: number;
  assetRefs: string[];
  findAssets: boolean;
  currentVersionId: string | null;
  createdAt: string;
}

export interface VersionOutputs {
  video: string | null;
  contactSheets: string[];
  captionsGroups: string | null;
}

export interface Version {
  id: string;
  sceneId: string;
  number: number;
  parentVersionId: string | null;
  jobId: string;
  /** omp cwd for this version. */
  workdir: string;
  /** Pipeline project directory (inside workdir), known once the job reports it. */
  projectDir: string | null;
  state: "pending" | "ready" | "failed";
  outputs: VersionOutputs;
  durationSec: number | null;
  notes: string | null;
  createdAt: string;
}

export interface Asset {
  id: string;
  projectId: string;
  name: string;
  kind: "image" | "video" | "audio" | "font" | "other";
  bytes: number;
  sha256: string;
  origin: "upload" | "ai-found";
  source: string | null;
  license: string | null;
  tags: string[];
  path: string;
  createdAt: string;
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return out || "untitled";
}

export function assetKind(name: string): Asset["kind"] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return "audio";
  if (["woff", "woff2", "ttf", "otf"].includes(ext)) return "font";
  return "other";
}
