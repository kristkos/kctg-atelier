/*
 * KCTG – Workshop  |  FoundryVTT v14
 */

import { MODULE_ID, applyTheme as _applyTheme, _addToKctgGroup, newId, safeFromUuid, getItemQty, addItemToActor, KCTGMixin, fallbackItemType, esc, kctgToast, logActivity,
  COIN_RATES, copperToCoinObj, isInventoryItem, creditCurrency,
  getCurrentDay, setCurrentDay, advanceDays, onDayAdvance, isWorldClockBound, getDayComponents, getWorldDateStr } from "./main.mjs";

// ─── DEBUG ──────────────────────────────────────────────────────────────────────
// Set to true to enable verbose console logging for troubleshooting.
const DEBUG = false;
function _log(...args) { if (DEBUG) console.log("%c🔨 KCTG|", "color:#c9a84c;font-weight:bold", ...args); }

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────

const TASK_TYPES = {
  forage: { label: "Forage",    icon: "fas fa-leaf",       color: "#5aad5a" },
  trade:  { label: "Trade Run", icon: "fas fa-route",      color: "#5a9ad0" },
  patrol: { label: "Patrol",    icon: "fas fa-shield-alt", color: "#9a5aad" },
  scout:  { label: "Scout",     icon: "fas fa-binoculars", color: "#ad7a5a" },
};

// Workshop task lifecycle. NOTE: these values ("active"/"complete") intentionally
// differ from Quest statuses ("in-progress"/"completed", quests.mjs) and Forge craft-job
// statuses ("inprogress"/"ready", forge.mjs CRAFT_JOB_STATUS). Each domain owns its own
// enum; they are never compared across domains (the Dashboard counts each separately).
// Default chat messages for force-completing a trade order (speculative deal,
// no tracked goods change hands). Pipe-separated, one picked at random; editable
// via the Campaign Dashboard's Message Templates app (Orders tab), which imports
// this constant for its Reset Defaults. Tokens: {actor} {order} {city} {payment}.
export const TRADE_ORDER_FORCE_DEFAULTS = [
  "{actor} closed the deal on {order} and collected {payment}.",
  "Word arrives from {city}: {order} is settled, and {payment} finds its way to {actor}.",
  "The {order} contract is concluded. {actor} pockets {payment}.",
  "{actor} shook hands on {order} and walked away with {payment}.",
].join("|");

const STATUS_CYCLE = ["pending", "active", "complete", "failed"];
const STATUS_META  = {
  pending:  { label: "Pending",  icon: "fas fa-clock",        color: "#9a8f7a" },
  active:   { label: "Active",   icon: "fas fa-running",      color: "#5aad5a" },
  complete: { label: "Complete", icon: "fas fa-check-circle", color: "#f5b430" },
  failed:   { label: "Failed",   icon: "fas fa-times-circle", color: "#c85050" },
};

const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
const DAYS_PER_YEAR  = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360

// ─── SETTINGS ──────────────────────────────────────────────────────────────────

Hooks.once("init", () => {

  // World data
  game.settings.register(MODULE_ID, "workshopName",    { scope: "world", config: false, type: String,  default: "The Workshop" });
  game.settings.register(MODULE_ID, "workshopBanner",  { scope: "world", config: false, type: String,  default: "" });
  game.settings.register(MODULE_ID, "workshopActorId", { scope: "world", config: false, type: String,  default: "" });
  // currentDay / worldDayOffset / bindWorldClock are registered by the shared time service in main.mjs
  game.settings.register(MODULE_ID, "openedDay",       { scope: "world", config: false, type: Number,  default: 1 });
  game.settings.register(MODULE_ID, "workers",         { scope: "world", config: false, type: Array,   default: [] });
  game.settings.register(MODULE_ID, "workerGroups",    { scope: "world", config: false, type: Array,   default: [] });
  game.settings.register(MODULE_ID, "tasks",           { scope: "world", config: false, type: Array,   default: [] });
  game.settings.register(MODULE_ID, "tradeOrders",     { scope: "world", config: false, type: Array,   default: [] });
  game.settings.register(MODULE_ID, "inventoryLog",    { scope: "world", config: false, type: Array,   default: [] });
  game.settings.register(MODULE_ID, "workerFolders",   { scope: "world", config: false, type: Array,   default: [] });
  game.settings.register(MODULE_ID, "mapConfig", {
    scope: "world", config: false, type: Object,
    default: { backgroundImage: "", locations: [], routes: [], homeLocationId: null }
  });
  game.settings.register(MODULE_ID, "eventTables", {
    scope: "world", config: false, type: Object,
    default: { forageUuid: "", tradeUuid: "", patrolUuid: "", scoutUuid: "", generalUuid: "" }
  });
  game.settings.register(MODULE_ID, "invFolders",     { scope: "world", config: false, type: Array,  default: [] });
  game.settings.register(MODULE_ID, "invItemFolders", { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "trackerEntries", { scope: "world", config: false, type: Array,  default: [] });
  game.settings.register(MODULE_ID, "taskTitleTemplates", {
    scope: "world", config: false, type: Object,
    default: {
      forage: "Forage Complete: {task}|{workers} return from foraging|The {task} forage is done",
      trade:  "Trade Run Complete: {task}|{workers} return from the trade route|The {task} trade run has concluded",
      patrol: "Patrol Report: {task}|{workers} finish their patrol|The {task} patrol is complete",
      scout:  "Scout Report: {task}|{workers} return from scouting|The {task} scouting mission is done",
    }
  });

  // Configurable settings
  game.settings.register(MODULE_ID, "participationMode", {
    name: "Participation Mode",
    hint: "How involved are players in workshop operations?",
    scope: "world", config: true, type: String,
    choices: {
      autonomous:    "Autonomous: workers operate on their own",
      collaborative: "Collaborative: players can assist workers",
      manual:        "Manual: players do everything, workers assist",
    },
    default: "collaborative"
  });
  game.settings.register(MODULE_ID, "calendarFineControl", {
    name: "Fine Calendar Control",
    hint: "Show year / month / day fields for setting the current date, instead of a single day counter. Useful for system-specific calendars.",
    scope: "world", config: true, type: Boolean, default: false
  });

  // ── Morale & Loyalty effect thresholds (managed via Workers tab Settings panel) ──
  game.settings.register(MODULE_ID, "moraleHighRerollChance", { scope: "world", config: false, type: Number, default: 20 });
  game.settings.register(MODULE_ID, "moraleLowSkipChance",    { scope: "world", config: false, type: Number, default: 20 });
  game.settings.register(MODULE_ID, "loyaltyHighSpeedChance", { scope: "world", config: false, type: Number, default: 20 });
  game.settings.register(MODULE_ID, "loyaltyLowSlowChance",   { scope: "world", config: false, type: Number, default: 20 });

  // ── Morale automation (Workers tab Settings panel) ──
  // Default OFF = the original fully-manual morale stat. When on: morale drifts
  // 1 step toward moraleBaseline every moraleDriftDays days, and a completed task
  // nudges its assigned workers +1. Manual edits keep working either way.
  game.settings.register(MODULE_ID, "moraleAutomation",   { scope: "world", config: false, type: Boolean, default: false });
  game.settings.register(MODULE_ID, "moraleBaseline",     { scope: "world", config: false, type: Number,  default: 5 });
  game.settings.register(MODULE_ID, "moraleDriftDays",    { scope: "world", config: false, type: Number,  default: 3 });
  game.settings.register(MODULE_ID, "moraleLastDriftDay", { scope: "world", config: false, type: Number,  default: 0 });

  // ── Trade Order random generation (managed via Trade Orders tab Settings panel) ──
  game.settings.register(MODULE_ID, "tradeOrderTableUuid",    { scope: "world", config: false, type: String, default: "" }); // legacy, kept for migration
  game.settings.register(MODULE_ID, "tradeOrderQtyMin",       { scope: "world", config: false, type: Number, default: 1 });
  game.settings.register(MODULE_ID, "tradeOrderQtyMax",       { scope: "world", config: false, type: Number, default: 10 });
  game.settings.register(MODULE_ID, "tradeOrderBasePrice",    { scope: "world", config: false, type: Number, default: 20 }); // legacy, no longer used
  game.settings.register(MODULE_ID, "tradeOrderPriceVariance",{ scope: "world", config: false, type: Number, default: 20 });
  // When on, players may edit existing orders (name/desc/needs/pays). Creating
  // orders (Add/Random) stays GM-only. GM toggles this on the fly from the
  // Trade Orders panel header. Default off = orders are read-only for players.
  game.settings.register(MODULE_ID, "tradeOrdersPlayerEdit",  { scope: "world", config: false, type: Boolean, default: false });
  // When on, the per-order "Force" button is shown (complete without the goods,
  // just grant the reward). GM toggles it from the Trade Orders panel header.
  game.settings.register(MODULE_ID, "tradeOrdersAllowForce",  { scope: "world", config: false, type: Boolean, default: false });
  // Per-city table UUIDs: { [locationId]: uuid }
  game.settings.register(MODULE_ID, "cityTableUuids",         { scope: "world", config: false, type: Object, default: {} });
  // Chat messages for force-completed orders (see TRADE_ORDER_FORCE_DEFAULTS)
  game.settings.register(MODULE_ID, "tradeOrderForceTemplates", { scope: "world", config: false, type: String, default: TRADE_ORDER_FORCE_DEFAULTS });

  // Handlebars helpers
  Handlebars.registerHelper("kctg_taskIcon",    t => TASK_TYPES[t]?.icon  ?? "fas fa-tasks");
  Handlebars.registerHelper("kctg_taskColor",   t => TASK_TYPES[t]?.color ?? "#888");
  Handlebars.registerHelper("kctg_moraleClass", m => m >= 8 ? "kctg-morale-high" : m >= 5 ? "kctg-morale-mid" : "kctg-morale-low");
  Handlebars.registerHelper("kctg_loyaltyColor",l => l >= 8 ? "var(--kctg-success)" : l >= 5 ? "var(--kctg-gold)" : "var(--kctg-danger)");
  Handlebars.registerHelper("kctg_pct",    v     => Math.round((v ?? 0) * 100));
  Handlebars.registerHelper("kctg_gt",    (a, b) => a > b);
  Handlebars.registerHelper("kctg_lte",   (a, b) => a <= b);
  Handlebars.registerHelper("kctg_sel",   (a, b) => a === b ? "selected" : "");
});

// ─── DATA HELPERS ──────────────────────────────────────────────────────────────

const getWsName    = ()  => game.settings.get(MODULE_ID, "workshopName")    ?? "The Workshop";
const getBanner    = ()  => game.settings.get(MODULE_ID, "workshopBanner")  ?? "";
const getWsActorId = ()  => game.settings.get(MODULE_ID, "workshopActorId") ?? "";
// getCurrentDay is imported from the shared time service (main.mjs)
const getOpenedDay = ()  => game.settings.get(MODULE_ID, "openedDay")       ?? 1;
const getWorkers   = ()  => game.settings.get(MODULE_ID, "workers")         ?? [];
const getGroups    = ()  => game.settings.get(MODULE_ID, "workerGroups")    ?? [];
const getTasks     = ()  => game.settings.get(MODULE_ID, "tasks")           ?? [];
const getTradeOrders = () => game.settings.get(MODULE_ID, "tradeOrders")    ?? [];
const getInvLog    = ()  => game.settings.get(MODULE_ID, "inventoryLog")    ?? [];
const getMapCfg    = ()  => game.settings.get(MODULE_ID, "mapConfig")       ?? { backgroundImage: "", locations: [], routes: [] };
const getEvTables  = ()  => game.settings.get(MODULE_ID, "eventTables")     ?? {};
const getWFolders  = ()  => game.settings.get(MODULE_ID, "workerFolders")   ?? [];

// ── GM delegation for world-setting writes ──────────────────────────────────
// World settings require the SETTINGS_MODIFY permission (GM / assistant GM only).
// To let regular players participate (assign workers, manage tasks/orders), their
// writes to a small set of player-facing keys are delegated to an active GM over
// the module socket. Everything else stays GM-only.
const _WS_PLAYER_KEYS = new Set(["tasks", "workers", "workerGroups", "tradeOrders", "inventoryLog"]);
function _canWriteSettings() { return game.user.isGM || game.user.hasPermission("SETTINGS_MODIFY"); }
function _wsActiveGM() { return game.users.find(u => u.isGM && u.active) ?? null; }
// World-state authorization for delegated player writes, mirroring the UI gates.
// Socket payloads carry no trusted sender id, so these gates are deliberately
// world-settings-based (the same toggles that show/hide the edit UI), checked on
// BOTH sides: the sender (friendly warning) and the applying GM (the real gate).
//   • tradeOrders   → only while "Players Edit" is on (fulfilment itself never
//                     writes the whole array from a player client; it goes through
//                     the wsFulfill / wsOrderMark operations instead).
//   • everything else (tasks, workers, workerGroups, inventoryLog)
//                   → only while Participation is not "Autonomous".
function _wsMayDelegate(key) {
  if (key === "tradeOrders") return !!game.settings.get(MODULE_ID, "tradeOrdersPlayerEdit");
  return game.settings.get(MODULE_ID, "participationMode") !== "autonomous";
}
async function _setWS(key, value) {
  if (_canWriteSettings()) return game.settings.set(MODULE_ID, key, value);
  if (!_WS_PLAYER_KEYS.has(key)) return ui.notifications.warn("Only the GM can change that workshop setting.");
  if (!_wsMayDelegate(key)) return ui.notifications.warn("The GM has not enabled player editing for this.");
  if (!_wsActiveGM()) return ui.notifications.warn("A GM must be online to make workshop changes.");
  game.socket.emit(`module.${MODULE_ID}`, { type: "wsSet", key, value });
}

const saveWsName    = v => _setWS("workshopName",    v);
const saveBanner    = v => _setWS("workshopBanner",  v);
const saveWsActorId = v => _setWS("workshopActorId", v);
// setCurrentDay / advanceDays come from the shared time service (main.mjs)
const saveOpenedDay = v => _setWS("openedDay",       v);
const saveWorkers   = w => _setWS("workers",         w);
const saveGroups    = g => _setWS("workerGroups",    g);
const saveTasks     = t => _setWS("tasks",           t);
const saveTradeOrders = o => _setWS("tradeOrders",   o);
const saveInvLog    = l => _setWS("inventoryLog",    l);
const saveMapCfg    = m => _setWS("mapConfig",       m);
const saveEvTbls    = t => _setWS("eventTables",     t);
const saveWFolders      = f => _setWS("workerFolders",   f);
const getInvFolders      = () => game.settings.get(MODULE_ID, "invFolders")     ?? [];
const saveInvFolders     = f => _setWS("invFolders",      f);
const getInvItemFolders  = () => game.settings.get(MODULE_ID, "invItemFolders") ?? {};
const saveInvItemFolders = m => _setWS("invItemFolders",  m);
// VOCABULARY: in the Trade Orders tab a "city" is just a map Location used as a trade
// hub — the same record stored in mapConfig.locations and keyed here by location id.
// The "city" naming (cityTableUuids, _selectedCityId, tradeOrderCities) is presentation
// only and kept as-is to avoid migrating this persisted setting key; read "city" as
// "trade-hub location".
const getCityTableUuids  = () => game.settings.get(MODULE_ID, "cityTableUuids") ?? {};
const saveCityTableUuids = m => _setWS("cityTableUuids",  m);
const getTrackerEntries      = () => game.settings.get(MODULE_ID, "trackerEntries")      ?? [];
const saveTrackerEntries     = v => _setWS("trackerEntries",      v);
const getTaskTitleTemplates  = () => game.settings.get(MODULE_ID, "taskTitleTemplates") ?? {};
const saveTaskTitleTemplates = v => _setWS("taskTitleTemplates",  v);

// Migrate old trade order format { itemName, itemImg, qty, payment } → { name, description, needs, pays }
function _migrateTradeOrder(o) {
  if (o.needs !== undefined) return o;
  return {
    id: o.id,
    locationId: o.locationId,
    name: o.itemName ?? "New Order",
    description: "",
    needs: [{ id: newId(), itemName: o.itemName ?? "Unknown", itemImg: o.itemImg ?? "icons/svg/item-bag.svg", qty: o.qty ?? 1 }],
    pays:  o.payment ?? [],
  };
}
function getTradeOrdersMigrated() {
  return getTradeOrders().map(_migrateTradeOrder);
}

function openIconPicker(current, cb) {
  new foundry.applications.apps.FilePicker.implementation({ type: "image", current: current || "icons/", callback: cb, activeSource: "data" }).render(true);
}
function ownedActors() {
  return game.actors?.filter(a => a.isOwner && a.type !== "group") ?? [];
}

/** Try to read a price string from item data, system-agnostic.
 *  Returns { value: number, label: string } e.g. { value: 5, label: "5 gp" } */
function getItemPrice(item) {
  const s = item.system;
  if (!s) return { value: 1, label: "1 gp" };
  // dnd5e v3+: { value: 50, denomination: "gp" }
  if (s.price?.denomination != null) {
    const v = s.price.value ?? 0;
    const d = s.price.denomination ?? "gp";
    return { value: v, label: `${v} ${d}` };
  }
  // pf2e: { value: { gp: 1 } } or { value: 5 }
  if (s.price?.value != null) {
    const pv = s.price.value;
    if (typeof pv === "object") {
      const parts = Object.entries(pv)
        .filter(([, v]) => v && v !== 0)
        .map(([k, v]) => `${v} ${k}`).join(" ");
      const total = (pv.gp ?? 0) * 100 + (pv.sp ?? 0) * 10 + (pv.cp ?? 0) + (pv.pp ?? 0) * 1000;
      return { value: Math.round(total / 100) || 1, label: parts || "0 gp" };
    }
    return { value: pv, label: `${pv} gp` };
  }
  // generic fallback fields
  const v = s.cost ?? s.value ?? s.price ?? 1;
  if (typeof v === "number") return { value: v, label: `${v} gp` };
  return { value: 1, label: String(v) || "1 gp" };
}

// ─── CALENDAR HELPERS ──────────────────────────────────────────────────────────

/** Total days → { years, months, days } */
function breakdownDays(total) {
  const t     = Math.max(0, Math.floor(total));
  const years  = Math.floor(t / DAYS_PER_YEAR);
  const months = Math.floor((t % DAYS_PER_YEAR) / DAYS_PER_MONTH);
  const days   = t % DAYS_PER_MONTH;
  return { years, months, days };
}

/** { years, months, days } → total days */
function totalDays({ years = 0, months = 0, days = 0 } = {}) {
  return years * DAYS_PER_YEAR + months * DAYS_PER_MONTH + days;
}

// World date label lives in main.mjs as getWorldDateStr() (shared with the dashboard).

/** Format elapsed days as a natural string */
function fmtElapsed(n) {
  if (!n || n < 0) return "0 days";
  const { years, months, days } = breakdownDays(n);
  const parts = [];
  if (years)  parts.push(`${years} year${years  !== 1 ? "s" : ""}`);
  if (months) parts.push(`${months} month${months !== 1 ? "s" : ""}`);
  if (days || !parts.length) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " and " + parts.at(-1);
}

// ─── ECONOMY ───────────────────────────────────────────────────────────────────

// ─── CHAT ──────────────────────────────────────────────────────────────────────

async function postWorkshopMsg(title, body, icon = "fas fa-hammer") {
  await ChatMessage.create({
    content: `<div style="background:#111;border:1px solid #f5b43055;border-radius:6px;padding:10px 12px;font-family:Signika,serif;color:#e8e0d0;"><div style="font-size:.85rem;font-weight:700;color:#f5b430;margin-bottom:5px;"><i class="${icon}" style="margin-right:5px;"></i>${title}</div><div style="font-size:.84rem;line-height:1.55;">${body}</div></div>`,
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
  });
}

// ─── ACTOR / ITEM HELPERS ──────────────────────────────────────────────────────


async function collectTaskItems(taskId) {
  const tasks = getTasks();
  const task  = tasks.find(t => t.id === taskId);
  if (!task) return;

  const actorId = getWsActorId();
  const actor   = actorId ? game.actors?.get(actorId) : null;
  if (!actor) { ui.notifications.warn("No Workshop Actor set. Drop one into the Overview tab first."); return; }

  // Collecting writes items onto the retainer actor — delegate to a GM if not owned.
  if (!actor.isOwner) {
    if (!_wsActiveGM()) return ui.notifications.warn("A GM must be online to collect items.");
    game.socket.emit(`module.${MODULE_ID}`, { type: "wsCollect", taskId });
    return;
  }

  const itemResults = task.itemResults ?? [];
  if (!itemResults.length) { ui.notifications.info("No items in this task's results."); return; }

  const log = getInvLog();
  let collected = 0;
  for (const r of itemResults) {
    let addedItem = null;
    try {
      if (r._source) {
        addedItem = await addItemToActor(actor, r._source, r.qty, true);
      } else if (r.uuid) {
        const src = await safeFromUuid(r.uuid);
        if (src) addedItem = await addItemToActor(actor, src, r.qty, false);
      }
      if (!addedItem) {
        // Text-only item or resolution failed: create a minimal placeholder.
        // Must carry a valid type + quantity: a typeless item fails schema
        // validation (and PF2e's type guard in addItemToActor rejects it).
        addedItem = await addItemToActor(actor, {
          name: r.name, img: r.img ?? "icons/svg/item-bag.svg",
          type: fallbackItemType(), system: { quantity: r.qty },
        }, r.qty, false);
      }
    } catch (e) {
      console.warn(`KCTG Workshop | Could not add "${r.name}" to actor:`, e.message);
    }
    log.push({
      id: newId(), actorId: actor.id, actorName: actor.name,
      actorImg: actor.img ?? "", itemName: r.name,
      itemImg: r.img ?? "icons/svg/item-bag.svg", qty: r.qty,
      taskId: task.id, taskName: task.name,
      addedAt: Date.now(), embeddedItemId: addedItem?.id ?? null,
    });
    collected++;
  }
  task.itemResults = [];
  await saveTasks(tasks);
  await saveInvLog(log);
  ui.notifications.info(`Collected ${collected} item(s) to ${actor.name}.`);
}

// True only for actors the Workshop legitimately tracks: the retainer actor, or any
// actor that already has an inventory-log entry. Used as the trust boundary for
// GM-delegated inventory deletions (see removeInventoryEntry).
function _isWorkshopTrackedActorId(actorId) {
  if (!actorId) return false;
  if (actorId === getWsActorId()) return true;
  return getInvLog().some(e => e.actorId === actorId);
}

async function removeInventoryEntry(entryId) {
  // Removing an entry deletes/updates an embedded item on an actor — delegate to a
  // GM when the current user doesn't own that actor.
  const _targetActorId = entryId.startsWith("live::")
    ? entryId.split("::")[1]
    : (getInvLog().find(e => e.id === entryId)?.actorId ?? null);
  const _targetActor = _targetActorId ? game.actors?.get(_targetActorId) : null;
  if (_targetActor && !_targetActor.isOwner) {
    if (!_wsActiveGM()) return ui.notifications.warn("A GM must be online to remove this inventory entry.");
    game.socket.emit(`module.${MODULE_ID}`, { type: "wsRemoveInv", entryId });
    return;
  }

  if (entryId.startsWith("live::")) {
    // Item added directly to actor, not via log — just delete the embedded item.
    // SECURITY: this runs with GM privilege when delegated over the socket, so the
    // entryId is attacker-controllable. Only ever touch actors the Workshop actually
    // tracks (the retainer, or an actor already present in the inventory log) — never
    // an arbitrary actor/item the caller names.
    const [, actorId, embeddedItemId] = entryId.split("::");
    if (!_isWorkshopTrackedActorId(actorId)) {
      console.warn(`KCTG Workshop | Refused to remove inventory entry for untracked actor ${actorId}.`);
      return;
    }
    const actor = game.actors?.get(actorId);
    const item  = actor?.items?.get(embeddedItemId);
    if (item) await item.delete();
    return;
  }
  const log   = getInvLog();
  const entry = log.find(e => e.id === entryId);
  if (!entry) return;
  const actor = game.actors?.get(entry.actorId);
  if (actor && entry.embeddedItemId) {
    const item = actor.items.get(entry.embeddedItemId);
    if (item) {
      const curQty = getItemQty(item);
      if (curQty <= entry.qty) await item.delete();
      else await item.update({ "system.quantity": curQty - entry.qty });
    }
  }
  await saveInvLog(log.filter(e => e.id !== entryId));
}

// ─── ITEM DESCRIPTION EXPANSION ──────────────────────────────────────────────
// Toggle an inline, enriched description panel under an inventory row (lazy-loaded).
// Mirrors the Merchant Inventory "Show description" behaviour.
async function _toggleInvItemDesc(row) {
  if (!row) return;
  const existing = row.querySelector(":scope > .kctg-item-desc");
  if (existing) { existing.remove(); return; }
  const actor = game.actors?.get(row.dataset.actorId);
  const item  = actor?.items?.get(row.dataset.embeddedId);
  const panel = document.createElement("div");
  panel.className = "kctg-item-desc";
  panel.innerHTML = `<em class="kctg-dim">Loading…</em>`;
  row.appendChild(panel);
  let raw = "";
  if (item) raw = foundry.utils.getProperty(item, "system.description.value")
               ?? foundry.utils.getProperty(item, "system.description") ?? "";
  let html;
  try {
    html = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
      String(raw || "<em>No description.</em>"), { relativeTo: item });
  } catch { html = String(raw || "No description."); }
  // The panel may have been removed (toggled off) while enriching.
  if (panel.isConnected) panel.innerHTML = html;
}

