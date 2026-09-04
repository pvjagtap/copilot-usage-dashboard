/**
 * ttlSound.ts — OS-native alert playback for the prompt-cache TTL tracker.
 *
 * Derived from the MIT-licensed `cache-timer` extension (© 2026 sukumarp2022),
 * with the Windows command hardened: the sound path is handed to PowerShell
 * through an environment variable instead of being interpolated into the
 * `-Command` string, so a crafted `copilotUsage.cacheTtl.soundPath` cannot
 * break out into arbitrary PowerShell. Paths are additionally validated by
 * {@link resolveSoundPath} before ever reaching a player.
 *
 * No `vscode` import — the extension host passes the bundled fallback path in.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Extensions the bundled players can actually decode. */
const ALLOWED_EXTS = new Set([".wav", ".mp3", ".ogg", ".aiff", ".aif", ".m4a"]);

/**
 * Validate a user-configured sound path, falling back to the bundled asset.
 * Rejects relative paths, missing files, directories, and unknown extensions.
 * Returns `""` when neither the override nor the fallback is usable.
 */
export function resolveSoundPath(userPath: string, bundledPath: string): string {
  const candidate = (userPath ?? "").trim();
  if (candidate && isUsableSound(candidate)) {
    return candidate;
  }
  return isUsableSound(bundledPath) ? bundledPath : "";
}

function isUsableSound(p: string): boolean {
  if (!p || !path.isAbsolute(p)) {
    return false;
  }
  if (!ALLOWED_EXTS.has(path.extname(p).toLowerCase())) {
    return false;
  }
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface PlayerCommand {
  cmd: string;
  args: string[];
  /** Extra environment entries the command needs (Windows path handoff). */
  env?: Record<string, string>;
}

/** Env var the PowerShell branch reads the path from. Never interpolated. */
export const WIN_SOUND_ENV = "COPILOT_USAGE_TTL_SOUND";

export function buildPlayerCommand(
  platform: NodeJS.Platform,
  soundPath: string
): PlayerCommand | undefined {
  switch (platform) {
    case "darwin":
      return { cmd: "afplay", args: [soundPath] };
    case "win32":
      return {
        cmd: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(New-Object Media.SoundPlayer $env:${WIN_SOUND_ENV}).PlaySync();`,
        ],
        env: { [WIN_SOUND_ENV]: soundPath },
      };
    case "linux":
      return { cmd: "paplay", args: [soundPath] };
    default:
      return undefined;
  }
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Play one sound to completion. Best-effort: resolves (never rejects) on any
 * failure, and falls back to `aplay` on Linux when `paplay` is absent.
 */
export function playOnce(soundPath: string, platform: NodeJS.Platform): Promise<void> {
  const pc = buildPlayerCommand(platform, soundPath);
  if (!pc) {
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    const done = once(resolve);
    try {
      const child = spawn(pc.cmd, pc.args, {
        stdio: "ignore",
        env: pc.env ? { ...process.env, ...pc.env } : process.env,
      });
      child.on("close", done);
      child.on("error", () => {
        if (platform === "linux") {
          try {
            const fallback = spawn("aplay", [soundPath], { stdio: "ignore" });
            fallback.on("close", done);
            fallback.on("error", () => done());
            return;
          } catch {
            /* give up quietly */
          }
        }
        done();
      });
    } catch {
      done();
    }
  });
}

/** Gap between consecutive alerts so each is audibly distinct. */
const ALERT_GAP_MS = 150;

export type SinglePlayer = (soundPath: string, platform: NodeJS.Platform) => Promise<void>;

export interface AlertQueue {
  enqueue(soundPath: string, platform: NodeJS.Platform, count?: number): void;
  /** Resolves once every queued alert has finished. Used by tests. */
  drain(): Promise<void>;
}

/**
 * Serialize playback so several sessions turning red on the same tick are
 * heard one after another instead of overlapping into one muddy sound.
 */
export function createAlertQueue(
  play: SinglePlayer = playOnce,
  gapMs: number = ALERT_GAP_MS
): AlertQueue {
  let chain: Promise<void> = Promise.resolve();
  return {
    enqueue(soundPath: string, platform: NodeJS.Platform, count = 1): void {
      if (!soundPath) {
        return;
      }
      const times = Math.min(10, Math.max(1, Math.floor(count)));
      for (let i = 0; i < times; i++) {
        chain = chain
          .then(() => play(soundPath, platform))
          .then(() => (gapMs > 0 ? delay(gapMs) : undefined))
          .catch(() => {
            /* one failed alert must never break the queue */
          });
      }
    },
    drain(): Promise<void> {
      return chain;
    },
  };
}
