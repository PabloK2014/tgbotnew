require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Заполните BOT_TOKEN в .env (см. .env.example)");
  process.exit(1);
}

const PROXY_URL = process.env.PROXY_URL;
const PROXY_ENABLED = String(process.env.PROXY_ENABLED || "").trim().toLowerCase() === "true";
let proxyAgent;
if (PROXY_ENABLED && PROXY_URL) {
  proxyAgent = PROXY_URL.startsWith("socks")
    ? new SocksProxyAgent(PROXY_URL)
    : new HttpsProxyAgent(PROXY_URL);
  console.log(`🌐 Используется прокси: ${PROXY_URL.replace(/\/\/.*@/, "//***@")}`);
  // Некоторые зависимости могут делать свои https-запросы напрямую, не принимая
  // agent явно и не видя proxyAgent из наших собственных функций. Подмена
  // глобального агента Node.js заставляет ЛЮБОЙ https.request без явного
  // agent идти через прокси, что закрывает эту дыру.
  https.globalAgent = proxyAgent;
  require("http").globalAgent = proxyAgent;
} else if (!PROXY_ENABLED && PROXY_URL) {
  console.log("🌐 Прокси отключён (PROXY_ENABLED=false), несмотря на заданный PROXY_URL.");
}

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CACHE_FILE = path.join(__dirname, "cache.json");
const CONNECTIONS_FILE = path.join(__dirname, "connections.json");
const OFFSET_FILE = path.join(__dirname, "offset.txt");
let connections = new Map();
let cache = new Map();
let updateOffset = 0;

function loadJsonMap(file) {
  try {
    if (fs.existsSync(file)) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf-8"))));
    }
  } catch (e) {
    console.error(`Не удалось загрузить ${file}:`, e.message);
  }
  return new Map();
}

function loadAll() {
  connections = loadJsonMap(CONNECTIONS_FILE);
  cache = loadJsonMap(CACHE_FILE);
  try {
    if (fs.existsSync(OFFSET_FILE)) {
      updateOffset = parseInt(fs.readFileSync(OFFSET_FILE, "utf-8"), 10) || 0;
    }
  } catch (e) {
    /* ignore */
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
      fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(Object.fromEntries(connections)));
    } catch (e) {
      console.error("Не удалось сохранить состояние:", e.message);
    }
  }, 1500);
}

function saveOffset() {
  fs.writeFileSync(OFFSET_FILE, String(updateOffset));
}
const MAX_CACHE_SIZE = 8000;
function trimCache() {
  if (cache.size <= MAX_CACHE_SIZE) return;
  const excess = cache.size - MAX_CACHE_SIZE;
  const it = cache.keys();
  for (let i = 0; i < excess; i++) {
    const { value, done } = it.next();
    if (done) break;
    cache.delete(value);
  }
}
function httpsPostJson(urlString, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const u = new URL(urlString);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 35000,
    };
    if (proxyAgent) options.agent = proxyAgent;

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpsGetJson(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: { "Accept": "application/json" },
      timeout: 15000,
    };
    if (proxyAgent) options.agent = proxyAgent;

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function tg(method, params) {
  try {
    const data = await httpsPostJson(`${API_URL}/${method}`, params);
    if (!data.ok) {
      console.error(`Ошибка ${method}:`, data.description);
    }
    return data;
  } catch (e) {
    console.error(`Сбой запроса ${method}:`, e.message);
    return null;
  }
}

function fmtUser(msg) {
  if (!msg || !msg.from) return "неизвестно";
  const u = msg.from;
  const handle = u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ");
  return `${handle} (id: ${u.id})`;
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return "неизвестно";
  return new Date(unixSeconds * 1000).toLocaleString("ru-RU");
}
function extractMedia(msg) {
  if (!msg) return null;
  if (msg.photo && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    return { type: "photo", fileId: largest.file_id, sendMethod: "sendPhoto", field: "photo" };
  }
  if (msg.video) return { type: "video", fileId: msg.video.file_id, sendMethod: "sendVideo", field: "video" };
  if (msg.animation) return { type: "animation", fileId: msg.animation.file_id, sendMethod: "sendAnimation", field: "animation" };
  if (msg.video_note) return { type: "video_note", fileId: msg.video_note.file_id, sendMethod: "sendVideoNote", field: "video_note" };
  if (msg.voice) return { type: "voice", fileId: msg.voice.file_id, sendMethod: "sendVoice", field: "voice" };
  if (msg.audio) return { type: "audio", fileId: msg.audio.file_id, sendMethod: "sendAudio", field: "audio" };
  if (msg.document) return { type: "document", fileId: msg.document.file_id, sendMethod: "sendDocument", field: "document" };
  if (msg.sticker) return { type: "sticker", fileId: msg.sticker.file_id, sendMethod: "sendSticker", field: "sticker" };
  return null;
}

function cacheKey(connId, chatId, messageId) {
  return `${connId}_${chatId}_${messageId}`;
}
function cacheMessage(connId, msg) {
  if (!msg || !msg.chat) return;
  //if (msg.chat.type !== "private") return; // отслеживаем только личные чаты

  const media = extractMedia(msg);
  const key = cacheKey(connId, msg.chat.id, msg.message_id);

  cache.set(key, {
    text: msg.text || msg.caption || "",
    mediaType: media ? media.type : null,
    fileId: media ? media.fileId : null,
    fromTag: fmtUser(msg),
    date: msg.date,
    chatId: msg.chat.id,
  });

  trimCache();
  scheduleSave();
}
async function resendCachedMedia(targetChatId, entry, captionPrefix) {
  if (!entry.mediaType || !entry.fileId) return;
  const methodMap = {
    photo: "sendPhoto",
    video: "sendVideo",
    animation: "sendAnimation",
    video_note: "sendVideoNote",
    voice: "sendVoice",
    audio: "sendAudio",
    document: "sendDocument",
    sticker: "sendSticker",
  };
  const method = methodMap[entry.mediaType];
  if (!method) return;

  const params = { chat_id: targetChatId };
  if (entry.mediaType === "video_note") {
    params.video_note = entry.fileId;
  } else if (entry.mediaType === "sticker") {
    params.sticker = entry.fileId;
  } else {
    params[entry.mediaType] = entry.fileId;
    if (captionPrefix) params.caption = captionPrefix;
  }
  await tg(method, params);
}

const BALANCES_FILE = path.join(__dirname, "balances.json");
const GAMES_FILE = path.join(__dirname, "games.json");
let balances = loadJsonMap(BALANCES_FILE);
let games = loadJsonMap(GAMES_FILE);

let saveExtraTimer = null;
function scheduleSaveExtra() {
  if (saveExtraTimer) return;
  saveExtraTimer = setTimeout(() => {
    saveExtraTimer = null;
    try {
      fs.writeFileSync(BALANCES_FILE, JSON.stringify(Object.fromEntries(balances)));
      fs.writeFileSync(GAMES_FILE, JSON.stringify(Object.fromEntries(games)));
    } catch (e) {
      console.error("Не удалось сохранить balances/games:", e.message);
    }
  }, 1000);
}
async function sendAsBusiness(conn, chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    business_connection_id: bcid(conn),
    text,
    ...extra,
  });
}

function getBalance(conn, userId) {
  const key = `${conn.id}_${userId}`;
  if (!balances.has(key)) balances.set(key, 5000);
  return balances.get(key);
}
function setBalance(conn, userId, value) {
  balances.set(`${conn.id}_${userId}`, value);
  scheduleSaveExtra();
}

/* =========================================================================
   КУРС ВАЛЮТ (.kurs) — источник: ЦБ РФ, обновление раз в сутки
   ========================================================================= */

const EXCHANGE_FILE = path.join(__dirname, "exchangeRates.json");
const CBR_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const EXCHANGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