// ─── TRADE ORDER FULFILMENT ──────────────────────────────────────────────────
//
// "Closing the loop": deliver an order's required goods FROM the retainer's stock
// and pay the reward INTO the retainer (coins + items). The retainer is the
// canonical workshop inventory (same actor the Inventory tab + treasury read from).

// COIN_RATES / copperToCoinObj are shared from main.mjs (single source of coin math).

// Non-stock items (features, spells, etc.) are excluded by the shared
// system-agnostic check in main.mjs (isInventoryItem); shared with the
// inventory builder in _prepareContext.

/** Map of itemName → total quantity of real (non-coin, non-feature) stock on an actor. */
function _wsStockMap(actor) {
  const m = new Map();
  if (!actor) return m;
  for (const item of actor.items) {
    if (!isInventoryItem(item) || _isCoinItem(item)) continue;
    m.set(item.name, (m.get(item.name) ?? 0) + Number(getItemQty(item) ?? 0));
  }
  return m;
}

/** Remove `qty` of an item (by name) from an actor, spanning stacks. */
async function _consumeFromActor(actor, itemName, qty) {
  let remaining = qty;
  for (const item of actor.items.filter(i => i.name === itemName && !_isCoinItem(i))) {
    if (remaining <= 0) break;
    const have = Number(getItemQty(item) ?? 0);
    if (have <= remaining) { remaining -= have; await item.delete(); }
    else { await item.update({ "system.quantity": have - remaining }); remaining = 0; }
  }
  return remaining <= 0;
}

/** Credit a copper amount to an actor — delegates to the shared composition-
 *  preserving helper in main.mjs (PF2e coin items, else adds gp/sp/cp on top). */
async function _wsAddCurrency(actor, copper) {
  return creditCurrency(actor, copper);
}

/**
 * Chat body for a force-completed order, from a random GM-editable template
 * (Campaign Dashboard > Message Templates > Orders). Token VALUES are escaped;
 * the template text itself is GM-authored and may carry inline HTML, matching
 * how _taskTitle treats task templates.
 */
function _orderForceMsg(actor, order, payStr) {
  const raw   = game.settings.get(MODULE_ID, "tradeOrderForceTemplates") ?? "";
  const lines = raw.split("|").map(t => t.trim()).filter(Boolean);
  const tpl   = lines.length
    ? lines[Math.floor(Math.random() * lines.length)]
    : "{actor} completed the order {order} and received {payment}.";
  const city = getMapCfg().locations?.find(l => l.id === order.locationId)?.name;
  return tpl
    .replace(/\{actor\}/g,   `<em style="color:#8a6e30">${esc(actor.name)}</em>`)
    .replace(/\{order\}/g,   `<strong>${esc(order.name)}</strong>`)
    .replace(/\{payment\}/g, `<strong>${esc(payStr)}</strong>`)
    .replace(/\{city\}/g,    esc(city || "afar"));
}

// ── Deadlines ─────────────────────────────────────────────────────────────────
// An order may carry an optional deadline: { dueDay, lateMode, latePenaltyPct }.
//   • dueDay          - workshop day the delivery is due (absent/0 = no deadline)
//   • lateMode        - "expire" (default): past due it can no longer be fulfilled
//                       "penalty": it stays deliverable, at a reduced payment
//   • latePenaltyPct  - percent removed from the payment on a late delivery (default 60)
// All states below are DERIVED from the clock at read time; only the one-shot
// announcement marker (overdueNotified) is persisted.

const LATE_PENALTY_DEFAULT = 60;

function _orderLatePct(o) {
  return Math.min(100, Math.max(0, Number(o.latePenaltyPct ?? LATE_PENALTY_DEFAULT)));
}

/** Deadline state of an order at the given workshop day. */
function _orderDeadlineState(o, curDay) {
  const dueDay = Math.max(0, Math.round(Number(o.dueDay) || 0));
  if (!dueDay) return { dueDay: null, daysLeft: null, overdue: false, expired: false, late: false };
  const overdue = !o.fulfilledAt && curDay > dueDay;
  const penalty = o.lateMode === "penalty";
  return {
    dueDay,
    daysLeft: Math.max(0, dueDay - curDay),
    overdue,
    expired: overdue && !penalty,
    late:    overdue && penalty,
  };
}

/** Reduce an order's payment for a late delivery; zeroed pays are dropped. */
function _applyLatePenalty(pays, pct) {
  const keep = Math.max(0, 100 - pct) / 100;
  return (pays ?? [])
    .map(p => ({ ...p, value: Math.floor((p.value ?? 0) * keep) }))
    .filter(p => p.value > 0);
}

/**
 * Mark an order fulfilled (the state write only; goods/payment are handled by the
 * caller). Marking is a play OUTCOME, not an edit, so player clients delegate this
 * specific operation over the socket - it must work even while player order-editing
 * (the wsSet "tradeOrders" gate) is disabled. The applying GM never trusts `force`
 * from the wire and re-derives lateness from the order's own deadline.
 */
async function _markTradeOrderFulfilled(orderId, { force = false } = {}) {
  if (!_canWriteSettings()) {
    if (!_wsActiveGM()) return ui.notifications.warn("A GM must be online to record the fulfilment.");
    game.socket.emit(`module.${MODULE_ID}`, { type: "wsOrderMark", orderId });
    return;
  }
  const allOrders = getTradeOrdersMigrated();
  const stored    = allOrders.find(x => x.id === orderId);
  if (!stored || stored.fulfilledAt) return;
  const st = _orderDeadlineState(stored, getCurrentDay());
  stored.fulfilledAt = Date.now();
  // Record HOW it closed so a force-completed (speculative, no goods delivered) order
  // stays distinguishable from a genuine fulfilment after the fact.
  stored.fulfilledMode = force ? "forced" : "delivered";
  if (!force && st.late) stored.fulfilledLate = true;
  await game.settings.set(MODULE_ID, "tradeOrders", allOrders);
}

/**
 * Fulfil a trade order: pay the reward (coins + items) into the retainer, mark it
 * fulfilled, and announce it (chat + toast). Players who don't own the retainer
 * delegate to a GM.
 *   • normal  → verify the retainer holds every required good, then consume them.
 *               Past an "expire" deadline this is refused; past a "penalty"
 *               deadline it proceeds at the reduced payment.
 *   • force   → skip the stock check, deadline and consumption (for speculative /
 *               random orders whose goods can't be matched); just grant the reward.
 */
async function _fulfillTradeOrder(orderId, { force = false } = {}) {
  const order = getTradeOrdersMigrated().find(o => o.id === orderId);
  if (!order) return;
  if (order.fulfilledAt) return;
  if (!force && !(order.needs?.length)) return ui.notifications.warn("This order has no required goods to deliver.");

  const st = _orderDeadlineState(order, getCurrentDay());
  if (!force && st.expired) return ui.notifications.warn(`"${order.name}" expired on day ${st.dueDay} and can no longer be fulfilled.`);

  const actorId = getWsActorId();
  const actor   = actorId ? game.actors?.get(actorId) : null;
  if (!actor) return ui.notifications.warn("Set a Retainer on the Overview tab before fulfilling orders.");

  // Mutating the retainer (consume goods + add payment) needs ownership; delegate to a GM.
  if (!actor.isOwner) {
    if (!_wsActiveGM()) return ui.notifications.warn("A GM must be online to fulfill orders.");
    game.socket.emit(`module.${MODULE_ID}`, { type: "wsFulfill", orderId, force });
    return;
  }

  // A retainer-owning player can consume/pay locally but still needs a GM online
  // to RECORD the fulfilment (world-setting write via wsOrderMark). Check before
  // consuming, or the goods and reward would apply while the order stays open
  // (repeatable fulfilment).
  if (!_canWriteSettings() && !_wsActiveGM())
    return ui.notifications.warn("A GM must be online to fulfill orders.");

  if (!force) {
    // Verify stock, then deliver the goods.
    const stock   = _wsStockMap(actor);
    const missing = (order.needs ?? [])
      .filter(n => (stock.get(n.itemName) ?? 0) < n.qty)
      .map(n => `${n.itemName} (${stock.get(n.itemName) ?? 0}/${n.qty})`);
    if (missing.length) return ui.notifications.warn(`Not enough materials: ${missing.join(", ")}.`);
    for (const n of order.needs) await _consumeFromActor(actor, n.itemName, n.qty);
  }

  // Late delivery at a loss: reduce the payment by the order's penalty.
  const isLate  = !force && st.late;
  const latePct = _orderLatePct(order);
  const pays    = isLate ? _applyLatePenalty(order.pays, latePct) : (order.pays ?? []);

  // Collect the payment.
  let copper = 0; const payParts = [];
  for (const p of pays) {
    if (p.type === "item") {
      const val = p.value ?? 1;
      await addItemToActor(actor, {
        name: p.itemName ?? "Reward", img: p.itemImg ?? "icons/svg/item-bag.svg",
        type: fallbackItemType(), system: { quantity: val },
      }, val, false);
      payParts.push(`${val}× ${p.itemName ?? "item"}`);
    } else {
      copper += (p.value ?? 0) * (COIN_RATES[p.type] ?? 0);
      payParts.push(`${p.value} ${p.type}`);
    }
  }
  if (copper > 0) await _wsAddCurrency(actor, copper);

  // Mark the order fulfilled. It is kept as a reopenable contract, not deleted,
  // so the same trade route can be run again later.
  await _markTradeOrderFulfilled(orderId, { force });

  // Announce: chat + toast (broadcast so every client sees the pop).
  const needStr  = (order.needs ?? []).map(n => `${n.qty}× ${n.itemName}`).join(", ");
  const payStr   = payParts.length ? payParts.join(", ") : "nothing";
  const lateNote = isLate ? ` <em style="color:#c0392b">Delivered late: payment reduced by ${latePct}%.</em>` : "";
  const body = force
    ? _orderForceMsg(actor, order, payStr)
    : `<em style="color:#8a6e30">${esc(actor.name)}</em> delivered <strong>${esc(needStr)}</strong> and received <strong>${esc(payStr)}</strong>.${lateNote}`;
  await postWorkshopMsg(force ? "Trade Order Completed" : "Trade Order Fulfilled", body, "fas fa-handshake");
  const toastOpts = { label: force ? "Order Completed" : "Order Fulfilled", name: order.name, icon: "fas fa-handshake", key: "wsorder-" + order.id };
  kctgToast({ ...toastOpts, onClick: () => WorkshopApp.open() });
  game.socket.emit(`module.${MODULE_ID}`, { type: "wsToast", ...toastOpts });
  await logActivity("order", `Trade order ${force ? "force-completed" : "fulfilled"}${isLate ? " (late)" : ""}: ${order.name}`);
  ui.notifications.info(`Fulfilled "${order.name}".`);
}

/**
 * Announce orders that crossed their deadline, once each (persisted marker:
 * overdueNotified). Only the single responsible GM writes and announces; other
 * clients see the change sync in via updateSetting.
 */
async function _checkOrderDeadlines() {
  if (_wsActiveGM()?.id !== game.user.id) return;
  const curDay = getCurrentDay();
  const orders = getTradeOrdersMigrated();
  let changed  = false;
  for (const o of orders) {
    const st = _orderDeadlineState(o, curDay);
    if (!st.overdue || o.overdueNotified) continue;
    o.overdueNotified = true;
    changed = true;
    const city    = getMapCfg().locations?.find(l => l.id === o.locationId)?.name;
    const cityStr = city ? ` (${esc(city)})` : "";
    let toastOpts;
    if (st.expired) {
      await postWorkshopMsg("Trade Order Expired",
        `<strong>${esc(o.name)}</strong>${cityStr} was not delivered by day ${st.dueDay} and has expired.`,
        "fas fa-hourglass-end");
      await logActivity("order", `Trade order expired: ${o.name}`);
      toastOpts = { label: "Order Expired", name: o.name, icon: "fas fa-hourglass-end", tone: "danger", key: "wsorderexp-" + o.id };
    } else {
      await postWorkshopMsg("Trade Order Overdue",
        `<strong>${esc(o.name)}</strong>${cityStr} missed its day ${st.dueDay} deadline. It can still be delivered, at ${_orderLatePct(o)}% reduced payment.`,
        "fas fa-hourglass-half");
      await logActivity("order", `Trade order overdue: ${o.name}`);
      toastOpts = { label: "Order Overdue", name: o.name, icon: "fas fa-hourglass-half", tone: "danger", key: "wsorderdue-" + o.id };
    }
    kctgToast({ ...toastOpts, onClick: () => WorkshopApp.open() });
    game.socket.emit(`module.${MODULE_ID}`, { type: "wsToast", ...toastOpts });
  }
  if (changed) await saveTradeOrders(orders);
}
onDayAdvance(() => _checkOrderDeadlines());

// ─── DAY ADVANCEMENT ───────────────────────────────────────────────────────────

async function _checkAutoComplete() {
  // Only the SINGLE responsible GM rolls results and writes completions. Gating on
  // _canWriteSettings() (true for every GM and any SETTINGS_MODIFY user) double-completes
  // tasks when more than one such client is online — duplicate rewards, chat and toasts.
  // Use the same single-authority gate as the socket delegation handler so exactly one
  // client acts. Players (and other GMs) see completions sync in via updateSetting.
  if (_wsActiveGM()?.id !== game.user.id) return;
  const tasks   = getTasks();
  const workers = getWorkers();
  const curDay  = getCurrentDay();
  let anyDone   = false;
  for (const t of tasks) {
    if (t.status !== "active" || !t.startDay) continue;
    const workerCount = (t.assignedWorkerIds ?? []).length;
    const effTaskDays = workerCount > 1 ? Math.ceil((t.taskDays ?? 1) / workerCount) : (t.taskDays ?? 1);
    const dur = 2 * (t.travelDays ?? 1) + effTaskDays;
    if (curDay - t.startDay >= dur) {
      await _autoCompleteTask(t, workers);
      anyDone = true;
    }
  }
  if (anyDone) { await saveTasks(tasks); await saveWorkers(workers); }
}

// Auto-complete tasks on ANY day advance (manual buttons, world clock, Simple Calendar).
onDayAdvance(() => _checkAutoComplete());

/**
 * Morale drift: while morale automation is on, every worker's morale moves 1 step
 * toward the baseline for each full moraleDriftDays interval elapsed. The last
 * processed day is persisted (moraleLastDriftDay) so multi-day jumps drift the
 * right number of steps and rewinding the clock re-arms instead of drifting.
 * Responsible-GM gated like _checkAutoComplete (single authority, GM-only writes).
 */
async function _checkMoraleDrift() {
  if (_wsActiveGM()?.id !== game.user.id) return;
  if (!game.settings.get(MODULE_ID, "moraleAutomation")) return;
  const driftDays = Math.max(0, Math.round(game.settings.get(MODULE_ID, "moraleDriftDays") ?? 3));
  if (!driftDays) return; // drift disabled; task nudges still apply
  const curDay = getCurrentDay();
  const last   = game.settings.get(MODULE_ID, "moraleLastDriftDay") ?? 0;
  if (!last || last > curDay) {
    await game.settings.set(MODULE_ID, "moraleLastDriftDay", curDay);
    return;
  }
  const steps = Math.floor((curDay - last) / driftDays);
  if (steps <= 0) return;
  const baseline = Math.min(10, Math.max(0, Math.round(game.settings.get(MODULE_ID, "moraleBaseline") ?? 5)));
  const workers  = getWorkers();
  let changed = false;
  for (const w of workers) {
    let m = Math.min(10, Math.max(0, Math.round(w.morale ?? 5)));
    for (let i = 0; i < steps && m !== baseline; i++) m += m < baseline ? 1 : -1;
    if (m !== (w.morale ?? 5)) { w.morale = m; changed = true; }
  }
  await game.settings.set(MODULE_ID, "moraleLastDriftDay", last + steps * driftDays);
  if (changed) await saveWorkers(workers);
}
onDayAdvance(() => _checkMoraleDrift());

function _taskTitle(task, wNames = "") {
  const templates = getTaskTitleTemplates();
  const raw = templates[task.type] ?? "Task Complete: {task}";
  const lines = raw.split("|").map(t => t.trim()).filter(Boolean);
  const tpl = lines[Math.floor(Math.random() * lines.length)] ?? "Task Complete: {task}";
  return tpl.replace(/\{task\}/g, esc(task.name)).replace(/\{workers\}/g, esc(wNames || "the workers"));
}

async function _autoCompleteTask(task, workers) {
  _log("Auto-completing task", task.id, task.name, "type:", task.type);
  const wNames = workers.filter(w => (task.assignedWorkerIds ?? []).includes(w.id)).map(w => w.name).join(", ") || "Unassigned";
  let resultTexts = [];
  let itemResults = [];
  let skipFinalMsg = false;

  if (task.tableUuid) {
    const table = await safeFromUuid(task.tableUuid);
    if (table) {
      const wList           = workers.filter(w => (task.assignedWorkerIds ?? []).includes(w.id));
      const hasHighMorale   = wList.some(w => (w.morale ?? 5) >= 10);
      const hasLowMorale    = wList.some(w => (w.morale ?? 5) <= 0);
      const highChance      = (game.settings.get(MODULE_ID, "moraleHighRerollChance") ?? 20) / 100;
      const skipChance      = (game.settings.get(MODULE_ID, "moraleLowSkipChance")   ?? 20) / 100;

      // Low morale — chance to skip the roll entirely
      if (hasLowMorale && Math.random() < skipChance) {
        _log("Morale 0 triggered — skipping result table roll for", task.name);
        skipFinalMsg = true;
        await postWorkshopMsg(_taskTitle(task, wNames), `<em style="color:#c0392b">Low morale took its toll — no results this time.</em>`, TASK_TYPES[task.type]?.icon ?? "fas fa-tasks");
      } else {
        // Base roll + possible bonus roll from high morale
        let rollCount = 1;
        if (hasHighMorale && Math.random() < highChance) {
          rollCount = 2;
          _log("Morale 10 triggered — bonus roll for", task.name);
        }
        for (let i = 0; i < rollCount; i++) {
          const draw = await table.draw({ displayChat: false });
          const drawResults = draw.results ?? [];
          _log(`Table draw ${i+1}/${rollCount} returned`, drawResults.length, "result(s)");
          for (const r of drawResults) {
            const parsed = await _parseTableResult(r);
            resultTexts.push(parsed.text);
            if (parsed.item) itemResults.push(parsed.item);
          }
        }
      }
    }
  }

  task.results     = resultTexts;
  task.itemResults = itemResults;
  task.status      = "complete";
  task.completedAt = Date.now();

  // Morale automation: bringing a task home lifts its workers' spirits (+1, capped).
  // A low-morale "no results" outcome earns no nudge; drift handles recovery.
  if (game.settings.get(MODULE_ID, "moraleAutomation") && !skipFinalMsg) {
    for (const wid of (task.assignedWorkerIds ?? [])) {
      const w = workers.find(x => x.id === wid);
      if (w) w.morale = Math.min(10, Math.round(w.morale ?? 5) + 1);
    }
  }

  // Free workers
  for (const wid of (task.assignedWorkerIds ?? [])) {
    const w = workers.find(x => x.id === wid);
    if (w) w.currentTaskId = null;
  }
  task.assignedWorkerIds = [];

  _log("Task complete", task.name, "| results:", resultTexts.length, "items:", itemResults.length);
  if (!skipFinalMsg) {
    const bodyHtml = resultTexts.length
      ? resultTexts.map(r => `<span style="display:block;">• ${esc(r)}</span>`).join("")
      : "No results.";
    await postWorkshopMsg(_taskTitle(task, wNames), `<em style="color:#8a6e30">Workers: ${esc(wNames)}</em><br>${bodyHtml}`, TASK_TYPES[task.type]?.icon ?? "fas fa-tasks");
  }

  // Toast the completion: locally for the authority, broadcast so players see it too.
  const toastOpts = {
    label: "Task Complete", name: task.name,
    icon: TASK_TYPES[task.type]?.icon ?? "fas fa-check-circle",
    key: `wstask-${task.id}-${task.completedAt}`,
  };
  kctgToast({ ...toastOpts, onClick: () => WorkshopApp.open() });
  game.socket.emit(`module.${MODULE_ID}`, { type: "wsToast", ...toastOpts });
  await logActivity("task", `Task complete: ${task.name}${wNames !== "Unassigned" ? ` (${wNames})` : ""}`);
}

