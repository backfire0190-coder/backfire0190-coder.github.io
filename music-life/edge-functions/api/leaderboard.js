const ALLOWED_ORIGINS = new Set([
  "https://backfire0190-coder.github.io",
  "https://xianshang-rensheng-cello-lgyy1rrc.edgeone.cool",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const LEADERBOARD_DISPLAY_LIMIT = 1000;

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
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanScore(value) {
  return Math.max(0, Math.min(99999, Math.round(Number(value) || 0)));
}

function supabaseConfig(env = {}) {
  const url = cleanText(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "", 200).replace(/\/$/, "");
  const key = cleanText(
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
    300,
  );
  return url && key ? { url, key } : null;
}

function normalizeRow(row) {
  return {
    id: cleanText(row.id, 40) || `${cleanText(row.nickname, 16)}-${cleanScore(row.score)}-${cleanText(row.created_at || row.createdAt, 40)}`,
    nickname: cleanText(row.nickname, 16) || "无名乐手",
    instrument: "",
    score: cleanScore(row.score),
    title: "云端分数",
    career: "",
    summary: cleanText(row.summary, 10),
    createdAt: cleanText(row.created_at || row.createdAt, 40) || new Date().toISOString(),
  };
}

function rankScores(scores) {
  return scores
    .map(normalizeRow)
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt))
    .slice(0, LEADERBOARD_DISPLAY_LIMIT);
}

async function supabaseFetch(env, path, options = {}) {
  const config = supabaseConfig(env);
  if (!config) return { configured: false, ok: false, data: null };

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { configured: true, ok: response.ok, status: response.status, data };
}

async function readTop(env) {
  let result = await supabaseFetch(
    env,
    `music_life_scores?select=id,nickname,score,summary,created_at&order=score.desc,created_at.asc&limit=${LEADERBOARD_DISPLAY_LIMIT}`,
  );
  if (result.configured && !result.ok) {
    result = await supabaseFetch(
      env,
      `music_life_scores?select=id,nickname,score,created_at&order=score.desc,created_at.asc&limit=${LEADERBOARD_DISPLAY_LIMIT}`,
    );
  }
  if (!result.configured) return { cloud: false, scores: [] };
  if (!result.ok || !Array.isArray(result.data)) throw new Error(`Supabase read failed: ${result.status}`);
  return { cloud: true, scores: rankScores(result.data) };
}

async function saveScore(env, row) {
  // Every submitted score is inserted. The display cap is only for read/display.
  let insert = await supabaseFetch(env, "music_life_scores", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ nickname: row.nickname, score: row.score, summary: row.summary }),
  });
  if (insert.configured && !insert.ok) {
    insert = await supabaseFetch(env, "music_life_scores", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ nickname: row.nickname, score: row.score }),
    });
  }
  if (!insert.configured) return { cloud: false, saved: false, scores: [] };
  if (!insert.ok) throw new Error(`Supabase insert failed: ${insert.status}`);
  return { ...(await readTop(env)), saved: true };
}

export default async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") return json(request, {}, 204);

  try {
    if (request.method === "GET") return json(request, await readTop(env));
    if (request.method !== "POST") return json(request, { error: "只接受 GET 或 POST" }, 405);

    let input = {};
    try {
      input = await request.json();
    } catch {
      return json(request, { error: "提交内容无法读取" }, 400);
    }

    const row = normalizeRow({
      nickname: input.nickname,
      score: input.score,
      summary: input.summary,
      createdAt: new Date().toISOString(),
    });
    if (!row.score) return json(request, { error: "分数无效" }, 400);

    return json(request, await saveScore(env, row));
  } catch (error) {
    console.error("leaderboard failed", error);
    return json(request, { cloud: false, saved: false, scores: [], error: "排行榜云数据暂时不可用" }, 200);
  }
}
