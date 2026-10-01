import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { transcodeMedia, TranscodeError, TRANSCODE_PROFILE } from "./transcode-media";

const sourceFilePath = path.resolve("test-media/relaystream-demo.mp4");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";

// These tests deliberately run actual tools; missing binaries fail rather than skip.
async function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Test tool failed (${code}): ${stderr}`));
    });
  });
}

async function digest(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function temporaryDirectory(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relaystream-media-test-"));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("real transcode produces decodable 640x360 H.264/AAC and hashes the completed bytes", async (t) => {
  // Spaces and shell metacharacters remain ordinary path characters with shell:false.
  const directory = await temporaryDirectory(t);
  const inputPath = path.join(directory, "source & sample.mp4");
  await fs.copyFile(sourceFilePath, inputPath);
  const sourceHash = await digest(inputPath);
  const result = await transcodeMedia({
    sourceFilePath: inputPath,
    expectedSourceContentHash: sourceHash,
    outputDirectory: path.join(directory, "output & media"),
  });
  assert.equal(result.outputContentHash, await digest(result.outputFilePath));
  assert.notEqual(result.outputContentHash, sourceHash);
  assert.equal(result.outputSizeBytes, (await fs.stat(result.outputFilePath)).size);
  assert.equal(result.sourceContentHash, sourceHash);
  assert.equal(await digest(inputPath), sourceHash);
  assert.equal(result.processing.width, 640);
  assert.equal(result.processing.height, 360);
  assert.equal(result.processing.videoCodec, "h264");
  assert.equal(result.processing.audioCodec, "aac");
  assert.equal(result.processing.pixelFormat, "yuv420p");
  assert.ok(Math.abs(result.processing.durationMs - 10_005) < 200);
  assert.deepEqual(result.processing.profile, TRANSCODE_PROFILE);
  assert.match(result.processing.toolVersion, /^ffmpeg version /);
  assert.match(result.processing.probeVersion, /^ffprobe version /);
  assert.ok(Date.parse(result.processing.completedAt) >= Date.parse(result.processing.startedAt));
  assert.deepEqual(await fs.readdir(path.dirname(result.outputFilePath)), ["output.mp4"]);
  const observed = JSON.parse(await run(ffprobe, [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", result.outputFilePath,
  ]));
  assert.equal(observed.streams.find((stream: { codec_type: string }) => stream.codec_type === "video").width, 640);
  assert.equal(observed.streams.find((stream: { codec_type: string }) => stream.codec_type === "audio").codec_name, "aac");
  await run(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-i", result.outputFilePath, "-f", "null", "-"]);
  // faststart places the MP4 movie header before its media data.
  const output = await fs.readFile(result.outputFilePath);
  const boxes: string[] = [];
  for (let offset = 0; offset + 8 <= output.length;) {
    const size = output.readUInt32BE(offset);
    const type = output.toString("ascii", offset + 4, offset + 8);
    boxes.push(type);
    const actualSize = size === 1 ? Number(output.readBigUInt64BE(offset + 8)) : size;
    if (actualSize === 0) break;
    assert.ok(actualSize >= 8 && offset + actualSize <= output.length);
    offset += actualSize;
  }
  assert.ok(boxes.indexOf("moov") >= 0 && boxes.indexOf("moov") < boxes.indexOf("mdat"));
});

test("silent source videos transcode without creating an audio stream", async (t) => {
  const directory = await temporaryDirectory(t);
  const silentPath = path.join(directory, "silent.mp4");
  await run(ffmpeg, ["-nostdin", "-v", "error", "-n", "-i", sourceFilePath, "-map", "0:v:0", "-c:v", "copy", "-an", silentPath]);
  const result = await transcodeMedia({
    sourceFilePath: silentPath,
    expectedSourceContentHash: await digest(silentPath),
    outputDirectory: path.join(directory, "outputs"),
  }, { ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  assert.equal(result.processing.audioCodec, null);
  assert.equal(result.outputContentHash, await digest(result.outputFilePath));
  const observed = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", result.outputFilePath]));
  assert.deepEqual(observed.streams.map((stream: { codec_type: string }) => stream.codec_type), ["video"]);
  await run(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-i", result.outputFilePath, "-f", "null", "-"]);
});

test("a source hash mismatch rejects before attempting either executable", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputDirectory = path.join(directory, "outputs");
  await assert.rejects(transcodeMedia({
    sourceFilePath, expectedSourceContentHash: "0".repeat(64), outputDirectory,
  }, { ffmpegPath: path.join(directory, "missing-ffmpeg.exe"), ffprobePath: path.join(directory, "missing-ffprobe.exe") }),
  (error: unknown) => error instanceof TranscodeError && error.code === "SOURCE_HASH_MISMATCH");
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test("missing FFmpeg fails clearly and removes the source snapshot", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputDirectory = path.join(directory, "outputs");
  await assert.rejects(transcodeMedia({
    sourceFilePath, expectedSourceContentHash: await digest(sourceFilePath), outputDirectory,
  }, { ffmpegPath: path.join(directory, "missing.exe") }),
  (error: unknown) => error instanceof TranscodeError && error.code === "PROCESS_NOT_FOUND");
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test("invalid media fails encoding and leaves no partial output", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalidPath = path.join(directory, "invalid.mp4");
  await fs.writeFile(invalidPath, "These registered bytes are not a video.");
  const outputDirectory = path.join(directory, "outputs");
  await assert.rejects(transcodeMedia({
    sourceFilePath: invalidPath, expectedSourceContentHash: await digest(invalidPath), outputDirectory,
  }), (error: unknown) => error instanceof TranscodeError && error.code === "PROCESS_FAILED");
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test("timeout terminates processing and removes its execution directory", async (t) => {
  const directory = await temporaryDirectory(t);
  const longPath = path.join(directory, "long.mp4");
  // Cheap stream-copy setup; a real 120-second encode cannot finish in 250 ms.
  await run(ffmpeg, ["-nostdin", "-v", "error", "-n", "-stream_loop", "11", "-i", sourceFilePath, "-t", "120", "-map", "0:v:0", "-c:v", "copy", longPath]);
  const outputDirectory = path.join(directory, "outputs");
  await assert.rejects(transcodeMedia({
    sourceFilePath: longPath, expectedSourceContentHash: await digest(longPath), outputDirectory,
  }, { timeoutMs: 250 }), (error: unknown) => error instanceof TranscodeError && error.code === "TIMEOUT");
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});