async function _parseTableResult(result) {
  // v14: result.type is the string "text" for plain text entries.
  // v13 compat: CONST.TABLE_RESULT_TYPES?.TEXT was 0.
  const TEXT_V13 = CONST.TABLE_RESULT_TYPES?.TEXT ?? 0;
  const isTextEntry = result.type === "text" || result.type === TEXT_V13;

  // Use toObject() to access raw schema data without triggering deprecated proxy getters.
  // v13 stores the full linked-document UUID in `documentUuid` (e.g. "Compendium.pf2e.xxx.Item.yyy")
  const raw = result.toObject?.() ?? {};
  const docUuid     = raw.documentUuid ?? "";   // v14/v13 primary — full UUID of the linked document
  const displayName = raw.description || raw.name || "";

  // ── TEXT entry ───────────────────────────────────────────────────────────────
  if (isTextEntry) {
    const label = displayName || "Unknown";
    return { text: label, item: { name: label, img: "icons/svg/item-bag.svg", qty: 1, uuid: null, _source: null } };
  }

  // ── Linked document entry ────────────────────────────────────────────────────
  // result.uuid = TableResult's own self-UUID. The item lives at raw.documentUuid.
  let item = null;
  if (docUuid) {
    try {
      const resolved = await foundry.utils.fromUuid(docUuid);
      if (resolved?.documentName === "Item") item = resolved;
    } catch (e) {
      console.warn("KCTG Workshop | Could not resolve table result documentUuid:", docUuid, e.message);
    }
  }

  if (item) {
    let _source = null;
    try {
      const itemRaw = item.toObject();
      delete itemRaw._id;
      _source = JSON.parse(JSON.stringify(itemRaw));
    } catch { /* ignore */ }
    return {
      text: item.name,
      item: { name: item.name, img: item.img ?? "icons/svg/item-bag.svg", qty: 1, uuid: item.uuid, _source }
    };
  }

  // Fallback — no linked item found, treat display name as collectible text item
  if (displayName) {
    return { text: displayName, item: { name: displayName, img: "icons/svg/item-bag.svg", qty: 1, uuid: null, _source: null } };
  }
  return { text: "Unknown", item: null };
}



// ─── MANUAL TASK RUN ───────────────────────────────────────────────────────────

async function runTask(taskId) {
  const tasks   = getTasks();
  const task    = tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!task.tableUuid) { ui.notifications.warn("No Rollable Table linked."); return; }

  // Drawing from the table + writing completion needs authority — delegate to a GM.
  if (!_canWriteSettings()) {
    if (!_wsActiveGM()) return ui.notifications.warn("A GM must be online to run a task.");
    game.socket.emit(`module.${MODULE_ID}`, { type: "wsRunTask", taskId });
    return;
  }

  const workers = getWorkers();
  await _autoCompleteTask(task, workers);
  await saveTasks(tasks);
  await saveWorkers(workers);
  // Re-render so the Collect button becomes visible
  const app = foundry.applications.instances?.get("kctg-workshop--hub");
  if (app) app.render();
}

// ─── EVENT ROLLER ──────────────────────────────────────────────────────────────

async function rollEvent(taskType) {
  // Drawing writes the table's drawn-state; delegate to a GM when the user can't write.
  if (!_canWriteSettings()) {
    if (!_wsActiveGM()) return ui.notifications.warn("A GM must be online to roll an event.");
    game.socket.emit(`module.${MODULE_ID}`, { type: "wsRollEvent", taskType });
    return;
  }
  const ev   = getEvTables();
  const uuid = ev[`${taskType}Uuid`] || ev.generalUuid;
  if (!uuid) { ui.notifications.warn("No event table linked for this type. Click 'Event Tables' in the Tasks tab."); return; }
  const table = await safeFromUuid(uuid);
  if (!table) { ui.notifications.error("Could not find event table."); return; }
  await table.draw({ displayChat: true });
}

// ─── MAP HELPERS ───────────────────────────────────────────────────────────────

/** Build route line data for SVG rendering.
 *  If waypoints exist on the route, renders a polyline through them.
 *  Otherwise falls back to auto quadratic bezier curve.
 *  Returns `pathD`, `wpHandles` (for edit-mode drag handles), and `name` as A ↔ B. */
function _buildRouteCurves(locations, routes, activeTaskRouteIds) {
  return (routes ?? []).map(r => {
    const from = locations.find(l => l.id === r.fromId);
    const to   = locations.find(l => l.id === r.toId);
    if (!from || !to) return null;
    const x1 = parseFloat((from.x * 100).toFixed(3));
    const y1 = parseFloat((from.y * 100).toFixed(3));
    const x2 = parseFloat((to.x * 100).toFixed(3));
    const y2 = parseFloat((to.y * 100).toFixed(3));
    const waypoints = r.waypoints ?? [];
    let pathD;
    if (waypoints.length > 0) {
      let d = `M ${x1} ${y1}`;
      for (const wp of waypoints) d += ` L ${(wp.x * 100).toFixed(3)} ${(wp.y * 100).toFixed(3)}`;
      d += ` L ${x2} ${y2}`;
      pathD = d;
    } else {
      // Auto bezier fallback
      const dx = x2 - x1, dy = y2 - y1;
      const cpX = ((x1 + x2) / 2 - dy * 0.18).toFixed(3);
      const cpY = ((y1 + y2) / 2 + dx * 0.18).toFixed(3);
      pathD = `M ${x1} ${y1} Q ${cpX} ${cpY} ${x2} ${y2}`;
    }
    const wpHandles = waypoints.map((wp, idx) => ({
      x: parseFloat((wp.x * 100).toFixed(3)),
      y: parseFloat((wp.y * 100).toFixed(3)),
      idx,
    }));
    const name = `${from.name} ↔ ${to.name}`;
    const _rc = (c) => (c && c !== "#c9a84c") ? c : null;
    const fromColor = _rc(from.rimColor) ?? _rc(r.color) ?? "#f5b430";
    const toColor   = _rc(to.rimColor)   ?? _rc(r.color) ?? "#d06838";
    const gradId = `kctg-grad-${r.id}`;
    return { ...r, name, x1pct: x1, y1pct: y1, x2pct: x2, y2pct: y2, pathD, wpHandles, fromColor, toColor, gradId, isActive: (activeTaskRouteIds ?? new Set()).has(r.id) };
  }).filter(Boolean);
}

/** Get all points on a route as an array of {x,y} (0-1 space).
 *  from → waypoints → to */
function _routePoints(route, locations) {
  const from = locations.find(l => l.id === route.fromId);
  const to   = locations.find(l => l.id === route.toId);
  if (!from || !to) return [];
  return [{ x: from.x, y: from.y }, ...(route.waypoints ?? []), { x: to.x, y: to.y }];
}

/** Position along a multi-segment polyline at fractional progress p (0-1).
 *  pts are {x,y} objects in any consistent coordinate space (e.g. 0-100 pct). */
function _posAlongPts(pts, p) {
  if (!pts || pts.length < 2) return pts?.[0] ?? { x: 0, y: 0 };
  let total = 0;
  const lens = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i+1].x - pts[i].x, dy = pts[i+1].y - pts[i].y;
    const l = Math.sqrt(dx*dx + dy*dy);
    lens.push(l); total += l;
  }
  if (total === 0) return pts[pts.length - 1];
  const target = Math.max(0, Math.min(1, p)) * total;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    const next = acc + lens[i];
    if (next >= target || i === lens.length - 1) {
      const frac = lens[i] > 0 ? (target - acc) / lens[i] : 0;
      return { x: pts[i].x + (pts[i+1].x - pts[i].x) * frac, y: pts[i].y + (pts[i+1].y - pts[i].y) * frac };
    }
    acc = next;
  }
  return pts[pts.length - 1];
}

/** Squared distance from point P to segment AB (all in 0-1 space). */
function _distPtSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

/** Suppress the next updateSetting-triggered re-render on map apps (avoids flash). */
function _suppressNextMapRender() {
  const hub = foundry.applications.instances?.get("kctg-workshop--hub");
  if (hub) hub._suppressNextRender = true;
  const tm  = foundry.applications.instances?.get("kctg-workshop--trade-map");
  if (tm)  tm._suppressNextRender  = true;
}

/** Update only the SVG route paths + waypoint handles in-place, no full re-render. */
function _updateRouteSVG(canvas) {
  const svg = canvas?.querySelector(".kctg-map-svg");
  if (!svg) return;
  const m    = getMapCfg();
  const locs = m.locations ?? [];
  const curves = _buildRouteCurves(locs, m.routes ?? [], new Set());
  // Update visible path d attributes
  svg.querySelectorAll(".kctg-route-line[data-route-id]").forEach(path => {
    const r = curves.find(c => c.id === path.dataset.routeId);
    if (r) path.setAttribute("d", r.pathD);
  });
  // Update hitzone d attributes
  svg.querySelectorAll(".kctg-route-hitzone[data-route-id]").forEach(path => {
    const r = curves.find(c => c.id === path.dataset.routeId);
    if (r) path.setAttribute("d", r.pathD);
  });
  // Update gradient endpoint coordinates (so gradients follow pin drags)
  svg.querySelectorAll("linearGradient[data-route-id]").forEach(grad => {
    const r = curves.find(c => c.id === grad.dataset.routeId);
    if (r) { grad.setAttribute("x1", r.x1pct); grad.setAttribute("y1", r.y1pct); grad.setAttribute("x2", r.x2pct); grad.setAttribute("y2", r.y2pct); }
  });
  // Update waypoint handle positions (HTML divs on the canvas)
  canvas.querySelectorAll(".kctg-wp-handle[data-route-id]").forEach(handle => {
    const r = curves.find(c => c.id === handle.dataset.routeId);
    const wp = r?.wpHandles?.[parseInt(handle.dataset.wpIdx)];
    if (wp) { handle.style.left = wp.x + "%"; handle.style.top = wp.y + "%"; }
  });
}

// ─── LOCATION EDIT DIALOG ──────────────────────────────────────────────────────

