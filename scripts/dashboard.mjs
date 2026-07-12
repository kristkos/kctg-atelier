/**
 * KCTG – Campaign Dashboard  |  FoundryVTT v14
 * Compact overview panel: Quests · Forge · Workshop · Merchants
 * Each row opens the matching module app when clicked.
 */

import { MODULE_ID, _addToKctgGroup, KCTGMixin, getCurrentDay, isWorldClockBound, getWorldDateStr, onDayAdvance, activityIcon, logActivity } from "./main.mjs";
import { TRADE_ORDER_FORCE_DEFAULTS } from "./workshop.mjs";

// ─── CAMPAIGN DATA EXPORT / IMPORT ────────────────────────────────────────────
//
// Everything the suite stores lives in module world settings, user flags, and
// actor flags (merchants + reputation). This bundles all three into one JSON
// snapshot so a bad write, a module purge, or a failed world migration can't
// silently take the campaign's workshop/forge/quest metadata with it. Quest
// CONTENT (journal pages) is normal Foundry world data and is NOT included;
// Foundry's own backups cover it.

const EXPORT_VERSION = 1;

function _moduleWorldSettingKeys() {
  const keys = [];
  for (const cfg of game.settings.settings.values()) {
    if (cfg.namespace === MODULE_ID && cfg.scope === "world") keys.push(cfg.key);
  }
  return keys;
}