// Валюты, которые показываем, и их коды в ответе ЦБ (UAH иногда пропадает из выдачи ЦБ - обрабатываем это)
const KURS_CODES = ["USD", "EUR", "KZT", "UAH"];

let exchangeState = { fetchedAt: 0, date: null, rates: {} }; // rates: { USD: 90.12, EUR: 98.3, ... } — рублей за 1 единицу валюты

function loadExchangeRates() {
  try {
    if (fs.existsSync(EXCHANGE_FILE)) {
      exchangeState = JSON.parse(fs.readFileSync(EXCHANGE_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Не удалось загрузить exchangeRates.json:", e.message);
  }
}

function saveExchangeRatesToDisk() {
  try {
    fs.writeFileSync(EXCHANGE_FILE, JSON.stringify(exchangeState));
  } catch (e) {
    console.error("Не удалось сохранить exchangeRates.json:", e.message);
  }
}

async function fetchExchangeRatesFromCbr() {
  const data = await httpsGetJson(CBR_URL);
  if (!data || !data.Valute) throw new Error("Некорректный ответ ЦБ РФ");

  const rates = {};
  for (const code of KURS_CODES) {
    const v = data.Valute[code];
    if (v && v.Nominal) {
      rates[code] = v.Value / v.Nominal; // рублей за 1 единицу валюты
    }
  }

  exchangeState = {
    fetchedAt: Date.now(),
    date: data.Date || new Date().toISOString(),
    rates,
  };
  saveExchangeRatesToDisk();
  return exchangeState;
}

// Возвращает актуальные курсы, при необходимости обновляя их (не чаще раза в сутки)
async function getExchangeRates() {
  const isStale = !exchangeState.fetchedAt || (Date.now() - exchangeState.fetchedAt) > EXCHANGE_TTL_MS;
  if (isStale) {
    try {
      await fetchExchangeRatesFromCbr();
    } catch (e) {
      console.error("Не удалось обновить курс валют:", e.message);
      // если обновить не удалось, но старые данные есть - используем их дальше
    }
  }
  return exchangeState;
}

// Фоновое автообновление раз в сутки, чтобы курс был свежим даже без обращений пользователя
function scheduleExchangeAutoUpdate() {
  setInterval(() => {
    fetchExchangeRatesFromCbr().catch((e) =>
      console.error("Ошибка автообновления курса валют:", e.message)
    );
  }, EXCHANGE_TTL_MS);
}

/* =========================================================================
   ГРУППЫ — бот работает как в бизнес-чатах, так и в обычных группах/лс
   ========================================================================= */

// business_connection_id нужен только для эмуляции бизнес-аккаунта.
// В обычных группах/личных чатах с самим ботом это поле не передаём.
function bcid(conn) {
  return conn && conn.isGroup ? undefined : (conn ? conn.id : undefined);
}

// "Псевдо-подключение" для группы/личного чата с ботом - хранится в той же
// коллекции connections (файл connections.json), чтобы переживать перезапуск,
// и чтобы для него так же работали .lang, .balance, .kub и т.д.
async function getOrCreateChatConn(chatId) {
  const key = `grp_${chatId}`;
  let conn = connections.get(key);
  if (!conn) {
    conn = { id: key, isGroup: true, ownerUserId: null, lang: DEFAULT_LANG };
    connections.set(key, conn);
    scheduleSave();
  }
  return conn;
}

// Проверка прав: только админы группы (или создатель) могут запускать команды,
// способные заспамить чат (.spam, .stop), чтобы бот нельзя было использовать
// для флуда группы любым случайным участником.
async function isGroupAdmin(chatId, userId) {
  const res = await tg("getChatMember", { chat_id: chatId, user_id: userId });
  const status = res?.result?.status;
  return status === "administrator" || status === "creator";
}

/* =========================================================================
   ЛОКАЛИЗАЦИЯ (i18n)
   ========================================================================= */

const DEFAULT_LANG = "ru";
const SUPPORTED_LANGS = ["ru", "en"];

// Возвращает текущий язык подключения (по умолчанию ru)
function getLang(conn) {
  return conn && SUPPORTED_LANGS.includes(conn.lang) ? conn.lang : DEFAULT_LANG;
}

function setLang(conn, lang) {
  conn.lang = lang;
  connections.set(conn.id, conn);
  scheduleSave();
}

const I18N = {
  ru: {
    commandsHelp: [
      ".mock <текст> — случайный регистр букв (Mocking SpongeBob)",
      ".love [имя] — анимация сердечка",
      ".help — список всех команд",
      ".spam [число] <текст> — отправить текст N раз (по умолчанию 50, максимум 500)",
      ".stop — остановить текущий .spam в этом чате",
      ".flip — подбросить монетку",
      ".ox — крестики-нолики против друга (.ox [1-9] — сделать ход)",
      ".kub [ставка] — бросить кубик, при ставке играем на виртуальные очки",
      ".balance — посмотреть баланс виртуальных очков",
      ".roll [N] — случайное число от 1 до N (по умолчанию 100)",
      ".8ball <вопрос> — спросить шар предсказаний",
      ".rps <камень|ножницы|бумага> — игра против друга",
      ".choose A, B, C — случайный выбор из вариантов через запятую",
      ".ping — проверить задержку ответа бота",
      ".quote — случайная цитата для настроения",
      ".lang [ru|en] — сменить язык ответов бота",
      ".switch [текст] — перевести текст (или последнее сообщение собеседника) и отправить в чат",
      ".kurs — курс рубля к доллару, евро, тенге и гривне (обновляется раз в сутки)",
      ".pils — случайная таблетка из списка",
      ".rimming <имя> — сделать римминг кому-нибудь",
      ".text <текст> — исправить текст и расставить знаки препинания",
      ".calc <выражение> — калькулятор (`+ - * / % ^`, скобки)",
      ".duel [ставка] — дуэль 1 на 1, второй игрок принимает вызов кнопкой",
    ].join("\n"),
    helpHeader: "📋 Доступные команды:\n\n",
    flipHeads: "🪙 Орёл!",
    flipTails: "🪙 Решка!",
    roll: (n, max) => `🎯 ${n} (от 1 до ${max})`,
    oxTitle: "🎮 **Крестики-нолики 1 на 1**",
    oxIntro: "\n\nПервый нажавший будет играть за ❌",
    oxFinished: (status) => `🎮 **Крестики-нолики 1 на 1**\n\n🏁 ${status}`,
    oxDraw: "🤝 Ничья!",
    oxWin: (mark) => `🎉 Победил: ${mark === "X" ? "Игрок ❌" : "Игрок ⭕"}!`,
    oxTurn: (mark) => `Ход: ${mark}`,
    kubInsufficient: (balance) => `❌ Недостаточно очков для ставки. Баланс: ${balance}`,
    kubWin: (value, stake) => `🎉 Выпало ${value} — вы выиграли ${stake} очков!`,
    kubLose: (value, stake) => `😢 Выпало ${value} — вы проиграли ${stake} очков.`,
    kubBalanceLine: (balance) => `\nБаланс: ${balance} очков (виртуальных, не реальные деньги)`,
    spamUsage:
      "Использование: .spam [количество] <текст>\nПример: .spam 20 привет\nОстановить в любой момент: .stop",
    spamStopped: (sent, count) => `⏹ Остановлено: отправлено ${sent} из ${count}`,
    spamNothing: "Сейчас ничего не отправляется.",
    spamAdminOnly: "⛔ В группах эту команду может использовать только администратор.",
    eightBallUsage: "Задайте вопрос: .8ball Стоит ли мне это делать?",
    eightBallThinking: "🎱 Думаю...",
    eightBallAnswer: (a) => `🎱 ${a}`,
    eightBallAnswers: [
      "Бесспорно", "Да", "Скорее всего да", "Сложно сказать, попробуй ещё раз",
      "Не рассчитывай на это", "Нет", "Мои источники говорят нет", "Весьма сомнительно",
      "Знаки говорят да", "Лучше не рассказывать тебе сейчас",
    ],
    mockUsage: "Напиши текст: .mock ну да, конечно",
    loveSentWithTarget: (target) => `❤️ Любовь отправлена для ${target}! ❤️`,
    loveSentNoTarget: "❤️ Любовь отправлена! ❤️",
    quoteEmpty: "❌ Список цитат пуст!",
    quotePrefix: (q) => `💬 ${q}`,
    quotes: [
      "Лучшее время посадить дерево было 20 лет назад. Следующее лучшее — сейчас.",
      "Сделай это сегодня, завтра придумаешь новую причину отложить.",
      "Маленькие шаги каждый день складываются в большой путь.",
      "Не сравнивай свою главу 1 с чужой главой 20.",
      "Дисциплина — это выбор между тем, что хочешь сейчас, и тем, что хочешь больше всего.",
    ],
    rpsTitle: "👊 **Камень, ножницы, бумага!**\nВыберите свой ход:",
    rpsWaiting: (name) => `🎮 **РПС 1 на 1**\n\nИгрок ${name} сделал ход. Ждем второго...`,
    rpsResult: (result, name1, c1, name2, c2) =>
      `🎮 **РПС 1 на 1**\n\nИтог: ${result}\n${name1}: ${c1} vs ${name2}: ${c2}`,
    rpsDraw: "🤝 Ничья!",
    rpsWinner: (name) => `🎉 Победил игрок ${name}!`,
    balanceText: (b) => `💰 Ваш баланс: ${b} виртуальных очков`,
    chooseUsage: "Использование: .choose вариант1, вариант2, вариант3",
    choosePick: (pick) => `👉 ${pick}`,
    pingText: (ms) => `🏓 Понг! Задержка: ${ms} мс`,
    langUsage: (current) =>
      `🌐 Текущий язык: ${current}\nИспользование: .lang en — переключить на английский\n.lang ru — переключить на русский`,
    langSet: (lang) => `✅ Язык переключен на: ${lang === "ru" ? "русский 🇷🇺" : "английский 🇬🇧"}`,
    unknownLang: (lang) => `❌ Неизвестный язык: ${lang}\nДоступно: ru, en`,
    switchTranslating: "🌐 Перевожу...",
    switchNoLastMessage: "❌ Нет сообщений собеседника для перевода в этом чате.",
    switchError: "❌ Не удалось перевести текст. Попробуйте позже.",
    kursTitle: "💱 **Курс рубля**",
    kursLoading: "💱 Загружаю актуальный курс...",
    kursNames: { USD: "🇺🇸 Доллар США", EUR: "🇪🇺 Евро", KZT: "🇰🇿 Тенге", UAH: "🇺🇦 Гривна" },
    kursFooter: (date) => `\n🕒 Обновлено: ${date}`,
    kursError: "❌ Не удалось получить курс валют. Попробуйте позже.",
    pilsPrefix: (name) => `💊 ${name}`,
    pils: ["Драмина", "Донормил", "Ксани", "Зенни", "Димедрол", "Атаракс"],
    rimmingUsage: "Укажите имя: .rimming Вася",
    rimmingDone: (name) => `👅 Сделал(а) римминг для ${name}`,
    textUsage: "Напишите текст: .text привет как дела надеюсь у тебя все хорошо",
    textResult: (fixed) => ` ${fixed}`,
    calcUsage: "Использование: .calc <выражение>\nПример: .calc (2+3)*4^2/7",
    calcResult: (expr, result) => ` ${expr} = ${result}`,
    calcError: "❌ Не удалось посчитать выражение. Проверьте синтаксис (доступно: + - * / % ^ ( )).",
    duelUsage: "Использование: .duel [ставка]\nПример: .duel 100 — вызов на дуэль со ставкой 100 очков\n.duel — дуэль без ставки",
    duelAcceptButton: "⚔️ Принять вызов",
    duelChallenge: (name, stake) =>
      stake > 0
        ? `⚔️ **Дуэль!**\n\n${name} вызывает на дуэль со ставкой ${stake} очков!\nКто примет вызов?`
        : `⚔️ **Дуэль!**\n\n${name} вызывает на дуэль!\nКто примет вызов?`,
    duelInsufficient: (balance) => `❌ Недостаточно очков для такой ставки. Баланс: ${balance}`,
    duelAcceptorInsufficient: (name, balance) => `❌ У ${name} недостаточно очков для этой ставки (баланс: ${balance}). Дуэль всё ещё открыта.`,
    duelResult: (name1, name2, winner, stake) =>
      stake > 0
        ? `⚔️ **Дуэль!**\n\n${name1} vs ${name2}\n\n🏆 Победил: ${winner}!\n💰 Забрал ${stake} очков у соперника.`
        : `⚔️ **Дуэль!**\n\n${name1} vs ${name2}\n\n🏆 Победил: ${winner}!`,
  },
  en: {
    commandsHelp: [
      ".mock <text> — random letter case (Mocking SpongeBob)",
      ".love [name] — heart animation",
      ".help — list of all commands",
      ".spam [count] <text> — send text N times (default 50, max 500)",
      ".stop — stop the current .spam in this chat",
      ".flip — flip a coin",
      ".ox — tic-tac-toe against a friend (.ox [1-9] — make a move)",
      ".kub [bet] — roll a die, bet virtual points",
      ".balance — check your virtual points balance",
      ".roll [N] — random number from 1 to N (default 100)",
      ".8ball <question> — ask the magic 8-ball",
      ".rps <rock|scissors|paper> — play against a friend",
      ".choose A, B, C — random pick from comma-separated options",
      ".ping — check bot response latency",
      ".quote — random mood-boosting quote",
      ".lang [ru|en] — change the bot's response language",
      ".switch [text] — translate text (or the other person's last message) and send it to the chat",
      ".kurs — RUB exchange rate vs USD, EUR, KZT, UAH (updates once a day)",
      ".pils — random pill from a list",
      ".rimming <name> — perform rimming on someone",
      ".text <text> — fix text and add punctuation",
      ".calc <expression> — calculator (`+ - * / % ^`, parentheses)",
      ".duel [bet] — 1v1 duel, the second player accepts the challenge with a button",
    ].join("\n"),
    helpHeader: "📋 Available commands:\n\n",
    flipHeads: "🪙 Heads!",
    flipTails: "🪙 Tails!",
    roll: (n, max) => `🎯 ${n} (from 1 to ${max})`,
    oxTitle: "🎮 **Tic-Tac-Toe 1v1**",
    oxIntro: "\n\nWhoever taps first plays as ❌",
    oxFinished: (status) => `🎮 **Tic-Tac-Toe 1v1**\n\n🏁 ${status}`,
    oxDraw: "🤝 Draw!",
    oxWin: (mark) => `🎉 Winner: ${mark === "X" ? "Player ❌" : "Player ⭕"}!`,
    oxTurn: (mark) => `Turn: ${mark}`,
    kubInsufficient: (balance) => `❌ Not enough points to bet. Balance: ${balance}`,
    kubWin: (value, stake) => `🎉 Rolled ${value} — you won ${stake} points!`,
    kubLose: (value, stake) => `😢 Rolled ${value} — you lost ${stake} points.`,
    kubBalanceLine: (balance) => `\nBalance: ${balance} points (virtual, not real money)`,
    spamUsage:
      "Usage: .spam [count] <text>\nExample: .spam 20 hello\nStop anytime with: .stop",
    spamStopped: (sent, count) => `⏹ Stopped: sent ${sent} of ${count}`,
    spamNothing: "Nothing is being sent right now.",
    spamAdminOnly: "⛔ In groups, only an admin can use this command.",
    eightBallUsage: "Ask a question: .8ball Should I do this?",
    eightBallThinking: "🎱 Thinking...",
    eightBallAnswer: (a) => `🎱 ${a}`,
    eightBallAnswers: [
      "It is certain", "Yes", "Most likely yes", "Hard to say, try again",
      "Don't count on it", "No", "My sources say no", "Very doubtful",
      "Signs point to yes", "Better not tell you now",
    ],
    mockUsage: "Write some text: .mock oh sure, of course",
    loveSentWithTarget: (target) => `❤️ Love sent to ${target}! ❤️`,
    loveSentNoTarget: "❤️ Love sent! ❤️",
    quoteEmpty: "❌ Quote list is empty!",
    quotePrefix: (q) => `💬 ${q}`,
    quotes: [
      "The best time to plant a tree was 20 years ago. The next best time is now.",
      "Do it today, tomorrow you'll just find a new excuse.",
      "Small steps each day add up to a long journey.",
      "Don't compare your chapter 1 to someone else's chapter 20.",
      "Discipline is choosing between what you want now and what you want most.",
    ],
    rpsTitle: "👊 **Rock, Paper, Scissors!**\nChoose your move:",
    rpsWaiting: (name) => `🎮 **RPS 1v1**\n\nPlayer ${name} made their move. Waiting for the second player...`,
    rpsResult: (result, name1, c1, name2, c2) =>
      `🎮 **RPS 1v1**\n\nResult: ${result}\n${name1}: ${c1} vs ${name2}: ${c2}`,
    rpsDraw: "🤝 Draw!",
    rpsWinner: (name) => `🎉 Player ${name} wins!`,
    balanceText: (b) => `💰 Your balance: ${b} virtual points`,
    chooseUsage: "Usage: .choose option1, option2, option3",
    choosePick: (pick) => `👉 ${pick}`,
    pingText: (ms) => `🏓 Pong! Latency: ${ms} ms`,
    langUsage: (current) =>
      `🌐 Current language: ${current}\nUsage: .lang en — switch to English\n.lang ru — switch to Russian`,
    langSet: (lang) => `✅ Language switched to: ${lang === "ru" ? "Russian 🇷🇺" : "English 🇬🇧"}`,
    unknownLang: (lang) => `❌ Unknown language: ${lang}\nAvailable: ru, en`,
    switchTranslating: "🌐 Translating...",
    switchNoLastMessage: "❌ No message from the other person to translate in this chat.",
    switchError: "❌ Failed to translate the text. Try again later.",
    kursTitle: "💱 **Ruble exchange rate**",
    kursLoading: "💱 Fetching current exchange rate...",
    kursNames: { USD: "🇺🇸 US Dollar", EUR: "🇪🇺 Euro", KZT: "🇰🇿 Tenge", UAH: "🇺🇦 Hryvnia" },
    kursFooter: (date) => `\n🕒 Updated: ${date}`,
    kursError: "❌ Failed to fetch exchange rates. Try again later.",
    pilsPrefix: (name) => `💊 ${name}`,
    pils: ["Драмина", "Донормил", "Ксани", "Зенни", "Димедрол", "Атаракс"],
    rimmingUsage: "Specify a name: .rimming John",
    rimmingDone: (name) => `👅 Performed rimming on ${name}`,
    textUsage: "Write some text: .text hi how are you hope youre doing well",
    textResult: (fixed) => ` ${fixed}`,
    calcUsage: "Usage: .calc <expression>\nExample: .calc (2+3)*4^2/7",
    calcResult: (expr, result) => ` ${expr} = ${result}`,
    calcError: "❌ Could not evaluate the expression. Check the syntax (allowed: + - * / % ^ ( )).",
    duelUsage: "Usage: .duel [bet]\nExample: .duel 100 — challenge with a 100-point bet\n.duel — a duel with no bet",
    duelAcceptButton: "⚔️ Accept the challenge",
    duelChallenge: (name, stake) =>
      stake > 0
        ? `⚔️ **Duel!**\n\n${name} challenges someone to a duel for ${stake} points!\nWho will accept?`
        : `⚔️ **Duel!**\n\n${name} challenges someone to a duel!\nWho will accept?`,
    duelInsufficient: (balance) => `❌ Not enough points for that bet. Balance: ${balance}`,
    duelAcceptorInsufficient: (name, balance) => `❌ ${name} doesn't have enough points for this bet (balance: ${balance}). The duel is still open.`,
    duelResult: (name1, name2, winner, stake) =>
      stake > 0
        ? `⚔️ **Duel!**\n\n${name1} vs ${name2}\n\n🏆 Winner: ${winner}!\n💰 Took ${stake} points from the opponent.`
        : `⚔️ **Duel!**\n\n${name1} vs ${name2}\n\n🏆 Winner: ${winner}!`,
  },
};

// t(conn, "key") -> строка/функция из соответствующего языка
function t(conn, key) {
  const lang = getLang(conn);
  return I18N[lang][key] ?? I18N[DEFAULT_LANG][key];
}

/* ========================================================================= */

function emptyBoard() { return Array(9).fill(" "); }

function checkWinner(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (let [a,b,c] of lines) {
    if (board[a] !== " " && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.includes(" ") ? null : "draw";
}

function generateOxKeyboard(board, isGameOver = false) {
  const keyboard = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const idx = r * 3 + c;
      const val = board[idx];
      let text = val === " " ? String(idx + 1) : (val === "X" ? "❌" : "⭕");
      const callback_data = (isGameOver || val !== " ") ? "ox_noop" : `ox_move_${idx}`;
      row.push({ text, callback_data });
    }
    keyboard.push(row);
  }
  return { inline_keyboard: keyboard };
}

async function cmdOx(conn, chatId, messageId, args) {
  const key = `${conn.id}_${chatId}`;
  const board = emptyBoard();
  games.set(key, { board, playerX: null, playerO: null });
  scheduleSaveExtra();

  await beginCommandResponse(
    conn,
    chatId,
    messageId,
    `${t(conn, "oxTitle")}${t(conn, "oxIntro")}`,
    generateOxKeyboard(board)
  );
}

async function processOxMove(conn, chatId, messageId, pos, userId) {
  const key = `${conn.id}_${chatId}`;
  let game = games.get(key);
  if (!game) return;
  if (!game.playerX) game.playerX = userId;
  else if (!game.playerO && userId !== game.playerX) game.playerO = userId;
  const isXTurn = game.board.filter(c => c !== " ").length % 2 === 0;
  if (isXTurn && userId !== game.playerX) return;
  if (!isXTurn && userId !== game.playerO) return;
  if (game.board[pos] !== " ") return;
  game.board[pos] = isXTurn ? "X" : "O";

  let winner = checkWinner(game.board);
  games.set(key, game);
  scheduleSaveExtra();
  let status = winner === "draw"
    ? t(conn, "oxDraw")
    : (winner ? t(conn, "oxWin")(winner) : t(conn, "oxTurn")(isXTurn ? "⭕" : "❌"));

  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    business_connection_id: bcid(conn),
    text: t(conn, "oxFinished")(status),
    parse_mode: "Markdown",
    reply_markup: JSON.stringify(generateOxKeyboard(game.board, !!winner))
  });

  if (winner) games.delete(key);
}
async function processRpsMove(conn, chatId, messageId, choice, userId, firstName) {
  const key = `rps_${conn.id}_${chatId}`;
  let game = games.get(key) || { players: {}, choices: {}, names: {} };
  if (!game) {
    game = { players: {}, choices: {}, names: {} };
  }

  if (!game.names) game.names = {};
  if (!game.choices) game.choices = {};
  game.choices[userId] = choice;
  game.players[userId] = true;
  game.names[userId] = firstName; // Сохраняем имя (первое имя пользователя)

  const playerIds = Object.keys(game.choices);
  if (playerIds.length === 2) {
    const p1 = playerIds[0];
    const p2 = playerIds[1];
    const name1 = game.names[p1];
    const name2 = game.names[p2];
    const c1 = game.choices[p1];
    const c2 = game.choices[p2];

    let result = "";
    if (c1 === c2) result = t(conn, "rpsDraw");
    else if (
      (c1 === "камень" && c2 === "ножницы") ||
      (c1 === "ножницы" && c2 === "бумага") ||
      (c1 === "бумага" && c2 === "камень")
    ) result = t(conn, "rpsWinner")(name1);
    else result = t(conn, "rpsWinner")(name2);

    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      business_connection_id: bcid(conn),
      text: t(conn, "rpsResult")(result, name1, c1, name2, c2),
      parse_mode: "Markdown"
    });
    games.delete(key);
  } else {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      business_connection_id: bcid(conn),
      text: t(conn, "rpsWaiting")(game.names[userId]),
      parse_mode: "Markdown",
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: "🪨", callback_data: "rps_камень" },
          { text: "✂️", callback_data: "rps_ножницы" },
          { text: "📄", callback_data: "rps_бумага" }
        ]]
      })
    });
    games.set(key, game);
  }
}
/* =========================================================================
   .text — эвристическое исправление текста и расстановка знаков препинания
   (без обращения к внешним API - работает полностью локально)
   ========================================================================= */