class LocationEditApp extends KCTGMixin(
  foundry.applications.api.HandlebarsApplicationMixin(
    foundry.applications.api.ApplicationV2
  )
) {
  constructor(locId, options = {}) {
    super(options);
    this._locId = locId;
    this._pending = null;      // buffered field values, flushed only on Save
    this._pendingIsHome = null; // tri-state: null = unset, boolean = user-changed
  }

  get id() { return `kctg-location-edit--${this._locId}`; }

  static DEFAULT_OPTIONS = {
    classes: ["kctg-module"],
    window: { title: "Edit Location", resizable: false },
    position: { width: 320, height: "auto" }
  };
  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/workshop/location-edit.hbs` }
  };

  async _prepareContext() {
    const map = getMapCfg();
    const stored = (map.locations ?? []).find(l => l.id === this._locId)
      ?? { id: this._locId, name: "", icon: "icons/svg/village.svg" };
    // Initialise pending state once; subsequent renders preserve buffered edits
    if (!this._pending) {
      this._pending = foundry.utils.deepClone(stored);
      this._pending.scale ??= 1;
    }
    if (this._pendingIsHome === null) this._pendingIsHome = map.homeLocationId === this._locId;
    const p = this._pending;
    // Resolve linked quest name if set
    let linkedQuestName = null;
    if (p.linkedQuestId) {
      const page = await foundry.utils.fromUuid(p.linkedQuestId).catch(() => null);
      linkedQuestName = page?.name ?? p.linkedQuestId;
    }
    return {
      loc: { ...p, linkedQuestName },
      isHome: this._pendingIsHome,
      rimColorSwatch:  p.rimColor  || "#f5b430",
      bgColorSwatch:   p.bgColor   || "#141414",
      tintColorSwatch: p.tintColor || "#ffffff",
      glowColorSwatch: p.glowColor || "#f5b430",
    };
  }

  _onRender(context, options) {
    const el = this.element;
    _applyTheme(el);

    // Name — buffer into pending, no save
    el.querySelector(".kctg-loc-name-input")?.addEventListener("input", e => {
      this._pending.name = e.target.value;
    });

    // Icon — re-render dialog only to show new icon (no save to settings)
    el.querySelector(".kctg-loc-icon-btn")?.addEventListener("click", e => {
      e.stopPropagation();
      openIconPicker(this._pending.icon ?? "icons/", path => {
        this._pending.icon = path; this.render();
      });
    });

    // Home toggle — re-render dialog to flip button state (no save)
    el.querySelector(".kctg-loc-home-btn")?.addEventListener("click", e => {
      e.stopPropagation();
      this._pendingIsHome = !this._pendingIsHome; this.render();
    });

    // Scale slider — update pending + live label
    const scaleSlider = el.querySelector(".kctg-loc-scale");
    const scaleLabel  = el.querySelector(".kctg-loc-scale-val");
    scaleSlider?.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      this._pending.scale = v;
      if (scaleLabel) scaleLabel.textContent = v.toFixed(1) + "×";
    });

    // Colors: swatch ↔ hex sync + clear — buffer only, no save
    el.querySelectorAll(".kctg-color-swatch").forEach(swatch => {
      swatch.addEventListener("input", e => {
        const field = e.target.dataset.field, hex = e.target.value;
        this._pending[field] = hex;
        const hexInput = el.querySelector(`.kctg-color-hex[data-field="${field}"]`);
        if (hexInput) hexInput.value = hex;
      });
    });
    el.querySelectorAll(".kctg-color-hex").forEach(inp => {
      inp.addEventListener("input", e => {
        const field = e.target.dataset.field, val = e.target.value.trim();
        this._pending[field] = val;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          const swatch = el.querySelector(`.kctg-color-swatch[data-field="${field}"]`);
          if (swatch) swatch.value = val;
        }
      });
    });
    el.querySelectorAll(".kctg-color-clear").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const field = btn.dataset.field;
        this._pending[field] = "";
        const hexInput = el.querySelector(`.kctg-color-hex[data-field="${field}"]`);
        if (hexInput) hexInput.value = "";
      });
    });

    // Linked quest drop zone
    const questSlot = el.querySelector(".kctg-loc-quest-slot");
    if (questSlot) {
      questSlot.addEventListener("dragover", e => { e.preventDefault(); questSlot.classList.add("kctg-drag-over"); });
      questSlot.addEventListener("dragleave", () => questSlot.classList.remove("kctg-drag-over"));
      questSlot.addEventListener("drop", async e => {
        e.preventDefault(); questSlot.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (!["JournalEntryPage","JournalEntry"].includes(data.type)) return;
        const doc = await foundry.utils.fromUuid(data.uuid).catch(() => null);
        if (!doc) return;
        this._pending.linkedQuestId = doc.uuid; this.render();
      });
    }
    el.querySelector(".kctg-loc-quest-clear")?.addEventListener("click", () => {
      this._pending.linkedQuestId = null; this.render();
    });

    // Save — commit all pending changes, one settings write, then close
    el.querySelector(".kctg-loc-save-btn")?.addEventListener("click", async () => {
      const m = getMapCfg();
      const idx = (m.locations ?? []).findIndex(l => l.id === this._locId);
      if (idx !== -1) Object.assign(m.locations[idx], this._pending);
      if (this._pendingIsHome) {
        m.homeLocationId = this._locId;
      } else if (m.homeLocationId === this._locId) {
        m.homeLocationId = null;
      }
      await saveMapCfg(m);
      this.close();
    });

    // Delete — immediate (removes the location entirely)
    el.querySelector(".kctg-loc-delete")?.addEventListener("click", async e => {
      e.stopPropagation();
      const m = getMapCfg();
      m.locations = (m.locations ?? []).filter(l => l.id !== this._locId);
      m.routes    = (m.routes    ?? []).filter(r => r.fromId !== this._locId && r.toId !== this._locId);
      if (m.homeLocationId === this._locId) m.homeLocationId = null;
      await saveMapCfg(m);
      this.close();
    });
  }
}

// ─── COIN HELPERS ──────────────────────────────────────────────────────────────

const _coinNameToDenom = {
  "Gold Pieces":"gp", "Silver Pieces":"sp", "Copper Pieces":"cp", "Platinum Pieces":"pp",
  "GP":"gp", "SP":"sp", "CP":"cp", "PP":"pp",
};
const _coinSlugToDenom = { "gold-pieces":"gp", "silver-pieces":"sp", "copper-pieces":"cp", "platinum-pieces":"pp" };

function _isCoinItem(item) {
  if (item.type === "money") return true;
  if (_coinNameToDenom[item.name]) return true;
  if (_coinSlugToDenom[item.system?.slug]) return true;
  if (item.type === "treasure" && item.system?.traits?.value?.includes("currency")) return true;
  return false;
}

function _actorCoinageStr(actor) {
  if (!actor) return null;
  const coins = actor.system?.coins ?? actor.system?.currency ?? null;
  if (!coins) return null;
  const parts = [];
  const pp = Number(coins.pp ?? 0), gp = Number(coins.gp ?? 0),
        sp = Number(coins.sp ?? 0), cp = Number(coins.cp ?? 0);
  if (pp) parts.push(`${pp} pp`);
  if (gp) parts.push(`${gp} gp`);
  if (sp) parts.push(`${sp} sp`);
  if (cp) parts.push(`${cp} cp`);
  return parts.length ? parts.join(" · ") : null;
}

// ─── WORKSHOP HUB ──────────────────────────────────────────────────────────────

class WorkshopApp extends KCTGMixin(
  foundry.applications.api.HandlebarsApplicationMixin(
    foundry.applications.api.ApplicationV2
  )
) {
  static open() {
    const existing = foundry.applications.instances?.get("kctg-workshop--hub");
    if (existing?.rendered) { existing.bringToFront(); return existing; }
    return new WorkshopApp().render(true);
  }

  constructor(options = {}) {
    super(options);
    this._tab = "overview";
    this._collapsedWF = new Set();
    // Map tab state (mirrors TradeMapApp)
    this._editMode     = false;
    this._placeMode    = false;
    this._waypointMode = false;
    this._routeMode    = false;
    this._pendingFrom  = null;
    this._panX = 0; this._panY = 0; this._zoom = 1;
    this._naturalW = 800; this._naturalH = 600;
    this._panCleanup = null; this._animRAF = null;
    this._savedView  = null; // set via "Set View" button, restored on reset
    // Settings panels
    this._workerSettingsOpen = false;
    this._toSettingsOpen     = false;
    // Trade orders state
    this._selectedCityId  = null;   // which city is showing orders on the right
    this._collapsedOrders = new Set(); // order IDs whose cards are collapsed
  }

  static DEFAULT_OPTIONS = {
    id: "kctg-workshop--hub",
    classes: ["kctg-module", "kctg-workshop-app"],
    window: { title: "Workshop", resizable: true },
    position: { width: 760, height: 700, top: 80, left: 120 }
  };
  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/workshop/workshop-hub.hbs`, scrollable: [".kctg-tab-content"] }
  };

  async _preFirstRender(context, options) {
    // Runs before the first render — catches tasks that elapsed while the app was closed.
    await _checkAutoComplete();
  }

  async _prepareContext() {
    const rawWorkers = getWorkers();
    const rawGroups  = getGroups();
    const rawTasks   = getTasks();
    const invLog     = getInvLog();
    const mapCfgData = getMapCfg();
    const mode       = game.settings.get(MODULE_ID, "participationMode");
    // Friendly badge label: the short word before the ":" in the setting's choice text.
    const _modeChoices = { autonomous: "Autonomous", collaborative: "Collaborative", manual: "Manual" };
    const modeLabel  = _modeChoices[mode] ?? mode;
    const fineCtl    = game.settings.get(MODULE_ID, "calendarFineControl");
    const curDay     = getCurrentDay();
    const opnDay     = getOpenedDay();
    const wsActorId  = getWsActorId();
    const wsActor    = wsActorId ? game.actors?.get(wsActorId) : null;
    const bd         = breakdownDays(curDay);

    const wsBanner = getBanner();
    const workers = rawWorkers.map(w => ({
      ...w,
      isIdle:      !w.currentTaskId,
      currentTask: rawTasks.find(t => t.id === w.currentTaskId) ?? null,
      taskIcon:    TASK_TYPES[rawTasks.find(t => t.id === w.currentTaskId)?.type]?.icon ?? "fas fa-couch",
      // Card silhouette: real portrait if the worker has one, else fall back to the
      // Overview banner (placeholder / manually-added workers).
      artImg:      (w.img && !w.img.includes("mystery-man")) ? w.img : wsBanner,
    }));

    const groups = rawGroups.map(g => ({
      ...g,
      members: workers.filter(w => (g.workerIds ?? []).includes(w.id)),
      idleCount: workers.filter(w => (g.workerIds ?? []).includes(w.id) && w.isIdle).length,
    }));

    const taskTypeList = Object.entries(TASK_TYPES).map(([id, v]) => ({ id, ...v }));

    // Build a flat list of routes for the task route-selector dropdown.
    // Show ALL routes (not filtered by home) so any route can be used as a trade task.
    const mapLocations = (mapCfgData.locations ?? []).map(l => ({ id: l.id, name: l.name, icon: l.icon }));
    const mapRoutes = (mapCfgData.routes ?? []).map(r => {
      const from = (mapCfgData.locations ?? []).find(l => l.id === r.fromId);
      const to   = (mapCfgData.locations ?? []).find(l => l.id === r.toId);
      const label = (from && to) ? `${from.name} ↔ ${to.name}` : (r.name || "Unknown Route");
      return { ...r, travelDays: r.travelDays ?? 1, label };
    });

    // ── Map tab context (only fully built when on map tab) ──
    // Use full float precision so icons aren't snapped to a 1%-grid
    const homeId = mapCfgData.homeLocationId ?? null;
    // Resolve quest status for locations that have a linkedQuestId
    const _completedQuestIds = new Set(
      game.journal.contents.flatMap(j =>
        j.pages.contents
          .filter(p => p.getFlag(MODULE_ID, "status") === "completed")
          .map(p => p.id)
      )
    );
    const _inProgressQuestIds = new Set(
      game.journal.contents.flatMap(j =>
        j.pages.contents
          .filter(p => ["in-progress"].includes(p.getFlag(MODULE_ID, "status") ?? ""))
          .map(p => p.id)
      )
    );

    const mapLocsPct = (mapCfgData.locations ?? []).map(l => {
      let pinStyle = "";
      if (l.rimColor)             pinStyle += `--pin-rim:${l.rimColor};`;
      if (l.bgColor)              pinStyle += `--pin-bg:${l.bgColor};`;
      if (l.glowColor)            pinStyle += `--pin-glow:${l.glowColor};`;
      if (l.scale && l.scale !== 1) pinStyle += `--kctg-pin-scale:${l.scale};`;
      // Quest pin: derive status from linkedQuestId
      let questStatus = null;
      if (l.linkedQuestId) {
        const qPageId = l.linkedQuestId.split(".").pop(); // extract page ID from UUID
        if (_completedQuestIds.has(qPageId))      questStatus = "completed";
        else if (_inProgressQuestIds.has(qPageId)) questStatus = "active";
        else                                        questStatus = "hidden";
      }
      return { ...l, xPct: parseFloat((l.x * 100).toFixed(3)), yPct: parseFloat((l.y * 100).toFixed(3)), pinStyle: pinStyle || null, tintColor: l.tintColor || null, questStatus };
    });
    const activeTaskRouteIds = new Set(rawTasks.filter(t => t.type === "trade" && t.status === "active" && t.routeId).map(t => t.routeId));
    const mapRouteLines = _buildRouteCurves(mapLocsPct.map(l => ({ ...l, x: l.xPct / 100, y: l.yPct / 100 })), mapCfgData.routes ?? [], activeTaskRouteIds);
    const travelingWorkers = [];
    rawTasks.filter(t => t.type === "trade" && t.status === "active").forEach(task => {
      const route = (mapCfgData.routes ?? []).find(r => r.id === task.routeId); if (!route) return;
      const from = mapLocsPct.find(l => l.id === route.fromId), to = mapLocsPct.find(l => l.id === route.toId); if (!from || !to) return;
      const elapsed = Math.max(0, curDay - (task.startDay ?? curDay));
      const wCount  = (task.assignedWorkerIds ?? []).length || 1;
      const effTaskDays = wCount > 1 ? Math.ceil((task.taskDays ?? 1) / wCount) : (task.taskDays ?? 1);
      const travelDays  = Math.max(1, task.travelDays ?? 1);
      let phase, startProgress;
      if (elapsed <= travelDays) { phase = "outbound"; startProgress = Math.min(1, elapsed / travelDays); }
      else if (elapsed <= travelDays + effTaskDays) { phase = "atDestination"; startProgress = 1; }
      else { phase = "returning"; startProgress = Math.max(0, 1 - (elapsed - travelDays - effTaskDays) / travelDays); }
      const rawPts = [{ x: from.xPct, y: from.yPct }, ...(route.waypoints ?? []).map(wp => ({ x: wp.x * 100, y: wp.y * 100 })), { x: to.xPct, y: to.yPct }];
      const animPts = phase === "returning" ? rawPts.slice().reverse() : rawPts;
      const ptsStr = animPts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
      const startPos = _posAlongPts(animPts, startProgress);
      rawWorkers.filter(w => (task.assignedWorkerIds ?? []).includes(w.id)).forEach((w, i) => {
        const xPct = parseFloat((startPos.x + i * 2).toFixed(3));
        const yPct = parseFloat(startPos.y.toFixed(3));
        travelingWorkers.push({ ...w, xPct, yPct, taskName: task.name, phase, startProgress, fromXPct: from.xPct, fromYPct: from.yPct, toXPct: to.xPct, toYPct: to.yPct, ptsStr });
      });
    });

    const tasks = rawTasks.map(t => {
      const travelDays      = t.travelDays  ?? 1;
      const baseTaskDays    = t.taskDays    ?? 1;
      const workerCount     = (t.assignedWorkerIds ?? []).length;
      // Extra workers speed up task phase only (halved, rounded up, per extra worker)
      const effectTaskDays  = workerCount > 1 ? Math.ceil(baseTaskDays / workerCount) : baseTaskDays;
      const durationDays    = 2 * travelDays + effectTaskDays;
      const elapsed         = (t.status === "active" && t.startDay != null) ? Math.max(0, curDay - t.startDay) : null;
      const progressPct     = (t.status === "active" && t.startDay != null)
        ? Math.min(100, Math.round((elapsed / durationDays) * 100)) : (t.status === "complete" ? 100 : 0);
      const daysLeft        = (elapsed != null) ? Math.max(0, durationDays - elapsed) : null;
      const idleWorkersForTask = workers.filter(w => w.isIdle);
      const idleGroupsForTask  = groups.filter(g => g.idleCount > 0);
      const linkedRoute     = t.routeId ? mapRoutes.find(r => r.id === t.routeId) : null;
      return {
        ...t,
        travelDays, taskDays: baseTaskDays, effectTaskDays, durationDays,
        typeLabel: TASK_TYPES[t.type]?.label ?? t.type,
        typeIcon:  TASK_TYPES[t.type]?.icon  ?? "fas fa-tasks",
        typeColor: TASK_TYPES[t.type]?.color ?? "#888",
        statusLabel: STATUS_META[t.status]?.label ?? t.status,
        statusIcon:  STATUS_META[t.status]?.icon  ?? "fas fa-clock",
        statusColor: STATUS_META[t.status]?.color ?? "#888",
        assignedWorkers: workers.filter(w => (t.assignedWorkerIds ?? []).includes(w.id)),
        idleWorkers: idleWorkersForTask,
        idleGroups:  idleGroupsForTask,
        hasItems:    (t.itemResults ?? []).length > 0,
        elapsed, progressPct, daysLeft,
        isActive:    t.status === "active",
        isComplete:  t.status === "complete",
        isBoosted:   workerCount > 1,
        isTradeTask:  t.type === "trade",
        isPatrolTask: t.type === "patrol",
        linkedRouteName:       linkedRoute?.label ?? null,
        linkedRouteTravelDays: linkedRoute?.travelDays ?? null,
        linkedLocationName: t.locationId
          ? ((mapCfgData.locations ?? []).find(l => l.id === t.locationId)?.name ?? null)
          : null,
      };
    });

    // ── Worker folders ─────────────────────────────────────────────────────────
    const rawWFolders = getWFolders();
    const workerFolderList = rawWFolders.map(f => ({
      ...f,
      workers: workers.filter(w => w.folderId === f.id),
      collapsed: this._collapsedWF.has(f.id),
    }));
    const ungroupedWorkers = workers.filter(w => !w.folderId);

    // ── Inventory — read LIVE from actor sheets, use log only for task metadata ──
    // This ensures qty changes on the actor sheet are reflected immediately,
    // and items added directly to the actor (not via tasks) also appear.
    // ── Flat inventory: all items from all relevant actors ──────────────────
    const logByEmbeddedId = {};
    for (const entry of invLog) logByEmbeddedId[`${entry.actorId}::${entry.embeddedItemId}`] = entry;

    const actorIds = new Set(invLog.map(e => e.actorId));
    if (wsActorId) actorIds.add(wsActorId);

    const allInvItems = [];

    let invGp = 0, invSp = 0, invCp = 0;

    for (const aid of actorIds) {
      const actor = game.actors?.get(aid);
      if (!actor) continue;
      for (const item of actor.items) {
        if (!isInventoryItem(item)) continue;
        if (_isCoinItem(item)) {
          // Only tally coins for the wsActor (retainer)
          if (aid === wsActorId) {
            const denom = _coinSlugToDenom[item.system?.slug] ?? _coinNameToDenom[item.name] ?? null;
            const qty = Number(item.system?.quantity ?? 0);
            if (denom === "gp") invGp += qty;
            else if (denom === "sp") invSp += qty;
            else if (denom === "cp") invCp += qty;
          }
          continue;
        }
        const logEntry = logByEmbeddedId[`${aid}::${item.id}`];
        const qty = item.system?.quantity ?? item.system?.amount ?? 1;
        const price = getItemPrice(item);
        allInvItems.push({
          id: logEntry?.id ?? `live::${aid}::${item.id}`,
          embeddedItemId: item.id, actorId: aid,
          itemName: item.name, itemImg: item.img ?? "icons/svg/item-bag.svg",
          qty, priceLabel: price.label,
          taskName: logEntry?.taskName ?? "Workshop Stock", fromLog: !!logEntry,
        });
      }
    }

    // Fallback: if PF2e coin items weren't found, try actor.system.coins directly
    if (!invGp && !invSp && !invCp && wsActor) {
      const coins = wsActor.system?.coins ?? wsActor.system?.currency ?? null;
      if (coins) {
        const parseV = v => typeof v === "object" && v !== null ? Number(v.value ?? 0) : Number(v ?? 0);
        invGp = parseV(coins.gp); invSp = parseV(coins.sp); invCp = parseV(coins.cp);
      }
    }

    const invCoinage = null; // replaced by invGp/invSp/invCp chips in template

    // ── Inventory folders ────────────────────────────────────────────────────
    const rawInvFolders  = getInvFolders();
    const invItemFolderMap = getInvItemFolders();
    const folderIds = new Set(rawInvFolders.map(f => f.id));
    const ungroupedInvItems = allInvItems.filter(item => {
      const fId = invItemFolderMap[item.id];
      return !fId || !folderIds.has(fId);
    });
    const invFolderList = rawInvFolders.map(f => ({
      ...f,
      items: allInvItems.filter(item => invItemFolderMap[item.id] === f.id),
    }));

    const daysOpen = Math.max(0, curDay - opnDay);

    // ── Tracker entries — per-item progress is tracked manually by the GM.
    // The assigned actor is identity only (avatar/name), it does not drive qty.
    const rawTrackerEntries = getTrackerEntries();
    const trackerEntries = rawTrackerEntries.map(e => {
      const enrichedTrackedItems = (e.trackedItems ?? []).map(ti => ({ ...ti, currentQty: Number(ti.currentQty ?? 0) }));

      let progressPct;
      if (enrichedTrackedItems.length > 0) {
        const totalTarget  = enrichedTrackedItems.reduce((s, i) => s + (i.targetQty ?? 1), 0);
        const totalCurrent = enrichedTrackedItems.reduce((s, i) => s + Math.min(i.currentQty, i.targetQty ?? 1), 0);
        progressPct = totalTarget > 0 ? Math.min(100, Math.round((totalCurrent / totalTarget) * 100)) : 0;
      } else {
        progressPct = (e.total ?? 0) > 0 ? Math.min(100, Math.round(((e.current ?? 0) / e.total) * 100)) : 0;
      }
      return { ...e, progressPct, trackedItems: enrichedTrackedItems };
    });

    // ── Trade orders (migrated) — quest-style left/right layout ──────────────
    const cityTableUuidsMap = getCityTableUuids();
    const allLocations      = mapCfgData.locations ?? [];
    // Auto-select first city if none is set or the stored one disappeared
    if (!this._selectedCityId || !allLocations.some(l => l.id === this._selectedCityId)) {
      this._selectedCityId = allLocations[0]?.id ?? null;
    }
    // Quest-linked orders stay LOCKED until their quest completes: hidden from
    // players entirely, shown dimmed with a lock badge to order managers.
    const _orderQuestLocked = o =>
      !!o.linkedQuestId && !_completedQuestIds.has(o.linkedQuestId.split(".").pop());
    const _isGMUser = game.user?.isGM ?? false;
    const tradeOrderCities = allLocations.map(loc => {
      const rawOrders = getTradeOrders().filter(o => o.locationId === loc.id).map(_migrateTradeOrder);
      const visible   = _isGMUser ? rawOrders : rawOrders.filter(o => !_orderQuestLocked(o));
      const ctUuid    = cityTableUuidsMap[loc.id] ?? "";
      return {
        ...loc,
        orders: visible,
        orderCount: visible.length,
        isSelected: loc.id === this._selectedCityId,
        cityTableUuid: ctUuid,
        cityTableName: ctUuid ? (ctUuid.split(".").pop() ?? ctUuid) : "",
      };
    });
    const selectedCity = tradeOrderCities.find(c => c.isSelected) ?? null;
    // Enrich selected city orders with collapse state, fulfilment readiness,
    // deadline state, and quest-lock state.
    // Stock is read from the retainer (the canonical workshop inventory).
    const wsStock = _wsStockMap(wsActor);
    const selectedCityOrders = (selectedCity?.orders ?? []).map(o => {
      const needs = (o.needs ?? []).map(n => {
        const have = wsStock.get(n.itemName) ?? 0;
        return { ...n, have, enough: have >= n.qty };
      });
      const fulfilled   = !!o.fulfilledAt;
      const st          = _orderDeadlineState(o, curDay);
      const questLocked = _orderQuestLocked(o);
      let linkedQuestName = null;
      if (o.linkedQuestId) {
        try { linkedQuestName = foundry.utils.fromUuidSync(o.linkedQuestId)?.name ?? "Unknown quest"; }
        catch { linkedQuestName = "Unknown quest"; }
      }
      return {
        ...o,
        needs,
        collapsed: this._collapsedOrders.has(o.id),
        fulfilled,
        fulfilledLate: !!o.fulfilledLate,
        questLocked, linkedQuestName,
        dueDay: st.dueDay, daysLeft: st.daysLeft,
        overdue: st.overdue, expired: st.expired, late: st.late,
        latePenaltyPct: _orderLatePct(o),
        lateModePenalty: o.lateMode === "penalty",
        canFulfill: !fulfilled && !st.expired && !questLocked && !!wsActor && needs.length > 0 && needs.every(n => n.enough),
      };
    });

    return {
      tab: this._tab,
      isOverview:    this._tab === "overview",
      isMap:         this._tab === "map",
      isWorkers:     this._tab === "workers",
      isTasks:       this._tab === "tasks",
      isTradeOrders: this._tab === "tradeOrders",
      isInventory:   this._tab === "inventory",
      isTracker:     this._tab === "tracker",
      trackerEntries,
      selectedCity, selectedCityOrders,
      // Map tab data
      locations: mapLocsPct, routes: mapRouteLines, travelingWorkers,
      editMode: this._editMode, placeMode: this._placeMode, waypointMode: this._waypointMode, routeMode: this._routeMode, pendingFrom: this._pendingFrom,
      hasBackground: !!(mapCfgData.backgroundImage), homeLocationId: homeId,
      hasSavedView: !!this._savedView,
      workers, ungroupedWorkers, workerFolderList,
      groups, tasks, taskTypeList, mapRoutes, mapLocations,
      tradeOrderCities,
      allInvItems, ungroupedInvItems, invFolderList, invCoinage,
      invGp, invSp, invCp,
      totalInventory: allInvItems.length,
      idleCount:    workers.filter(w => w.isIdle).length,
      activeCount:  tasks.filter(t => t.status === "active").length,
      totalWorkers: workers.length,
      totalTasks:   tasks.length,
      totalTradeOrders: tradeOrderCities.reduce((s, c) => s + (c.orders?.length ?? 0), 0),
      isGM:         game.user?.isGM ?? false,
      mode, modeLabel,
      workshopBanner: getBanner(),
      workshopName:   getWsName(),
      wsActor:  wsActor ? { id: wsActor.id, name: wsActor.name, img: wsActor.img ?? "icons/svg/mystery-man.svg" } : null,
      wsActorCoinage: _actorCoinageStr(wsActor),
      hasWsActor: !!wsActor,
      curDay, opnDay, daysOpen,
      daysOpenStr: fmtElapsed(daysOpen),
      fineCtl,
      curYear:   bd.years,
      curMonth:  bd.months,
      curDayRem: bd.days,
      // World-clock binding: when bound, surface Foundry's real calendar date
      worldBound:  isWorldClockBound(),
      worldDateStr: isWorldClockBound() ? getWorldDateStr() : null,
      // Settings panel visibility
      workerSettingsOpen: this._workerSettingsOpen,
      toSettingsOpen:     this._toSettingsOpen,
      // Worker morale/loyalty thresholds
      moraleHighChance: game.settings.get(MODULE_ID, "moraleHighRerollChance") ?? 20,
      moraleLowChance:  game.settings.get(MODULE_ID, "moraleLowSkipChance")    ?? 20,
      loyaltyHighChance:game.settings.get(MODULE_ID, "loyaltyHighSpeedChance") ?? 20,
      loyaltyLowChance: game.settings.get(MODULE_ID, "loyaltyLowSlowChance")   ?? 20,
      // Morale automation (drift toward baseline + task-completion nudge)
      moraleAuto:      game.settings.get(MODULE_ID, "moraleAutomation") ?? false,
      moraleBaseline:  game.settings.get(MODULE_ID, "moraleBaseline")   ?? 5,
      moraleDriftDays: game.settings.get(MODULE_ID, "moraleDriftDays")  ?? 3,
      // Trade order settings
      tradeQtyMin:  game.settings.get(MODULE_ID, "tradeOrderQtyMin")       ?? 1,
      tradeQtyMax:  game.settings.get(MODULE_ID, "tradeOrderQtyMax")       ?? 10,
      tradeVariance:game.settings.get(MODULE_ID, "tradeOrderPriceVariance") ?? 20,
      // Players can edit existing orders only when the GM enables it (creating stays GM-only)
      playerEditOrders: game.settings.get(MODULE_ID, "tradeOrdersPlayerEdit") ?? false,
      // Gates field edits AND lifecycle administration (Reopen). Backed by the
      // persisted setting key "tradeOrdersPlayerEdit", which keeps its old name.
      canManageOrders:  (game.user?.isGM ?? false) || (game.settings.get(MODULE_ID, "tradeOrdersPlayerEdit") ?? false),
      // The Force-complete toggle state (for the settings button), and whether the
      // per-order Force button shows. Force is GM-only: players never see it.
      allowForce:       game.settings.get(MODULE_ID, "tradeOrdersAllowForce") ?? false,
      showForce:        (game.user?.isGM ?? false) && (game.settings.get(MODULE_ID, "tradeOrdersAllowForce") ?? false),
    };
  }

  _onRender(context, options) {
    const el = this.element;
    _applyTheme(el);

    // ── TABS ──
    el.querySelectorAll(".kctg-tab-btn").forEach(btn =>
      btn.addEventListener("click", () => { this._tab = btn.dataset.tab; this.render(); })
    );

    // ── MAP TAB ──
    if (this._tab === "map") this._setupMapTab(el);

    if (game.user?.isGM) this._wireOverview(el);
    this._wireWorkers(el);
    this._wireTasks(el);
    this._wireTradeOrders(el);
    this._wireInventory(el);
    this._wireTracker(el);
  }

  // ─── _onRender sub-handlers ─────────────────────────────────────────────────

  _wireOverview(el) {
    el.querySelector(".kctg-ws-name-input")?.addEventListener("change", async e => {
      await saveWsName(e.target.value.trim() || "The Workshop"); this.render();
    });
    el.querySelector(".kctg-banner-area")?.addEventListener("click", () => {
      openIconPicker(getBanner() || "scenes/", async path => { await saveBanner(path); this.render(); });
    });
    el.querySelector(".kctg-banner-clear")?.addEventListener("click", async e => {
      e.stopPropagation(); await saveBanner(""); this.render();
    });
    const wsDrop = el.querySelector(".kctg-ws-actor-slot");
    if (wsDrop) {
      wsDrop.addEventListener("dragover",  e => e.preventDefault());
      wsDrop.addEventListener("dragenter", e => { e.preventDefault(); wsDrop.classList.add("kctg-drag-over"); });
      wsDrop.addEventListener("dragleave", () => wsDrop.classList.remove("kctg-drag-over"));
      wsDrop.addEventListener("drop", async e => {
        e.preventDefault(); wsDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Actor") return ui.notifications.warn("Drop an Actor here.");
        const actor = await safeFromUuid(data.uuid ?? `Actor.${data.id}`);
        if (!actor) return;
        await saveWsActorId(actor.id); this.render();
      });
    }
    el.querySelector(".kctg-ws-actor-clear")?.addEventListener("click", async e => {
      e.stopPropagation(); await saveWsActorId(""); this.render();
    });
    el.querySelector(".kctg-day-minus")?.addEventListener("click",   async () => { await advanceDays(-1);  this.render(); });
    el.querySelector(".kctg-day-plus")?.addEventListener("click",    async () => { await advanceDays(1);   this.render(); });
    el.querySelector(".kctg-day-minus10")?.addEventListener("click", async () => { await advanceDays(-10); this.render(); });
    el.querySelector(".kctg-day-plus10")?.addEventListener("click",  async () => { await advanceDays(10);  this.render(); });
    el.querySelector(".kctg-day-direct")?.addEventListener("change", async e => {
      await setCurrentDay(parseInt(e.target.value) || 1); this.render();
    });
    const syncFine = async () => {
      const y = parseInt(el.querySelector(".kctg-fine-year")?.value  || 0);
      const m = parseInt(el.querySelector(".kctg-fine-month")?.value || 0);
      const d = parseInt(el.querySelector(".kctg-fine-day")?.value   || 1);
      await setCurrentDay(totalDays({ years: y, months: m, days: d })); this.render();
    };
    el.querySelector(".kctg-fine-year")?.addEventListener("change",  syncFine);
    el.querySelector(".kctg-fine-month")?.addEventListener("change", syncFine);
    el.querySelector(".kctg-fine-day")?.addEventListener("change",   syncFine);
    el.querySelector(".kctg-set-opened")?.addEventListener("click", async () => {
      await saveOpenedDay(getCurrentDay()); this.render();
    });
  }

  _wireWorkers(el) {
    el.querySelector(".kctg-add-worker")?.addEventListener("click", async () => {
      const name = await foundry.applications.api.DialogV2.prompt({
        window: { title: "New Worker" },
        content: `<input type="text" name="workerName" placeholder="Worker name" autofocus style="width:100%;box-sizing:border-box;" />`,
        ok: { label: "Add", callback: (event, button) => button.form.elements.workerName.value.trim() },
        modal: true, rejectClose: false,
      });
      if (!name) return; // cancelled or left blank
      const ws = getWorkers();
      ws.push({ id: newId(), name, img: "icons/svg/mystery-man.svg", morale: 5, loyalty: 5, currentTaskId: null, notes: "" });
      await saveWorkers(ws); this.render();
    });
    const workerDrop = el.querySelector(".kctg-actor-drop-zone");
    if (workerDrop) {
      workerDrop.addEventListener("dragover",  e => e.preventDefault());
      workerDrop.addEventListener("dragenter", e => { e.preventDefault(); workerDrop.classList.add("kctg-drag-over"); });
      workerDrop.addEventListener("dragleave", () => workerDrop.classList.remove("kctg-drag-over"));
      workerDrop.addEventListener("drop", async e => {
        e.preventDefault(); workerDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Actor") return ui.notifications.warn("Drop an Actor here.");
        const actor = await safeFromUuid(data.uuid ?? `Actor.${data.id}`);
        if (!actor) return;
        const ws = getWorkers();
        ws.push({ id: newId(), name: actor.name, img: actor.img ?? "icons/svg/mystery-man.svg", morale: 5, loyalty: 5, currentTaskId: null, notes: "" });
        await saveWorkers(ws); this.render();
      });
    }
    el.querySelectorAll(".kctg-worker-morale").forEach(input =>
      input.addEventListener("change", async e => {
        const ws = getWorkers(), w = ws.find(x => x.id === e.target.dataset.id); if (!w) return;
        const v = Math.max(0, Math.min(10, parseInt(e.target.value) || 0));
        e.target.value = v;
        w.morale = v; await saveWorkers(ws);
        e.target.classList.remove("kctg-morale-high", "kctg-morale-mid", "kctg-morale-low");
        e.target.classList.add(v >= 8 ? "kctg-morale-high" : v >= 5 ? "kctg-morale-mid" : "kctg-morale-low");
      })
    );
    el.querySelectorAll(".kctg-worker-loyalty").forEach(input =>
      input.addEventListener("change", async e => {
        const ws = getWorkers(), w = ws.find(x => x.id === e.target.dataset.id); if (!w) return;
        const v = Math.max(0, Math.min(10, parseInt(e.target.value) || 0));
        e.target.value = v;
        w.loyalty = v; await saveWorkers(ws);
        e.target.style.color = v >= 8 ? "var(--kctg-success)" : v >= 5 ? "var(--kctg-gold)" : "var(--kctg-danger)";
      })
    );
    el.querySelectorAll(".kctg-worker-edit").forEach(btn =>
      btn.addEventListener("click", async () => {
        const w = getWorkers().find(x => x.id === btn.dataset.id); if (!w) return;
        const safe = String(w.name ?? "").replaceAll('"', "&quot;");
        const name = await foundry.applications.api.DialogV2.prompt({
          window: { title: "Rename Worker" },
          content: `<input type="text" name="workerName" value="${safe}" autofocus style="width:100%;box-sizing:border-box;" />`,
          ok: { label: "Save", callback: (event, button) => button.form.elements.workerName.value.trim() },
          modal: true, rejectClose: false,
        });
        if (!name) return; // cancelled or left blank
        const ws = getWorkers(), ww = ws.find(x => x.id === btn.dataset.id);
        if (ww) { ww.name = name; await saveWorkers(ws); this.render(); }
      })
    );
    el.querySelectorAll(".kctg-delete-worker").forEach(btn =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const ts = getTasks();
        ts.forEach(t => { t.assignedWorkerIds = (t.assignedWorkerIds ?? []).filter(wid => wid !== id); });
        await saveTasks(ts);
        await saveWorkers(getWorkers().filter(w => w.id !== id));
        this.render();
      })
    );
    el.querySelectorAll(".kctg-worker-unassign").forEach(btn =>
      btn.addEventListener("click", async () => {
        const wid = btn.dataset.id;
        const ws  = getWorkers(), w = ws.find(x => x.id === wid); if (!w) return;
        const ts  = getTasks(), t = ts.find(x => x.id === w.currentTaskId);
        if (t) { t.assignedWorkerIds = (t.assignedWorkerIds ?? []).filter(id => id !== wid); await saveTasks(ts); }
        w.currentTaskId = null; await saveWorkers(ws); this.render();
      })
    );
    // Groups
    el.querySelector(".kctg-add-group")?.addEventListener("click", async () => {
      const gs = getGroups();
      gs.push({ id: newId(), name: "New Group", workerIds: [] });
      await saveGroups(gs); this.render();
    });
    this._bindTextField(el, ".kctg-group-name", getGroups, saveGroups, "name");
    el.querySelectorAll(".kctg-delete-group").forEach(btn =>
      btn.addEventListener("click", async () => {
        await saveGroups(getGroups().filter(g => g.id !== btn.dataset.id)); this.render();
      })
    );
    // Worker folders
    el.querySelector(".kctg-add-worker-folder")?.addEventListener("click", async () => {
      const fs = getWFolders(); fs.push({ id: newId(), name: "New Folder" }); await saveWFolders(fs); this.render();
    });
    this._bindTextField(el, ".kctg-wfolder-name", getWFolders, saveWFolders, "name");
    el.querySelectorAll(".kctg-delete-wfolder").forEach(btn =>
      btn.addEventListener("click", async () => {
        const ws = getWorkers().map(w => w.folderId === btn.dataset.id ? { ...w, folderId: null } : w);
        await saveWorkers(ws);
        await saveWFolders(getWFolders().filter(f => f.id !== btn.dataset.id)); this.render();
      })
    );
    // Worker card drag-to-folder
    el.querySelectorAll(".kctg-worker-card[data-worker-id]").forEach(card => {
      card.setAttribute("draggable", "true");
      // Disable card drag the moment a press lands on an interactive control, so the
      // browser does normal text selection / spinner drag; re-enable on the card body.
      card.addEventListener("pointerdown", e => {
        card.draggable = !e.target.closest("input, textarea, select, button");
      });
      card.addEventListener("dragstart", e => {
        // Belt-and-suspenders: still bail if a drag somehow starts on a control.
        if (e.target.closest("input, textarea, select, button")) { e.preventDefault(); return; }
        e.dataTransfer.setData("text/plain", JSON.stringify({ type: "kctg-worker", id: card.dataset.workerId }));
        e.dataTransfer.effectAllowed = "move";
        card.classList.add("kctg-dragging");
      });
      card.addEventListener("dragend", () => card.classList.remove("kctg-dragging"));
    });
    const _workerDrop = async (e, targetFolderId) => {
      e.preventDefault();
      let d; try { d = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
      if (d.type !== "kctg-worker") return;
      const ws = getWorkers(), w = ws.find(x => x.id === d.id); if (!w) return;
      w.folderId = targetFolderId || null;
      await saveWorkers(ws); this.render();
    };
    el.querySelectorAll(".kctg-folder-drop[data-folder-id]").forEach(zone => {
      zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("kctg-drag-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("kctg-drag-over"));
      zone.addEventListener("drop",      e => { zone.classList.remove("kctg-drag-over"); _workerDrop(e, zone.dataset.folderId); });
    });
    const ungroupedWorkerGrid = el.querySelector(".kctg-roster-grid.kctg-ungrouped");
    if (ungroupedWorkerGrid) {
      ungroupedWorkerGrid.addEventListener("dragover", e => e.preventDefault());
      ungroupedWorkerGrid.addEventListener("drop",     e => _workerDrop(e, null));
    }
    el.querySelectorAll(".kctg-folder-toggle").forEach(btn =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.id, set = this._collapsedWF;
        if (set.has(id)) set.delete(id); else set.add(id);
        this.render();
      })
    );
    el.querySelectorAll(".kctg-group-add-worker").forEach(sel =>
      sel.addEventListener("change", async e => {
        const wid = e.target.value; if (!wid) return;
        const gs = getGroups(), g = gs.find(x => x.id === e.target.dataset.id); if (!g) return;
        g.workerIds = g.workerIds ?? [];
        if (!g.workerIds.includes(wid)) g.workerIds.push(wid);
        await saveGroups(gs); e.target.value = ""; this.render();
      })
    );
    el.querySelectorAll(".kctg-group-remove-worker").forEach(btn =>
      btn.addEventListener("click", async () => {
        const { groupId, workerId } = btn.dataset;
        const gs = getGroups(), g = gs.find(x => x.id === groupId); if (!g) return;
        g.workerIds = (g.workerIds ?? []).filter(id => id !== workerId);
        await saveGroups(gs); this.render();
      })
    );
  }

  _wireTasks(el) {
    el.querySelector(".kctg-open-event-tables")?.addEventListener("click", () => new EventTableConfigApp().render(true));
    el.querySelector(".kctg-add-task")?.addEventListener("click", async () => {
      const ts = getTasks();
      ts.push({ id: newId(), name: "New Task", type: "forage", status: "pending", tableUuid: "", tableName: "", notes: "", assignedWorkerIds: [], results: [], itemResults: [], travelDays: 1, taskDays: 1 });
      await saveTasks(ts); this.render();
    });
    this._bindTextField(el, ".kctg-task-name", getTasks, saveTasks, "name");
    this._bindNumField(el, ".kctg-task-travel-days", getTasks, saveTasks, "travelDays", 0, 999);
    this._bindNumField(el, ".kctg-task-task-days",   getTasks, saveTasks, "taskDays",   1, 999);
    el.querySelectorAll(".kctg-task-type").forEach(sel =>
      sel.addEventListener("change", async e => {
        const ts = getTasks(), t = ts.find(x => x.id === e.target.dataset.id);
        if (t) { t.type = e.target.value; await saveTasks(ts); this.render(); }
      })
    );
    el.querySelectorAll(".kctg-task-route-select").forEach(sel =>
      sel.addEventListener("change", async e => {
        const ts = getTasks(), t = ts.find(x => x.id === e.target.dataset.id); if (!t) return;
        const routeId = e.target.value || null;
        t.routeId = routeId;
        if (routeId) {
          const opt = e.target.querySelector(`option[value="${routeId}"]`);
          const preset = parseInt(opt?.dataset.travelDays);
          if (preset > 0) t.travelDays = preset;
        }
        await saveTasks(ts); this.render();
      })
    );
    el.querySelectorAll(".kctg-task-loc-select").forEach(sel =>
      sel.addEventListener("change", async e => {
        const ts = getTasks(), t = ts.find(x => x.id === e.target.dataset.id); if (!t) return;
        t.locationId = e.target.value || null;
        await saveTasks(ts); this.render();
      })
    );
    el.querySelectorAll(".kctg-task-set-active").forEach(btn =>
      btn.addEventListener("click", async () => {
        const ts = getTasks(), t = ts.find(x => x.id === btn.dataset.id); if (!t) return;
        if (t.status === "complete") {
          t.status = "pending"; t.startDay = null; t.completedAt = null; t.itemResults = []; t.results = [];
        } else {
          t.status = "active"; t.startDay = t.startDay ?? getCurrentDay();
          const taskWorkers  = getWorkers().filter(w => (t.assignedWorkerIds ?? []).includes(w.id));
          const hasHighLoy   = taskWorkers.some(w => (w.loyalty ?? 5) >= 10);
          const hasLowLoy    = taskWorkers.some(w => (w.loyalty ?? 5) <= 0);
          const speedChance  = (game.settings.get(MODULE_ID, "loyaltyHighSpeedChance") ?? 20) / 100;
          const slowChance   = (game.settings.get(MODULE_ID, "loyaltyLowSlowChance")   ?? 20) / 100;
          if (hasHighLoy && Math.random() < speedChance) {
            const reduction = 1;
            t.travelDays = Math.max(0, (t.travelDays ?? 1) - reduction);
            _log("Loyalty 10 — speed bonus: travel reduced by", reduction, "day for", t.name);
            ui.notifications.info(`High loyalty — ${t.name} travel shortened by ${reduction} day!`);
          } else if (hasLowLoy && Math.random() < slowChance) {
            t.travelDays = (t.travelDays ?? 1) + 1;
            _log("Loyalty 0 — slowdown: travel increased by 1 day for", t.name);
            ui.notifications.warn(`Low loyalty — ${t.name} travel extended by 1 day.`);
          }
        }
        await saveTasks(ts); this.render();
      })
    );
    el.querySelectorAll(".kctg-task-run").forEach(btn =>
      btn.addEventListener("click", async () => { await runTask(btn.dataset.id); this.render(); })
    );
    el.querySelectorAll(".kctg-task-roll-event").forEach(btn =>
      btn.addEventListener("click", () => {
        const t = getTasks().find(x => x.id === btn.dataset.id);
        if (t) rollEvent(t.type);
      })
    );
    el.querySelectorAll(".kctg-task-collect").forEach(btn =>
      btn.addEventListener("click", async () => { await collectTaskItems(btn.dataset.id); this.render(); })
    );
    el.querySelectorAll(".kctg-task-assign-select").forEach(sel =>
      sel.addEventListener("change", async e => {
        const val = e.target.value; if (!val) return;
        const tid = e.target.dataset.id;
        const ts  = getTasks(), t  = ts.find(x => x.id === tid);
        const ws  = getWorkers();
        if (!t) return;
        const isGroup = val.startsWith("group:");
        const workerIds = isGroup
          ? (getGroups().find(g => g.id === val.slice(6))?.workerIds ?? []).filter(wid => {
              const w = ws.find(x => x.id === wid); return w && !w.currentTaskId;
            })
          : [val];
        t.assignedWorkerIds = t.assignedWorkerIds ?? [];
        for (const wid of workerIds) {
          const w = ws.find(x => x.id === wid); if (!w) continue;
          if (w.currentTaskId && w.currentTaskId !== tid) {
            const prev = ts.find(x => x.id === w.currentTaskId);
            if (prev) prev.assignedWorkerIds = (prev.assignedWorkerIds ?? []).filter(id => id !== wid);
          }
          if (!t.assignedWorkerIds.includes(wid)) t.assignedWorkerIds.push(wid);
          w.currentTaskId = tid;
        }
        await saveTasks(ts); await saveWorkers(ws);
        e.target.value = ""; this.render();
      })
    );
    el.querySelectorAll(".kctg-task-unassign-worker").forEach(btn =>
      btn.addEventListener("click", async () => {
        const { taskId, workerId } = btn.dataset;
        const ts = getTasks(), t  = ts.find(x => x.id === taskId);
        const ws = getWorkers(), w = ws.find(x => x.id === workerId);
        if (t) t.assignedWorkerIds = (t.assignedWorkerIds ?? []).filter(id => id !== workerId);
        if (w && w.currentTaskId === taskId) w.currentTaskId = null;
        await saveTasks(ts); await saveWorkers(ws); this.render();
      })
    );
    el.querySelectorAll(".kctg-task-table-slot").forEach(slot => {
      slot.addEventListener("dragover",  e => e.preventDefault());
      slot.addEventListener("dragenter", e => { e.preventDefault(); slot.classList.add("kctg-drag-over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("kctg-drag-over"));
      slot.addEventListener("drop", async e => {
        e.preventDefault(); slot.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "RollTable") return ui.notifications.warn("Drop a RollTable here.");
        const uuid  = data.uuid ?? (data.id ? `RollTable.${data.id}` : null); if (!uuid) return;
        const table = await safeFromUuid(uuid);
        const ts = getTasks(), t = ts.find(x => x.id === slot.dataset.id);
        if (t) { t.tableUuid = uuid; t.tableName = table?.name ?? "Unknown"; await saveTasks(ts); this.render(); }
      });
    });
    el.querySelectorAll(".kctg-task-clear-table").forEach(btn =>
      btn.addEventListener("click", async () => {
        const ts = getTasks(), t = ts.find(x => x.id === btn.dataset.id);
        if (t) { t.tableUuid = ""; t.tableName = ""; await saveTasks(ts); this.render(); }
      })
    );
    el.querySelectorAll(".kctg-delete-task").forEach(btn =>
      btn.addEventListener("click", async () => {
        const tid = btn.dataset.id;
        const ws  = getWorkers().map(w => w.currentTaskId === tid ? { ...w, currentTaskId: null } : w);
        await saveWorkers(ws);
        await saveTasks(getTasks().filter(t => t.id !== tid));
        this.render();
      })
    );
    // Worker settings toggle
    el.querySelector(".kctg-worker-settings-toggle")?.addEventListener("click", () => {
      this._workerSettingsOpen = !this._workerSettingsOpen; this.render();
    });
    // Morale automation on/off (baseline + drift inputs use the generic
    // .kctg-setting-input wiring below)
    el.querySelector(".kctg-morale-auto-toggle")?.addEventListener("click", async () => {
      await game.settings.set(MODULE_ID, "moraleAutomation", !game.settings.get(MODULE_ID, "moraleAutomation"));
      this.render();
    });
    el.querySelectorAll(".kctg-setting-input").forEach(inp =>
      inp.addEventListener("change", async () => {
        const key = inp.dataset.setting; if (!key) return;
        const val = Number(inp.value); if (isNaN(val)) return;
        await game.settings.set(MODULE_ID, key, val); this.render();
      })
    );
  }

  _wireTradeOrders(el) {
    // ── City selection ────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-city-row").forEach(row =>
      row.addEventListener("click", () => {
        this._selectedCityId = row.dataset.id;
        this.render();
      })
    );

    // ── Fulfil order ──────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-fulfill").forEach(btn =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await _fulfillTradeOrder(btn.dataset.id);
        this.render();
      })
    );

    // ── Force-complete an order (speculative / random: skip goods, grant reward) ─
    el.querySelectorAll(".kctg-to-force-fulfill").forEach(btn =>
      btn.addEventListener("click", async () => {
        const ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Force Complete Order" },
          content: `<p style="margin:0;">Complete this order <strong>without delivering the required goods</strong> and grant the reward to the workshop?</p>`,
          modal: true, rejectClose: false,
        });
        if (!ok) return;
        btn.disabled = true;
        await _fulfillTradeOrder(btn.dataset.id, { force: true });
        this.render();
      })
    );

    // ── Reopen a fulfilled order (make it available again) ────────────────────
    el.querySelectorAll(".kctg-to-reopen").forEach(btn =>
      btn.addEventListener("click", async () => {
        const orders = getTradeOrdersMigrated();
        const o = orders.find(x => x.id === btn.dataset.id);
        if (o) {
          delete o.fulfilledAt; delete o.fulfilledMode; delete o.fulfilledLate;
          // A reopened order past its due day is immediately overdue again; keep
          // overdueNotified so it doesn't re-announce (editing the due day re-arms it).
          await saveTradeOrders(orders);
        }
        this.render();
      })
    );

    // ── Deadline: due day / late mode / penalty percent ───────────────────────
    el.querySelectorAll(".kctg-to-due-day").forEach(inp =>
      inp.addEventListener("change", async e => {
        const orders = getTradeOrdersMigrated(), o = orders.find(x => x.id === inp.dataset.id);
        if (!o) return;
        const v = parseInt(e.target.value);
        if (v > 0) o.dueDay = v; else delete o.dueDay;
        delete o.overdueNotified; // re-arm the one-shot announcement for the new deadline
        await saveTradeOrders(orders); this.render();
      })
    );
    el.querySelectorAll(".kctg-to-late-mode").forEach(sel =>
      sel.addEventListener("change", async e => {
        const orders = getTradeOrdersMigrated(), o = orders.find(x => x.id === sel.dataset.id);
        if (!o) return;
        o.lateMode = e.target.value === "penalty" ? "penalty" : "expire";
        delete o.overdueNotified;
        await saveTradeOrders(orders); this.render();
      })
    );
    el.querySelectorAll(".kctg-to-late-pct").forEach(inp =>
      inp.addEventListener("change", async e => {
        const orders = getTradeOrdersMigrated(), o = orders.find(x => x.id === inp.dataset.id);
        if (!o) return;
        o.latePenaltyPct = Math.min(100, Math.max(0, parseInt(e.target.value) || 0));
        await saveTradeOrders(orders); this.render();
      })
    );

    // ── Quest link: the order stays locked until the dropped quest completes ──
    el.querySelectorAll(".kctg-to-quest-slot").forEach(slot => {
      slot.addEventListener("dragover",  e => { e.preventDefault(); slot.classList.add("kctg-drag-over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("kctg-drag-over"));
      slot.addEventListener("drop", async e => {
        e.preventDefault(); slot.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (!["JournalEntryPage", "JournalEntry"].includes(data.type)) return ui.notifications.warn("Drop a Quest journal page here.");
        const doc = await safeFromUuid(data.uuid); if (!doc) return;
        const orders = getTradeOrdersMigrated(), o = orders.find(x => x.id === slot.dataset.id);
        if (!o) return;
        o.linkedQuestId = doc.uuid;
        await saveTradeOrders(orders); this.render();
      });
    });
    el.querySelectorAll(".kctg-to-quest-clear").forEach(btn =>
      btn.addEventListener("click", async () => {
        const orders = getTradeOrdersMigrated(), o = orders.find(x => x.id === btn.dataset.id);
        if (!o) return;
        delete o.linkedQuestId;
        await saveTradeOrders(orders); this.render();
      })
    );

    // ── Order card collapse toggle ────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-order-collapse").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (this._collapsedOrders.has(id)) this._collapsedOrders.delete(id);
        else this._collapsedOrders.add(id);
        this.render();
      })
    );

    // ── Settings: toggles an inline strip below the panel header (Workers style) ─
    el.querySelector(".kctg-to-settings-toggle")?.addEventListener("click", () => {
      this._toSettingsOpen = !this._toSettingsOpen; this.render();
    });
    el.querySelectorAll(".kctg-to-settings-inline-row .kctg-setting-input").forEach(inp =>
      inp.addEventListener("change", async () => {
        const key = inp.dataset.setting; if (!key) return;
        const val = Number(inp.value); if (isNaN(val)) return;
        await game.settings.set(MODULE_ID, key, val); this.render();
      })
    );
    el.querySelector(".kctg-to-toggle-pedit")?.addEventListener("click", async () => {
      await game.settings.set(MODULE_ID, "tradeOrdersPlayerEdit", !game.settings.get(MODULE_ID, "tradeOrdersPlayerEdit"));
      this.render();
    });
    el.querySelector(".kctg-to-toggle-force")?.addEventListener("click", async () => {
      await game.settings.set(MODULE_ID, "tradeOrdersAllowForce", !game.settings.get(MODULE_ID, "tradeOrdersAllowForce"));
      this.render();
    });

    // ── Per-city roll table drop ──────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-city-table-slot").forEach(slot => {
      slot.addEventListener("dragover",  e => e.preventDefault());
      slot.addEventListener("dragenter", e => { e.preventDefault(); slot.classList.add("kctg-drag-over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("kctg-drag-over"));
      slot.addEventListener("drop", async e => {
        e.preventDefault(); slot.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "RollTable") return ui.notifications.warn("Drop a RollTable here.");
        const uuid = data.uuid ?? `RollTable.${data.id}`;
        const m = getCityTableUuids(); m[slot.dataset.locId] = uuid;
        await saveCityTableUuids(m); this.render();
      });
    });
    el.querySelectorAll(".kctg-to-clear-city-table").forEach(btn =>
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const m = getCityTableUuids(); delete m[btn.dataset.locId];
        await saveCityTableUuids(m); this.render();
      })
    );

    // ── Add blank order ───────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-add-order").forEach(btn =>
      btn.addEventListener("click", async () => {
        const locId = btn.dataset.locId;
        const orders = getTradeOrders();
        orders.push({ id: newId(), locationId: locId, name: "New Order", description: "", needs: [], pays: [] });
        await saveTradeOrders(orders); this.render();
      })
    );

    // ── Random order generation ───────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-random-order").forEach(btn =>
      btn.addEventListener("click", async () => {
        const locId   = btn.dataset.locId;
        const locName = btn.dataset.locName;
        const qtyMin   = Math.max(1, game.settings.get(MODULE_ID, "tradeOrderQtyMin") ?? 1);
        const qtyMax   = Math.max(qtyMin, game.settings.get(MODULE_ID, "tradeOrderQtyMax") ?? 10);
        const variance = (game.settings.get(MODULE_ID, "tradeOrderPriceVariance") ?? 20) / 100;
        const tableUuid = getCityTableUuids()[locId] ?? "";
        let itemName = "", itemImg = "icons/svg/item-bag.svg", itemBasePrice = null;
        if (tableUuid) {
          const table = await safeFromUuid(tableUuid);
          if (table) {
            const draw = await table.draw({ displayChat: false });
            const r = draw.results?.[0];
            if (r) {
              const parsed = await _parseTableResult(r);
              itemName = parsed.text;
              if (parsed.item?.img) itemImg = parsed.item.img;
              const priceVal = parsed.item?.system?.price?.value;
              if (priceVal && typeof priceVal === "object") itemBasePrice = priceVal;
            }
          } else {
            ui.notifications.warn(`No table set for ${locName} — drop a RollTable on the city header.`);
          }
        }
        if (!itemName) {
          const pool = ["Grain","Leather","Spices","Timber","Iron Ore","Cloth","Salt","Wine","Tools","Medicine"];
          itemName = pool[Math.floor(Math.random() * pool.length)];
        }
        const qty  = Math.floor(qtyMin + Math.random() * (qtyMax - qtyMin + 1));
        const pays = [];
        if (itemBasePrice) {
          const factor = 1 + (Math.random() * 2 - 1) * variance;
          for (const [coin, base] of Object.entries(itemBasePrice)) {
            const val = Math.max(1, Math.round((Number(base) || 0) * factor));
            if (val > 0) pays.push({ id: newId(), type: coin, value: val });
          }
        }
        const orders = getTradeOrders();
        orders.push({ id: newId(), locationId: locId, name: itemName, description: "", needs: [{ id: newId(), itemName, itemImg, qty }], pays });
        await saveTradeOrders(orders);
        ui.notifications.info(`Generated order for ${locName}: ${qty}× ${itemName}`);
        this.render();
      })
    );

    // ── Delete order ──────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-delete-order").forEach(btn =>
      btn.addEventListener("click", async () => {
        await saveTradeOrders(getTradeOrders().filter(o => o.id !== btn.dataset.id)); this.render();
      })
    );

    // ── Order name / description ──────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-order-name").forEach(inp =>
      inp.addEventListener("change", async e => {
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === e.target.dataset.id);
        if (o) { o.name = e.target.value; await saveTradeOrders(orders); }
      })
    );
    el.querySelectorAll(".kctg-to-order-desc").forEach(inp =>
      inp.addEventListener("change", async e => {
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === e.target.dataset.id);
        if (o) { o.description = e.target.value; await saveTradeOrders(orders); }
      })
    );

    // ── Needs: add item via drop ──────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-needs-drop").forEach(zone => {
      zone.addEventListener("dragover",  e => e.preventDefault());
      zone.addEventListener("dragenter", e => { e.preventDefault(); zone.classList.add("kctg-drag-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("kctg-drag-over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault(); zone.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item") return ui.notifications.warn("Drop an Item here.");
        const item = await safeFromUuid(data.uuid ?? `Item.${data.id}`); if (!item) return;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === zone.dataset.orderId);
        if (!o) return;
        o.needs.push({ id: newId(), itemName: item.name, itemImg: item.img ?? "icons/svg/item-bag.svg", qty: 1 });
        await saveTradeOrders(orders); this.render();
      });
    });

    // ── Needs: quantity change ────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-need-qty").forEach(inp =>
      inp.addEventListener("change", async e => {
        const { orderId, needId } = inp.dataset;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === orderId);
        if (!o) return;
        const n = o.needs.find(x => x.id === needId);
        if (n) { n.qty = Math.max(1, parseInt(e.target.value) || 1); await saveTradeOrders(orders); }
      })
    );

    // ── Needs: remove item ────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-del-need").forEach(btn =>
      btn.addEventListener("click", async () => {
        const { orderId, needId } = btn.dataset;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === orderId);
        if (!o) return;
        o.needs = o.needs.filter(n => n.id !== needId);
        await saveTradeOrders(orders); this.render();
      })
    );

    // ── Pays: add currency ────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-add-pay").forEach(btn =>
      btn.addEventListener("click", async () => {
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === btn.dataset.id);
        if (!o) return;
        o.pays.push({ id: newId(), type: "gp", value: 1 });
        await saveTradeOrders(orders); this.render();
      })
    );

    // ── Pays: add item via drop ───────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-pays-drop").forEach(zone => {
      zone.addEventListener("dragover",  e => e.preventDefault());
      zone.addEventListener("dragenter", e => { e.preventDefault(); zone.classList.add("kctg-drag-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("kctg-drag-over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault(); zone.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item") return;
        const item = await safeFromUuid(data.uuid ?? `Item.${data.id}`); if (!item) return;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === zone.dataset.orderId);
        if (!o) return;
        const coinNames = { "Gold Pieces":"gp","Silver Pieces":"sp","Copper Pieces":"cp","Platinum Pieces":"pp","Gold":"gp","Silver":"sp","Copper":"cp","Platinum":"pp" };
        const coinType = coinNames[item.name] ?? null;
        if (coinType) o.pays.push({ id: newId(), type: coinType, value: 1 });
        else o.pays.push({ id: newId(), type: "item", value: 1, itemName: item.name, itemImg: item.img ?? "icons/svg/item-bag.svg" });
        await saveTradeOrders(orders); this.render();
      });
    });

    // ── Pays: value / type / item name changes ────────────────────────────────
    el.querySelectorAll(".kctg-to-pay-value").forEach(inp =>
      inp.addEventListener("change", async e => {
        const { orderId, payId } = inp.dataset;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === orderId);
        const p = o?.pays.find(x => x.id === payId);
        if (p) { p.value = Math.max(1, parseInt(e.target.value) || 1); await saveTradeOrders(orders); }
      })
    );
    el.querySelectorAll(".kctg-to-pay-type").forEach(sel =>
      sel.addEventListener("change", async e => {
        const { orderId, payId } = sel.dataset;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === orderId);
        const p = o?.pays.find(x => x.id === payId);
        if (p) { p.type = e.target.value; await saveTradeOrders(orders); this.render(); }
      })
    );
    el.querySelectorAll(".kctg-to-pay-item-name").forEach(inp =>
      inp.addEventListener("change", async e => {
        const { orderId, payId } = inp.dataset;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === orderId);
        const p = o?.pays.find(x => x.id === payId);
        if (p) { p.itemName = e.target.value; await saveTradeOrders(orders); }
      })
    );

    // ── Pays: drop item to replace ────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-pay-item-drop").forEach(slot => {
      slot.addEventListener("dragover",  e => e.preventDefault());
      slot.addEventListener("dragenter", e => { e.preventDefault(); slot.classList.add("kctg-drag-over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("kctg-drag-over"));
      slot.addEventListener("drop", async e => {
        e.preventDefault(); slot.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item") return;
        const item = await safeFromUuid(data.uuid ?? `Item.${data.id}`); if (!item) return;
        const { orderId, payId } = slot.dataset;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === orderId);
        const p = o?.pays.find(x => x.id === payId);
        if (p) { p.type = "item"; p.itemName = item.name; p.itemImg = item.img ?? "icons/svg/item-bag.svg"; await saveTradeOrders(orders); this.render(); }
      });
    });

    // ── Pays: delete ──────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-to-del-payment").forEach(btn =>
      btn.addEventListener("click", async () => {
        const { orderId, payId } = btn.dataset;
        const orders = getTradeOrders().map(_migrateTradeOrder), o = orders.find(x => x.id === orderId);
        if (!o) return;
        o.pays = o.pays.filter(p => p.id !== payId);
        await saveTradeOrders(orders); this.render();
      })
    );
  }

  _wireInventory(el) {
    el.querySelectorAll(".kctg-inv-remove").forEach(btn =>
      btn.addEventListener("click", async () => { await removeInventoryEntry(btn.dataset.id); this.render(); })
    );
    // Show description — toggles an inline, enriched panel under the row
    el.querySelectorAll(".kctg-inventory-tab .kctg-item-info").forEach(btn =>
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        await _toggleInvItemDesc(btn.closest(".kctg-inv-card"));
      })
    );
    // Inventory folder management writes the GM-only invFolders/invItemFolders settings,
    // so only wire it for the GM. Players get the create/delete buttons hidden by the
    // template; gating the rename/collapse/drag handlers here too avoids dead controls
    // that would only ever trigger the "GM only" warning.
    if (game.user?.isGM) {
      el.querySelector(".kctg-inv-add-folder")?.addEventListener("click", async () => {
        const fs = getInvFolders(); fs.push({ id: newId(), name: "New Folder", collapsed: false });
        await saveInvFolders(fs); this.render();
      });
      el.querySelectorAll(".kctg-inv-folder-name").forEach(inp =>
        inp.addEventListener("change", async e => {
          const fs = getInvFolders(), f = fs.find(x => x.id === e.target.dataset.id);
          if (f) { f.name = e.target.value; await saveInvFolders(fs); }
        })
      );
      el.querySelectorAll(".kctg-inv-folder-delete").forEach(btn =>
        btn.addEventListener("click", async () => {
          const fid = btn.dataset.id;
          const m = getInvItemFolders();
          for (const k of Object.keys(m)) { if (m[k] === fid) delete m[k]; }
          await saveInvItemFolders(m);
          await saveInvFolders(getInvFolders().filter(f => f.id !== fid));
          this.render();
        })
      );
      el.querySelectorAll(".kctg-inv-folder-toggle").forEach(btn =>
        btn.addEventListener("click", async () => {
          const fs = getInvFolders(), f = fs.find(x => x.id === btn.dataset.id);
          if (f) { f.collapsed = !f.collapsed; await saveInvFolders(fs); this.render(); }
        })
      );
      let draggedInvId = null;
      el.querySelectorAll(".kctg-inv-card[data-inv-id]").forEach(card => {
        card.addEventListener("dragstart", e => { draggedInvId = card.dataset.invId; e.dataTransfer.effectAllowed = "move"; card.classList.add("kctg-dragging"); });
        card.addEventListener("dragend", () => { draggedInvId = null; card.classList.remove("kctg-dragging"); });
      });
      el.querySelectorAll(".kctg-inv-drop-zone").forEach(zone => {
        zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("kctg-drag-over"); });
        zone.addEventListener("dragleave", () => zone.classList.remove("kctg-drag-over"));
        zone.addEventListener("drop", async e => {
          e.preventDefault(); zone.classList.remove("kctg-drag-over");
          if (!draggedInvId) return;
          const fid = zone.dataset.folderId ?? null;
          const m = getInvItemFolders();
          if (fid) m[draggedInvId] = fid; else delete m[draggedInvId];
          await saveInvItemFolders(m); this.render();
        });
      });
    }
  }

  _wireTracker(el) {
    if (!el.querySelector(".kctg-tracker-list")) return;
    const isGM = game.user?.isGM ?? false;

    // Add entry (one button — numeric or item-based depending on what is dropped)
    el.querySelector(".kctg-tracker-add-entry")?.addEventListener("click", async () => {
      if (!isGM) return;
      const entries = getTrackerEntries();
      entries.push({ id: newId(), actorUuid: "", actorName: "", actorImg: "", label: "Working towards...", current: 0, total: 10, trackedItems: [] });
      await saveTrackerEntries(entries); this.render();
    });

    // Remove entry
    el.querySelectorAll(".kctg-tracker-remove-btn").forEach(btn =>
      btn.addEventListener("click", async () => {
        if (!isGM) return;
        await saveTrackerEntries(getTrackerEntries().filter(e => e.id !== btn.dataset.id));
        this.render();
      })
    );

    // Label change
    el.querySelectorAll(".kctg-tracker-label-input").forEach(input =>
      input.addEventListener("change", async e => {
        if (!isGM) return;
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === e.target.dataset.id);
        if (entry) { entry.label = e.target.value; await saveTrackerEntries(entries); }
      })
    );

    // Progress current/total
    el.querySelectorAll(".kctg-tracker-current").forEach(input =>
      input.addEventListener("change", async e => {
        if (!isGM) return;
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === e.target.dataset.id);
        if (entry) { entry.current = Math.max(0, parseInt(e.target.value) || 0); await saveTrackerEntries(entries); this.render(); }
      })
    );
    el.querySelectorAll(".kctg-tracker-total").forEach(input =>
      input.addEventListener("change", async e => {
        if (!isGM) return;
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === e.target.dataset.id);
        if (entry) { entry.total = Math.max(1, parseInt(e.target.value) || 1); await saveTrackerEntries(entries); this.render(); }
      })
    );

    // Item tracking: manual current qty
    el.querySelectorAll(".kctg-titem-current").forEach(input =>
      input.addEventListener("change", async e => {
        if (!isGM) return;
        const { entryId, itemId } = input.dataset;
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === entryId);
        if (!entry) return;
        const ti = (entry.trackedItems ?? []).find(i => i.id === itemId);
        if (ti) { ti.currentQty = Math.max(0, parseInt(e.target.value) || 0); await saveTrackerEntries(entries); this.render(); }
      })
    );

    // Item tracking: target qty
    el.querySelectorAll(".kctg-titem-target").forEach(input =>
      input.addEventListener("change", async e => {
        if (!isGM) return;
        const { entryId, itemId } = input.dataset;
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === entryId);
        if (!entry) return;
        const ti = (entry.trackedItems ?? []).find(i => i.id === itemId);
        if (ti) { ti.targetQty = Math.max(1, parseInt(e.target.value) || 1); await saveTrackerEntries(entries); this.render(); }
      })
    );

    // Remove a tracked item from an entry
    el.querySelectorAll(".kctg-titem-remove").forEach(btn =>
      btn.addEventListener("click", async () => {
        if (!isGM) return;
        const { entryId, itemId } = btn.dataset;
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === entryId);
        if (!entry) return;
        entry.trackedItems = (entry.trackedItems ?? []).filter(i => i.id !== itemId);
        await saveTrackerEntries(entries); this.render();
      })
    );

    // Drop item onto tracked-items drop zone
    el.querySelectorAll(".kctg-titem-drop-zone").forEach(zone => {
      zone.addEventListener("dragover",  e => e.preventDefault());
      zone.addEventListener("dragenter", e => { e.preventDefault(); zone.classList.add("kctg-drag-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("kctg-drag-over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault(); zone.classList.remove("kctg-drag-over");
        if (!isGM) return;
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item") return ui.notifications.warn("Drop an Item here.");
        const item = await safeFromUuid(data.uuid); if (!item) return;
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === zone.dataset.entryId);
        if (!entry) return;
        entry.trackedItems = entry.trackedItems ?? [];
        if (entry.trackedItems.some(i => i.itemUuid === data.uuid)) return ui.notifications.info("Already tracking that item.");
        entry.trackedItems.push({ id: newId(), itemUuid: data.uuid, itemName: item.name, itemImg: item.img ?? "icons/svg/item-bag.svg", currentQty: 0, targetQty: 1 });
        await saveTrackerEntries(entries); this.render();
      });
    });

    // Drop actor onto tracker entry
    el.querySelectorAll(".kctg-tracker-actor-drop").forEach(zone => {
      zone.addEventListener("dragover",  e => e.preventDefault());
      zone.addEventListener("dragenter", e => { e.preventDefault(); zone.classList.add("kctg-drag-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("kctg-drag-over"));
      zone.addEventListener("drop", async e => {
        e.preventDefault(); zone.classList.remove("kctg-drag-over");
        if (!isGM) return;
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        const actor = await safeFromUuid(data.uuid);
        if (!actor || actor.documentName !== "Actor") return ui.notifications.warn("Drop an Actor here.");
        const entries = getTrackerEntries(), entry = entries.find(en => en.id === zone.dataset.id);
        if (entry) { entry.actorUuid = data.uuid; entry.actorName = actor.name; entry.actorImg = actor.img; await saveTrackerEntries(entries); this.render(); }
      });
    });

    // Drag-to-reorder
    (() => {
      const list = el.querySelector(".kctg-tracker-list");
      if (!list || !isGM) return;
      let dragSrc = null;
      list.querySelectorAll(".kctg-tracker-entry[draggable]").forEach(entry => {
        entry.addEventListener("dragstart", e => { dragSrc = entry; e.dataTransfer.effectAllowed = "move"; setTimeout(() => entry.classList.add("kctg-tracker-dragging"), 0); });
        entry.addEventListener("dragend", () => { entry.classList.remove("kctg-tracker-dragging"); list.querySelectorAll(".kctg-tracker-drop-target").forEach(x => x.classList.remove("kctg-tracker-drop-target")); dragSrc = null; });
        entry.addEventListener("dragover", e => { if (!dragSrc || dragSrc === entry) return; e.preventDefault(); list.querySelectorAll(".kctg-tracker-drop-target").forEach(x => x.classList.remove("kctg-tracker-drop-target")); entry.classList.add("kctg-tracker-drop-target"); });
        entry.addEventListener("dragleave", () => entry.classList.remove("kctg-tracker-drop-target"));
        entry.addEventListener("drop", async e => {
          e.preventDefault(); entry.classList.remove("kctg-tracker-drop-target");
          if (!dragSrc || dragSrc === entry) return;
          const entries = getTrackerEntries();
          const fi = entries.findIndex(en => en.id === dragSrc.dataset.id);
          const ti = entries.findIndex(en => en.id === entry.dataset.id);
          if (fi === -1 || ti === -1) return;
          const [moved] = entries.splice(fi, 1); entries.splice(ti, 0, moved);
          await saveTrackerEntries(entries); this.render();
        });
      });
    })();
  }

  _bindTextField(el, sel, getter, saver, field) {
    el.querySelectorAll(sel).forEach(input =>
      input.addEventListener("change", async e => {
        const arr = getter(), item = arr.find(x => x.id === e.target.dataset.id);
        if (item) { item[field] = e.target.value; await saver(arr); }
      })
    );
  }
  _bindNumField(el, sel, getter, saver, field, min = 0, max = 9999) {
    el.querySelectorAll(sel).forEach(input =>
      input.addEventListener("change", async e => {
        const arr = getter(), item = arr.find(x => x.id === e.target.dataset.id);
        if (item) { item[field] = Math.max(min, Math.min(max, parseInt(e.target.value) || min)); await saver(arr); this.render(); }
      })
    );
  }

  // ── Map tab methods (same logic as TradeMapApp, scoped to WorkshopApp instance) ──

  _applyTransform(c) {
    c.style.transformOrigin = "0 0";
    c.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
  }

  _doZoom(el, canvas, delta) {
    const mapArea = el?.querySelector(".kctg-map-area");
    const newZ = Math.max(0.1, Math.min(4, this._zoom + delta));
    if (mapArea) { const cx = mapArea.clientWidth / 2, cy = mapArea.clientHeight / 2; this._panX = cx - (cx - this._panX) * (newZ / this._zoom); this._panY = cy - (cy - this._panY) * (newZ / this._zoom); }
    this._zoom = newZ;
    if (canvas && mapArea) this._clampPan(canvas, mapArea);
    if (canvas) this._applyTransform(canvas);
    const lbl = el?.querySelector(".kctg-zoom-label"); if (lbl) lbl.textContent = Math.round(newZ * 100) + "%";
  }

  _startTravelerAnimations(el) {
    if (this._animRAF) { cancelAnimationFrame(this._animRAF); this._animRAF = null; }
    const travelers = [...el.querySelectorAll(".kctg-traveler[data-phase]")].filter(t => t.dataset.phase !== "atDestination");
    if (!travelers.length) return;
    const PERIOD = 4000, AMP = 0.02, startTime = performance.now();
    const tick = (now) => {
      const elapsed = now - startTime;
      travelers.forEach(t => {
        const sp  = parseFloat(t.dataset.startProgress) || 0;
        const osc = Math.sin((elapsed / PERIOD) * Math.PI * 2) * AMP;
        const p   = Math.max(0, Math.min(1, sp + osc));
        const ptsData = (t.dataset.pts ?? "").split(" ").map(s => { const [x, y] = s.split(",").map(Number); return { x, y }; }).filter(pt => !isNaN(pt.x));
        const pos = ptsData.length >= 2 ? _posAlongPts(ptsData, p) : { x: parseFloat(t.dataset.fromX) + (parseFloat(t.dataset.toX) - parseFloat(t.dataset.fromX)) * p, y: parseFloat(t.dataset.fromY) + (parseFloat(t.dataset.toY) - parseFloat(t.dataset.fromY)) * p };
        t.style.left = pos.x + "%";
        t.style.top  = pos.y + "%";
      });
      this._animRAF = requestAnimationFrame(tick);
    };
    this._animRAF = requestAnimationFrame(tick);
  }

  async _placeLocation(x, y) {
    const m = getMapCfg(); m.locations = m.locations ?? [];
    m.locations.push({ id: newId(), name: "New Location", icon: "icons/svg/village.svg", x, y });
    await saveMapCfg(m); this._placeMode = false; this.render();
  }

  /** Clamp pan so the map never scrolls fully out of the viewport.
   *  At least `minVis` pixels of the canvas must remain visible on each axis. */
  _clampPan(canvas, mapArea) {
    const cw      = parseFloat(canvas.style.width)  || this._naturalW;
    const ch      = parseFloat(canvas.style.height) || this._naturalH;
    const vw      = mapArea.clientWidth;
    const vh      = mapArea.clientHeight;
    const minVis  = 80;
    this._panX = Math.max(minVis - cw * this._zoom, Math.min(vw - minVis, this._panX));
    this._panY = Math.max(minVis - ch * this._zoom, Math.min(vh - minVis, this._panY));
  }

  _setupMapTab(el) {
    if (this._panCleanup) { this._panCleanup(); this._panCleanup = null; }
    const map = getMapCfg();
    const mapArea = el.querySelector(".kctg-map-area"), canvas = el.querySelector(".kctg-map-canvas");
    if (!mapArea || !canvas) return;

    if (map.backgroundImage) {
      canvas.classList.add("kctg-map-loading");  // hide until zoom is correct
      const img = new Image();
      img.onload = () => {
        this._naturalW = img.naturalWidth || 800; this._naturalH = img.naturalHeight || 600;
        canvas.style.width  = this._naturalW + "px"; canvas.style.height = this._naturalH + "px";
        canvas.style.backgroundImage = `url('${map.backgroundImage}')`; canvas.style.backgroundSize = "100% 100%";
        const sw = Math.max(0.03, 150 / this._naturalW).toFixed(4);
        canvas.querySelectorAll(".kctg-map-svg .kctg-route-line").forEach(l => l.setAttribute("stroke-width", sw));
        if (this._zoom === 1) { const vw = mapArea.clientWidth || 680, vh = mapArea.clientHeight || 450; if (this._naturalW > vw || this._naturalH > vh) { this._zoom = Math.max(0.1, Math.min(vw / this._naturalW, vh / this._naturalH) * 0.95); const lbl = el.querySelector(".kctg-zoom-label"); if (lbl) lbl.textContent = Math.round(this._zoom * 100) + "%"; } }
        this._applyTransform(canvas);
        canvas.classList.remove("kctg-map-loading");  // fade in after zoom applied
      };
      img.src = map.backgroundImage;
    } else this._applyTransform(canvas);

    let dragging = false, startX = 0, startY = 0, p0x = 0, p0y = 0, moved = false;
    const onDown  = e => { if (e.button !== 0 || e.target.closest(".kctg-map-pin")) return; dragging = true; moved = false; startX = e.clientX; startY = e.clientY; p0x = this._panX; p0y = this._panY; mapArea.style.cursor = "grabbing"; e.preventDefault(); };
    const onMove  = e => { if (!dragging) return; const dx = e.clientX - startX, dy = e.clientY - startY; if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true; this._panX = p0x + dx; this._panY = p0y + dy; this._clampPan(canvas, mapArea); this._applyTransform(canvas); };
    const onUp    = e => { if (!dragging) return; dragging = false; mapArea.style.cursor = this._placeMode ? "crosshair" : "grab"; if (this._placeMode && !moved && game.user?.isGM) { const rect = mapArea.getBoundingClientRect(), cw = parseFloat(canvas.style.width) || 600, ch = parseFloat(canvas.style.height) || 400; const x = (e.clientX - rect.left - this._panX) / (cw * this._zoom), y = (e.clientY - rect.top - this._panY) / (ch * this._zoom); if (x >= 0 && x <= 1 && y >= 0 && y <= 1) this._placeLocation(x, y); } };
    const onWheel = e => { e.preventDefault(); const delta = e.deltaY > 0 ? -0.1 : 0.1, newZ = Math.max(0.25, Math.min(4, this._zoom + delta)), rect = mapArea.getBoundingClientRect(); this._panX = (e.clientX - rect.left) - ((e.clientX - rect.left) - this._panX) * (newZ / this._zoom); this._panY = (e.clientY - rect.top)  - ((e.clientY - rect.top)  - this._panY) * (newZ / this._zoom); this._zoom = newZ; this._clampPan(canvas, mapArea); this._applyTransform(canvas); const lbl = el.querySelector(".kctg-zoom-label"); if (lbl) lbl.textContent = Math.round(newZ * 100) + "%"; };
    mapArea.addEventListener("mousedown", onDown); document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp); mapArea.addEventListener("wheel", onWheel, { passive: false });
    mapArea.style.cursor = this._placeMode ? "crosshair" : "grab";
    this._panCleanup = () => { mapArea.removeEventListener("mousedown", onDown); document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); mapArea.removeEventListener("wheel", onWheel); };

    this._startTravelerAnimations(el);
    if (!game.user?.isGM) return;

    el.querySelector(".kctg-map-set-bg")?.addEventListener("click", () => openIconPicker(map.backgroundImage || "scenes/", async path => { const m = getMapCfg(); m.backgroundImage = path; await saveMapCfg(m); this.render(); }));
    el.querySelector(".kctg-map-clear-bg")?.addEventListener("click", async () => { const m = getMapCfg(); m.backgroundImage = ""; await saveMapCfg(m); this.render(); });
    el.querySelector(".kctg-map-set-view")?.addEventListener("click", () => {
      this._savedView = { panX: this._panX, panY: this._panY, zoom: this._zoom };
      ui.notifications.info("Map view saved. Reset will return here.");
      this.render();
    });
    el.querySelector(".kctg-map-reset-pan")?.addEventListener("click", () => {
      if (this._savedView) { this._panX = this._savedView.panX; this._panY = this._savedView.panY; this._zoom = this._savedView.zoom; }
      else { this._panX = 0; this._panY = 0; this._zoom = 1; }
      this._applyTransform(canvas); const lbl = el.querySelector(".kctg-zoom-label"); if (lbl) lbl.textContent = Math.round(this._zoom * 100) + "%";
    });
    el.querySelector(".kctg-zoom-in")?.addEventListener("click",  () => this._doZoom(el, canvas,  0.2));
    el.querySelector(".kctg-zoom-out")?.addEventListener("click", () => this._doZoom(el, canvas, -0.2));
    el.querySelector(".kctg-map-toggle-edit")?.addEventListener("click", () => { this._editMode = !this._editMode; this._placeMode = false; this._waypointMode = false; this._routeMode = false; this._pendingFrom = null; this.render(); });
    el.querySelector(".kctg-map-toggle-place")?.addEventListener("click", () => { this._placeMode = !this._placeMode; mapArea.style.cursor = this._placeMode ? "crosshair" : "grab"; this.render(); });
    el.querySelector(".kctg-map-toggle-wp")?.addEventListener("click", () => { this._waypointMode = !this._waypointMode; if (mapArea) mapArea.classList.toggle("kctg-wp-mode", this._waypointMode); this.render(); });
    el.querySelector(".kctg-map-toggle-route")?.addEventListener("click", () => { this._routeMode = !this._routeMode; if (!this._routeMode) { this._pendingFrom = null; } this.render(); });
    if (this._waypointMode && mapArea) mapArea.classList.add("kctg-wp-mode");

    if (this._editMode) {
      // ── Pin drag-to-reposition ──
      el.querySelectorAll(".kctg-map-pin").forEach(pin => {
        pin.style.cursor = "move";
        pin.addEventListener("mousedown", e => {
          if (e.button !== 0) return; e.stopPropagation();
          const id = pin.dataset.id; let dd = false; const sx = e.clientX, sy = e.clientY;
          const mm = ev => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!dd && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dd = true;
            if (!dd) return;
            const rect = canvas.getBoundingClientRect(), cw = parseFloat(canvas.style.width) || 800, ch = parseFloat(canvas.style.height) || 600;
            pin.style.left = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / (cw * this._zoom)) * 100)) + "%";
            pin.style.top  = Math.max(0, Math.min(100, ((ev.clientY - rect.top)  / (ch * this._zoom)) * 100)) + "%";
          };
          // Suppress settings-hook re-render; update SVG paths in-place instead
          const mu = async ev => {
            document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu);
            if (!dd) return;
            const rect = canvas.getBoundingClientRect(), cw = parseFloat(canvas.style.width) || 800, ch = parseFloat(canvas.style.height) || 600;
            const m = getMapCfg(), loc = (m.locations ?? []).find(l => l.id === id);
            if (loc) {
              loc.x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / (cw * this._zoom)));
              loc.y = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / (ch * this._zoom)));
              _suppressNextMapRender();
              await saveMapCfg(m);
              _updateRouteSVG(canvas);
            }
          };
          document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
        });
        // Double-click opens the edit dialog
        pin.addEventListener("dblclick", e => {
          e.stopPropagation();
          const existing = foundry.applications.instances?.get(`kctg-location-edit--${pin.dataset.id}`);
          if (existing?.rendered) { existing.bringToFront(); return; }
          new LocationEditApp(pin.dataset.id).render(true);
        });
      });

      // ── Route-drawing — only when routeMode is active ──
      el.querySelectorAll(".kctg-map-pin").forEach(pin => pin.addEventListener("click", async e => {
        if (!this._editMode || !this._routeMode) return; e.stopPropagation();
        const id = pin.dataset.id;
        if (!this._pendingFrom) {
          this._pendingFrom = id;
          el.querySelectorAll(".kctg-map-pin").forEach(p => p.classList.toggle("kctg-pin-pending", p.dataset.id === id));
        } else if (this._pendingFrom === id) {
          this._pendingFrom = null;
          el.querySelectorAll(".kctg-map-pin").forEach(p => p.classList.remove("kctg-pin-pending"));
        } else {
          const m = getMapCfg(), from = (m.locations ?? []).find(l => l.id === this._pendingFrom), to = (m.locations ?? []).find(l => l.id === id);
          m.routes = m.routes ?? [];
          const duplicate = m.routes.find(r => (r.fromId === this._pendingFrom && r.toId === id) || (r.fromId === id && r.toId === this._pendingFrom));
          if (!duplicate) m.routes.push({ id: newId(), name: `${from?.name ?? "A"} ↔ ${to?.name ?? "B"}`, fromId: this._pendingFrom, toId: id, travelDays: 1 });
          else ui.notifications.warn("A route between these locations already exists.");
          this._pendingFrom = null;
          await saveMapCfg(m); this.render();
        }
      }));

      // ── Waypoint handles: drag to move, right-click to remove ──
      el.querySelectorAll(".kctg-wp-handle").forEach(handle => {
        handle.addEventListener("mousedown", e => {
          if (e.button !== 0) return; e.stopPropagation();
          const routeId = handle.dataset.routeId, wpIdx = parseInt(handle.dataset.wpIdx);
          let dd = false;
          const onMove = ev => {
            dd = true;
            const rect = canvas.getBoundingClientRect(), cw = parseFloat(canvas.style.width) || 800, ch = parseFloat(canvas.style.height) || 600;
            handle.style.left = Math.max(0, Math.min(100, (ev.clientX - rect.left) / (cw * this._zoom) * 100)).toFixed(3) + "%";
            handle.style.top  = Math.max(0, Math.min(100, (ev.clientY - rect.top)  / (ch * this._zoom) * 100)).toFixed(3) + "%";
            _updateRouteSVG(canvas);
          };
          const onUp = async ev => {
            document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
            if (!dd) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            const y = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / rect.height));
            const m = getMapCfg(), r = (m.routes ?? []).find(x2 => x2.id === routeId);
            if (r?.waypoints?.[wpIdx] != null) { r.waypoints[wpIdx] = { x, y }; _suppressNextMapRender(); await saveMapCfg(m); _updateRouteSVG(canvas); }
          };
          document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
        });
        handle.addEventListener("contextmenu", async e => {
          e.preventDefault(); e.stopPropagation();
          const routeId = handle.dataset.routeId, wpIdx = parseInt(handle.dataset.wpIdx);
          const m = getMapCfg(), r = (m.routes ?? []).find(x => x.id === routeId);
          if (r?.waypoints) { r.waypoints.splice(wpIdx, 1); await saveMapCfg(m); this.render(); }
        });
      });

      // ── Route hitzone: click to add a waypoint (only when waypointMode active) ──
      el.querySelectorAll(".kctg-route-hitzone").forEach(hzone => {
        hzone.addEventListener("click", async e => {
          if (!this._waypointMode) return;
          e.stopPropagation();
          const routeId = hzone.dataset.routeId;
          const rect = canvas.getBoundingClientRect();
          const cx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const cy = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
          const m = getMapCfg(), r = (m.routes ?? []).find(x => x.id === routeId);
          if (!r) return;
          r.waypoints = r.waypoints ?? [];
          const pts = _routePoints(r, m.locations ?? []);
          let best = pts.length - 2, bestD = Infinity;
          for (let i = 0; i < pts.length - 1; i++) {
            const d = _distPtSegSq(cx, cy, pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y);
            if (d < bestD) { bestD = d; best = i; }
          }
          r.waypoints.splice(best, 0, { x: cx, y: cy });
          await saveMapCfg(m); this.render();
        });
      });
    }
    el.querySelectorAll(".kctg-route-delete").forEach(btn => btn.addEventListener("click", async () => { const m = getMapCfg(); m.routes = (m.routes ?? []).filter(r => r.id !== btn.dataset.id); await saveMapCfg(m); this.render(); }));
    el.querySelectorAll(".kctg-route-travel-days").forEach(inp => inp.addEventListener("change", async e => { const m = getMapCfg(), r = (m.routes ?? []).find(x => x.id === e.target.dataset.id); if (r) { r.travelDays = Math.max(1, parseInt(e.target.value) || 1); await saveMapCfg(m); } }));
  }

  _onClose(options) {
    if (this._animRAF) { cancelAnimationFrame(this._animRAF); this._animRAF = null; }
    if (this._panCleanup) { this._panCleanup(); this._panCleanup = null; }
  }
}

