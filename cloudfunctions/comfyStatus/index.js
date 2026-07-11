function response(statusCode, payload) {
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

function parsePromptId(event) {
  if (!event) return "";
  if (event.queryStringParameters && event.queryStringParameters.promptId) {
    return event.queryStringParameters.promptId;
  }
  if (event.promptId) return event.promptId;
  if (event.body) {
    const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    return body.promptId || body.prompt_id || "";
  }
  return "";
}

function authHeaders() {
  const header = process.env.COMFY_AUTH_HEADER;
  if (!header) return {};
  const index = header.indexOf(":");
  if (index < 0) return {};
  return { [header.slice(0, index).trim()]: header.slice(index + 1).trim() };
}

function getOutputImage(historyItem) {
  const outputNodeId = process.env.COMFY_OUTPUT_NODE_ID;
  const outputs = historyItem && historyItem.outputs ? historyItem.outputs : {};

  if (outputNodeId && outputs[outputNodeId] && outputs[outputNodeId].images && outputs[outputNodeId].images[0]) {
    return outputs[outputNodeId].images[0];
  }

  for (const output of Object.values(outputs)) {
    if (output && output.images && output.images[0]) {
      return output.images[0];
    }
  }

  return null;
}

function makeImageUrl(image) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });

  const proxyUrl = process.env.COMFY_IMAGE_PUBLIC_URL;
  if (proxyUrl) {
    return `${proxyUrl}${proxyUrl.includes("?") ? "&" : "?"}${params.toString()}`;
  }

  const baseUrl = (process.env.COMFY_BASE_URL || "").replace(/\/+$/, "");
  return `${baseUrl}/view?${params.toString()}`;
}

async function makeInlineImageUrl(image) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  const baseUrl = (process.env.COMFY_BASE_URL || "").replace(/\/+$/, "");
  const comfyResponse = await fetch(`${baseUrl}/view?${params.toString()}`, {
    headers: authHeaders(),
  });
  const buffer = Buffer.from(await comfyResponse.arrayBuffer());
  if (!comfyResponse.ok) {
    throw new Error("Failed to fetch ComfyUI image.");
  }

  const contentType = comfyResponse.headers.get("content-type") || "image/png";
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

exports.main = async (event) => {
  if (event && event.httpMethod === "OPTIONS") {
    return response(204, {});
  }

  try {
    const baseUrl = (process.env.COMFY_BASE_URL || "").replace(/\/+$/, "");
    const promptId = parsePromptId(event);

    if (!baseUrl) return response(500, { error: "Missing COMFY_BASE_URL." });
    if (!promptId) return response(400, { error: "Missing promptId." });

    const comfyResponse = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
      headers: authHeaders(),
    });
    const history = await comfyResponse.json();

    if (!comfyResponse.ok) {
      return response(comfyResponse.status, { status: "error", error: history.error || history.message || "ComfyUI status failed." });
    }

    const item = history[promptId];
    if (!item) return response(200, { status: "pending", promptId });

    if (item.status && item.status.status_str === "error") {
      return response(200, { status: "failed", promptId, error: "ComfyUI workflow failed." });
    }

    const image = getOutputImage(item);
    if (!image) return response(200, { status: "pending", promptId });
    const inlineImage = process.env.COMFY_INLINE_IMAGE === "1";

    return response(200, {
      status: "done",
      promptId,
      image,
      imageUrl: inlineImage ? await makeInlineImageUrl(image) : makeImageUrl(image),
    });
  } catch (error) {
    return response(500, { status: "error", error: error.message || String(error) });
  }
};
