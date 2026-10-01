import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const TRANSCODE_PROFILE = Object.freeze({
  profileId: "h264-aac-mp4-640-v1",
  format: "mp4",
  videoEncoder: "libx264",
  width: 640,
  crf: 28,
  preset: "veryfast",
  pixelFormat: "yuv420p",
  audioEncoder: "aac",
  audioBitrate: "128k",
  faststart: true,
} as const);

export interface TranscodeInput {
  sourceFilePath: string;
  expectedSourceContentHash: string;
  /** Parent directory; the adapter creates its own unique execution directory. */
  outputDirectory: string;
}

export interface TranscodeOptions {
  /** Otherwise FFMPEG_PATH / FFPROBE_PATH, then the executable name on PATH. */
  ffmpegPath?: string;
  ffprobePath?: string;
  /** One deadline for snapshotting, tool checks, encoding, probing and hashing. */
  timeoutMs?: number;
}

export interface TranscodeResult {
  executionId: string;
  outputFilePath: string;
  sourceContentHash: string;
  outputContentHash: string;
  outputSizeBytes: number;
  hashAlgorithm: "sha256";
  processing: {
    tool: "ffmpeg";
    toolVersion: string;
    probeVersion: string;
    profile: typeof TRANSCODE_PROFILE;
    startedAt: string;
    completedAt: string;
    outputFormat: "mp4";
    videoCodec: "h264";
    audioCodec: "aac" | null;
    pixelFormat: "yuv420p";
    width: number;
    height: number;
    durationMs: number;
  };
}

export type TranscodeErrorCode =
  | "INVALID_INPUT"
  | "SOURCE_HASH_MISMATCH"
  | "PROCESS_NOT_FOUND"
  | "PROCESS_FAILED"
  | "PROCESS_OUTPUT_LIMIT"
  | "INVALID_OUTPUT"
  | "TIMEOUT";

export class TranscodeError extends Error {
  constructor(
    public readonly code: TranscodeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TranscodeError";
  }
}

function remainingTime(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new TranscodeError("TIMEOUT", "Media processing exceeded its timeout.");
  }
  return Math.ceil(remaining);
}