// ─── TRADE MAP APP ─────────────────────────────────────────────────────────────

class TradeMapApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static open() {
    const existing = foundry.applications.instances?.get("kctg-workshop--trade-map");
    if (existing?.rendered) { existing.bringToFront(); return existing; }
    return new TradeMapApp().render(true);
  }

  constructor(options = {}) {
    super(options);
    this._editMode     = false;
    this._placeMode    = false;
    this._waypointMode = false;
    this._routeMode    = false;
    this._pendingFrom  = null;
    this._panX         = 0;
    this._panY         = 0;
    this._zoom         = 1;
    this._naturalW     = 800;
    this._naturalH     = 600;
    this._panCleanup   = null;
    this._animRAF      = null;
    this._savedView    = null;
  }

  static DEFAULT_OPTIONS = {
    id: "kctg-workshop--trade-map",
    classes: ["kctg-module", "kctg-trade-map-app"],
    window: { title: "Trade Map", resizable: true },
    position: { width: 780, height: 600 }
  };
  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/workshop/trade-map.hbs` }
  };

  async _prepareContext() {
    const map     = getMapCfg();
    const workers = getWorkers();
    const tasks   = getTasks();
    const homeId = map.homeLocationId ?? null;
    const locations = (map.locations ?? []).map(l => {
      let pinStyle = "";
      if (l.rimColor)             pinStyle += `--pin-rim:${l.rimColor};`;
      if (l.bgColor)              pinStyle += `--pin-bg:${l.bgColor};`;
      if (l.glowColor)            pinStyle += `--pin-glow:${l.glowColor};`;
      if (l.scale && l.scale !== 1) pinStyle += `--kctg-pin-scale:${l.scale};`;
      return { ...l, xPct: parseFloat((l.x * 100).toFixed(3)), yPct: parseFloat((l.y * 100).toFixed(3)), pinStyle: pinStyle || null, tintColor: l.tintColor || null };
    });
    const activeTaskRouteIds = new Set(
      tasks.filter(t => t.type === "trade" && t.status === "active" && t.routeId).map(t => t.routeId)
    );
    const routeLines = _buildRouteCurves(locations.map(l => ({ ...l, x: l.xPct / 100, y: l.yPct / 100 })), map.routes ?? [], activeTaskRouteIds);
    const travelingWorkers = [];
    tasks.filter(t => t.type === "trade" && t.status === "active").forEach(task => {
      const route = (map.routes ?? []).find(r => r.id === task.routeId);
      if (!route) { if (task.routeId) _log("Trade task", task.id, "has routeId", task.routeId, "but no matching route in map config"); return; }
      const from = locations.find(l => l.id === route.fromId), to = locations.find(l => l.id === route.toId);
      if (!from || !to) return;
      const elapsed     = getCurrentDay() - (task.startDay ?? getCurrentDay());
      const workerCount = (task.assignedWorkerIds ?? []).length || 1;
      const effTaskDays = workerCount > 1 ? Math.ceil((task.taskDays ?? 1) / workerCount) : (task.taskDays ?? 1);
      const travelDays  = Math.max(1, task.travelDays ?? 1);
      let phase, startProgress;
      if (elapsed <= travelDays) {
        phase = "outbound";      startProgress = Math.min(1, elapsed / travelDays);
      } else if (elapsed <= travelDays + effTaskDays) {
        phase = "atDestination"; startProgress = 1;
      } else {
        phase = "returning";     startProgress = Math.max(0, 1 - (elapsed - travelDays - effTaskDays) / travelDays);
      }
      const rawPts = [{ x: from.xPct, y: from.yPct }, ...(route.waypoints ?? []).map(wp => ({ x: wp.x * 100, y: wp.y * 100 })), { x: to.xPct, y: to.yPct }];
      const animPts = phase === "returning" ? rawPts.slice().reverse() : rawPts;
      const ptsStr = animPts.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
      const startPos = _posAlongPts(animPts, startProgress);
      workers.filter(w => (task.assignedWorkerIds ?? []).includes(w.id)).forEach((w, i) => {
        const xPct = parseFloat((startPos.x + i * 2).toFixed(3));
        const yPct = parseFloat(startPos.y.toFixed(3));
        travelingWorkers.push({ ...w, xPct, yPct, taskName: task.name, phase, startProgress, fromXPct: from.xPct, fromYPct: from.yPct, toXPct: to.xPct, toYPct: to.yPct, ptsStr, taskType: task.type });
      });
    });
    return { map, locations, routes: routeLines, travelingWorkers, isGM: game.user?.isGM ?? false, editMode: this._editMode, placeMode: this._placeMode, waypointMode: this._waypointMode, routeMode: this._routeMode, pendingFrom: this._pendingFrom, hasBackground: !!map.backgroundImage, homeLocationId: homeId, hasSavedView: !!this._savedView };
  }

  _onRender(context, options) {
    const el = this.element;
    _applyTheme(el);
    if (this._panCleanup) { this._panCleanup(); this._panCleanup = null; }
    const mapArea = el.querySelector(".kctg-map-area"), canvas = el.querySelector(".kctg-map-canvas"), map = getMapCfg();
    if (map.backgroundImage && canvas && mapArea) {
      canvas.classList.add("kctg-map-loading");
      const img = new Image();
      img.onload = () => {
        this._naturalW = img.naturalWidth  || 800;
        this._naturalH = img.naturalHeight || 600;
        canvas.style.width  = this._naturalW + "px";
        canvas.style.height = this._naturalH + "px";
        canvas.style.backgroundImage = `url('${map.backgroundImage}')`;
        canvas.style.backgroundSize  = "100% 100%";
        const sw = Math.max(0.03, 150 / this._naturalW).toFixed(4);
        canvas.querySelectorAll(".kctg-map-svg .kctg-route-line").forEach(l => l.setAttribute("stroke-width", sw));
        if (this._zoom === 1) {
          const vw = mapArea.clientWidth || 680, vh = mapArea.clientHeight || 450;
          if (this._naturalW > vw || this._naturalH > vh) {
            this._zoom = Math.max(0.1, Math.min(vw / this._naturalW, vh / this._naturalH) * 0.95);
            const lbl = el.querySelector(".kctg-zoom-label");
            if (lbl) lbl.textContent = Math.round(this._zoom * 100) + "%";
          }
        }
        this._applyTransform(canvas);
        canvas.classList.remove("kctg-map-loading");
      };
      img.src = map.backgroundImage;
    } else if (canvas) this._applyTransform(canvas);

    if (mapArea && canvas) {
      let dragging = false, startX = 0, startY = 0, p0x = 0, p0y = 0, moved = false;
      const onDown = e => {
        if (e.button !== 0 || e.target.closest(".kctg-map-pin")) return;
        dragging = true; moved = false; startX = e.clientX; startY = e.clientY; p0x = this._panX; p0y = this._panY;
        mapArea.style.cursor = "grabbing"; e.preventDefault();
      };
      const onMove = e => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        this._panX = p0x + dx; this._panY = p0y + dy;
        this._clampPan(canvas, mapArea); this._applyTransform(canvas);
      };
      const onUp = e => {
        if (!dragging) return; dragging = false;
        mapArea.style.cursor = this._placeMode ? "crosshair" : "grab";
        if (this._placeMode && !moved && game.user?.isGM) {
          const rect = mapArea.getBoundingClientRect();
          const cw = parseFloat(canvas.style.width) || 600, ch = parseFloat(canvas.style.height) || 400;
          const x = (e.clientX - rect.left - this._panX) / (cw * this._zoom);
          const y = (e.clientY - rect.top  - this._panY) / (ch * this._zoom);
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) this._placeLocation(x, y);
        }
      };
      const onWheel = e => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newZ  = Math.max(0.25, Math.min(4, this._zoom + delta));
        const rect  = mapArea.getBoundingClientRect();
        const mx    = e.clientX - rect.left, my = e.clientY - rect.top;
        this._panX  = mx - (mx - this._panX) * (newZ / this._zoom);
        this._panY  = my - (my - this._panY) * (newZ / this._zoom);
        this._zoom  = newZ;
        this._clampPan(canvas, mapArea); this._applyTransform(canvas);
        const lbl = el.querySelector(".kctg-zoom-label");
        if (lbl) lbl.textContent = Math.round(newZ * 100) + "%";
      };
      mapArea.addEventListener("mousedown", onDown);
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
      mapArea.addEventListener("wheel", onWheel, { passive: false });
      mapArea.style.cursor = this._placeMode ? "crosshair" : "grab";
      this._panCleanup = () => {
        mapArea.removeEventListener("mousedown", onDown);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        mapArea.removeEventListener("wheel", onWheel);
      };
    }

    this._startTravelerAnimations(el);
    if (!game.user?.isGM) return;
    el.querySelector(".kctg-map-set-bg")?.addEventListener("click", () => { openIconPicker(map.backgroundImage || "scenes/", async path => { const m = getMapCfg(); m.backgroundImage = path; await saveMapCfg(m); this.render(); }); });
    el.querySelector(".kctg-map-clear-bg")?.addEventListener("click", async () => { const m = getMapCfg(); m.backgroundImage = ""; await saveMapCfg(m); this.render(); });
    el.querySelector(".kctg-map-set-view")?.addEventListener("click", () => {
      this._savedView = { panX: this._panX, panY: this._panY, zoom: this._zoom };
      ui.notifications.info("Map view saved. Reset will return here.");
      this.render();
    });
    el.querySelector(".kctg-map-reset-pan")?.addEventListener("click", () => {
      if (this._savedView) { this._panX = this._savedView.panX; this._panY = this._savedView.panY; this._zoom = this._savedView.zoom; }
      else { this._panX = 0; this._panY = 0; this._zoom = 1; }
      const c = el.querySelector(".kctg-map-canvas"); if (c) this._applyTransform(c);
      const lbl = el.querySelector(".kctg-zoom-label"); if (lbl) lbl.textContent = Math.round(this._zoom * 100) + "%";
    });
    el.querySelector(".kctg-zoom-in")?.addEventListener("click",  () => this._doZoom(el, canvas,  0.2));
    el.querySelector(".kctg-zoom-out")?.addEventListener("click", () => this._doZoom(el, canvas, -0.2));
    el.querySelector(".kctg-map-toggle-edit")?.addEventListener("click", () => { this._editMode = !this._editMode; this._placeMode = false; this._waypointMode = false; this._routeMode = false; this._pendingFrom = null; this.render(); });
    el.querySelector(".kctg-map-toggle-place")?.addEventListener("click", () => { this._placeMode = !this._placeMode; if (mapArea) mapArea.style.cursor = this._placeMode ? "crosshair" : "grab"; this.render(); });
    el.querySelector(".kctg-map-toggle-wp")?.addEventListener("click", () => { this._waypointMode = !this._waypointMode; if (mapArea) mapArea.classList.toggle("kctg-wp-mode", this._waypointMode); this.render(); });
    el.querySelector(".kctg-map-toggle-route")?.addEventListener("click", () => { this._routeMode = !this._routeMode; if (!this._routeMode) this._pendingFrom = null; this.render(); });
    if (this._waypointMode && mapArea) mapArea.classList.add("kctg-wp-mode");

    if (this._editMode) {
      // ── Pin drag ──
      el.querySelectorAll(".kctg-map-pin").forEach(pin => {
        pin.style.cursor = "move";
        pin.addEventListener("mousedown", e => {
          if (e.button !== 0) return; e.stopPropagation();
          const id = pin.dataset.id; let dd = false; const sx = e.clientX, sy = e.clientY;
          const onMove = ev => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!dd && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dd = true;
            if (!dd) return;
            const rect = canvas.getBoundingClientRect(), cw = parseFloat(canvas.style.width) || 800, ch = parseFloat(canvas.style.height) || 600;
            pin.style.left = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / (cw * this._zoom)) * 100)) + "%";
            pin.style.top  = Math.max(0, Math.min(100, ((ev.clientY - rect.top)  / (ch * this._zoom)) * 100)) + "%";
          };
          const onUp = async ev => {
            document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
            if (!dd) return;
            const rect = canvas.getBoundingClientRect(), cw = parseFloat(canvas.style.width) || 800, ch = parseFloat(canvas.style.height) || 600;
            const m = getMapCfg(), loc = (m.locations ?? []).find(l => l.id === id);
            if (loc) {
              loc.x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / (cw * this._zoom)));
              loc.y = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / (ch * this._zoom)));
              _suppressNextMapRender(); await saveMapCfg(m); _updateRouteSVG(canvas);
            }
          };
          document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
        });
        pin.addEventListener("dblclick", e => {
          e.stopPropagation();
          const existing = foundry.applications.instances?.get(`kctg-location-edit--${pin.dataset.id}`);
          if (existing?.rendered) { existing.bringToFront(); return; }
          new LocationEditApp(pin.dataset.id).render(true);
        });
      });
      // ── Route-drawing — only when routeMode is active ──
      el.querySelectorAll(".kctg-map-pin").forEach(pin => pin.addEventListener("click", async e => {
        if (!this._editMode || !this._routeMode) return; e.stopPropagation(); const id = pin.dataset.id;
        if (!this._pendingFrom) {
          this._pendingFrom = id;
          el.querySelectorAll(".kctg-map-pin").forEach(p => p.classList.toggle("kctg-pin-pending", p.dataset.id === id));
        } else if (this._pendingFrom === id) {
          this._pendingFrom = null;
          el.querySelectorAll(".kctg-map-pin").forEach(p => p.classList.remove("kctg-pin-pending"));
        } else {
          const m = getMapCfg(), from = (m.locations ?? []).find(l => l.id === this._pendingFrom), to = (m.locations ?? []).find(l => l.id === id);
          m.routes = m.routes ?? [];
          const dup = m.routes.find(r => (r.fromId === this._pendingFrom && r.toId === id) || (r.fromId === id && r.toId === this._pendingFrom));
          if (!dup) m.routes.push({ id: newId(), name: `${from?.name ?? "A"} ↔ ${to?.name ?? "B"}`, fromId: this._pendingFrom, toId: id, travelDays: 1 });
          else ui.notifications.warn("A route between these locations already exists.");
          this._pendingFrom = null; await saveMapCfg(m); this.render();
        }
      }));
      // ── Waypoint handle drag + right-click remove ──
      el.querySelectorAll(".kctg-wp-handle").forEach(handle => {
        handle.addEventListener("mousedown", e => {
          if (e.button !== 0) return; e.stopPropagation();
          const routeId = handle.dataset.routeId, wpIdx = parseInt(handle.dataset.wpIdx);
          let dd = false;
          const onMove = ev => {
            dd = true;
            const rect = canvas.getBoundingClientRect(), cw = parseFloat(canvas.style.width) || 800, ch = parseFloat(canvas.style.height) || 600;
            handle.style.left = Math.max(0, Math.min(100, (ev.clientX - rect.left) / (cw * this._zoom) * 100)).toFixed(3) + "%";
            handle.style.top  = Math.max(0, Math.min(100, (ev.clientY - rect.top)  / (ch * this._zoom) * 100)).toFixed(3) + "%";
            _updateRouteSVG(canvas);
          };
          const onUp = async ev => {
            document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp);
            if (!dd) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            const y = Math.max(0, Math.min(1, (ev.clientY - rect.top)  / rect.height));
            const m = getMapCfg(), r = (m.routes ?? []).find(x2 => x2.id === routeId);
            if (r?.waypoints?.[wpIdx] != null) { r.waypoints[wpIdx] = { x, y }; _suppressNextMapRender(); await saveMapCfg(m); _updateRouteSVG(canvas); }
          };
          document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
        });
        handle.addEventListener("contextmenu", async e => {
          e.preventDefault(); e.stopPropagation();
          const routeId = handle.dataset.routeId, wpIdx = parseInt(handle.dataset.wpIdx);
          const m = getMapCfg(), r = (m.routes ?? []).find(x => x.id === routeId);
          if (r?.waypoints) { r.waypoints.splice(wpIdx, 1); await saveMapCfg(m); this.render(); }
        });
      });
      // ── Route hitzone: click to add waypoint (only when waypointMode active) ──
      el.querySelectorAll(".kctg-route-hitzone").forEach(hzone => {
        hzone.addEventListener("click", async e => {
          if (!this._waypointMode) return;
          e.stopPropagation();
          const routeId = hzone.dataset.routeId;
          const rect = canvas.getBoundingClientRect();
          const cx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const cy = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
          const m = getMapCfg(), r = (m.routes ?? []).find(x => x.id === routeId);
          if (!r) return;
          r.waypoints = r.waypoints ?? [];
          const pts = _routePoints(r, m.locations ?? []);
          let best = pts.length - 2, bestD = Infinity;
          for (let i = 0; i < pts.length - 1; i++) {
            const d = _distPtSegSq(cx, cy, pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y);
            if (d < bestD) { bestD = d; best = i; }
          }
          r.waypoints.splice(best, 0, { x: cx, y: cy });
          await saveMapCfg(m); this.render();
        });
      });
    }
    el.querySelectorAll(".kctg-route-delete").forEach(btn => btn.addEventListener("click", async () => { const m = getMapCfg(); m.routes = (m.routes ?? []).filter(r => r.id !== btn.dataset.id); await saveMapCfg(m); this.render(); }));
    el.querySelectorAll(".kctg-route-travel-days").forEach(input =>
      input.addEventListener("change", async e => {
        const m = getMapCfg(), r = (m.routes ?? []).find(x => x.id === e.target.dataset.id);
        if (r) { r.travelDays = Math.max(1, parseInt(e.target.value) || 1); await saveMapCfg(m); }
      })
    );
  }

  _applyTransform(c) {
    c.style.transformOrigin = "0 0";
    c.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
  }

  _clampPan(canvas, mapArea) {
    const cw = parseFloat(canvas.style.width)  || this._naturalW;
    const ch = parseFloat(canvas.style.height) || this._naturalH;
    const vw = mapArea.clientWidth, vh = mapArea.clientHeight;
    const minVis = 80;
    this._panX = Math.max(minVis - cw * this._zoom, Math.min(vw - minVis, this._panX));
    this._panY = Math.max(minVis - ch * this._zoom, Math.min(vh - minVis, this._panY));
  }

  _doZoom(el, canvas, delta) {
    const mapArea = el?.querySelector(".kctg-map-area");
    const newZ = Math.max(0.1, Math.min(4, this._zoom + delta));
    if (mapArea) {
      const cx = mapArea.clientWidth  / 2;
      const cy = mapArea.clientHeight / 2;
      this._panX = cx - (cx - this._panX) * (newZ / this._zoom);
      this._panY = cy - (cy - this._panY) * (newZ / this._zoom);
    }
    this._zoom = newZ;
    if (canvas && mapArea) this._clampPan(canvas, mapArea);
    if (canvas) this._applyTransform(canvas);
    const lbl = el?.querySelector(".kctg-zoom-label");
    if (lbl) lbl.textContent = Math.round(newZ * 100) + "%";
  }
  // Gently oscillate traveling workers around their game-day position (±2% of route length).
  // This is purely visual — the icon stays near the correct progress point, not animated to destination.
  _startTravelerAnimations(el) {
    if (this._animRAF) { cancelAnimationFrame(this._animRAF); this._animRAF = null; }
    const travelers = [...el.querySelectorAll(".kctg-traveler[data-phase]")]
      .filter(t => t.dataset.phase !== "atDestination");
    if (!travelers.length) return;
    _log("Starting traveler oscillations for", travelers.length, "worker(s)");
    const PERIOD = 4000, AMP = 0.02, startTime = performance.now();
    const tick = (now) => {
      const elapsed = now - startTime;
      travelers.forEach(t => {
        const sp  = parseFloat(t.dataset.startProgress) || 0;
        const osc = Math.sin((elapsed / PERIOD) * Math.PI * 2) * AMP;
        const p   = Math.max(0, Math.min(1, sp + osc));
        const ptsData = (t.dataset.pts ?? "").split(" ").map(s => { const [x, y] = s.split(",").map(Number); return { x, y }; }).filter(pt => !isNaN(pt.x));
        const pos = ptsData.length >= 2 ? _posAlongPts(ptsData, p) : { x: parseFloat(t.dataset.fromX) + (parseFloat(t.dataset.toX) - parseFloat(t.dataset.fromX)) * p, y: parseFloat(t.dataset.fromY) + (parseFloat(t.dataset.toY) - parseFloat(t.dataset.fromY)) * p };
        t.style.left = pos.x + "%";
        t.style.top  = pos.y + "%";
      });
      this._animRAF = requestAnimationFrame(tick);
    };
    this._animRAF = requestAnimationFrame(tick);
  }

  async _placeLocation(x, y) { const m = getMapCfg(); m.locations = m.locations ?? []; m.locations.push({ id: newId(), name: "New Location", icon: "icons/svg/village.svg", x, y }); await saveMapCfg(m); this._placeMode = false; this.render(); }
  _onClose(options) { if (this._animRAF) { cancelAnimationFrame(this._animRAF); this._animRAF = null; } if (this._panCleanup) { this._panCleanup(); this._panCleanup = null; } }
}

// ─── EVENT TABLE CONFIG ────────────────────────────────────────────────────────

class EventTableConfigApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  static DEFAULT_OPTIONS = {
    id: "kctg-workshop--event-config",
    classes: ["kctg-module", "kctg-event-config"],
    window: { title: "Event Tables", resizable: false },
    position: { width: 520, height: 320 }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/workshop/event-config.hbs` } };

  async _prepareContext() {
    const ev = getEvTables();
    return { rows: [
      { key: "forageUuid",  label: "Forage Events",  uuid: ev.forageUuid  ?? "", icon: "fas fa-leaf"       },
      { key: "tradeUuid",   label: "Trade Events",   uuid: ev.tradeUuid   ?? "", icon: "fas fa-route"      },
      { key: "patrolUuid",  label: "Patrol Events",  uuid: ev.patrolUuid  ?? "", icon: "fas fa-shield-alt" },
      { key: "scoutUuid",   label: "Scout Events",   uuid: ev.scoutUuid   ?? "", icon: "fas fa-binoculars" },
      { key: "generalUuid", label: "General Events", uuid: ev.generalUuid ?? "", icon: "fas fa-dice-d20"   },
    ]};
  }

  _onRender(context, options) {
    const el = this.element;
    _applyTheme(el);
    el.querySelectorAll(".kctg-evtable-slot").forEach(slot => {
      slot.addEventListener("dragover",  e => e.preventDefault());
      slot.addEventListener("dragenter", e => { e.preventDefault(); slot.classList.add("kctg-drag-over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("kctg-drag-over"));
      slot.addEventListener("drop", async e => {
        e.preventDefault(); slot.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "RollTable") return ui.notifications.warn("Drop a RollTable here.");
        const uuid = data.uuid ?? (data.id ? `RollTable.${data.id}` : null); if (!uuid) return;
        const table = await safeFromUuid(uuid), ev = getEvTables();
        ev[slot.dataset.key] = uuid; ev[slot.dataset.key.replace("Uuid","Name")] = table?.name ?? "Unknown";
        await saveEvTbls(ev); this.render();
      });
    });
    el.querySelectorAll(".kctg-evtable-clear").forEach(btn =>
      btn.addEventListener("click", async () => { const ev = getEvTables(); ev[btn.dataset.key] = ""; await saveEvTbls(ev); this.render(); })
    );
  }
}

// Campaign dashboard open hook
Hooks.on("kctg:openWorkshop", () => WorkshopApp.open());

// ─── HOOKS ─────────────────────────────────────────────────────────────────────

Hooks.on("getSceneControlButtons", controls => {
  _addToKctgGroup(controls, {
    name: "kctg-workshop-open",
    title: "Workshop",
    icon: "fas fa-store",
    button: true,
    onChange: () => {
      const ex = foundry.applications.instances?.get("kctg-workshop--hub");
      if (ex?.rendered) ex.close(); else WorkshopApp.open();
    },
  });
});


Hooks.once("ready", () => {
  // Player → GM delegation: the single responsible (first active) GM applies
  // player-initiated writes (settings, retainer-actor item changes).
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    // Broadcast toasts, shown on EVERY client (must run before the GM-only gate).
    if (data?.type === "wsToast") {
      kctgToast({ label: data.label, name: data.name, icon: data.icon, tone: data.tone, key: data.key, onClick: () => WorkshopApp.open() });
      return;
    }
    // Delegated writes: only the single responsible GM applies these.
    if (!game.user.isGM || _wsActiveGM()?.id !== game.user.id) return;
    if (data?.type === "wsSet") {
      // Every delegable player key stores an array; reject anything else so a crafted
      // socket message can't overwrite a list with arbitrary content (griefing/data loss).
      // _wsMayDelegate re-checks the world-state gate GM-side: a crafted emit can't
      // write a key whose player editing the GM has switched off.
      if (_WS_PLAYER_KEYS.has(data.key) && _wsMayDelegate(data.key) && Array.isArray(data.value))
        await game.settings.set(MODULE_ID, data.key, data.value);
    } else if (data?.type === "wsOrderMark") {
      // Fulfilment outcome from a retainer-owning player. Never trust force from
      // the wire; lateness is re-derived from the order's own deadline.
      await _markTradeOrderFulfilled(data.orderId, { force: false });
    } else if (data?.type === "wsCollect") {
      await collectTaskItems(data.taskId);
    } else if (data?.type === "wsRemoveInv") {
      await removeInventoryEntry(data.entryId);
    } else if (data?.type === "wsRunTask") {
      await runTask(data.taskId);
    } else if (data?.type === "wsRollEvent") {
      await rollEvent(data.taskType);
    } else if (data?.type === "wsFulfill") {
      await _fulfillTradeOrder(data.orderId, { force: !!data.force });
    }
  });

  const _wsMod = game.modules.get(MODULE_ID);
  _wsMod.api ??= {};
  Object.assign(_wsMod.api, { openWorkshop: () => WorkshopApp.open(), openTradeMap: () => TradeMapApp.open(), runTask, rollEvent, setCurrentDay });
  console.log("%c🔨 KCTG Workshop | Ready", "color:#c9a84c;font-weight:bold;");
});

