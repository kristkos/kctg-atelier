/**
 * KCTG Suite — shared module bootstrap
 * Imported by forge.mjs, quests.mjs, and workshop.mjs
 */

export const MODULE_ID = "kctg-atelier";

// Theme system removed — single unified visual style
export function applyTheme(_element) {}

// v14: getSceneControlButtons receives a plain object keyed by control name.
// Both the control group and each tool require a numeric `order` in v14 (the UI
// sorts the keyed records into arrays by it); a missing order makes button placement
// non-deterministic. We give the group a fixed order and auto-assign each tool's
// order by insertion sequence so the KCTG buttons keep a stable, predictable layout.
export function _addToKctgGroup(controls, tool) {
  if (!controls.kctg) {
    controls.kctg = { name: "kctg", title: "KCTG", icon: "fas fa-dice-d20", order: 100, tools: {} };
  }
  if (tool.order == null) tool.order = (Object.keys(controls.kctg.tools).length + 1) * 10;
  controls.kctg.tools[tool.name] = tool;
}

// ─── SHARED UTILITIES ─────────────────────────────────────────────────────────

export const newId = () => foundry.utils.randomID(16);

/** Escape a value for safe interpolation into innerHTML / ChatMessage content
 *  (covers both text positions and double-quoted attributes). */
export function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

export async function safeFromUuid(uuid) {
  if (!uuid) return null;
  try { return await foundry.utils.fromUuid(uuid); } catch { return null; }
}

export function getItemQty(item) {
  return item.system?.quantity ?? item.system?.qty ?? item.system?.uses?.value ?? 1;
}

/** Item types the running system actually accepts for createEmbeddedDocuments.
 *  Sourced from the system's own manifest (game.documentTypes), so this works
 *  on any system without a hardcoded list. */
export function validItemTypes() {
  return (game.documentTypes?.Item ?? []).filter(t => t !== CONST.BASE_DOCUMENT_TYPE);
}

// ─── SHARED PHYSICAL-ITEM CHECK ───────────────────────────────────────────────
//
// "Can this item sit in an inventory / shop as goods?" One check for the whole
// suite (Merchant stock, Workshop inventory). Detection order:
//   1. item.isOfType("physical")   — systems with an authoritative API (PF2e).
//   2. schema fields               — typed data models (dnd5e etc.): physical
//      items declare quantity/price/cost fields, abstract ones declare none.
//   3. type-name blocklist         — untyped systems (simple worldbuilding).
// New systems usually land in bucket 1 or 2 automatically — no porting needed.

const NON_PHYSICAL_TYPES = new Set([
  "feat","feature","classfeature","action","reaction","free-action",
  "class","subclass","background","race","subrace","ancestry","heritage","classdc",
  "skill","lore","proficiency","talent","edge","hindrance","power",
  "spell","spellcastingentry","focus",
  "effect","condition","affliction","curse",
  "deity","campaignfeature","facility",
  "grant","ability","specialability","monsterability","melee",
  "npc","hazard","book",
]);

/** True when an item is a physical/inventory item, on any system. */
export function isInventoryItem(item) {
  if (typeof item?.isOfType === "function") return item.isOfType("physical");
  const t = item?.type?.toLowerCase() ?? "";
  if (NON_PHYSICAL_TYPES.has(t)) return false;
  // Field spellings mirror the quantity vocabulary the suite already honours
  // (getItemQty reads quantity/qty; workshop inventory also reads amount).
  const fields = item?.system?.schema?.fields;
  if (fields && !["quantity", "qty", "amount", "price", "cost"].some(f => f in fields)) return false;
  return true;
}

/**
 * Add srcItem to actor, stacking against an existing item of the same name if possible.
 * Returns the resulting Item document, or null on failure.
 * @param {Actor}   actor     - target actor
 * @param {object}  srcItem   - live Item document or plain source data object
 * @param {number}  qty       - quantity to add
 * @param {boolean} isRawData - true when srcItem is already plain source data (skips toObject())
 */