function fixText(input) {
  let s = input.trim();
  if (!s) return s;

  // схлопываем повторяющиеся пробелы/табы/переносы строк в один пробел
  s = s.replace(/\s+/g, " ");

  // убираем пробел перед знаками препинания ("привет ," -> "привет,")
  s = s.replace(/\s+([,.!?;:])/g, "$1");

  // добавляем пробел после знака препинания, если сразу дальше идёт буква/цифра без пробела
  s = s.replace(/([,.!?;:])(?=[^\s\d)])/g, "$1 ");

  // приводим избыточную пунктуацию к разумному виду (не убираем эмоцию совсем, но ограничиваем)
  s = s.replace(/([!?])\1{2,}/g, "$1$1$1");
  s = s.replace(/\.{4,}/g, "...");

  // капитализируем первую букву предложения (в начале строки и после . ! ?)
  s = s.replace(/(^\s*|[.!?]\s+)([a-zа-яё])/gu, (m, p1, p2) => p1 + p2.toUpperCase());

  // капитализируем одиночную английскую "i" (местоимение I)
  s = s.replace(/\bi\b/g, "I");

  // если в конце нет завершающего знака препинания - добавляем точку
  if (!/[.!?…]$/.test(s)) s += ".";

  return s;
}

/* =========================================================================
   .calc — безопасный калькулятор без eval()/Function(): собственный
   токенайзер + рекурсивный спуск, поддержка + - * / % ^ ( ) и унарного минуса
   ========================================================================= */
