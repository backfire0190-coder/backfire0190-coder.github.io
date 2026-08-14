const STAT_KEYS = ["technique", "musicality", "love", "stress", "health", "stage", "reputation", "teaching", "ensemble", "network"];
const buckets = new Map();

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "https://backfire0190-coder.github.io",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanEffect(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = STAT_KEYS.flatMap((key) => {
    const raw = Number(value[key]);
    if (!Number.isFinite(raw) || raw === 0) return [];
    return [[key, Math.max(-8, Math.min(10, Math.round(raw)))]];
  }).slice(0, 4);
  return Object.fromEntries(entries);
}

function enrichSparseEffect(effect, choiceText) {
  const keys = Object.keys(effect);
  const hasMasteryGain = ["technique", "musicality", "stage", "ensemble", "network", "teaching", "reputation"].some((key) => Number(effect[key]) > 0);
  if (hasMasteryGain || !keys.some((key) => key === "stress" || key === "health" || key === "love")) return effect;
  const text = String(choiceText || "");
  const patched = { ...effect };
  if (/室内乐|乐团|声部|合奏|排位|首席|指挥|排练厅/.test(text)) patched.ensemble = 2;
  else if (/大师课|教授|曲目|练|技巧|试演|片段|工作坊|指导|录音指导|复核|审读/.test(text)) patched.technique = 2;
  else if (/演出|舞台|公开课|录音|试音|首演/.test(text)) patched.stage = 2;
  else if (/教学|学生|助教/.test(text)) patched.teaching = 2;
  else if (/沟通|制作人|经纪|总监|学长|同事|推荐/.test(text)) patched.network = 2;
  else patched.musicality = 2;
  return Object.fromEntries(Object.entries(patched).slice(0, 4));
}

function cleanChoice(choice, index) {
  if (!choice || typeof choice !== "object") throw new Error("选项格式不完整");
  const label = cleanText(choice.label, 36);
  const hint = cleanText(choice.hint, 90);
  if (!label || !hint) throw new Error("选项缺少说明");
  const base = { id: `ai-choice-${index + 1}`, label, hint };
  if (Array.isArray(choice.outcomes) && choice.outcomes.length >= 2) {
    const outcomes = choice.outcomes.slice(0, 3).map((outcome, outcomeIndex, all) => ({
      chance: outcomeIndex === all.length - 1 ? 1 : Math.max(0.05, Math.min(0.75, Number(outcome.chance) || 0.25)),
      text: cleanText(outcome.text, 150),
      effect: enrichSparseEffect(cleanEffect(outcome.effect), `${label}${hint}${outcome.text}`),
    }));
    if (outcomes.some((outcome) => !outcome.text || Object.keys(outcome.effect).length === 0)) throw new Error("概率结果格式不完整");
    return { ...base, outcomes };
  }
  const effect = enrichSparseEffect(cleanEffect(choice.effect), `${label}${hint}`);
  if (Object.keys(effect).length === 0) throw new Error("选项没有有效影响");
  return { ...base, effect };
}

const TRAINING_RISK_PATTERN = /练|冲刺|比赛|试演|赛前|每天|小时|曲目|技巧|基本功|排练/;

function calibrateTrainingRisk(choice, stats) {
  if (!Array.isArray(choice.outcomes) || !TRAINING_RISK_PATTERN.test(`${choice.label}${choice.hint}`)) return choice;
  const outcomes = choice.outcomes.map((outcome) => ({ ...outcome, effect: { ...outcome.effect } }));
  const success = outcomes[0];
  if (!Number.isFinite(success.effect.technique) || success.effect.technique <= 0) {
    success.effect = {
      technique: 5,
      ...Object.fromEntries(Object.entries(success.effect).filter(([key]) => key !== "technique").slice(0, 3)),
    };
  }
  const setback = outcomes[outcomes.length - 1];
  setback.effect = {
    technique: Math.min(-2, Number(setback.effect.technique) || -3),
    health: Math.min(-3, Number(setback.effect.health) || -5),
    stress: Math.max(4, Number(setback.effect.stress) || 6),
    ...(Number(setback.effect.love) < 0 ? { love: Number(setback.effect.love) } : {}),
  };
  const love = Number(stats?.love) || 0;
  const health = Number(stats?.health) || 0;
  const stress = Number(stats?.stress) || 0;
  success.chance = Math.max(0.18, Math.min(0.72, 0.18 + love / 300 + health / 600 - stress / 420));
  return { ...choice, hint: `${choice.hint}；身体、喜爱和压力会改变突破或受伤概率`.slice(0, 90), outcomes };
}