export async function addItemToActor(actor, srcItem, qty, isRawData = false) {
  let data;
  try {
    data = isRawData
      ? foundry.utils.deepClone(srcItem)
      : (srcItem.toObject ? srcItem.toObject() : foundry.utils.deepClone(srcItem));
  } catch {
    data = foundry.utils.deepClone(srcItem);
  }
  delete data._id;
  const name = data.name ?? srcItem.name;

  // Stack only onto a same-type item; a name-only match would let e.g. a lore
  // named "Dagger" absorb a crafted weapon "Dagger". Untyped source data (none of
  // our callers today) still falls back to name-only.
  const existing = actor.items.find(i => i.name === name && (!data.type || i.type === data.type));
  if (existing) {
    if (existing.system?.quantity !== undefined) {
      await existing.update({ "system.quantity": (getItemQty(existing) ?? 0) + qty });
    } else if (qty > 1) {
      console.warn(`KCTG | "${name}" (${existing.type}) does not track quantity; actor keeps a single copy, requested ${qty}.`);
    }
    return existing;
  }

  if (data.system?.quantity !== undefined) data.system.quantity = qty;

  const valid = validItemTypes();
  if (data.type && valid.length && !valid.includes(data.type)) {
    console.warn(`KCTG | Skipping "${name}" — type "${data.type}" is not a valid ${game.system?.id} item type.`);
    return null;
  }

  try {
    const created = await actor.createEmbeddedDocuments("Item", [data]);
    return created[0] ?? null;
  } catch (err) {
    console.error(`KCTG | Failed to add "${name}" to ${actor.name}:`, err.message);
    return null;
  }
}

// ─── SHARED CURRENCY ──────────────────────────────────────────────────────────
//
// One source of truth for coin math across the suite (Workshop rewards, Merchant
// transactions). Keep this single — divergent copies silently lose or mint money.

/** Copper value of one of each denomination. */
export const COIN_RATES = { pp: 1000, gp: 100, sp: 10, cp: 1, ep: 50 };

/**
 * Split a copper amount into a {gp, sp, cp} coin object. gp is the base unit, so
 * platinum/electrum are intentionally NOT produced (PF2e's addCoins/removeCoins make
 * change automatically; e.g. 190000cp → 1900 gp, never 190 pp).
 */
export function copperToCoinObj(copper) {
  let rem = Math.max(0, Math.round(copper));
  const gp = Math.floor(rem / 100); rem -= gp * 100;
  const sp = Math.floor(rem / 10);  rem -= sp * 10;
  return { gp, sp, cp: rem };
}

// Some systems store a denomination as {value: N} rather than a bare number.
function _readCoinValue(v) {
  return typeof v === "object" && v !== null ? Number(v.value ?? 0) : Number(v ?? 0);
}

const _currencyBase = actor => actor.system?.currency != null ? "system.currency" : "system.coins";
const _currencyObj  = actor => actor.system?.currency ?? actor.system?.coins ?? {};

/** An actor's total coinage in copper. Prefers the system's own computed value
 *  (PF2e inventory.coins), else sums the generic currency/coins object. */
export function actorCopperValue(actor) {
  const inv = actor?.inventory?.coins;
  if (inv && typeof inv.copperValue === "number") return inv.copperValue;
  return Object.entries(_currencyObj(actor))
    .reduce((t, [d, v]) => t + (COIN_RATES[d] ?? 0) * _readCoinValue(v), 0);
}

/**
 * Credit a copper amount to an actor. PF2e-style systems go through the
 * inventory API; generic systems (dnd5e etc.) get the amount ADDED as a
 * gp/sp/cp split on top of their existing coins — the rest of the purse is
 * never rewritten (players notice when 120 gp silently becomes 12 pp).
 */
export async function creditCurrency(actor, copper) {
  if (copper <= 0) return;
  if (typeof actor?.inventory?.addCoins === "function") {
    await actor.inventory.addCoins(copperToCoinObj(copper));
    return;
  }
  const cur  = _currencyObj(actor);
  const base = _currencyBase(actor);
  const add  = copperToCoinObj(copper);
  const update = {};
  if (["gp", "sp", "cp"].every(d => !(add[d] ?? 0) || d in cur)) {
    for (const d of ["gp", "sp", "cp"]) {
      if (add[d]) update[`${base}.${d}`] = _readCoinValue(cur[d]) + add[d];
    }
  } else {
    // Currency object lacks gp/sp/cp keys — redistribute the total into
    // whatever denominations the system does track (largest first, no ep).
    let rem = actorCopperValue(actor) + copper;
    for (const [d, r] of Object.entries(COIN_RATES).sort((a, b) => b[1] - a[1])) {
      if (!(d in cur) || d === "ep") continue;
      update[`${base}.${d}`] = Math.floor(rem / r);
      rem %= r;
    }
  }
  await actor.update(update);
}

