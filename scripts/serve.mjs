import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(rootDir, "public");
const port = Number(process.env.PORT || 4173);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8"
};

function resolvePublicPath(urlPath) {
  const cleanPath = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const target = resolve(publicDir, cleanPath === "/" ? "index.html" : cleanPath.slice(1));
  if (!target.startsWith(publicDir)) return null;
  return target;
}

createServer(async (request, response) => {
  const target = resolvePublicPath(request.url || "/");
  if (!target) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    let filePath = target;
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
    response.writeHead(200, {
      "content-type": types[extname(filePath)] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Serving ${publicDir} at http://127.0.0.1:${port}`);
});