function cleanEvent(value, age, stats) {
  if (!value || typeof value !== "object") throw new Error("事件格式不完整");
  const choices = Array.isArray(value.choices) ? value.choices.slice(0, 3).map(cleanChoice) : [];
  if (choices.length !== 3) throw new Error("事件必须包含三个选择");
  if (!choices.some((choice) => Array.isArray(choice.outcomes))) {
    const fallback = choices[2];
    const successEffect = fallback.effect;
    const setbackEffect = Object.fromEntries(Object.entries(successEffect).map(([key, amount]) => {
      if (key === "stress") return [key, Math.min(8, Math.max(2, Math.abs(amount) + 2))];
      if (key === "health") return [key, -Math.min(6, Math.max(2, Math.abs(amount)))];
      return [key, amount > 0 ? -Math.max(1, Math.ceil(amount / 2)) : Math.max(-8, amount - 2)];
    }));
    choices[2] = {
      id: fallback.id,
      label: fallback.label,
      hint: `${fallback.hint}（动态结果：较顺利 62%，遭遇挫折 38%）`.slice(0, 90),
      outcomes: [
        { chance: 0.62, text: "局势朝有利方向发展，你的准备和判断得到了回应。", effect: successEffect },
        { chance: 1, text: "现场条件没有站在你这边，代价比预想更明显。", effect: setbackEffect },
      ],
    };
  }
  const eyebrow = cleanText(value.eyebrow, 36);
  const title = cleanText(value.title, 52);
  const text = cleanText(value.text, 260);
  if (!eyebrow || !title || !text) throw new Error("事件正文不完整");
  return { id: `ai-event-${age}-${Date.now()}`, eyebrow, title, text, choices: choices.map((choice) => calibrateTrainingRisk(choice, stats)) };
}

