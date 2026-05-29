import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const markerPath = resolve(".daily-state", "last-sent.json");

function beijingDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
}

async function readMarker() {
  try {
    return JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return null;
  }
}

const eventName = process.env.GITHUB_EVENT_NAME || "";
const today = beijingDate();
const marker = await readMarker();
const alreadySent = marker?.date === today;
const skip = eventName === "schedule" && alreadySent;

await setOutput("skip", String(skip));
await setOutput("today", today);

if (skip) {
  console.log(`Skip scheduled run: AI HOT daily was already sent for ${today}.`);
} else {
  console.log(`Proceed with AI HOT daily. Event: ${eventName || "unknown"}, Beijing date: ${today}.`);
}
