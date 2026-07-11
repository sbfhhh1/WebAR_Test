function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };
}

function imageResponse(contentType, buffer) {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": contentType || "image/png",
    },
    body: Buffer.from(buffer).toString("base64"),
  };
}

function authHeaders() {
  const header = process.env.COMFY_AUTH_HEADER;
  if (!header) return {};
  const index = header.indexOf(":");
  if (index < 0) return {};
  return { [header.slice(0, index).trim()]: header.slice(index + 1).trim() };
}

function query(event, key) {
  return event && event.queryStringParameters ? event.queryStringParameters[key] || "" : "";
}

async function handleEvent(event) {
  if (event && event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }

  try {
    const baseUrl = (process.env.COMFY_BASE_URL || "").replace(/\/+$/, "");
    const filename = query(event, "filename");
    const subfolder = query(event, "subfolder");
    const type = query(event, "type") || "output";

    if (!baseUrl) return jsonResponse(500, { error: "Missing COMFY_BASE_URL." });
    if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return jsonResponse(400, { error: "Invalid filename." });
    }

    const params = new URLSearchParams({ filename, subfolder, type });
    const comfyResponse = await fetch(`${baseUrl}/view?${params.toString()}`, {
      headers: authHeaders(),
    });
    const buffer = Buffer.from(await comfyResponse.arrayBuffer());

    if (!comfyResponse.ok) {
      return jsonResponse(comfyResponse.status, { error: "Failed to fetch ComfyUI image." });
    }

    return imageResponse(comfyResponse.headers.get("content-type"), buffer);
  } catch (error) {
    return jsonResponse(500, { error: error.message || String(error) });
  }
}

exports.main = handleEvent;

if (require.main === module) {
  const http = require("http");
  const port = Number(process.env.PORT || 9000);

  http
    .createServer(async (request, response) => {
      const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const result = await handleEvent({
        httpMethod: request.method,
        queryStringParameters: Object.fromEntries(requestUrl.searchParams.entries()),
      });

      for (const [key, value] of Object.entries(result.headers || {})) {
        response.setHeader(key, value);
      }
      response.statusCode = result.statusCode || 200;
      response.end(result.isBase64Encoded ? Buffer.from(result.body || "", "base64") : result.body || "");
    })
    .listen(port, "0.0.0.0");
}