function parseJsonContent(content) {
  if (typeof content !== "string" || !content.trim()) throw new Error("AI 返回内容为空");
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("AI 返回内容不是 JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

const INSTRUMENT_NAMES = ["小提琴", "中提琴", "大提琴", "低音提琴", "长笛", "短笛", "双簧管", "英国管", "单簧管", "低音单簧管", "大管", "低音大管", "圆号", "小号", "长号", "低音长号", "大号", "定音鼓", "打击乐", "竖琴", "钢琴", "钢片琴", "管风琴", "萨克斯管"];
const RELATED_INSTRUMENTS = {
  短笛: ["长笛"],
  英国管: ["双簧管"],
  低音单簧管: ["单簧管"],
  低音大管: ["大管"],
  低音长号: ["长号"],
  钢片琴: ["钢琴"],
  定音鼓: ["打击乐"],
};

function validateInstrumentConsistency(value, instrumentName) {
  const text = JSON.stringify(value);
  const focalText = `${cleanText(value?.eyebrow, 80)} ${cleanText(value?.title, 120)}`;
  const wrongFocalInstrument = INSTRUMENT_NAMES.find((name) => name !== instrumentName && focalText.includes(name));
  if (wrongFocalInstrument) {
    throw new Error(`事件标题把 ${instrumentName} 玩家写进了 ${wrongFocalInstrument} 的核心场景`);
  }
  const assignedPatterns = [
    /(?:你|玩家|考生).{0,18}(?:演奏|顶替|担任|主修|代奏|负责).{0,12}(小提琴|中提琴|大提琴|低音提琴|长笛|短笛|双簧管|英国管|单簧管|低音单簧管|大管|低音大管|圆号|小号|长号|低音长号|大号|定音鼓|打击乐|竖琴|钢琴|钢片琴|管风琴|萨克斯管)/g,
    /(?:需|要|改为|被要求|指挥要求)(?:你)?演奏.{0,12}(小提琴|中提琴|大提琴|低音提琴|长笛|短笛|双簧管|英国管|单簧管|低音单簧管|大管|低音大管|圆号|小号|长号|低音长号|大号|定音鼓|打击乐|竖琴|钢琴|钢片琴|管风琴|萨克斯管)/g,
    /(小提琴|中提琴|大提琴|低音提琴|长笛|短笛|双簧管|英国管|单簧管|低音单簧管|大管|低音大管|圆号|小号|长号|低音长号|大号|定音鼓|打击乐|竖琴|钢琴|钢片琴|管风琴|萨克斯管)(?:独奏部分|独奏声部|专业考生|专业席位|首席|声部|协奏曲)/g,
  ];
  for (const pattern of assignedPatterns) {
    for (const match of text.matchAll(pattern)) {
      const assigned = match[1];
      if (INSTRUMENT_NAMES.includes(assigned) && assigned !== instrumentName) {
        throw new Error(`事件错误地让 ${instrumentName} 玩家演奏 ${assigned}`);
      }
    }
  }
  const allowedRelated = new Set(RELATED_INSTRUMENTS[instrumentName] || []);
  for (const other of INSTRUMENT_NAMES) {
    if (other === instrumentName || allowedRelated.has(other) || !text.includes(other)) continue;
    const risky = new RegExp(`${other}.{0,8}(?:首席|声部|独奏|协奏曲|试演|替补|顶替|代奏)|(?:首席|声部|独奏|协奏曲|试演|替补|顶替|代奏).{0,8}${other}`);
    if (risky.test(text)) throw new Error(`事件把 ${instrumentName} 的核心职业动作写成了 ${other}`);
  }
  if (/换调降低难度|改写谱面|临时更换规定曲目|评委.{0,12}更换/.test(text)) {
    throw new Error("事件包含不合理的考试或谱面规则");
  }
}

const KNOWN_MUSIC_MIDDLE_SCHOOLS = ["本地音乐附中", "中央音乐学院附中", "上海音乐学院附中", "中国音乐学院附中", "星海音乐学院附中", "武汉音乐学院附中", "四川音乐学院附中", "沈阳音乐学院附中", "西安音乐学院附中", "天津音乐学院附中", "浙江音乐学院附中"];

function validateInstitutionConsistency(value, playerContext) {
  const text = JSON.stringify(value);
  if (playerContext.age >= 18 && text.includes("附中")) throw new Error("大学阶段事件错误地退回附中叙事");
  const namedSchools = [...text.matchAll(/[\u4e00-\u9fa5]{2,12}(?:音乐学院附中|音乐附中)/g)].map((match) => match[0]);
  const invented = namedSchools.find((name) => name !== playerContext.schoolName && !KNOWN_MUSIC_MIDDLE_SCHOOLS.includes(name));
  if (invented) throw new Error(`事件虚构了院校：${invented}`);
  if (playerContext.age < 60 && /直接退役|正式退役|永久退出|职业生涯.{0,8}结束|就到这里吧|从此不再踢球|从此不再演奏/.test(text)) {
    throw new Error("普通年度事件不应直接结束职业生涯");
  }
}

async function generateWithProvider({ provider, url, apiKey, model, systemPrompt, playerContext, age, timeoutMs, extra = {} }) {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `请根据以下玩家状态生成 json 年度事件：${JSON.stringify(playerContext)}` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1400,
        stream: false,
        ...extra,
      }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error(`${provider} error`, upstream.status, detail.slice(0, 300));
      return null;
    }
    const completion = await upstream.json();
    const content = completion?.choices?.[0]?.message?.content;
    const parsed = parseJsonContent(content);
    validateInstrumentConsistency(parsed, playerContext.instrument.name);
    validateInstitutionConsistency(parsed, playerContext);
    return cleanEvent(parsed, age, playerContext.stats);
  } catch (error) {
    console.error(`${provider} event generation failed`, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isRateLimited(request) {
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("cf-connecting-ip")
    || "anonymous";
  const now = Date.now();
  const current = buckets.get(client);
  if (!current || now - current.startedAt > 10 * 60 * 1000) {
    buckets.set(client, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > 240;
}

function fallbackEvent(playerContext, age) {
  const instrument = playerContext.instrument.name || "乐器";
  const work = playerContext.instrument.representativeWork || "本年度曲目";
  const focus = playerContext.instrument.techniqueFocus || "基本技术";
  const college = playerContext.schoolName || "学校";
  const professional = /orchestra|soloist|teacher|freelance|职业|乐团|独奏/.test(playerContext.career);
  return {
    id: `fallback-event-${age}-${Date.now()}`,
    eyebrow: professional ? "职业年度 · 稳定项目" : "学院年度 · 主课之外",
    title: professional ? `${instrument}声部的年度项目协调` : `${college}${instrument}主课工作坊`,
    text: professional
      ? `这一年没有突然改变命运的奇迹，但${instrument}声部有一个真实项目需要你处理：${work}相关片段、排练沟通和身体负荷都要同时管理。`
      : `${college}安排了一次围绕${work}的主课工作坊。教授要求你不只完成音符，还要说明${focus}、句法和舞台呈现之间的关系。`,
    choices: [
      { id: "fallback-focused", label: `先拆${focus}，再进曲目`, hint: "技巧收益稳定；代价是本周压力上升，舞台曝光较少", effect: { technique: 4, stress: 3, health: -1 } },
      { id: "fallback-stage", label: "直接参加公开呈现", hint: "舞台与人脉增加；准备不足时容易暴露细节问题", outcomes: [
        { chance: 0.62, text: "现场反馈具体而有效，你把问题带回练习室后进步更清楚。", effect: { stage: 4, network: 3, technique: 2, stress: 3 } },
        { chance: 1, text: "呈现没有完全站稳，但你看清了下一轮必须补的技术点。", effect: { technique: 2, stress: 6, love: -1 } },
      ] },
      { id: "fallback-balance", label: "保留恢复日，做慢速录音复盘", hint: "乐感和身体更稳；短期曝光减少，但能降低失误风险", effect: { musicality: 4, health: 3, stress: -3 } },
    ],
  };
}

export default async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "https://backfire0190-coder.github.io",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "POST") return response({ error: "只接受 POST 请求" }, 405);
  if (isRateLimited(request)) return response({ error: "十分钟内生成次数过多，请稍后再试" }, 429);
  if (!env.ZHIPU_API_KEY && !env.DEEPSEEK_API_KEY) return response({ error: "动态事件服务尚未配置" }, 503);

  let input;
  try {
    input = await request.json();
  } catch {
    return response({ error: "请求内容无法读取" }, 400);
  }
  const age = Math.max(15, Math.min(70, Math.round(Number(input.age) || 15)));
  const instrumentName = cleanText(input.instrument?.name, 20);
  if (!instrumentName) return response({ error: "缺少乐器信息" }, 400);

  const systemPrompt = `你是严谨的古典音乐职业生涯模拟器编剧，同时熟悉中国、欧洲和北美音乐学院、职业乐团、独奏市场与国际比赛。生成一个现实、具体、有戏剧冲突但不狗血的事件。事件必须贴合玩家的乐器、年龄、学校、职业、能力和最近履历，避免空泛的“努力/放弃”，也不能重复最近发生过的事件。

必须具体到这件乐器真实会遇到的技术、曲目、声部关系、试演片段、排练制度或职业结构。玩家只演奏状态中指定的 instrument.name：绝不能让大提琴手去顶替小提琴、中提琴等其他乐器，也不能给任何乐器安排不属于它的声部、谱面或演奏技术；室内乐和乐团情境必须使用该乐器真实承担的声部。可以出现其他声部作为合作者或背景，但其他乐器不能成为事件标题、核心任务、玩家要顶替的首席、玩家要演奏的独奏声部或玩家要竞争的专业席位。低音单簧管、低音大管、英国管、短笛、钢片琴、低音长号、定音鼓等兼属/邻近乐器尤其要小心：可以写与本族首席沟通，但玩家的任务必须仍是自己的乐器。优先使用状态中 instrument.representativeWork 给出的曲目；需要换作品时也必须换成该乐器真实常见曲目，不要反复只写同一首。不得编造真实作品的作曲家、体裁、独奏编制、谱面内容或乐章位置，不得把小提琴协奏曲写成双协奏曲，也不得把钢琴协奏曲写成其他乐器独奏任务；不得声称演奏者可以随意换调、降低作品难度或改写作曲家的谱面；巴赫大提琴组曲本身就是无伴奏组曲，不能当成两套不同作品。不得虚构评委在考生进场前临时更换规定曲目、临时改变招生规则等不合理制度；考试冲突必须来自准备、发挥、评审偏好或真实程序。不确定时宁可使用不带作品名的真实职业情境。青少年阶段可涉及老师、艺考曲目、夏校、大师课、附中与多校申请；音乐学院阶段可涉及主课、室内乐、乐团排位、大师课、驻校艺术家项目、乐团学院旁听与比赛。只有当玩家在中国或本地院校时，才可以写海外交换/短期访学；如果 schoolName 是茱莉亚、柯蒂斯、英国皇家、巴黎国立、柏林汉斯·艾斯勒等海外顶级学校，严禁再写“申请出国交换”，应改写为大师班、职业乐团学院、驻校艺术家或教授推荐项目。职业阶段可涉及排练事故、临时替补、匿名试演、声部政治、比赛选择、教学伦理、同行合作、伤病、录音、经纪、家庭与迁居。不要虚构玩家已经获得的荣誉。

严格遵守人生阶段：只要 age 大于等于 18、schoolName 非空，或 career 表示音乐学院/大学，玩家就是大学本科或更高阶段。此时严禁出现“附中、附中老师、附中师弟、艺考前、家长替你安排”等中学叙事，必须直接使用 schoolName 和大学阶段的课程、教授、同学与职业资源。career 已进入职业后，也不得倒退成学生阶段。

不得虚构任何音乐学院、音乐附中、比赛或职业乐团的名字。状态中没有给出学校名称时，只能写“本地音乐附中”“音乐学院”这类泛称；绝不能创造“瑞鸣音乐附中”一类看似真实但不存在的机构。

recentHistory 是硬性去重清单。最近十条经历中出现过的核心物件或冲突（尤其是琴房、琴房钥匙、占琴房、交还琴房、练习室排队）至少八年内不得再次成为事件中心；也不要只换一个人物后重复同一冲突。若 recentlyUsedThemes 非空，必须选择列表之外的领域创作。

只要选项涉及赛前冲刺、长时间练习、急于求成或带伤排练，就必须使用 outcomes 呈现真正的双向风险：成功可以形成突破，失败必须明确造成 technique 下降，并伴随 health 下降或 stress 上升。成功概率要根据玩家当前的 love、health 与 stress 合理变化，不能把高强度练习写成稳赚不赔。

普通年度事件不得让玩家“直接退役、永久退出职业、职业生涯到此结束”。伤病可以出现，但必须提供康复、减少强度、转教学/幕后、重新评估合同等可继续游玩的选项；只有系统在六十岁退休结算时才能写正式退役。

玩家状态中可能包含 anchorEvent。若没有 anchorEvent，你必须完全重新创作这一年的处境与三个选项：不要复用“报名上台、买票旁听、留在家准备”等固定模板，也不要只替换标题和正文。三个选择的动作、措辞、风险来源都必须紧扣本次事件，并且彼此代表真正不同的策略。

若 anchorEvent.planner 为 true，年度训练与青年比赛已经由系统单独提供。你只生成一个与学校、工作、人际、演出、合同、教学或家庭相关的职业事件，三个选项不得再次变成“多练技巧、主练曲目、参加比赛”三种换汤不换药的训练方案。

若 anchorEvent.mechanicsLocked 为 true，这一年承担录取、毕业、职业分流、乐团席位、国际比赛或教职等关键系统功能：你必须围绕 anchorEvent 的同一处境重写更有质感的标题、正文以及选择文字，不得把它改成无关小事，不得声称玩家已被未列出的学校或单位录取。若 anchorEvent 恰好有三个选择，生成的三个选择必须依次对应原选择的战略含义，但 label 和 hint 要像这个具体场景中的真实决定，不能照抄原句。若不是三个选择，则只改写事件标题和正文，系统会保留完整候选清单。

只输出一个合法 JSON 对象，格式如下：
{"eyebrow":"场景短标签","title":"具体事件标题","text":"80到150字的处境说明","choices":[{"label":"选择一","hint":"明确说明潜在问题与取舍","effect":{"technique":4,"stress":3}},{"label":"选择二","hint":"明确说明潜在问题与取舍","effect":{"musicality":5,"love":2}},{"label":"选择三（概率选择）","hint":"说明这是概率结果以及风险来源","outcomes":[{"chance":0.2,"text":"低概率结果","effect":{"reputation":8,"stress":5}},{"chance":0.5,"text":"中间结果","effect":{"stage":4,"network":3}},{"chance":1,"text":"剩余概率结果","effect":{"stress":6,"love":-3}}]}]}

effect 只能使用 technique、musicality、love、stress、health、stage、reputation、teaching、ensemble、network。每个 effect 最多四项，单项整数范围 -8 到 10。不要修改职业、学校、乐团、奖项和收入。任何专业行动都不能只增加 stress 或只降低 health：只要玩家上课、排练、演出、旁听职业训练、做项目或教学，必须至少带来 technique、musicality、stage、ensemble、network、teaching 或 reputation 中的一项小幅收益，同时写清楚代价。每个 hint 都必须明确写出收益、代价和可能出问题的原因，不能只写“提升能力”。至少一个选择必须是带 outcomes 的动态概率抽签，概率必须来自场地、准备程度、评委偏好、合作对象或身体状态等本次事件中的具体不确定性。三个 label 不能是“选择一/二/三”式占位词，也不能复用最近事件的动作。数值成长必须克制：普通练习通常只给 1 到 4 的原始增量，重大突破才可给 5 到 8，不能让能力轻易接近 95。JSON 之外不要输出任何文字。`;

  const playerContext = {
    age,
    nickname: cleanText(input.nickname, 20),
    instrument: {
      name: instrumentName,
      family: cleanText(input.instrument?.family, 20),
      representativeWork: cleanText(input.instrument?.repertoire, 60),
      techniqueFocus: cleanText(input.instrument?.techniqueFocus, 40),
    },
    career: cleanText(input.career, 30),
    location: cleanText(input.location, 30),
    schoolName: cleanText(input.schoolName, 40),
    orchestraName: cleanText(input.orchestraName, 40),
    orchestraRole: cleanText(input.orchestraRole, 30),
    stats: Object.fromEntries(STAT_KEYS.map((key) => [key, Math.max(0, Math.min(100, Math.round(Number(input.stats?.[key]) || 0)))])),
    awards: Array.isArray(input.awards) ? input.awards.slice(0, 5).map((item) => cleanText(item, 60)) : [],
    recentHistory: Array.isArray(input.recentHistory) ? input.recentHistory.slice(0, 10).map((item) => ({ age: Number(item.age), title: cleanText(item.title, 50), choice: cleanText(item.choice, 60), result: cleanText(item.result, 120) })) : [],
    recentlyUsedThemes: Array.isArray(input.recentHistory) ? [...new Set(input.recentHistory.slice(0, 10).flatMap((item) => {
      const text = `${item?.title || ""}${item?.choice || ""}${item?.result || ""}`;
      return ["琴房", "钥匙", "席位", "大师课", "比赛", "伤病", "录音", "经纪", "试演", "室内乐", "教学", "迁居"].filter((theme) => text.includes(theme));
    }))].slice(0, 8) : [],
    anchorEvent: input.anchorEvent && typeof input.anchorEvent === "object" ? {
      id: cleanText(input.anchorEvent.id, 60),
      title: cleanText(input.anchorEvent.title, 80),
      text: cleanText(input.anchorEvent.text, 300),
      mechanicsLocked: Boolean(input.anchorEvent.mechanicsLocked) || (!input.anchorEvent.planner && Array.isArray(input.anchorEvent.choices) && input.anchorEvent.choices.some((choice) => {
        const effects = [choice?.effect, ...(Array.isArray(choice?.outcomes) ? choice.outcomes.map((outcome) => outcome?.effect) : [])];
        return effects.some((effect) => effect && typeof effect === "object" && ["career", "location", "award", "orchestraTier", "orchestraRole", "schoolName", "orchestraName", "facultyName", "facultyTier"].some((key) => key in effect));
      })),
      planner: Boolean(input.anchorEvent.planner),
      choices: Array.isArray(input.anchorEvent.choices) ? input.anchorEvent.choices.slice(0, 8).map((choice) => ({
        label: cleanText(choice?.label, 60),
        hint: cleanText(choice?.hint, 120),
      })) : [],
    } : null,
  };

  const zhipuEvent = await generateWithProvider({
    provider: "Zhipu",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    apiKey: env.ZHIPU_API_KEY,
    model: env.ZHIPU_MODEL || "glm-4.7-flash",
    systemPrompt,
    playerContext,
    age,
    timeoutMs: 6500,
    extra: { temperature: 0.82, thinking: { type: "disabled" } },
  });
  if (zhipuEvent) return response({ event: zhipuEvent, provider: "zhipu" });

  const deepseekEvent = await generateWithProvider({
    provider: "DeepSeek",
    url: "https://api.deepseek.com/chat/completions",
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    systemPrompt,
    playerContext,
    age,
    timeoutMs: 18000,
    extra: { thinking: { type: "disabled" } },
  });
  if (deepseekEvent) return response({ event: deepseekEvent, provider: "deepseek" });

  return response({ event: fallbackEvent(playerContext, age), provider: "system-fallback" });
}