function tokenizeMath(str) {
  const cleaned = str.trim().replace(/,/g, "."); // допускаем запятую как десятичный разделитель
  const matched = cleaned.match(/\d+\.?\d*|\.\d+|[+\-*/%^()]/g);
  if (!matched) throw new Error("Пустое выражение");

  // защита от мусора: убеждаемся, что во входной строке нет ничего, кроме
  // распознанных токенов и пробелов (иначе строка типа "2+alert(1)" пройдёт мимо)
  const withoutSpaces = cleaned.replace(/\s+/g, "");
  if (matched.join("").length !== withoutSpaces.length) {
    throw new Error("Недопустимые символы в выражении");
  }
  return matched;
}

function evalMathExpression(exprStr) {
  const tokens = tokenizeMath(exprStr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpression() { // + -
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }
  function parseTerm() { // * / %
    let value = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const rhs = parseFactor();
      if ((op === "/" || op === "%") && rhs === 0) throw new Error("Деление на ноль");
      value = op === "*" ? value * rhs : op === "/" ? value / rhs : value % rhs;
    }
    return value;
  }
  function parseFactor() { // ^ (право-ассоциативный)
    const value = parseUnary();
    if (peek() === "^") {
      next();
      return Math.pow(value, parseFactor());
    }
    return value;
  }
  function parseUnary() {
    if (peek() === "-") { next(); return -parseUnary(); }
    if (peek() === "+") { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = next();
    if (tok === "(") {
      const value = parseExpression();
      if (next() !== ")") throw new Error("Ожидалась закрывающая скобка");
      return value;
    }
    const num = tok === undefined ? NaN : parseFloat(tok);
    if (isNaN(num)) throw new Error("Некорректное выражение");
    return num;
  }

  const result = parseExpression();
  if (pos !== tokens.length) throw new Error("Некорректное выражение");
  if (!isFinite(result)) throw new Error("Некорректный результат");

  // округляем плавающую погрешность (0.1+0.2 и т.п.), но сохраняем целые числа как есть
  return Math.round(result * 1e10) / 1e10;
}

/* =========================================================================
   .duel — дуэль 1 на 1: игрок бросает вызов, второй принимает кнопкой,
   победитель определяется случайно; если указана ставка - очки переходят
   от проигравшего к победителю (используется общий баланс, как в .kub)
   ========================================================================= */
async function cmdDuel(conn, chatId, messageId, userId, firstName, args) {
  const key = `duel_${conn.id}_${chatId}`;
  const stake = Math.max(0, parseInt(args[0], 10) || 0);

  if (stake > 0) {
    const balance = getBalance(conn, userId);
    if (stake > balance) {
      await editCommandResponse(conn, chatId, messageId, t(conn, "duelInsufficient")(balance));
      return;
    }
  }

  games.set(key, { challengerId: userId, challengerName: firstName, stake });
  scheduleSaveExtra();

  await beginCommandResponse(
    conn,
    chatId,
    messageId,
    t(conn, "duelChallenge")(firstName, stake),
    { inline_keyboard: [[{ text: t(conn, "duelAcceptButton"), callback_data: "duel_accept" }]] }
  );
}

async function processDuelAccept(conn, chatId, messageId, userId, firstName) {
  const key = `duel_${conn.id}_${chatId}`;
  const game = games.get(key);
  if (!game) return;
  if (userId === game.challengerId) return; // нельзя принять собственный вызов

  if (game.stake > 0) {
    const balance = getBalance(conn, userId);
    if (balance < game.stake) {
      // ставка слишком велика для принявшего - вызов остаётся открытым для других
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        business_connection_id: bcid(conn),
        text: `${t(conn, "duelChallenge")(game.challengerName, game.stake)}\n\n${t(conn, "duelAcceptorInsufficient")(firstName, balance)}`,
        parse_mode: "Markdown",
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: t(conn, "duelAcceptButton"), callback_data: "duel_accept" }]] }),
      });
      return;
    }
  }

  const challengerWins = Math.random() < 0.5;
  const winnerName = challengerWins ? game.challengerName : firstName;

  if (game.stake > 0) {
    const winnerId = challengerWins ? game.challengerId : userId;
    const loserId = challengerWins ? userId : game.challengerId;
    setBalance(conn, winnerId, getBalance(conn, winnerId) + game.stake);
    setBalance(conn, loserId, getBalance(conn, loserId) - game.stake);
  }

  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    business_connection_id: bcid(conn),
    text: t(conn, "duelResult")(game.challengerName, firstName, winnerName, game.stake),
    parse_mode: "Markdown",
  });

  games.delete(key);
  scheduleSaveExtra();
}