// ─── CROSS-MODULE: quest completions unlock linked trade orders ────────────────
// Mirrors the Forge (recipe unlock) and Merchant (auto-restock) listeners. The
// lock itself is DERIVED (linkedQuestId + quest status) so no write is needed to
// unlock; this listener only announces and refreshes.
Hooks.on("kctg:questCompleted", async (questPageId, questName) => {
  const unlocked = getTradeOrdersMigrated().filter(o =>
    o.linkedQuestId && o.linkedQuestId.split(".").pop() === questPageId && !o.fulfilledAt);
  if (!unlocked.length) return;
  // The hook fires on every client, so toast locally rather than over the socket.
  for (const o of unlocked) {
    kctgToast({ label: "Trade Order Unlocked", name: o.name, icon: "fas fa-unlock",
      key: "wsorderunlock-" + o.id, onClick: () => WorkshopApp.open() });
  }
  // Chat + activity feed once, from the single responsible GM.
  if (_wsActiveGM()?.id === game.user.id) {
    const names = unlocked.map(o => `<strong>${esc(o.name)}</strong>`).join(", ");
    await postWorkshopMsg("Trade Orders Unlocked",
      `Completing <em>${esc(questName)}</em> unlocked ${names}.`, "fas fa-unlock");
    for (const o of unlocked) await logActivity("order", `Trade order unlocked: ${o.name} (quest "${questName}")`);
  }
  _reRenderHub();
});