function _exportCampaignData() {
  const settings = {};
  for (const key of _moduleWorldSettingKeys()) {
    try { settings[key] = game.settings.get(MODULE_ID, key); } catch (_e) { /* unreadable setting: skip */ }
  }
  const users = {};
  for (const u of game.users) {
    const flags = u.flags?.[MODULE_ID];
    if (flags && Object.keys(flags).length) users[u.id] = { name: u.name, flags: foundry.utils.deepClone(flags) };
  }
  const actors = [];
  for (const a of (game.actors?.contents ?? [])) {
    const flags = a.flags?.[MODULE_ID];
    if (flags && Object.keys(flags).length) actors.push({ actorId: a.id, name: a.name, flags: foundry.utils.deepClone(flags) });
  }
  const payload = {
    module: MODULE_ID, exportVersion: EXPORT_VERSION,
    created: new Date().toISOString(), world: game.world.id,
    settings, users, actors,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${MODULE_ID}-${game.world.id}-${payload.created.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  ui.notifications.info("Campaign data exported.");
}

async function _importCampaignData(app) {
  if (!game.user.isGM) return;
  const file = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Import Campaign Data" },
    content: `<div style="display:flex;flex-direction:column;gap:8px;">
      <p style="margin:0;font-size:.85rem;">Select a campaign data JSON exported from this module. Importing <strong>overwrites</strong> the module's current settings, user data, and merchant configurations.</p>
      <input type="file" name="file" accept=".json,application/json" />
    </div>`,
    ok: { icon: "fas fa-file-import", label: "Import", callback: (_e, btn) => btn.form.elements.file?.files?.[0] ?? null },
  }).catch(() => null);
  if (!file) return;

  let data;
  try { data = JSON.parse(await file.text()); } catch { return ui.notifications.error("Not a valid JSON file."); }
  if (data?.module !== MODULE_ID || typeof data.settings !== "object" || data.settings === null)
    return ui.notifications.error("Not a KCTG Atelier campaign export.");

  const nSettings = Object.keys(data.settings).length;
  const nUsers    = Object.keys(data.users ?? {}).length;
  const nActors   = (data.actors ?? []).length;
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Overwrite Current Data?" },
    content: `<p style="margin:0;">Import <strong>${nSettings}</strong> settings, <strong>${nUsers}</strong> user data sets and <strong>${nActors}</strong> actor configurations (exported ${data.created?.slice(0, 10) ?? "on an unknown date"}${data.world ? ` from world "${data.world}"` : ""})?<br><br><strong>This overwrites the module's current data.</strong> Consider exporting first.</p>`,
    modal: true, rejectClose: false,
  });
  if (!ok) return;

  const registered = new Set(_moduleWorldSettingKeys());
  const counts = { settings: 0, users: 0, actors: 0 };
  const skipped = [];
  // Apply the clock keys LAST, in a fixed order: writing bindWorldClock runs its
  // onChange (which recomputes worldDayOffset from whatever currentDay it sees),
  // and every currentDay/worldDayOffset write fires the day-advance subscribers
  // (auto-completions). Deferring these makes those side effects run against
  // fully imported data, and the imported day values are what survives.
  const clockKeys = ["bindWorldClock", "currentDay", "worldDayOffset"];
  const ordered = [
    ...Object.entries(data.settings).filter(([k]) => !clockKeys.includes(k)),
    ...clockKeys.filter(k => k in data.settings).map(k => [k, data.settings[k]]),
  ];
  for (const [key, value] of ordered) {
    if (!registered.has(key)) { skipped.push(key); continue; }
    try { await game.settings.set(MODULE_ID, key, value); counts.settings++; }
    catch (e) { console.warn(`KCTG | import: setting "${key}" failed:`, e); skipped.push(key); }
  }
  // Flag restores use Document#update, which MERGES into existing flags: restored
  // keys win, but keys created after the export survive (a restore, not a wipe).
  for (const [uid, u] of Object.entries(data.users ?? {})) {
    const user = game.users.get(uid) ?? game.users.find(x => x.name === u.name);
    if (!user) { skipped.push(`user:${u.name ?? uid}`); continue; }
    try { await user.update({ [`flags.${MODULE_ID}`]: u.flags }); counts.users++; }
    catch { skipped.push(`user:${u.name ?? uid}`); }
  }
  for (const m of (data.actors ?? [])) {
    const actor = game.actors.get(m.actorId) ?? game.actors.find(a => a.name === m.name);
    if (!actor) { skipped.push(`actor:${m.name ?? m.actorId}`); continue; }
    try { await actor.update({ [`flags.${MODULE_ID}`]: m.flags }); counts.actors++; }
    catch { skipped.push(`actor:${m.name ?? m.actorId}`); }
  }
  await logActivity("system", `Campaign data imported (${counts.settings} settings, ${counts.users} users, ${counts.actors} actors)`);
  ui.notifications.info(`Import complete: ${counts.settings} settings, ${counts.users} user data sets, ${counts.actors} actors.${skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""}`);
  app?.render();
}

// ─── STAT READERS ─────────────────────────────────────────────────────────────

function _questStats() {
  // Quests are pages in the module's quest journal. The page name is the quest name
  // (there is no name flag), and group pages are flagged isGroup, so match on the
  // module flag and exclude groups rather than looking for a name flag.
  let journal = game.journal?.contents.find(j => j.getFlag?.(MODULE_ID, "isQuestJournal"));
  if (!journal) {
    try { journal = game.journal?.get(game.settings.get(MODULE_ID, "journalId")); }
    catch (_e) { /* journalId setting may not be registered yet */ }
  }
  const pages = (journal?.pages?.contents ?? []).filter(p => {
    const f = p.flags?.[MODULE_ID];
    return f && !f.isGroup;
  });
  const statusOf = p => p.flags?.[MODULE_ID]?.status ?? "in-progress";
  return {
    active:    pages.filter(p => statusOf(p) === "in-progress").length,
    completed: pages.filter(p => statusOf(p) === "completed").length,
    total:     pages.length,
  };
}

function _forgeStats() {
  try {
    const recipes = game.settings.get(MODULE_ID, "recipes") ?? [];
    const locked  = recipes.filter(r => r.locked).length;
    return { total: recipes.length, locked, unlocked: recipes.length - locked };
  } catch { return { total: 0, locked: 0 }; }
}