async function cmdKub(conn, chatId, userId, args) {
  const stake = parseInt(args[0], 10);

  if (!args[0] || isNaN(stake) || stake <= 0) {
    await tg("sendDice", { chat_id: chatId, business_connection_id: bcid(conn), emoji: "🎲" });
    return;
  }

  const balance = getBalance(conn, userId);
  if (stake > balance) {
    await sendAsBusiness(conn, chatId, t(conn, "kubInsufficient")(balance));
    return;
  }

  const res = await tg("sendDice", { chat_id: chatId, business_connection_id: bcid(conn), emoji: "🎲" });
  const value = res?.result?.dice?.value;
  if (!value) return;

  let newBalance;
  let outcome;
  if (value >= 4) {
    newBalance = balance + stake;
    outcome = t(conn, "kubWin")(value, stake);
  } else {
    newBalance = balance - stake;
    outcome = t(conn, "kubLose")(value, stake);
  }
  setBalance(conn, userId, newBalance);
  await sleep(3500);
  await sendAsBusiness(conn, chatId, `${outcome}${t(conn, "kubBalanceLine")(newBalance)}`);
}
const activeSpam = new Map(); // `${connId}_${chatId}` -> { cancelled: boolean }

async function cmdSpam(conn, chatId, args) {
  let count = 50;
  let textArgs = args;
  if (args.length > 1 && /^\d+$/.test(args[0])) {
    count = parseInt(args[0], 10);
    textArgs = args.slice(1);
  }

  const text = textArgs.join(" ").trim();
  if (!text) {
    await sendAsBusiness(conn, chatId, t(conn, "spamUsage"));
    return;
  }

  const MAX_REPEAT = 500;
  count = Math.min(Math.max(count, 1), MAX_REPEAT);

  const key = `${conn.id}_${chatId}`;
  const state = { cancelled: false };
  activeSpam.set(key, state);

  let sent = 0;
  for (let i = 0; i < count; i++) {
    if (state.cancelled) break;
    await sendAsBusiness(conn, chatId, text);
    sent++;
    await sleep(350); // пауза, чтобы не словить ограничение Telegram на частоту сообщений
  }

  activeSpam.delete(key);

  if (state.cancelled) {
    await sendAsBusiness(conn, chatId, t(conn, "spamStopped")(sent, count));
  }
}