/**
 * Deduct a copper amount from an actor; returns false when they can't afford it.
 * PF2e-style systems use the inventory API (it makes change itself). Generic
 * systems pay like a person at a till: matching denominations first, then the
 * smallest coins, and only if change is still owed is one larger coin broken —
 * the rest of the purse keeps its exact composition.
 */
export async function debitCurrency(actor, copper) {
  if (copper <= 0) return true;
  if (actorCopperValue(actor) < copper) return false;
  if (typeof actor?.inventory?.removeCoins === "function") {
    return !!(await actor.inventory.removeCoins(copperToCoinObj(copper)));
  }
  const cur  = _currencyObj(actor);
  const base = _currencyBase(actor);
  const target = {};
  for (const d of Object.keys(COIN_RATES)) if (d in cur) target[d] = _readCoinValue(cur[d]);

  let rem = copper;
  // 1. Pay each denomination of the price with matching coins where available.
  const want = copperToCoinObj(copper);
  for (const [d, r] of [["gp", 100], ["sp", 10], ["cp", 1]]) {
    if (!(d in target)) continue;
    const take = Math.min(target[d], want[d] ?? 0);
    target[d] -= take; rem -= take * r;
  }
  // 2. Cover any remainder starting from the smallest coins.
  for (const [d, r] of Object.entries(COIN_RATES).sort((a, b) => a[1] - b[1])) {
    if (!(d in target) || rem <= 0) continue;
    const take = Math.min(target[d], Math.floor(rem / r));
    target[d] -= take; rem -= take * r;
  }
  // 3. Still short → break the smallest single coin that covers it; change
  //    comes back in gp/sp/cp.
  if (rem > 0) {
    const candidate = Object.entries(COIN_RATES)
      .filter(([d, r]) => (target[d] ?? 0) > 0 && r > rem)
      .sort((a, b) => a[1] - b[1])[0];
    if (!candidate) return false; // no combination works (all large coins spent)
    target[candidate[0]] -= 1;
    let change = candidate[1] - rem;
    for (const [cd, cr] of [["gp", 100], ["sp", 10], ["cp", 1]]) {
      if (!(cd in target)) continue;
      const back = Math.floor(change / cr);
      target[cd] += back; change -= back * cr;
    }
  }
  const update = {};
  for (const [d, v] of Object.entries(target)) update[`${base}.${d}`] = v;
  await actor.update(update);
  return true;
}

// ─── SHARED APP UTILITIES ─────────────────────────────────────────────────────

/** Best-guess fallback Item type for the current game system. Known systems get
 *  their idiomatic loot type; anything else picks the first plausible type the
 *  system's manifest actually declares, so placeholders never fail validation. */
export function fallbackItemType() {
  const preferred = { pf2e: "treasure", sf2e: "treasure", dnd5e: "loot", pf1: "misc" }[game.system?.id];
  const valid = validItemTypes();
  if (preferred && (!valid.length || valid.includes(preferred))) return preferred;
  for (const t of ["loot", "treasure", "item", "gear", "object", "equipment", "misc"]) {
    if (valid.includes(t)) return t;
  }
  return valid[0] ?? "item";
}

/**
 * Mixin that adds a safe setPosition guard to any ApplicationV2 subclass.
 * Guards against _updatePosition crashes when the element isn't in the DOM yet —
 * a timing issue that can occur if setPosition is called before first render.
 */
export function KCTGMixin(Base) {
  return class extends Base {
    setPosition(position = {}) {
      if (!this.element) return position;
      try { return super.setPosition(position); } catch { return position; }
    }
  };
}

// ─── SHARED TOAST ─────────────────────────────────────────────────────────────
//
// Lightweight top-center notification, matching the Quests toast styling so the
// whole suite has one consistent "pop". Lives on <body> (outside any .kctg-module),
// so the CSS hoists its own design tokens. Quests keeps its own toast (it carries
// extra unread-tracking logic); everything else should use this.

/**
 * Show a transient toast. De-dupes by `key` (a second toast with the same key is skipped).
 * @param {object}   opts
 * @param {string}   [opts.label]   - small prefix label (e.g. "Task Complete")
 * @param {string}   [opts.name]    - emphasised name (e.g. the task name)
 * @param {string}   [opts.icon]    - Font Awesome icon class
 * @param {string}   [opts.tone]    - "gold" (default) | "danger"
 * @param {Function} [opts.onClick] - run on left-click (the toast also dismisses)
 * @param {string}   [opts.key]     - de-dupe key
 */
