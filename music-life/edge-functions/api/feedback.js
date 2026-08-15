const ALLOWED_ORIGINS = new Set([
  "https://backfire0190-coder.github.io",
  "https://xianshang-rensheng-cello-lgyy1rrc.edgeone.cool",
  "http://localhost:3000",
  "http://localhost:5173",
]);

function corsOrigin(request) {
  const origin = request.headers.get("origin") || "";
  return ALLOWED_ORIGINS.has(origin) ? origin : "https://backfire0190-coder.github.io";
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": corsOrigin(request),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function supabaseConfig(env = {}) {
  const url = cleanText(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "", 200).replace(/\/$/, "");
  const key = cleanText(
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
    300,
  );
  return url && key ? { url, key } : null;
}

async function supabaseInsert(env, row) {
  const config = supabaseConfig(env);
  if (!config) return { configured: false, ok: false, status: 0 };

  const response = await fetch(`${config.url}/rest/v1/music_life_feedback`, {
    method: "POST",
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });

  return { configured: true, ok: response.ok, status: response.status };
}

export default async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "只接受 POST" }, 405);

  let input = {};
  try {
    input = await request.json();
  } catch {
    return json(request, { error: "提交内容无法读取" }, 400);
  }

  const row = {
    source: cleanText(input.source, 20) || "unknown",
    message: cleanText(input.message, 2000),
    nickname: cleanText(input.nickname, 16),
    instrument: cleanText(input.instrument, 30),
    age: cleanNumber(input.age),
    score: cleanNumber(input.score),
    page_url: cleanText(input.url, 500),
    user_agent: cleanText(request.headers.get("user-agent") || "", 300),
  };

  if (row.message.length < 1) return json(request, { error: "建议内容不能为空" }, 400);

  try {
    const insert = await supabaseInsert(env, row);
    if (!insert.configured) return json(request, { saved: false, error: "反馈表尚未配置" }, 200);
    if (!insert.ok) throw new Error(`Supabase feedback insert failed: ${insert.status}`);
    return json(request, { saved: true });
  } catch (error) {
    console.error("feedback failed", error);
    return json(request, { saved: false, error: "反馈暂时无法提交" }, 200);
  }
}
