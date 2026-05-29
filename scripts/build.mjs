import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { chromium } from "playwright";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(rootDir, "public");
const assetsDir = resolve(publicDir, "assets");
const dataDir = resolve(publicDir, "data");

const AIHOT_BASE_URL = "https://aihot.virxact.com";
const HOURS = Number(process.env.SINCE_HOURS || 24);
const TAKE = Number(process.env.AIHOT_TAKE || 80);
const excludedCategories = new Set(["industry", "paper", "research"]);

function cleanEnv(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

function normalizeImageApiUrl(value) {
  if (!value) return "";
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    url.pathname = "/v1/images/generations";
  } else if (path === "/v1") {
    url.pathname = "/v1/images/generations";
  } else if (path === "/v1/images") {
    url.pathname = "/v1/images/generations";
  }
  return url.toString();
}

const categoryLabels = {
  "ai-models": "模型",
  "ai-products": "产品",
  industry: "行业",
  research: "研究",
  paper: "论文",
  tip: "技巧",
  tools: "工具"
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function trimText(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatDateTime(value, timeZone = "Asia/Shanghai") {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function formatDate(value, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

async function ensureDirs() {
  await mkdir(assetsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "aihot-daily-site/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return response.json();
}

async function fetchAihotData() {
  const now = new Date();
  const since = new Date(now.getTime() - HOURS * 60 * 60 * 1000);
  const itemsUrl = new URL("/api/public/items", AIHOT_BASE_URL);
  itemsUrl.searchParams.set("mode", process.env.AIHOT_MODE || "selected");
  itemsUrl.searchParams.set("since", since.toISOString());
  itemsUrl.searchParams.set("take", String(TAKE));

  const [itemsResponse, daily] = await Promise.all([
    fetchJson(itemsUrl),
    fetchJson(new URL("/api/public/daily", AIHOT_BASE_URL))
  ]);

  const allItems = itemsResponse.items || [];
  const items = allItems
    .filter((item) => !excludedCategories.has(item.category || "other"))
    .map((item) => ({
      id: item.id,
      title: item.title || item.title_en || "未命名动态",
      titleEn: item.title_en || "",
      url: item.url,
      source: item.source,
      publishedAt: item.publishedAt,
      summary: item.summary || "",
      category: item.category || "other",
      categoryLabel: categoryLabels[item.category] || "其他"
    }));

  return {
    meta: {
      generatedAt: now.toISOString(),
      windowStart: since.toISOString(),
      windowEnd: now.toISOString(),
      hours: HOURS,
      itemCount: items.length,
      rawItemCount: allItems.length,
      excludedCategories: [...excludedCategories],
      source: AIHOT_BASE_URL
    },
    items,
    daily
  };
}

function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.categoryLabel || "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([label, groupItems]) => ({ label, items: groupItems }));
}

function makeImagePrompt(data) {
  const topItems = data.items.slice(0, 8);
  const lines = topItems
    .map((item, index) => `${index + 1}. ${item.title} - ${trimText(item.summary, 70)}`)
    .join("\n");

  return [
    "请生成一张竖版中文 AI 行业日报信息图。",
    "画面比例 3:4，尺寸适合 1080x1440。",
    "风格：高端科技媒体、清爽、现代、信息密度高但不拥挤，适合飞书群早报。",
    "要求：中文标题必须清晰可读，层级明确，使用深色背景与亮色重点，不要添加虚构公司或虚构数据。",
    `主标题：AI HOT 24 小时热点日报`,
    `日期：${formatDate(data.meta.generatedAt)}`,
    "内容按重要程度展示，保留简短中文摘要。",
    "热点内容：",
    lines
  ].join("\n");
}

function extractImageFromResponse(payload) {
  const first = payload?.data?.[0] || payload?.result?.[0] || payload;
  return {
    base64:
      first?.b64_json ||
      first?.base64 ||
      first?.image_base64 ||
      payload?.b64_json ||
      payload?.image_base64,
    url: first?.url || first?.image_url || payload?.url || payload?.image_url
  };
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Image download failed ${response.status}: ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function generateWithImg2(prompt, destination) {
  const apiKey = cleanEnv(process.env.IMG2_API_KEY || process.env.OPENAI_API_KEY);
  if (!apiKey) return false;

  const apiUrl =
    normalizeImageApiUrl(cleanEnv(process.env.IMG2_API_URL)) ||
    cleanEnv(process.env.OPENAI_IMAGE_API_URL) ||
    "https://api.openai.com/v1/images/generations";
  const model = cleanEnv(process.env.IMG2_MODEL) || "gpt-image-2";
  const size = cleanEnv(process.env.IMG2_SIZE) || "1080x1440";

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      n: 1
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`img2 request failed ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = JSON.parse(text);
  const image = extractImageFromResponse(payload);
  if (image.base64) {
    await writeFile(destination, Buffer.from(image.base64, "base64"));
    return true;
  }
  if (image.url) {
    await downloadFile(image.url, destination);
    return true;
  }

  throw new Error("img2 response did not include a supported image field");
}

function renderDailyCardHtml(data) {
  const topItems = data.items.slice(0, 4);
  const chips = groupByCategory(data.items)
    .slice(0, 6)
    .map((group) => `<span>${escapeHtml(group.label)} ${group.items.length}</span>`)
    .join("");

  const list = topItems
    .map(
      (item, index) => `
        <article class="item">
          <div class="rank">${String(index + 1).padStart(2, "0")}</div>
          <div>
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-summary">${escapeHtml(trimText(item.summary || item.titleEn, 96))}</div>
            <div class="item-meta">${escapeHtml(item.categoryLabel)} · ${escapeHtml(item.source || "")}</div>
          </div>
        </article>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 1080px;
      height: 1440px;
      font-family: Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      background: #07101d;
      color: #f7fafc;
    }
    .poster {
      width: 1080px;
      height: 1440px;
      padding: 76px 72px 64px;
      background:
        radial-gradient(circle at 18% 10%, rgba(62, 201, 164, .24), transparent 34%),
        radial-gradient(circle at 82% 16%, rgba(100, 137, 255, .22), transparent 30%),
        linear-gradient(145deg, #07101d 0%, #101c2d 52%, #06131a 100%);
    }
    .eyebrow { color: #7dd3fc; font-size: 28px; font-weight: 800; letter-spacing: 0; }
    h1 { margin: 22px 0 0; font-size: 76px; line-height: 1.02; letter-spacing: 0; }
    .sub { margin-top: 22px; color: #cbd5e1; font-size: 30px; line-height: 1.45; }
    .chips { display: flex; flex-wrap: wrap; gap: 14px; margin: 38px 0 46px; }
    .chips span {
      padding: 12px 18px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 999px;
      background: rgba(255,255,255,.08);
      color: #e2e8f0;
      font-size: 24px;
      font-weight: 700;
    }
    .item {
      display: grid;
      grid-template-columns: 76px 1fr;
      gap: 20px;
      padding: 30px 0;
      border-top: 1px solid rgba(255,255,255,.12);
    }
    .rank {
      width: 58px;
      height: 58px;
      display: grid;
      place-items: center;
      border-radius: 18px;
      background: #e6ff6f;
      color: #111827;
      font-size: 24px;
      font-weight: 900;
    }
    .item-title { font-size: 31px; line-height: 1.24; font-weight: 850; }
    .item-summary { margin-top: 10px; color: #cbd5e1; font-size: 24px; line-height: 1.5; }
    .item-meta { margin-top: 12px; color: #7dd3fc; font-size: 20px; font-weight: 700; }
    .footer {
      position: absolute;
      left: 72px;
      right: 72px;
      bottom: 56px;
      display: flex;
      justify-content: space-between;
      color: #94a3b8;
      font-size: 22px;
    }
  </style>
</head>
<body>
  <main class="poster">
    <div class="eyebrow">AI HOT DAILY</div>
    <h1>24 小时<br>AI 热点日报</h1>
    <div class="sub">${escapeHtml(formatDate(data.meta.generatedAt))} · 共 ${data.items.length} 条精选动态</div>
    <div class="chips">${chips}</div>
    <section>${list}</section>
    <div class="footer">
      <span>Generated by AI HOT</span>
      <span>aihot.virxact.com</span>
    </div>
  </main>
</body>
</html>`;
}

async function generateFallbackImage(data, destination) {
  const cardPath = resolve(publicDir, "daily-card.html");
  await writeFile(cardPath, renderDailyCardHtml(data), "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1 });
    await page.goto(`file://${cardPath.replaceAll("\\", "/")}`);
    await page.screenshot({ path: destination, fullPage: false });
  } finally {
    await browser.close();
  }
}

function renderSite(data) {
  const generated = formatDateTime(data.meta.generatedAt);
  const groups = groupByCategory(data.items);
  const topItems = data.items.slice(0, 12);

  const statCards = [
    ["24h 精选", `${data.items.length} 条`],
    ["日报日期", data.daily?.date || "今日"],
    ["分类数", `${groups.length} 个`],
    ["生成时间", generated]
  ]
    .map(([label, value]) => `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  const topList = topItems
    .map(
      (item, index) => `<a class="news" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
        <span class="num">${index + 1}</span>
        <span>
          <strong>${escapeHtml(item.title)}</strong>
          <em>${escapeHtml(trimText(item.summary || item.titleEn, 150))}</em>
          <small>${escapeHtml(item.categoryLabel)} · ${escapeHtml(item.source || "")} · ${escapeHtml(formatDateTime(item.publishedAt))}</small>
        </span>
      </a>`
    )
    .join("");

  const categorySections = groups
    .map(
      (group) => `<section class="band">
        <div class="section-head">
          <h2>${escapeHtml(group.label)}</h2>
          <span>${group.items.length} 条</span>
        </div>
        <div class="compact-list">
          ${group.items
            .slice(0, 8)
            .map(
              (item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
                <strong>${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(formatDateTime(item.publishedAt))}</small>
              </a>`
            )
            .join("")}
        </div>
      </section>`
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI HOT 24 小时热点日报</title>
  <meta name="description" content="自动汇总最近 24 小时 AI 热点，并生成日报图片。">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="./">AI HOT Daily</a>
    <nav>
      <a href="data/latest.json">JSON</a>
      <a href="assets/daily.png">日报图</a>
      <a href="https://aihot.virxact.com/agent" target="_blank" rel="noopener noreferrer">API</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">过去 ${HOURS} 小时</p>
        <h1>AI 圈今天值得看的变化</h1>
        <p class="lead">每天自动抓取 AI HOT 精选动态，沉淀成网页、数据文件和一张适合飞书早报的日报图片。</p>
        <div class="stats">${statCards}</div>
      </div>
      <a class="poster-link" href="assets/daily.png">
        <img src="assets/daily.png" alt="AI HOT 24 小时日报图片">
      </a>
    </section>

    <section class="band">
      <div class="section-head">
        <h2>重点速览</h2>
        <span>${escapeHtml(generated)}</span>
      </div>
      <div class="news-list">${topList}</div>
    </section>

    ${categorySections}
  </main>
  <footer>
    数据来自 <a href="https://aihot.virxact.com/" target="_blank" rel="noopener noreferrer">AI HOT</a>。摘要由上游生成，重要引用请回原文核对。
  </footer>
</body>
</html>`;
}

function renderCss() {
  return `:root {
  color-scheme: dark;
  --bg: #07101d;
  --panel: #101b2b;
  --line: rgba(255,255,255,.12);
  --text: #f8fafc;
  --muted: #9ca3af;
  --cyan: #67e8f9;
  --lime: #e6ff6f;
  --pink: #f0abfc;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
}
a { color: inherit; text-decoration: none; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px clamp(18px, 4vw, 48px);
  background: rgba(7, 16, 29, .82);
  backdrop-filter: blur(18px);
  border-bottom: 1px solid var(--line);
}
.brand { font-weight: 900; letter-spacing: 0; }
nav { display: flex; gap: 18px; color: var(--muted); font-size: 14px; }
main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
  gap: 48px;
  align-items: center;
  min-height: calc(100vh - 70px);
  padding: 56px 0;
}
.eyebrow { color: var(--cyan); font-weight: 850; margin: 0 0 14px; }
h1 { margin: 0; font-size: clamp(42px, 7vw, 86px); line-height: 1; letter-spacing: 0; }
.lead { color: #cbd5e1; font-size: 19px; line-height: 1.8; max-width: 680px; }
.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 34px;
}
.stat {
  min-height: 96px;
  padding: 18px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,.05);
  border-radius: 8px;
}
.stat span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.stat strong { font-size: 24px; line-height: 1.2; }
.poster-link img {
  display: block;
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--line);
  box-shadow: 0 30px 80px rgba(0,0,0,.35);
}
.band {
  padding: 34px 0 42px;
  border-top: 1px solid var(--line);
}
.section-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: end;
  margin-bottom: 18px;
}
h2 { margin: 0; font-size: 28px; letter-spacing: 0; }
.section-head span { color: var(--muted); font-size: 14px; }
.news-list { display: grid; gap: 10px; }
.news {
  display: grid;
  grid-template-columns: 44px 1fr;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255,255,255,.045);
}
.num {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--lime);
  color: #111827;
  font-weight: 900;
}
.news strong, .compact-list strong { display: block; line-height: 1.45; }
.news em {
  display: block;
  margin-top: 8px;
  color: #cbd5e1;
  font-style: normal;
  line-height: 1.6;
}
.news small, .compact-list small {
  display: block;
  margin-top: 8px;
  color: var(--cyan);
}
.compact-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.compact-list a {
  min-height: 112px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255,255,255,.04);
}
footer {
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
  padding: 36px 0 60px;
  color: var(--muted);
  border-top: 1px solid var(--line);
}
footer a { color: var(--cyan); }

@media (max-width: 860px) {
  .hero { grid-template-columns: 1fr; min-height: auto; }
  .stats, .compact-list { grid-template-columns: 1fr 1fr; }
}

@media (max-width: 560px) {
  nav { gap: 12px; font-size: 13px; }
  .stats, .compact-list { grid-template-columns: 1fr; }
  .news { grid-template-columns: 1fr; }
}`;
}

async function main() {
  await ensureDirs();
  const data = await fetchAihotData();
  const prompt = makeImagePrompt(data);
  const imagePath = resolve(assetsDir, "daily.png");

  await writeFile(resolve(dataDir, "latest.json"), JSON.stringify(data, null, 2), "utf8");
  await writeFile(resolve(dataDir, "daily-prompt.txt"), prompt, "utf8");

  let imageGeneratedBy = "fallback";
  let fallbackGenerated = false;
  try {
    const ok = await generateWithImg2(prompt, imagePath);
    if (ok) imageGeneratedBy = "img2";
  } catch (error) {
    console.warn(`img2 failed, using HTML screenshot fallback: ${error.message}`);
    await generateFallbackImage(data, imagePath);
    fallbackGenerated = true;
  }

  if (imageGeneratedBy === "fallback" && !fallbackGenerated) {
    await generateFallbackImage(data, imagePath);
  }

  await writeFile(resolve(publicDir, "index.html"), renderSite(data), "utf8");
  await writeFile(resolve(publicDir, "styles.css"), renderCss(), "utf8");
  await writeFile(
    resolve(publicDir, "meta.json"),
    JSON.stringify({ generatedAt: data.meta.generatedAt, imageGeneratedBy }, null, 2),
    "utf8"
  );

  console.log(`Built ${data.items.length} items. Image: ${imageGeneratedBy}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