export function kctgToast({ label = "", name = "", icon = "fas fa-bell", tone = "gold", onClick = null, key = "" } = {}) {
  if (key && document.querySelector(`.kctg-toast[data-key="${CSS.escape(key)}"]`)) return;

  let container = document.getElementById("kctg-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "kctg-toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `kctg-toast kctg-toast--${tone}`;
  if (key) toast.dataset.key = key;
  const sep = label && name ? ": " : "";
  // icon is escaped too: wsToast relays it verbatim from the module socket, so a
  // crafted emit from any logged-in client must not become markup on other clients.
  toast.innerHTML = `<i class="${esc(icon)}"></i> ${esc(label)}${sep}<span class="kctg-toast-name">${esc(name)}</span>`;
  container.appendChild(toast);

  toast.animate([{ opacity: 0, transform: "translateY(-24px) scale(0.95)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
    { duration: 350, easing: "cubic-bezier(0.2, 0, 0.15, 1)", fill: "forwards" });

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "ease-in" })
      .onfinish = () => { toast.remove(); if (!container.children.length) container.remove(); };
  };

  toast.addEventListener("mouseup", e => { dismiss(); if (e.button === 0 && onClick) onClick(); });
  setTimeout(dismiss, 8000);
}

// ─── SHARED ACTIVITY LOG ──────────────────────────────────────────────────────
//
// A small capped feed of notable campaign events (task completions, order
// fulfilments, craft collections, quest completions, restocks), rendered on the
// Campaign Dashboard. Stored in the world setting "activityLog" (newest first).
// Entries carry plain text only; the dashboard template escapes on render.

const ACTIVITY_LOG_MAX = 40;

// Icons are derived from the entry type on the writing GM's side, never taken
// from the socket payload, so a crafted emit can't smuggle markup into the feed.
const ACTIVITY_ICONS = {
  task:    "fas fa-tasks",
  order:   "fas fa-handshake",
  craft:   "fas fa-hammer",
  quest:   "fas fa-scroll",
  restock: "fas fa-store",
  system:  "fas fa-database",
};

function _activityEntry(type, text) {
  return {
    id:   newId(),
    ts:   Date.now(),
    day:  getCurrentDay(),
    type: ACTIVITY_ICONS[type] ? type : "system",
    text: String(text ?? "").slice(0, 300),
  };
}

async function _writeActivityEntry(entry) {
  const log = [entry, ...(game.settings.get(MODULE_ID, "activityLog") ?? [])];
  await game.settings.set(MODULE_ID, "activityLog", log.slice(0, ACTIVITY_LOG_MAX));
}

/**
 * Append an event to the shared activity feed. Callable from any client:
 * non-GM writers delegate to the single responsible GM over the module socket
 * (world settings are GM-writable only).
 * @param {"task"|"order"|"craft"|"quest"|"restock"|"system"} type
 * @param {string} text - plain text, truncated to 300 chars
 */
export async function logActivity(type, text) {
  const entry = _activityEntry(type, text);
  if (game.user.isGM || game.user.hasPermission("SETTINGS_MODIFY")) {
    await _writeActivityEntry(entry);
  } else if (game.users.some(u => u.isGM && u.active)) {
    game.socket.emit(`module.${MODULE_ID}`, { type: "kctgLogActivity", entryType: entry.type, text: entry.text });
  }
  // No GM online → the event is simply not logged; the feed is a convenience, not a ledger.
}

/** Icon class for an activity entry type (used by the dashboard context). */
export function activityIcon(type) {
  return ACTIVITY_ICONS[type] ?? ACTIVITY_ICONS.system;
}

// ─── SHARED TIME SERVICE ──────────────────────────────────────────────────────
//
// One clock drives all of the suite's time-based automation (Workshop tasks,
// Forge crafting, and anything added later). It can run in two modes:
//
//   • Standalone  — an internal integer "day" counter (the original behaviour).
//   • World-bound — the day is derived from Foundry's world clock (game.time),
//                   so advancing time in Foundry / Simple Calendar / another
//                   module advances the workshop day and auto-completes work.
//
// Consumers should ONLY use getCurrentDay() / advanceDays() / onDayAdvance() —
// they never read the raw settings directly, so both modes "just work".

/** Day-advance subscribers, fired whenever the current day may have changed. */
const _dayAdvanceSubs = new Set();

/**
 * Register a callback fired whenever the current day advances (manual buttons,
 * Foundry world clock, Simple Calendar, etc.). Returns an unsubscribe function.
 */
