import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const stateDir = resolve(".daily-state");
const markerPath = resolve(stateDir, "last-sent.json");
const metaPath = resolve("public", "meta.json");

function beijingDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

async function readMeta() {
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    return {};
  }
}

const meta = await readMeta();
const marker = {
  date: beijingDate(),
  sentAt: new Date().toISOString(),
  eventName: process.env.GITHUB_EVENT_NAME || null,
  runId: process.env.GITHUB_RUN_ID || null,
  sha: process.env.GITHUB_SHA || null,
  imageGeneratedBy: meta.imageGeneratedBy || null,
  generatedAt: meta.generatedAt || null
};

await mkdir(stateDir, { recursive: true });
await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
console.log(`Marked AI HOT daily sent for ${marker.date}.`);