function _workshopStats() {
  try {
    return {
      day:     getCurrentDay(),
      active:  (game.settings.get(MODULE_ID, "tasks")   ?? []).filter(t => t.status === "active").length,
      workers: (game.settings.get(MODULE_ID, "workers") ?? []).length,
    };
  } catch { return { day: 1, active: 0, workers: 0 }; }
}

function _merchantStats() {
  const all  = (game.actors?.contents ?? []).filter(a => a.getFlag?.(MODULE_ID, "merchant")?.enabled);
  return { total: all.length, open: all.filter(a => a.getFlag(MODULE_ID, "merchant")?.openForBusiness).length };
}

// ─── MESSAGE TEMPLATES APP ────────────────────────────────────────────────────

const _FORGE_DEFAULTS = [
  "Using {ingredients}, {actor} was able to craft {results}.",
  "{actor} combined {ingredients} and produced {results}.",
  "After careful work, {actor} turned {ingredients} into {results}.",
  "{actor} put {ingredients} to use and crafted {results}.",
  "With steady hands, {actor} forged {results} from {ingredients}.",
  "{actor} successfully crafted {results} using {ingredients}.",
  "The craft was a success: {actor} made {results} from {ingredients}.",
  "{actor} worked the {ingredients} and emerged with {results}.",
];
const _TASK_DEFAULTS = {
  forage: "Forage Complete: {task}|{workers} return from foraging|The {task} forage is done",
  trade:  "Trade Run Complete: {task}|{workers} return from the trade route|The {task} trade run has concluded",
  patrol: "Patrol Report: {task}|{workers} finish their patrol|The {task} patrol is complete",
  scout:  "Scout Report: {task}|{workers} return from scouting|The {task} scouting mission is done",
};