export function onDayAdvance(fn) {
  _dayAdvanceSubs.add(fn);
  return () => _dayAdvanceSubs.delete(fn);
}

function _fireDayAdvance() {
  for (const fn of _dayAdvanceSubs) {
    try { Promise.resolve(fn()).catch(e => console.error("KCTG | day-advance handler failed:", e)); }
    catch (e) { console.error("KCTG | day-advance handler failed:", e); }
  }
}

/** Seconds in one in-world day, honouring the active (possibly custom) calendar. */
export function secondsPerDay() {
  const d = game.time?.calendar?.days;
  if (d) return (d.secondsPerMinute ?? 60) * (d.minutesPerHour ?? 60) * (d.hoursPerDay ?? 24);
  return 86400;
}

/** True when the workshop day is slaved to Foundry's world clock. */
export function isWorldClockBound() {
  return !!game.settings.get(MODULE_ID, "bindWorldClock");
}

/** Absolute day number derived purely from world time (no offset applied). */
function _worldDay() {
  return Math.floor((game.time?.worldTime ?? 0) / secondsPerDay());
}

/**
 * The current workshop day.
 *   • Standalone  → the internal counter.
 *   • World-bound → world day + offset (offset keeps the day number continuous
 *                   across a mode switch so existing task/craft timers stay valid).
 */
export function getCurrentDay() {
  if (isWorldClockBound()) {
    return _worldDay() + (game.settings.get(MODULE_ID, "worldDayOffset") ?? 0);
  }
  return game.settings.get(MODULE_ID, "currentDay") ?? 1;
}

/** Calendar components for the current world time, or null when unavailable. */
export function getDayComponents() {
  try { return game.time?.components ?? null; } catch { return null; }
}

/**
 * Human-readable current world date. Prefers PF2e's world clock (Golarion / Absalom
 * Reckoning, etc.) so the label matches the calendar chosen in the system; otherwise
 * falls back to Foundry's core calendar. Returns null when no date is available.
 */
export function getWorldDateStr() {
  const pf = game.pf2e?.worldClock;
  if (pf) {
    try {
      const dt = pf.worldTime;
      if (dt?.isValid) {
        const hh  = String(dt.hour).padStart(2, "0");
        const mm  = String(dt.minute).padStart(2, "0");
        const era = pf.era ? ` ${pf.era}` : "";
        return `${pf.month} ${dt.day}, ${pf.year}${era} at ${hh}:${mm}`;
      }
    } catch (_e) { /* fall through to the core-calendar path below */ }
  }

  const c = getDayComponents();
  if (!c) return null;
  const cal      = game.time?.calendar;
  const rawMonth = cal?.months?.values?.[c.month]?.name;
  const month    = rawMonth ? game.i18n.localize(rawMonth) : `Month ${(c.month ?? 0) + 1}`;
  const dayNum   = (c.dayOfMonth ?? c.day ?? 0) + 1;
  const hh       = String(c.hour ?? 0).padStart(2, "0");
  const mm       = String(c.minute ?? 0).padStart(2, "0");
  return `${month} ${dayNum}, Year ${c.year ?? 0} at ${hh}:${mm}`;
}

function _canWriteWorldSettings() {
  return game.user.isGM || game.user.hasPermission("SETTINGS_MODIFY");
}

/**
 * Set the current day to an absolute value.
 *   • World-bound → adjust the offset so the derived day equals `day`
 *                   (world time itself is left to Foundry / the calendar).
 *   • Standalone  → write the internal counter.
 * GM-only (day controls live on the GM-facing Overview). Fires subscribers.
 */
export async function setCurrentDay(day) {
  const target = Math.max(1, Math.round(day));
  if (!_canWriteWorldSettings()) return;
  if (isWorldClockBound()) {
    // World time itself is unchanged; only the offset moves. The updateSetting
    // hook below fires subscribers on every client.
    await game.settings.set(MODULE_ID, "worldDayOffset", target - _worldDay());
  } else {
    await game.settings.set(MODULE_ID, "currentDay", target);
  }
}

/**
 * Advance (or rewind, if negative) the day by `n`.
 *   • World-bound → advances Foundry world time (Simple Calendar moves too);
 *                   the updateWorldTime hook fires subscribers.
 *   • Standalone  → bumps the internal counter and fires subscribers.
 */
export async function advanceDays(n) {
  if (!n) return;
  if (isWorldClockBound()) {
    if (!_canWriteWorldSettings()) return;
    await game.time.advance(Math.round(n) * secondsPerDay());
    // updateWorldTime hook handles firing.
  } else {
    await setCurrentDay(getCurrentDay() + Math.round(n));
  }
}