// ─── LIVE SYNC ──────────────────────────────────────────────────────────────────
// Re-render open Workshop/TradeMap apps whenever any module setting changes.
// _suppressNextRender flag can be set to skip ONE re-render (used during pin drags
// and waypoint moves where we update the SVG in-place instead of a full re-render).
Hooks.on("updateSetting", setting => {
  if (!setting.key?.startsWith(MODULE_ID + ".")) return;
  const hub = foundry.applications.instances?.get("kctg-workshop--hub");
  if (hub?.rendered) {
    if (hub._suppressNextRender) { hub._suppressNextRender = false; }
    else hub.render();
  }
  const map = foundry.applications.instances?.get("kctg-workshop--trade-map");
  if (map?.rendered) {
    if (map._suppressNextRender) { map._suppressNextRender = false; }
    else map.render();
  }
});

// Re-render when items are added/removed/updated on the retainer actor or any logged actor
function _reRenderHub() {
  const hub = foundry.applications.instances?.get("kctg-workshop--hub");
  if (hub?.rendered) hub.render();
}
function _isTrackedActor(item) {
  const aid = item.parent?.id;
  if (!aid) return false;
  if (aid === getWsActorId()) return true;
  return getInvLog().some(e => e.actorId === aid);
}
Hooks.on("createItem", item => { if (_isTrackedActor(item)) _reRenderHub(); });
Hooks.on("deleteItem", item => { if (_isTrackedActor(item)) _reRenderHub(); });
Hooks.on("updateItem", (item, changes) => {
  if (_isTrackedActor(item) && (changes.system?.quantity != null || changes.system?.amount != null || changes.system?.coins != null || changes.system?.currency != null))
    _reRenderHub();
});