async function cmdStop(conn, chatId) {
  const key = `${conn.id}_${chatId}`;
  const state = activeSpam.get(key);
  if (state) {
    state.cancelled = true;
  } else {
    await sendAsBusiness(conn, chatId, t(conn, "spamNothing"));
  }
}

// --- .love: анимация сердечка через последовательное редактирование сообщения ---
const LOVE_FRAMES = [
  "🤍",
  "🤍 🤍",
  "💗",
  "💗 💗",
  "💖 💖 💖",
  "❤️ ❤️ ❤️ ❤️",
  "❤️❤️❤️❤️❤️❤️❤️",
];

async function cmdLove(conn, chatId, args) {
  const target = args.join(" ").trim();

  const sent = await tg("sendMessage", {
    chat_id: chatId,
    business_connection_id: bcid(conn),
    text: LOVE_FRAMES[0],
  });
  const messageId = sent?.result?.message_id;
  if (!messageId) return; // не удалось отправить первое сообщение - дальше анимировать нечего

  for (let i = 1; i < LOVE_FRAMES.length; i++) {
    await sleep(400);
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      business_connection_id: bcid(conn),
      text: LOVE_FRAMES[i],
    });
  }

  await sleep(400);
  const finalText = target ? t(conn, "loveSentWithTarget")(target) : t(conn, "loveSentNoTarget");
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    business_connection_id: bcid(conn),
    text: finalText,
  });
}

async function cmdKurs(conn, chatId, messageId) {
  const workingId = await beginCommandResponse(conn, chatId, messageId, t(conn, "kursLoading"));

  let state;
  try {
    state = await getExchangeRates();
  } catch (e) {
    state = null;
  }

  if (!state || !state.rates || Object.keys(state.rates).length === 0) {
    await updateCommandResponse(conn, chatId, workingId, t(conn, "kursError"));
    return;
  }

  const names = t(conn, "kursNames");
  const lines = [];
  for (const code of KURS_CODES) {
    const rate = state.rates[code];
    if (rate === undefined) continue;
    // KZT/UAH обычно дешевле рубля - показываем больше знаков после запятой для читаемости
    const decimals = rate < 1 ? 4 : 2;
    lines.push(`${names[code]}: **${rate.toFixed(decimals)} ₽**`);
  }

  const dateStr = state.date ? new Date(state.date).toLocaleDateString(getLang(conn) === "ru" ? "ru-RU" : "en-US") : "—";

  const text = `${t(conn, "kursTitle")}\n\n${lines.join("\n")}${t(conn, "kursFooter")(dateStr)}`;

  await updateCommandResponse(conn, chatId, workingId, text);
}

/* =========================================================================
   ПЕРЕВОДЧИК (.switch) — неофициальный бесплатный эндпоинт Google Translate
   ========================================================================= */

// Храним последнее входящее (от собеседника, не от владельца) сообщение по каждому чату,
// чтобы .switch без аргументов знал, что переводить.
const LAST_INCOMING_FILE = path.join(__dirname, "lastIncoming.json");
let lastIncoming = loadJsonMap(LAST_INCOMING_FILE);
let saveLastIncomingTimer = null;
function scheduleSaveLastIncoming() {
  if (saveLastIncomingTimer) return;
  saveLastIncomingTimer = setTimeout(() => {
    saveLastIncomingTimer = null;
    try {
      fs.writeFileSync(LAST_INCOMING_FILE, JSON.stringify(Object.fromEntries(lastIncoming)));
    } catch (e) {
      console.error("Не удалось сохранить lastIncoming.json:", e.message);
    }
  }, 1000);
}
function rememberLastIncoming(connId, chatId, text) {
  if (!text) return;
  lastIncoming.set(`${connId}_${chatId}`, text);
  scheduleSaveLastIncoming();
}

async function googleTranslateRequest(text, sl, tl) {
  const params = new URLSearchParams({ client: "gtx", sl, tl, dt: "t", q: text });
  const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const data = await httpsGetJson(url);
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Некорректный ответ переводчика");
  }
  const translated = data[0].map((chunk) => chunk[0]).filter(Boolean).join("");
  const detectedLang = data[2] || sl;
  return { translated, detectedLang };
}

// Переводит текст на "противоположный" язык: если оригинал английский - переводит на русский,
// если оригинал любой другой (обычно русский) - переводит на английский.
async function translateAuto(text) {
  const first = await googleTranslateRequest(text, "auto", "en");
  if (first.detectedLang && first.detectedLang.toLowerCase().startsWith("en")) {
    const second = await googleTranslateRequest(text, "en", "ru");
    return { translated: second.translated, from: "en", to: "ru" };
  }
  return { translated: first.translated, from: first.detectedLang, to: "en" };
}

async function cmdSwitch(conn, chatId, messageId, args) {
  const workingId = await beginCommandResponse(conn, chatId, messageId, t(conn, "switchTranslating"), null);

  let sourceText;
  if (args.length) {
    sourceText = args.join(" ");
  } else {
    sourceText = lastIncoming.get(`${conn.id}_${chatId}`);
    if (!sourceText) {
      await updateCommandResponse(conn, chatId, workingId, t(conn, "switchNoLastMessage"));
      return;
    }
  }

  let result;
  try {
    result = await translateAuto(sourceText);
  } catch (e) {
    console.error("Ошибка перевода:", e.message);
    await updateCommandResponse(conn, chatId, workingId, t(conn, "switchError"));
    return;
  }

  // Финальное сообщение - просто переведённый текст, без служебных пометок и без Markdown,
  // чтобы это выглядело как обычное сообщение в чате и не ломалось на спецсимволах перевода.
  await updateCommandResponse(conn, chatId, workingId, result.translated, { markdown: false });
}