/** No shell, bounded captured output, and wait for termination before cleanup. */
function runTool(executable: string, args: string[], deadline: number): Promise<string> {
  const timeoutMs = remainingTime(deadline);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let stderr = Buffer.alloc(0);
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure ??= new TranscodeError("TIMEOUT", "Media processing exceeded its timeout.");
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > 1024 * 1024) {
        failure ??= new TranscodeError("PROCESS_OUTPUT_LIMIT", "Media tool output exceeded 1 MiB.");
        child.kill("SIGKILL");
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-64 * 1024);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure ??= new TranscodeError(
        error.code === "ENOENT" ? "PROCESS_NOT_FOUND" : "PROCESS_FAILED",
        `Cannot run ${executable}: ${error.message}`,
        { cause: error },
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
      } else if (code !== 0) {
        reject(new TranscodeError(
          "PROCESS_FAILED",
          `${executable} failed (${code ?? signal}): ${stderr.toString("utf8").trim()}`,
        ));
      } else {
        resolve(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

async function hashFile(filePath: string, deadline: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    remainingTime(deadline);
    hash.update(chunk as Buffer);
  }
  remainingTime(deadline);
  return hash.digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOutput(probeJson: string) {
  let probe: unknown;
  try {
    probe = JSON.parse(probeJson);
  } catch (cause) {
    throw new TranscodeError("INVALID_OUTPUT", "ffprobe returned invalid JSON.", { cause });
  }
  if (!isObject(probe) || !Array.isArray(probe.streams) || !isObject(probe.format)) {
    throw new TranscodeError("INVALID_OUTPUT", "Output has no valid stream/format metadata.");
  }
  const streams = probe.streams.filter(isObject);
  const video = streams.filter((stream) => stream.codec_type === "video");
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  const stream = video[0];
  const durationMs = Math.round(Number(probe.format.duration) * 1000);
  if (
    streams.length !== probe.streams.length || video.length !== 1 || audio.length > 1 ||
    streams.length !== video.length + audio.length ||
    !stream || stream.codec_name !== "h264" || stream.pix_fmt !== "yuv420p" ||
    stream.width !== TRANSCODE_PROFILE.width ||
    typeof stream.height !== "number" || !Number.isInteger(stream.height) ||
    stream.height <= 0 || stream.height % 2 !== 0 ||
    (audio.length === 1 && audio[0]?.codec_name !== "aac") ||
    typeof probe.format.format_name !== "string" ||
    !probe.format.format_name.split(",").includes("mp4") ||
    !Number.isSafeInteger(durationMs) || durationMs <= 0
  ) {
    throw new TranscodeError("INVALID_OUTPUT", "Output does not match the H.264/AAC MP4 profile.");
  }
  return {
    width: stream.width,
    height: stream.height,
    durationMs,
    audioCodec: audio.length === 1 ? "aac" as const : null,
  };
}

/** Standalone processor: authorization must be checked by its future caller. */
export async function transcodeMedia(
  input: TranscodeInput,
  options: TranscodeOptions = {},
): Promise<TranscodeResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (
    !input.sourceFilePath?.trim() || !input.outputDirectory?.trim() ||
    !/^[a-f0-9]{64}$/i.test(input.expectedSourceContentHash) ||
    !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
  ) {
    throw new TranscodeError("INVALID_INPUT", "Source path, output directory, SHA-256 and positive timeout are required.");
  }
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobe = options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const deadline = performance.now() + timeoutMs;
  const startedAt = new Date().toISOString();
  const sourcePath = path.resolve(input.sourceFilePath);
  const outputRoot = path.resolve(input.outputDirectory);
  if (!(await fs.stat(sourcePath)).isFile()) {
    throw new TranscodeError("INVALID_INPUT", "Source media must be a regular local file.");
  }
  remainingTime(deadline);
  await fs.mkdir(outputRoot, { recursive: true });
  const executionId = randomUUID();
  const executionDirectory = path.join(outputRoot, executionId);
  await fs.mkdir(executionDirectory);
  const snapshotPath = path.join(executionDirectory, "source.mp4");
  const partialPath = path.join(executionDirectory, "output.partial.mp4");
  const outputFilePath = path.join(executionDirectory, "output.mp4");
  try {
    await fs.copyFile(sourcePath, snapshotPath, fs.constants.COPYFILE_EXCL);
    const sourceContentHash = await hashFile(snapshotPath, deadline);
    if (sourceContentHash !== input.expectedSourceContentHash.toLowerCase()) {
      throw new TranscodeError("SOURCE_HASH_MISMATCH", "Source bytes do not match the registered SHA-256.");
    }
    const toolVersion = (await runTool(ffmpeg, ["-version"], deadline)).split(/\r?\n/)[0];
    const probeVersion = (await runTool(ffprobe, ["-version"], deadline)).split(/\r?\n/)[0];
    if (!toolVersion?.startsWith("ffmpeg version ") || !probeVersion?.startsWith("ffprobe version ")) {
      throw new TranscodeError("PROCESS_FAILED", "Configured paths must point to FFmpeg and ffprobe executables.");
    }
    await runTool(ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-n",
      "-protocol_whitelist", "file,pipe", "-i", snapshotPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", `scale=${TRANSCODE_PROFILE.width}:-2`,
      "-c:v", TRANSCODE_PROFILE.videoEncoder,
      "-preset", TRANSCODE_PROFILE.preset, "-crf", String(TRANSCODE_PROFILE.crf),
      "-pix_fmt", TRANSCODE_PROFILE.pixelFormat,
      "-c:a", TRANSCODE_PROFILE.audioEncoder, "-b:a", TRANSCODE_PROFILE.audioBitrate,
      "-movflags", "+faststart", "-f", TRANSCODE_PROFILE.format, partialPath,
    ], deadline);
    const properties = validateOutput(await runTool(ffprobe, [
      "-v", "error", "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name,pix_fmt,width,height",
      "-of", "json", partialPath,
    ], deadline));
    const outputSizeBytes = (await fs.stat(partialPath)).size;
    if (outputSizeBytes <= 0) {
      throw new TranscodeError("INVALID_OUTPUT", "Transcode produced an empty file.");
    }
    await fs.rename(partialPath, outputFilePath);
    const outputContentHash = await hashFile(outputFilePath, deadline);
    await fs.unlink(snapshotPath);
    remainingTime(deadline);
    return {
      executionId, outputFilePath, sourceContentHash, outputContentHash, outputSizeBytes,
      hashAlgorithm: "sha256",
      processing: {
        tool: "ffmpeg", toolVersion, probeVersion, profile: TRANSCODE_PROFILE,
        startedAt, completedAt: new Date().toISOString(),
        outputFormat: "mp4", videoCodec: "h264", pixelFormat: "yuv420p",
        ...properties,
      },
    };
  } catch (error) {
    // Verify the resolved deletion target is a child of this execution's root.
    const relative = path.relative(outputRoot, path.resolve(executionDirectory));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Refusing to clean up outside the media output directory.", { cause: error });
    }
    try {
      await fs.rm(executionDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Media processing failed and its execution directory could not be cleaned up.");
    }
    throw error;
  }
}
