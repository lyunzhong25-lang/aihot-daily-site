# AI HOT 24 小时热点日报

这个项目每天从 AI HOT 公共 API 拉取最近 24 小时 AI 热点，生成：

- GitHub Pages 静态热点网站
- `public/data/latest.json` 数据文件
- `public/assets/daily.png` 日报图片
- 飞书机器人早报推送

## 本地运行

```bash
npm install
npm run build
```

生成结果在 `public/` 目录，直接部署为静态网站即可。

## GitHub Secrets

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 添加：

```text
FEISHU_WEBHOOK      飞书自定义机器人的 webhook
FEISHU_SECRET       可选，飞书机器人签名 secret
IMG2_API_KEY        img2 / OpenAI-compatible 图片接口 key
IMG2_API_URL        可选，默认 https://api.openai.com/v1/images/generations
IMG2_MODEL          可选，默认 gpt-image-2
```

如果没有配置 `IMG2_API_KEY`，构建脚本会用 HTML/CSS 截图生成兜底日报图。

## GitHub Pages

Actions 工作流每天北京时间 09:00 运行一次，也可以手动触发。首次使用前，在 GitHub 仓库的 `Settings -> Pages` 里把 Source 设为 `GitHub Actions`。

## AI HOT API

当前使用：

```text
GET https://aihot.virxact.com/api/public/items?mode=selected&since=<ISO时间>&take=80
GET https://aihot.virxact.com/api/public/daily
```

AI HOT 的接口目前标注为测试版，脚本会把每次结果写成静态文件，降低临时不可用时对页面访问的影响。
