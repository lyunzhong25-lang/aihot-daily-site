import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function signFeishu(timestamp, secret) {
  const key = `${timestamp}\n${secret}`;
  return createHmac("sha256", key).update("").digest("base64");
}

function trimText(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

async function loadLatest() {
  const raw = await readFile(resolve(rootDir, "public/data/latest.json"), "utf8");
  return JSON.parse(raw);
}

function makePayload(data, baseUrl) {
  const date = formatDate(data.meta.generatedAt);
  const siteUrl = baseUrl.replace(/\/$/, "");
  const imageUrl = `${siteUrl}/assets/daily.png`;
  const topItems = data.items.slice(0, 8);
  const lines = topItems
    .map((item, index) => `${index + 1}. [${item.title}](${item.url})\n${trimText(item.summary || item.titleEn, 90)}`)
    .join("\n\n");

  return {
    msg_type: "interactive",
    card: {
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: `AI HOT 24 小时日报 · ${date}`
        }
      },
      elements: [
        {
          tag: "markdown",
          content: `今日共抓取 **${data.items.length}** 条精选动态。\n\n${lines}\n\n日报图片：${imageUrl}`
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: "打开热点网站"
              },
              url: siteUrl,
              type: "primary"
            },
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: "查看日报图片"
              },
              url: imageUrl,
              type: "default"
            }
          ]
        }
      ]
    }
  };
}

async function main() {
  const webhook = process.env.FEISHU_WEBHOOK;
  const baseUrl = process.env.PAGES_BASE_URL;

  if (!webhook) {
    console.log("FEISHU_WEBHOOK is not set, skip push.");
    return;
  }
  if (!baseUrl) {
    throw new Error("PAGES_BASE_URL is required for Feishu links.");
  }

  const data = await loadLatest();
  const payload = makePayload(data, baseUrl);
  const secret = process.env.FEISHU_SECRET;
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    payload.timestamp = String(timestamp);
    payload.sign = signFeishu(timestamp, secret);
  }

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Feishu push failed ${response.status}: ${text}`);
  }

  console.log(`Feishu push response: ${text}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