export class MessageTemplatesApp extends KCTGMixin(
  foundry.applications.api.HandlebarsApplicationMixin(
    foundry.applications.api.ApplicationV2
  )
) {
  constructor(options = {}) {
    super(options);
    this._tab = options.tab ?? "forge";
  }

  static DEFAULT_OPTIONS = {
    id: "kctg-message-templates",
    classes: ["kctg-module", "kctg-msg-templates-app"],
    window: { title: "Message Templates", resizable: true },
    position: { width: 680, height: 560 },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/dashboard/message-templates.hbs`, scrollable: [".kctg-mt-list"] }
  };

  static open(tab = "forge") {
    const existing = foundry.applications.instances?.get("kctg-message-templates");
    if (existing?.rendered) { existing._tab = tab; existing.render(); existing.bringToFront(); return existing; }
    return new MessageTemplatesApp({ tab }).render(true);
  }

  async _prepareContext() {
    const tab = this._tab;
    let templates;
    if (tab === "forge") {
      const raw = game.settings.get(MODULE_ID, "craftTemplates") ?? "";
      templates = raw.split("|").map((t, idx) => ({ idx, text: t.trim() })).filter(t => t.text);
    } else if (tab === "orders") {
      const raw = game.settings.get(MODULE_ID, "tradeOrderForceTemplates") ?? "";
      templates = raw.split("|").map((t, idx) => ({ idx, text: t.trim() })).filter(t => t.text);
    } else {
      const stored = game.settings.get(MODULE_ID, "taskTitleTemplates") ?? {};
      const raw = stored[tab] ?? _TASK_DEFAULTS[tab] ?? "";
      templates = raw.split("|").map((t, idx) => ({ idx, text: t.trim() })).filter(t => t.text);
    }
    return { tab, templates };
  }

  _onRender(context, options) {
    const el  = this.element;
    const tab = this._tab;

    el.querySelectorAll(".kctg-tab-btn[data-tab]").forEach(btn =>
      btn.addEventListener("click", () => { this._tab = btn.dataset.tab; this.render(); })
    );

    const _getList = () => {
      if (tab === "forge") {
        return (game.settings.get(MODULE_ID, "craftTemplates") ?? "").split("|").map(t => t.trim()).filter(Boolean);
      }
      if (tab === "orders") {
        return (game.settings.get(MODULE_ID, "tradeOrderForceTemplates") ?? "").split("|").map(t => t.trim()).filter(Boolean);
      }
      const stored = game.settings.get(MODULE_ID, "taskTitleTemplates") ?? {};
      return (stored[tab] ?? _TASK_DEFAULTS[tab] ?? "").split("|").map(t => t.trim()).filter(Boolean);
    };
    const _saveList = async list => {
      if (tab === "forge") {
        await game.settings.set(MODULE_ID, "craftTemplates", list.join("|"));
      } else if (tab === "orders") {
        await game.settings.set(MODULE_ID, "tradeOrderForceTemplates", list.join("|"));
      } else {
        const stored = game.settings.get(MODULE_ID, "taskTitleTemplates") ?? {};
        stored[tab] = list.join("|");
        await game.settings.set(MODULE_ID, "taskTitleTemplates", stored);
      }
    };

    el.querySelector(".kctg-mt-add")?.addEventListener("click", async () => {
      const list = _getList();
      list.push(tab === "forge"  ? "{actor} crafted {results} from {ingredients}."
              : tab === "orders" ? "{actor} completed {order} and received {payment}."
              : "Task Complete: {task}");
      await _saveList(list);
      this.render();
    });
    el.querySelectorAll(".kctg-mt-input").forEach(ta =>
      ta.addEventListener("change", async e => {
        const list = _getList();
        const idx = parseInt(ta.dataset.idx);
        if (!isNaN(idx) && idx < list.length) {
          list[idx] = e.target.value.trim();
          await _saveList(list.filter(Boolean));
        }
      })
    );
    el.querySelectorAll(".kctg-mt-delete").forEach(btn =>
      btn.addEventListener("click", async () => {
        const list = _getList();
        const idx = parseInt(btn.dataset.idx);
        if (!isNaN(idx)) { list.splice(idx, 1); await _saveList(list); this.render(); }
      })
    );
    el.querySelector(".kctg-mt-reset")?.addEventListener("click", async () => {
      if (tab === "forge") {
        await game.settings.set(MODULE_ID, "craftTemplates", _FORGE_DEFAULTS.join("|"));
      } else if (tab === "orders") {
        await game.settings.set(MODULE_ID, "tradeOrderForceTemplates", TRADE_ORDER_FORCE_DEFAULTS);
      } else {
        const stored = game.settings.get(MODULE_ID, "taskTitleTemplates") ?? {};
        stored[tab] = _TASK_DEFAULTS[tab];
        await game.settings.set(MODULE_ID, "taskTitleTemplates", stored);
      }
      this.render();
    });
  }
}

// ─── APP ──────────────────────────────────────────────────────────────────────

export class DashboardApp extends KCTGMixin(
  foundry.applications.api.HandlebarsApplicationMixin(
    foundry.applications.api.ApplicationV2
  )
) {
  static DEFAULT_OPTIONS = {
    id: "kctg-dashboard",
    classes: ["kctg-module", "kctg-dashboard-app"],
    window: { title: "Campaign Dashboard", resizable: false },
    position: { width: 420, height: "auto", top: 60, left: 200 }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/dashboard/dashboard.hbs` }
  };

  static open() {
    const existing = foundry.applications.instances?.get("kctg-dashboard");
    if (existing?.rendered) { existing.bringToFront(); return existing; }
    return new DashboardApp().render(true);
  }

  async _prepareContext() {
    const isGM = game.user.isGM;
    // Recent activity: latest entries from the shared feed (text is plain and
    // escaped by Handlebars on render).
    let activity = [];
    try {
      activity = (game.settings.get(MODULE_ID, "activityLog") ?? [])
        .slice(0, 8)
        .map(e => ({ ...e, icon: activityIcon(e.type) }));
    } catch (_e) { /* setting not registered yet */ }
    return {
      isGM,
      worldDate: isWorldClockBound() ? getWorldDateStr() : null,
      quests:    _questStats(),
      forge:     isGM ? _forgeStats()    : null,
      workshop:  isGM ? _workshopStats() : null,
      merchants: _merchantStats(),
      activity,
    };
  }

  _onRender(_context, _options) {
    const el = this.element;
    el.querySelector(".kctg-dash-refresh")?.addEventListener("click", () => this.render());
    el.querySelector(".kctg-dash-quests")?.addEventListener("click",    () => Hooks.callAll("kctg:openQuests"));
    el.querySelector(".kctg-dash-merchants")?.addEventListener("click", () => Hooks.callAll("kctg:openMerchants"));
    el.querySelector(".kctg-dash-workshop")?.addEventListener("click",  () => Hooks.callAll("kctg:openWorkshop"));
    el.querySelector(".kctg-dash-forge")?.addEventListener("click",     () => Hooks.callAll("kctg:openForge"));
    el.querySelector(".kctg-dash-messages")?.addEventListener("click",  () => MessageTemplatesApp.open());
    // Campaign data snapshot (GM)
    el.querySelector(".kctg-dash-export")?.addEventListener("click", () => _exportCampaignData());
    el.querySelector(".kctg-dash-import")?.addEventListener("click", () => _importCampaignData(this));
    // Activity feed clear (GM)
    el.querySelector(".kctg-dash-activity-clear")?.addEventListener("click", async () => {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Clear Activity Feed" },
        content: `<p style="margin:0;">Remove all entries from the recent activity feed?</p>`,
        modal: true, rejectClose: false,
      });
      if (!ok) return;
      await game.settings.set(MODULE_ID, "activityLog", []);
      this.render();
    });
  }
}