/**
 * Toggle world-clock binding. Day-number continuity is preserved by the setting's
 * onChange handler (_onBindingChanged), so this is a thin convenience wrapper.
 */
export async function setWorldClockBinding(on) {
  if (!_canWriteWorldSettings()) return;
  await game.settings.set(MODULE_ID, "bindWorldClock", !!on);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

// Registered once (ES module caching means this file only runs once)
Hooks.once("init", () => {
  // Handlebars helpers — namespaced to avoid conflicts with other modules
  Handlebars.registerHelper("kctg_eq",     (a, b) => a === b);
  Handlebars.registerHelper("kctg_or",     (a, b) => a || b);
  Handlebars.registerHelper("kctg_add",    (a, b) => (a ?? 0) + (b ?? 0));
  Handlebars.registerHelper("kctg_divide", (a, b) => b ? a / b : 0);

  // ── Shared time-service settings (used by Workshop tasks & Forge crafting) ──
  game.settings.register(MODULE_ID, "currentDay", {
    scope: "world", config: false, type: Number, default: 1
  });
  game.settings.register(MODULE_ID, "worldDayOffset", {
    scope: "world", config: false, type: Number, default: 0
  });
  game.settings.register(MODULE_ID, "bindWorldClock", {
    name: "Bind Workshop Day to World Clock",
    hint: "When enabled, the workshop day follows Foundry's world time (and Simple Calendar). Advancing time auto-completes tasks and crafts. When off, the day is a standalone counter you advance manually.",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: on => _onBindingChanged(!!on)
  });

  // Shared activity feed (Campaign Dashboard). Newest first, capped.
  game.settings.register(MODULE_ID, "activityLog", {
    scope: "world", config: false, type: Array, default: []
  });
});

// Player-side logActivity calls delegate here; only the single responsible GM
// writes, and the entry is rebuilt server-side from {entryType, text} so the
// wire payload can't set the icon, id, or timestamp.
Hooks.once("ready", () => {
  game.socket.on(`module.${MODULE_ID}`, async data => {
    if (data?.type !== "kctgLogActivity") return;
    const responsible = game.users.find(u => u.isGM && u.active);
    if (!game.user.isGM || responsible?.id !== game.user.id) return;
    await _writeActivityEntry(_activityEntry(data.entryType, data.text));
  });
});

/**
 * Keep the day number continuous when binding is toggled — works no matter how it
 * was flipped (our UI or Foundry's Settings menu). Uses only persisted settings, so
 * no pre-toggle state is needed. GM-only (settings writes); other clients just re-render.
 */
async function _onBindingChanged(on) {
  if (_canWriteWorldSettings()) {
    if (on) {
      // Continue from the standalone counter's last value.
      const standalone = game.settings.get(MODULE_ID, "currentDay") ?? 1;
      await game.settings.set(MODULE_ID, "worldDayOffset", standalone - _worldDay());
    } else {
      // Freeze the derived day into the standalone counter.
      const offset = game.settings.get(MODULE_ID, "worldDayOffset") ?? 0;
      await game.settings.set(MODULE_ID, "currentDay", _worldDay() + offset);
    }
  }
  _fireDayAdvance();
  rerenderKctgApps();
}

/** Re-render any open KCTG suite apps (id-prefixed "kctg-") so timers update live. */
export function rerenderKctgApps() {
  for (const app of foundry.applications.instances?.values?.() ?? []) {
    if (app.id?.startsWith?.("kctg-") && app.rendered) app.render(false);
  }
}

// Drive the day-advance subscribers from Foundry's world clock when bound.
Hooks.on("updateWorldTime", () => {
  if (!isWorldClockBound()) return;
  _fireDayAdvance();
  rerenderKctgApps();
});

// Standalone mode: the day lives in a world setting, so react on every client
// when it (or the binding/offset) changes. Fired once per change on all clients,
// which keeps player-owned craft jobs completing even when the GM advances time.
// bindWorldClock is handled by its own onChange (_onBindingChanged); only the day
// values need a generic listener here.
const _DAY_KEYS = new Set([`${MODULE_ID}.currentDay`, `${MODULE_ID}.worldDayOffset`]);
Hooks.on("updateSetting", setting => {
  if (!_DAY_KEYS.has(setting.key)) return;
  _fireDayAdvance();
  rerenderKctgApps();
});