async function handleCallback(callbackQuery) {
  const { id, data, message, from } = callbackQuery;
  const chatId = message.chat.id;
  const connId = message.business_connection_id;
  const conn = connId ? connections.get(connId) : await getOrCreateChatConn(chatId);

  await tg("answerCallbackQuery", { callback_query_id: id });

  if (conn && data.startsWith("ox_move_")) {
    const pos = parseInt(data.split("_")[2], 10);
    await processOxMove(conn, chatId, message.message_id, pos, from.id);
  }

  if (conn && data.startsWith("rps_")) {
    const choice = data.split("_")[1];
    await processRpsMove(conn, chatId, message.message_id, choice, from.id, from.first_name);
  }

  if (conn && data === "duel_accept") {
    await processDuelAccept(conn, chatId, message.message_id, from.id, from.first_name);
  }
}

// Начинает ответ на команду:
// - в бизнес-чате редактирует само командное сообщение владельца (это разрешено через business-подключение)
// - в группе/личном чате с ботом редактировать чужое сообщение нельзя, поэтому отправляем новое
// Возвращает message_id сообщения, которое дальше можно редактировать (updateCommandResponse).
async function beginCommandResponse(conn, chatId, commandMessageId, text, markup = null, markdown = true) {
  if (conn.isGroup) {
    const sent = await tg("sendMessage", {
      chat_id: chatId,
      reply_to_message_id: commandMessageId,
      text,
      parse_mode: markdown ? "Markdown" : undefined,
      reply_markup: markup ? JSON.stringify(markup) : undefined,
    });
    return sent?.result?.message_id || null;
  }
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: commandMessageId,
    business_connection_id: bcid(conn),
    text,
    parse_mode: markdown ? "Markdown" : undefined,
    reply_markup: markup ? JSON.stringify(markup) : undefined,
  });
  return commandMessageId;
}

// Редактирует уже существующее "рабочее" сообщение бота (полученное из beginCommandResponse
// или взятое из callback query) - одинаково работает и в группе, и в бизнес-чате,
// потому что в обоих случаях это сообщение либо принадлежит боту, либо доступно через business-подключение.
async function updateCommandResponse(conn, chatId, workingMessageId, text, { markup = null, markdown = true } = {}) {
  if (!workingMessageId) return;
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: workingMessageId,
    business_connection_id: bcid(conn),
    text,
    parse_mode: markdown ? "Markdown" : undefined,
    reply_markup: markup ? JSON.stringify(markup) : undefined,
  });
}

// Обёртка для простых одношаговых ответов (.flip, .roll, .balance и т.д.) - под капотом
// использует beginCommandResponse, дальнейшее редактирование им не требуется.
// markdown=false стоит передавать всегда, когда в text подставляется произвольный
// пользовательский ввод (.text, .calc) - иначе непарный "*"/"_"/"`" в тексте
// пользователя ломает parse_mode: "Markdown" на стороне Telegram (Bad Request: can't parse entities).
async function editCommandResponse(conn, chatId, messageId, text, markup = null, markdown = true) {
  await beginCommandResponse(conn, chatId, messageId, text, markup, markdown);
}

async function handleCommand(conn, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();

  switch (cmd) {
    case ".help":
      await editCommandResponse(conn, chatId, msg.message_id, `${t(conn, "helpHeader")}${t(conn, "commandsHelp")}`);
      return true;

    case ".lang": {
      const arg = (args[0] || "").toLowerCase();
      const current = getLang(conn);
      if (!arg) {
        // без аргумента - переключаем на противоположный язык
        const next = current === "ru" ? "en" : "ru";
        setLang(conn, next);
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "langSet")(next));
        return true;
      }
      if (!SUPPORTED_LANGS.includes(arg)) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "unknownLang")(arg));
        return true;
      }
      setLang(conn, arg);
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "langSet")(arg));
      return true;
    }

    case ".switch": {
      await cmdSwitch(conn, chatId, msg.message_id, args);
      return true;
    }

    case ".flip":
      await editCommandResponse(conn, chatId, msg.message_id, Math.random() < 0.5 ? t(conn, "flipHeads") : t(conn, "flipTails"));
      return true;

    case ".roll": {
      const max = parseInt(args[0], 10) || 100;
      const n = Math.floor(Math.random() * max) + 1;
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "roll")(n, max));
      return true;
    }

    case ".ox": {
      await cmdOx(conn, chatId, msg.message_id, args);
      return true;
    }

    case ".kub": {
      await cmdKub(conn, chatId, userId, args);
      return true;
    }

    case ".8ball": {
      if (!args.length) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "eightBallUsage"));
        return true;
      }

      await tg("sendMessage", {
        chat_id: chatId,
        business_connection_id: bcid(conn),
        text: t(conn, "eightBallThinking"),
        parse_mode: "Markdown"
      }).then(async (sentMessage) => {
        setTimeout(async () => {
          const answers = t(conn, "eightBallAnswers");
          const answer = answers[Math.floor(Math.random() * answers.length)];
          await tg("editMessageText", {
            chat_id: chatId,
            message_id: sentMessage.result.message_id,
            business_connection_id: bcid(conn),
            text: t(conn, "eightBallAnswer")(answer),
            parse_mode: "Markdown"
          });
        }, 1500);
      });

      return true;
    }

    case ".mock": {
      const text = args.join(" ");
      if (!text) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "mockUsage"));
        return true;
      }
      const mocked = text.split("").map((char, index) => (index % 2 === 0 ? char.toLowerCase() : char.toUpperCase())).join("");
      await editCommandResponse(conn, chatId, msg.message_id, mocked);
      return true;
    }

    case ".love": {
      cmdLove(conn, chatId, args).catch((e) => console.error("Ошибка в .love:", e.message));
      return true;
    }

    case ".quote": {
      const quotes = t(conn, "quotes");
      if (!quotes || quotes.length === 0) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "quoteEmpty"));
        return true;
      }

      const q = quotes[Math.floor(Math.random() * quotes.length)];
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "quotePrefix")(q));
      return true;
    }

    case ".rps": {
      const key = `rps_${conn.id}_${chatId}`;
      games.set(key, { players: {}, choices: {}, names: {} });
      const markup = {
        inline_keyboard: [[
          { text: "🪨", callback_data: "rps_камень" },
          { text: "✂️", callback_data: "rps_ножницы" },
          { text: "📄", callback_data: "rps_бумага" }
        ]]
      };
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "rpsTitle"), markup);
      return true;
    }

    case ".balance": {
      const b = getBalance(conn, userId);
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "balanceText")(b));
      return true;
    }

    case ".choose": {
      const options = args.join(" ").split(",").map((s) => s.trim()).filter(Boolean);
      if (options.length < 2) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "chooseUsage"));
        return true;
      }
      const pick = options[Math.floor(Math.random() * options.length)];
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "choosePick")(pick));
      return true;
    }

    case ".ping": {
      const start = Date.now();
      const ms = Date.now() - start;
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "pingText")(ms));
      return true;
    }

    case ".kurs": {
      await cmdKurs(conn, chatId, msg.message_id);
      return true;
    }

    case ".pils": {
      const list = t(conn, "pils");
      const pick = list[Math.floor(Math.random() * list.length)];
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "pilsPrefix")(pick));
      return true;
    }

    case ".rimming": {
      const name = args.join(" ").trim();
      if (!name) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "rimmingUsage"));
        return true;
      }
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "rimmingDone")(name));
      return true;
    }

    case ".spam": {
      if (conn.isGroup && !(await isGroupAdmin(chatId, userId))) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "spamAdminOnly"));
        return true;
      }
      cmdSpam(conn, chatId, args);
      return true;
    }

    case ".stop": {
      if (conn.isGroup && !(await isGroupAdmin(chatId, userId))) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "spamAdminOnly"));
        return true;
      }
      await cmdStop(conn, chatId);
      return true;
    }

    case ".text": {
      const input = args.join(" ").trim();
      if (!input) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "textUsage"), null, false);
        return true;
      }
      const fixed = fixText(input);
      await editCommandResponse(conn, chatId, msg.message_id, t(conn, "textResult")(fixed), null, false);
      return true;
    }

    case ".calc": {
      const expr = args.join(" ").trim();
      if (!expr) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "calcUsage"), null, false);
        return true;
      }
      try {
        const result = evalMathExpression(expr);
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "calcResult")(expr, result), null, false);
      } catch (e) {
        await editCommandResponse(conn, chatId, msg.message_id, t(conn, "calcError"), null, false);
      }
      return true;
    }

    case ".duel": {
      const firstName = msg.from.first_name || "Игрок";
      await cmdDuel(conn, chatId, msg.message_id, userId, firstName, args);
      return true;
    }

    default:
      return false;
  }
}
async function handleBusinessConnection(conn) {
  const existing = connections.get(conn.id);
  connections.set(conn.id, {
    id: conn.id,
    userChatId: conn.user_chat_id,
    ownerUserId: conn.user.id,
    isEnabled: conn.is_enabled,
    lang: existing?.lang || DEFAULT_LANG, // сохраняем ранее выбранный язык, если уже было подключение
  });
  scheduleSave();
}