// Programmatic open (parity with the other suite apps)
Hooks.on("kctg:openDashboard", () => DashboardApp.open());

// ─── LIVE REFRESH ─────────────────────────────────────────────────────────────
// The dashboard's stats are derived from settings (recipes / tasks / workers),
// journal pages (quests) and actor flags (merchants). Re-render the open panel
// whenever any of those change, so the numbers stay current without the manual
// Refresh button. Debounced so a burst of writes triggers a single render.
let _dashRefreshTimer = null;
function _scheduleDashRefresh() {
  const app = foundry.applications.instances?.get("kctg-dashboard");
  if (!app?.rendered) return;
  clearTimeout(_dashRefreshTimer);
  _dashRefreshTimer = setTimeout(() => {
    const a = foundry.applications.instances?.get("kctg-dashboard");
    if (a?.rendered) a.render();
  }, 150);
}

Hooks.on("updateSetting", s => { if (s.key?.startsWith(MODULE_ID + ".")) _scheduleDashRefresh(); });
Hooks.on("updateActor",            () => _scheduleDashRefresh());  // merchant flags + reputation
Hooks.on("createJournalEntryPage", () => _scheduleDashRefresh());  // quests added
Hooks.on("updateJournalEntryPage", () => _scheduleDashRefresh());  // quest status changes
Hooks.on("deleteJournalEntryPage", () => _scheduleDashRefresh());  // quests removed
onDayAdvance(_scheduleDashRefresh);                                // workshop day / world date

// ─── SCENE CONTROL ────────────────────────────────────────────────────────────
Hooks.on("getSceneControlButtons", controls => {
  _addToKctgGroup(controls, {
    name:     "kctg-dashboard-open",
    title:    "Campaign Dashboard",
    icon:     "fas fa-tachometer-alt",
    button:   true,
    onChange: () => {
      const ex = foundry.applications.instances?.get("kctg-dashboard");
      if (ex?.rendered) ex.close(); else DashboardApp.open();
    },
  });
});