async function handleBusinessMessage(msg) {
  const connId = msg.business_connection_id;
  if (!connId) return;

  const conn = connections.get(connId);
  if (conn && msg.text && msg.text.startsWith(".") && msg.from && msg.from.id === conn.ownerUserId) {
    const handled = await handleCommand(conn, msg);
    if (handled) return; // команды не кэшируем как обычные сообщения
  }

  // Запоминаем последнее сообщение именно от собеседника (не от владельца аккаунта),
  // чтобы команда .switch без аргументов знала, что переводить.
  if (conn && msg.from && msg.from.id !== conn.ownerUserId) {
    const text = msg.text || msg.caption || "";
    if (text) rememberLastIncoming(connId, msg.chat.id, text);
  }

  cacheMessage(connId, msg);
}

async function handleBotMessage(msg) {
  console.log("Пришло сообщение из чата:", msg.chat.id, "тип:", msg.chat.type, "текст:", msg.text);
  const isPrivate = msg.chat.type === "private";
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isPrivate && !isGroup) return;

  const text = msg.text || msg.caption || "";


  if (isPrivate && text.startsWith("/start")) {
    const welcomeText =
      `👋 Привет! Я Telegram Save Bot.\n\n` +
      `Я умею сохранять удаленные сообщения, кидать кубик, спамить, играть в крестики-нолики и много чего еще.\n\n` +
      `🛠 **Список команд:**\n` +
      `Напишите \`.help\` в любом подключенном чате или прямо здесь, а также в любой группе, где я состою.\n\n` +
      `🔌 **Как подключить меня к вашему аккаунту (режим "бизнес"):**\n` +
      `1. Убедитесь, что у вас есть **Telegram Premium**.\n` +
      `2. Зайдите в Настройки Telegram -> **Telegram для бизнеса** (Telegram Business).\n` +
      `3. Прокрутите вниз до раздела **Чат-боты** (Chatbots).\n` +
      `4. Введите мой юзернейм.\n` +
      `5. Настройте, в каких чатах я буду работать (рекомендую «Все личные чаты», кроме исключений).\n\n` +
      `👥 **Или просто добавьте меня в группу** — команды (.help, .kurs, .ox, .rps и т.д.) будут работать и там.\n` +
      `ceo - @imrealg0at`;

    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: welcomeText,
      parse_mode: "Markdown"
    });
    return;
  }

  if (!text) return;

  // Команды работают и в группах (для всех участников, кроме .spam/.stop - только для админов),
  // и в личном чате напрямую с ботом (не через бизнес-подключение).
  if (text.startsWith(".")) {
    const conn = await getOrCreateChatConn(msg.chat.id);
    await handleCommand(conn, msg);
    return;
  }

  // Запоминаем обычные сообщения в группе/лс, чтобы .switch без аргументов
  // мог перевести последнее сообщение в этом чате.
  const conn = await getOrCreateChatConn(msg.chat.id);
  rememberLastIncoming(conn.id, msg.chat.id, text);
}

async function handleEditedBusinessMessage(msg) {
  const connId = msg.business_connection_id;
  if (!connId) return;
  const conn = connections.get(connId);
  if (!conn) return;

  const key = cacheKey(connId, msg.chat.id, msg.message_id);
  const old = cache.get(key);
  const newText = msg.text || msg.caption || "";

  if (!old) {
    cacheMessage(connId, msg);
    return;
  }

  if (old.text === newText) return; // реальных изменений текста нет

  const text =
    `✏️ Отредактированное сообщение\n` +
    `Было:\n«${old.text || "[без текста]"}»\n\n` +
    `Стало:\n«${newText || "[без текста]"}»\n\n` +
    `От: ${old.fromTag}\n` +
    `Время отправки: ${fmtDate(old.date)}`;

  await tg("sendMessage", { chat_id: conn.userChatId, text });
  await resendCachedMedia(conn.userChatId, old, "Медиа из отредактированного сообщения");

  cacheMessage(connId, msg); // обновляем кэш новой версией
}

async function handleDeletedBusinessMessages(update) {
  const connId = update.business_connection_id;
  const conn = connections.get(connId);
  if (!conn) return;
  const chatId = update.chat?.id;

  for (const messageId of update.message_ids || []) {
    const key = cacheKey(connId, chatId, messageId);
    const entry = cache.get(key);
    if (!entry) continue; // нет в кэше - нечего показать

    const text =
      `🗑 Удалённое сообщение\n` +
      `Содержимое:\n«${entry.text || (entry.mediaType ? `[${entry.mediaType}]` : "[пусто]")}»\n\n` +
      `От: ${entry.fromTag}\n` +
      `Время отправки: ${fmtDate(entry.date)}`;

    await tg("sendMessage", { chat_id: conn.userChatId, text });
    await resendCachedMedia(conn.userChatId, entry, "Медиа из удалённого сообщения");

    cache.delete(key);
  }
  scheduleSave();
}
async function pollLoop() {
  console.log("✅ Бот запущен,");
  while (true) {
    try {
      const data = await tg("getUpdates", {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: [
          "message",
          "business_connection",
          "business_message",
          "edited_business_message",
          "deleted_business_messages",
          "callback_query"
        ],
      });

      if (!data || !data.ok) {
        await sleep(3000);
        continue;
      }

      for (const update of data.result) {
        updateOffset = update.update_id + 1;
        if (update.message) {
          await handleBotMessage(update.message);
        } else if (update.business_connection) {
          await handleBusinessConnection(update.business_connection);
        } else if (update.business_message) {
          await handleBusinessMessage(update.business_message);
        } else if (update.callback_query) {
          await handleCallback(update.callback_query);
        } else if (update.edited_business_message) {
          await handleEditedBusinessMessage(update.edited_business_message);
        } else if (update.deleted_business_messages) {
          await handleDeletedBusinessMessages(update.deleted_business_messages);
        }
      }

      if (data.result.length) saveOffset();
    } catch (e) {
      console.error("Ошибка в цикле polling:", e.message);
      await sleep(3000);
    }
  }
}
 
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

loadAll();
loadExchangeRates();
scheduleExchangeAutoUpdate();
pollLoop();