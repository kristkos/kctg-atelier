/**
 * KCTG - Forge  |  FoundryVTT v14
 * Drag-and-drop recipe crafting system.
 */

import { MODULE_ID, applyTheme as _applyTheme, _addToKctgGroup, newId, safeFromUuid, getItemQty, addItemToActor, fallbackItemType, esc,
  getCurrentDay, onDayAdvance, logActivity } from "./main.mjs";

// ─── STATUS VOCABULARY ────────────────────────────────────────────────────────
// Centralised so craft-job / approval states aren't bare string literals scattered
// across the file (a typo'd "inprogess" would silently never match). The string
// VALUES are the persisted form and must not change without a data migration.
// NOTE: these intentionally differ in spelling from the Workshop task statuses
// ("active"/"complete") and Quest statuses ("in-progress"/"completed"); each domain
// owns its own enum and they are never compared directly.
export const CRAFT_JOB_STATUS = { IN_PROGRESS: "inprogress", READY: "ready", FAILED: "failed" };
export const CRAFT_APPROVAL_STATUS = { PENDING: "pending" };

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "recipes",  { name: "Recipes",        scope: "world", config: false, type: Array,  default: [] });
  game.settings.register(MODULE_ID, "folders",  { name: "Folders",        scope: "world", config: false, type: Array,  default: [] });
  game.settings.register(MODULE_ID, "craftingLog", { name: "Crafting Log",scope: "world", config: false, type: Array,  default: [] });
  game.settings.register(MODULE_ID, "craftApprovals", { name: "Pending Approvals", scope: "world", config: false, type: Array, default: [] });
  game.settings.register(MODULE_ID, "craftApproved",  { name: "Approved Recipes",  scope: "world", config: false, type: Array, default: [] });
  game.settings.register(MODULE_ID, "craftApprovedOnce", { name: "One-Time Approved Crafts", scope: "world", config: false, type: Array, default: [] });
  game.settings.register(MODULE_ID, "craftNpcActors", { name: "Craft NPC List",    scope: "world", config: false, type: Array, default: [] });

  game.settings.register(MODULE_ID, "requireApproval", {
    name: "Require GM Approval for Player Crafting",
    hint: "When enabled, a player's first craft of any recipe (or after it changes) requires GM sign-off before proceeding.",
    scope: "world", config: true, type: Boolean, default: false, restricted: true,
  });

  game.settings.register(MODULE_ID, "playerCraftingRole", {
    name: "Player Recipe Creation",
    hint: "Minimum role required for players to create and manage their own personal recipes.",
    scope: "world", config: true, type: Number, default: 0,
    choices: { 0:"Disabled — GM only", 1:"Player and above", 2:"Trusted Player and above", 3:"Assistant GM and above" },
    restricted: true,
  });

  game.settings.register(MODULE_ID, "craftTemplates", {
    name: "Craft Message Templates",
    hint: "Separate each template with | to add more. Placeholders: {actor}, {recipe}, {ingredients}, {results}.",
    scope: "world", config: false, type: String,
    default: [
      "Using {ingredients}, {actor} was able to craft {results}.",
      "{actor} combined {ingredients} and produced {results}.",
      "After careful work, {actor} turned {ingredients} into {results}.",
      "{actor} put {ingredients} to use and crafted {results}.",
      "With steady hands, {actor} forged {results} from {ingredients}.",
      "{actor} successfully crafted {results} using {ingredients}.",
      "The craft was a success: {actor} made {results} from {ingredients}.",
      "{actor} worked the {ingredients} and emerged with {results}.",
    ].join("|")
  });

});

// ─── STORAGE HELPERS ──────────────────────────────────────────────────────────

const getRecipes   = ()  => game.settings.get(MODULE_ID, "recipes")  ?? [];
const saveRecipes  = (r) => game.settings.set(MODULE_ID, "recipes",  r);
const getFolders   = ()  => game.settings.get(MODULE_ID, "folders")  ?? [];
const saveFolders  = (f) => game.settings.set(MODULE_ID, "folders",  f);
const getCraftLog  = ()  => game.settings.get(MODULE_ID, "craftingLog") ?? [];
const saveCraftLog = (l) => game.settings.set(MODULE_ID, "craftingLog", l);

// ── Approval storage ──────────────────────────────────────────────────────────
// craftApprovals world setting retained for GM-side status tracking only
const getCraftApprovals  = ()  => game.settings.get(MODULE_ID, "craftApprovals") ?? [];
const saveCraftApprovals = (a) => game.settings.set(MODULE_ID, "craftApprovals", a);
const getCraftApproved   = ()  => game.settings.get(MODULE_ID, "craftApproved")  ?? [];
const saveCraftApproved  = (a) => game.settings.set(MODULE_ID, "craftApproved",  a);
const getCraftNpcs       = ()  => game.settings.get(MODULE_ID, "craftNpcActors") ?? [];
const saveCraftNpcs      = (a) => game.settings.set(MODULE_ID, "craftNpcActors", a);

// Crafter roster (GM-side writes only). The craftNpcActors setting holds every
// actor the GM wants on the Character list: NPCs or PCs dropped on the drop
// zone, plus any actor that actually completes a craft (added here from the
// craft-log paths). The GM prunes entries in the Manage Crafters dialog.
async function _rosterAddActors(ids) {
  const saved = getCraftNpcs();
  const add   = [...new Set(ids)].filter(id => id && !saved.includes(id) && game.actors.get(id));
  if (add.length) await saveCraftNpcs([...saved, ...add]);
}

// Pending requests live in each player's own user flag — writable without GM permission
const getPendingCrafts  = (user = game.user) => user.getFlag(MODULE_ID, "pendingCrafts") ?? [];
const savePendingCrafts = (reqs, user = game.user) => user.setFlag(MODULE_ID, "pendingCrafts", reqs);

// One-time approvals granted by the GM without "remember". SECURITY: these live in a
// GM-only WORLD setting (not the player's user flag) so a player can read but not write
// them — otherwise the "requires GM approval" gate is self-bypassable by editing one's
// own flag. Format: [{ userId, recipeId, hash }]. Granting (GM) writes the setting;
// consumption (player craft) is delegated to the GM over the socket.
const getCraftApprovedOnce  = ()  => game.settings.get(MODULE_ID, "craftApprovedOnce") ?? [];
const saveCraftApprovedOnce = (a) => game.settings.set(MODULE_ID, "craftApprovedOnce", a);
/** True if the given user currently holds a one-time approval for recipe+hash. */
function hasOneTimeApproval(userId, recipeId, hash) {
  return getCraftApprovedOnce().some(a => a.userId === userId && a.recipeId === recipeId && a.hash === hash);
}
/** Consume a one-time approval. Players can't write world settings, so they delegate
 *  the removal to the responsible GM; the GM removes it directly. */
async function consumeOneTimeApproval(userId, recipeId, hash) {
  if (game.user.isGM) {
    await saveCraftApprovedOnce(getCraftApprovedOnce().filter(a => !(a.userId === userId && a.recipeId === recipeId && a.hash === hash)));
  } else {
    game.socket.emit(`module.${MODULE_ID}`, { type: "consumeOneTimeApproval", userId, recipeId, hash });
  }
}

// ── Timed-craft queue ───────────────────────────────────────────────────────
// In-progress and ready-to-collect crafts live on the crafter's own user flag
// (permission-correct: the player owns their actor and consumes/receives items).
// Each client processes ONLY its own jobs on day-advance. Stored per job:
//   { id, recipeId, recipeName, recipeSnapshot, source, actorId, actorName,
//     qty, mode, startDay, craftDays, status: "inprogress"|"ready"|"failed" }
const getCraftJobs  = (user = game.user) => user.getFlag(MODULE_ID, "craftJobs") ?? [];
const saveCraftJobs = (jobs, user = game.user) => user.setFlag(MODULE_ID, "craftJobs", jobs);

/** Total days a craft takes: flat per-recipe, or per-item × quantity. 0 = instant. */
function craftTotalDays(recipe, qty) {
  const per = Math.max(0, parseInt(recipe?.craftDays) || 0);
  if (!per) return 0;
  return recipe.craftTimeFlat ? per : per * Math.max(1, qty);
}

// Guard so a single day-advance can't process the same queue twice concurrently.
let _craftQueueBusy = false;

/**
 * Complete any of the current user's in-progress crafts whose time has elapsed.
 * Consumes ingredients NOW (consume-on-completion); on success the results are
 * held in a "ready to collect" state and announced in chat. Runs on day-advance
 * and whenever the Forge opens.
 */
async function _checkCraftQueue() {
  if (_craftQueueBusy) return;
  const jobs = getCraftJobs();
  if (!jobs.some(j => j.status === CRAFT_JOB_STATUS.IN_PROGRESS)) return;
  _craftQueueBusy = true;
  try {
    const today = getCurrentDay();
    let changed = false;
    for (const job of jobs) {
      if (job.status !== CRAFT_JOB_STATUS.IN_PROGRESS) continue;
      if (today - job.startDay < job.craftDays) continue;
      changed = true;
      const actor = game.actors?.get(job.actorId) ?? null;
      const recipe = job.recipeSnapshot ?? {};
      if (!actor) {
        job.status = CRAFT_JOB_STATUS.FAILED;
        job.failReason = "The crafting actor no longer exists.";
        await _postCraftReadyMsg(job, true);
        continue;
      }
      // Consume on completion (skip for "free" mode). Verify presence first.
      if (job.mode !== "free") {
        const missing = (recipe.ingredients ?? []).find(ing => {
          if (ing.consume === false) return false;
          const item = actor.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name);
          return !item || getItemQty(item) < ing.qty * job.qty;
        });
        if (missing) {
          job.status = CRAFT_JOB_STATUS.FAILED;
          job.failReason = `Missing ingredient on completion: ${missing.name}.`;
          await _postCraftReadyMsg(job, true);
          continue;
        }
        for (const ing of (recipe.ingredients ?? [])) {
          if (ing.consume === false) continue; // require-only ingredient — never consumed
          const item = actor.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name);
          if (!item) continue;
          const needed = ing.qty * job.qty;
          const have   = getItemQty(item);
          if (have <= needed) await item.delete();
          else await item.update({ "system.quantity": have - needed });
        }
      }
      job.status = CRAFT_JOB_STATUS.READY;
      await _postCraftReadyMsg(job, false);
    }
    if (changed) await saveCraftJobs(jobs);
  } finally {
    _craftQueueBusy = false;
  }
}

/** Collect a ready job's results onto the actor, log the craft, and remove the job. */
async function _collectCraftJob(jobId) {
  const jobs = getCraftJobs();
  const job  = jobs.find(j => j.id === jobId);
  if (!job) return;
  if (job.status === CRAFT_JOB_STATUS.FAILED) {
    // Nothing to collect — just dismiss it.
    await saveCraftJobs(jobs.filter(j => j.id !== jobId));
    return;
  }
  if (job.status !== CRAFT_JOB_STATUS.READY) return;
  const actor = game.actors?.get(job.actorId) ?? null;
  if (!actor) { ui.notifications.warn("The crafting actor no longer exists."); return; }
  const recipe = job.recipeSnapshot ?? {};
  for (const res of (recipe.results ?? [])) {
    const total = res.qty * job.qty;
    const src   = await safeFromUuid(res.uuid) ?? game.items.find(i => i.name === res.name) ?? null;
    if (src) {
      const craftedItem = await addItemToActor(actor, src, total);
      await appendDescriptorsToItem(craftedItem, recipe);
    } else {
      const created = await actor.createEmbeddedDocuments("Item", [{
        name: res.name, img: res.img ?? "icons/svg/item-bag.svg", type: fallbackItemType(),
      }]);
      const newItem = created?.[0] ?? null;
      if (newItem) {
        if (newItem.system?.quantity !== undefined) await newItem.update({ "system.quantity": total });
        await appendDescriptorsToItem(newItem, recipe);
      }
    }
  }
  await appendCraftLogEntry({
    actorId: actor.id, actorName: actor.name,
    userId: game.user.id, userName: game.user.name,
    recipeId: job.recipeId, recipeName: job.recipeName,
    qty: job.qty, mode: job.mode,
    ingredients: (recipe.ingredients ?? []).map(i => `${i.qty * job.qty}x ${i.name}`),
    results:     (recipe.results     ?? []).map(r => `${r.qty * job.qty}x ${r.name}`),
  });
  await saveCraftJobs(jobs.filter(j => j.id !== jobId));
  await postCraftMessage(actor, { ...recipe, _personal: job.source === "personal" }, job.qty);
  await logActivity("craft", `${actor.name} collected ${job.recipeName}${job.qty > 1 ? ` ×${job.qty}` : ""}`);
}

/** Chat card when a timed craft is queued. */
async function _postCraftStartedMsg(job) {
  const days = job.craftDays;
  await ChatMessage.create({
    content: `<div style="background:#111;border:1px solid #f5b43055;border-radius:6px;padding:9px 11px;font-family:Signika,serif;color:#e8e0d0;">
      <div style="font-size:.85rem;font-weight:700;color:#f5b430;margin-bottom:4px;"><i class="fas fa-hammer" style="margin-right:5px;"></i>Crafting Started</div>
      <div style="font-size:.83rem;line-height:1.5;"><strong>${esc(job.actorName)}</strong> began crafting <strong>${esc(job.recipeName)}</strong>${job.qty > 1 ? ` ×${job.qty}` : ""}.<br>
      <em style="color:#8a6e30;">Ready in ${days} day${days !== 1 ? "s" : ""}.</em></div></div>`,
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
  });
}

/** Chat card when a timed craft finishes (ready to collect) or fails. */
async function _postCraftReadyMsg(job, failed) {
  const title = failed ? "Crafting Failed" : "Ready to Collect";
  const icon  = failed ? "fas fa-times-circle" : "fas fa-box-open";
  const color = failed ? "#c0392b" : "#f5b430";
  const body  = failed
    ? `<strong>${esc(job.recipeName)}</strong> could not be completed.<br><em style="color:#c0392b;">${esc(job.failReason ?? "Crafting failed.")}</em>`
    : `<strong>${esc(job.recipeName)}</strong>${job.qty > 1 ? ` ×${job.qty}` : ""} is finished and waiting at the Forge for <strong>${esc(job.actorName)}</strong> to collect.`;
  await ChatMessage.create({
    content: `<div style="background:#111;border:1px solid ${color}55;border-radius:6px;padding:9px 11px;font-family:Signika,serif;color:#e8e0d0;">
      <div style="font-size:.85rem;font-weight:700;color:${color};margin-bottom:4px;"><i class="${icon}" style="margin-right:5px;"></i>${title}</div>
      <div style="font-size:.83rem;line-height:1.5;">${body}</div></div>`,
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
  });
}

// Drive craft completion off the shared clock + on Forge open.
onDayAdvance(() => _checkCraftQueue());

// GM collects pending requests from ALL non-GM user flags (works even if GM was offline at submission)
function getAllPendingCrafts() {
  return game.users
    .filter(u => !u.isGM)
    .flatMap(u => (u.getFlag(MODULE_ID, "pendingCrafts") ?? []).map(r => ({ ...r, _userId: u.id })));
}

function _recipeHash(recipe) {
  const sig = JSON.stringify({
    ingredients: (recipe.ingredients ?? []).map(i => ({ uuid: i.uuid, name: i.name, qty: i.qty, consume: i.consume ?? true })).sort((a,b) => a.name.localeCompare(b.name)),
    results:     (recipe.results     ?? []).map(r => ({ uuid: r.uuid, name: r.name, qty: r.qty })).sort((a,b) => a.name.localeCompare(b.name)),
    prerequisites: (recipe.prerequisites ?? []).map(p => p.name).sort(),
  });
  // Simple djb2-style hash — no crypto needed, just change detection
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h) ^ sig.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// Dangerous item types: if an ingredient is one of these, GM gets a stern warning
const DANGEROUS_TYPES = new Set(["spell", "feat", "feature", "class", "subclass", "background", "ancestry", "heritage", "action", "reaction", "passive"]);

function _dangerousIngredients(recipe) {
  return (recipe.ingredients ?? []).filter(ing => {
    const item = game.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name)
               ?? canvas?.tokens?.placeables?.map(t => t.actor?.items?.find(i => i.name === ing.name)).find(Boolean);
    return item && DANGEROUS_TYPES.has(item.type);
  });
}

const getPersonalRecipes  = (user = game.user) => user.getFlag(MODULE_ID, "recipes") ?? [];
const savePersonalRecipes = (r, user = game.user) => user.setFlag(MODULE_ID, "recipes", r);
const getPersonalFolders  = (user = game.user) => user.getFlag(MODULE_ID, "folders") ?? [];
const savePersonalFolders = (f, user = game.user) => user.setFlag(MODULE_ID, "folders", f);

async function appendCraftLogEntry(entry) {
  const fullEntry = { id: newId(), ts: Date.now(), ...entry };
  if (game.user.isGM) {
    const log = getCraftLog();
    log.push(fullEntry);
    if (log.length > 200) log.splice(0, log.length - 200);
    await saveCraftLog(log);
    await _rosterAddActors([fullEntry.actorId]);
  } else {
    const hasActiveGM = game.users.some(u => u.isGM && u.active);
    if (hasActiveGM) {
      // GM is online — delegate immediately via socket
      game.socket.emit(`module.${MODULE_ID}`, { type: "craftLogEntry", entry: fullEntry });
    } else {
      // No GM online — buffer in player's own flag; GM drains on next login
      const pending = game.user.getFlag(MODULE_ID, "pendingLogEntries") ?? [];
      pending.push(fullEntry);
      await game.user.setFlag(MODULE_ID, "pendingLogEntries", pending);
    }
  }
}

function canCreatePersonalRecipes() {
  const minRole = game.settings.get(MODULE_ID, "playerCraftingRole") ?? 0;
  return minRole > 0 && game.user.role >= minRole;
}

function getPlayerRecipeEntries() {
  return game.users
    .filter(u => !u.isGM)
    .map(u => ({
      user:    { id: u.id, name: u.name, avatar: u.avatar ?? "icons/svg/mystery-man.svg", active: u.active },
      recipes: getPersonalRecipes(u),
      folders: getPersonalFolders(u),
    }))
    .filter(e => e.recipes.length > 0);
}


function visibleDescriptors(ing) {
  const out = [];
  if (ing.desc1?.label?.trim()) out.push({ label: ing.desc1.label.trim(), value: ing.desc1.value ?? "", type: "primary" });
  if (ing.desc2?.label?.trim()) out.push({ label: ing.desc2.label.trim(), value: ing.desc2.value ?? "", type: "secondary" });
  return out;
}

function aggregateDescriptors(ingredients) {
  const primary = [], secondary = [];
  for (const ing of ingredients) {
    for (const d of visibleDescriptors(ing)) {
      (d.type === "primary" ? primary : secondary).push({ label: d.label, value: d.value });
    }
  }
  return { primary, secondary };
}

function _recipeOwnershipDot(recipe, actor) {
  if (!actor) return "";
  const ings = recipe.ingredients ?? [];
  if (!ings.length) return "";
  let have = 0;
  for (const ing of ings) {
    const item = actor.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name);
    if (item && getItemQty(item) >= ing.qty) have++;
  }
  if (have === 0)        return "red";
  if (have === ings.length) return "green";
  return "yellow";
}

function _buildGroupedRecipes(recipes, folders, collapsedSet = new Set(), actor = null) {
  const groups = [];
  const annotate = r => ({ ...r, _dot: _recipeOwnershipDot(r, actor) });
  for (const folder of folders) {
    groups.push({ folder, collapsed: collapsedSet.has(folder.id), recipes: recipes.filter(r => r.folderId === folder.id).map(annotate) });
  }
  const uncategorized = recipes.filter(r => !r.folderId || !folders.find(f => f.id === r.folderId)).map(annotate);
  if (uncategorized.length || !folders.length) groups.push({ folder: null, collapsed: false, recipes: uncategorized });
  return groups;
}

// ─── QUEST-STYLE RECIPE LIST (shared by CraftApp + RecipeManagerApp) ─────────
// Folder rows reuse the quest journal's group-row look and behaviour: collapse,
// right-click edit (color / rename / delete) and drag-and-drop of recipes into
// folders plus folder reordering. A `store` bundles the read/write accessors so
// the same wiring serves world settings and personal user flags alike.

/** Flatten grouped recipes into template list items (folder rows + recipe rows). */
function _buildRecipeListItems(recipes, folders, collapsedSet, actor = null) {
  const items = [];
  for (const g of _buildGroupedRecipes(recipes, folders, collapsedSet, actor)) {
    if (g.folder) {
      items.push({ isFolder: true, id: g.folder.id, name: g.folder.name, color: g.folder.color ?? null, collapsed: g.collapsed, count: g.recipes.length });
      if (!g.collapsed) for (const r of g.recipes) items.push({ isFolder: false, inFolder: true, ...r });
    } else {
      for (const r of g.recipes) items.push({ isFolder: false, inFolder: false, ...r });
    }
  }
  return items;
}

/** Flatten grouped recipes into the chart sidebar's checkbox list — same
 *  folder-row look as the world/personal list, plus per-folder checkboxes.
 *  Filtering hides non-matching recipes and folders with no matches. */
function _buildChartListItems(recipes, folders, selectedIds, filter, collapsedSet) {
  const f = (filter ?? "").toLowerCase();
  const match = r => !f || r.name.toLowerCase().includes(f);
  const items = [];
  const pushRecipes = (rs, folderId, inFolder) => {
    for (const r of rs) items.push({ isFolder: false, inFolder, id: r.id, name: r.name, folderId, checked: selectedIds.has(r.id) });
  };
  for (const g of _buildGroupedRecipes(recipes, folders, collapsedSet)) {
    const visible = g.recipes.filter(match);
    if (g.folder) {
      if (f && !visible.length) continue;
      const selCount = visible.filter(r => selectedIds.has(r.id)).length;
      items.push({
        isFolder: true, id: g.folder.id, name: g.folder.name, color: g.folder.color ?? null,
        collapsed: g.collapsed, count: visible.length, selCount,
        allChecked:  visible.length > 0 && selCount === visible.length,
        someChecked: selCount > 0 && selCount < visible.length,
      });
      if (!g.collapsed) pushRecipes(visible, g.folder.id, true);
    } else {
      pushRecipes(visible, "", false);
    }
  }
  return items;
}

/** Generic quest-style context menu. `entries` = {icon,label,danger?,cb} or "divider". */
function _showCtxMenu(e, entries) {
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  document.querySelector(".kctg-ctx-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "kctg-ctx-menu";
  const x = Math.min(e.clientX, window.innerWidth  - 165);
  const y = Math.min(e.clientY, window.innerHeight - 130);
  // Set position explicitly inline so Foundry's app transforms can't affect it.
  menu.style.position = "fixed";
  menu.style.left = x + "px";
  menu.style.top  = y + "px";

  for (const entry of entries) {
    if (entry === "divider") {
      menu.appendChild(Object.assign(document.createElement("div"), { className: "kctg-ctx-divider" }));
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "kctg-ctx-item" + (entry.danger ? " kctg-ctx-danger" : "");
    btn.innerHTML = `<i class="${entry.icon}"></i>${entry.label}`;
    btn.addEventListener("click", () => { menu.remove(); entry.cb(); });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const close = ev => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", close); }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

/** Right-click context menu on a recipe folder row (mirrors the quest group menu). */
function _showRecipeFolderMenu(e, folderId, store, render) {
  const folder = store.getFolders().find(f => f.id === folderId); if (!folder) return;

  const entries = [];
  const _item = (icon, label, cb, danger = false) => entries.push({ icon, label, cb, danger });

  _item("fas fa-palette", "Change Color", async () => {
    const cur = folder.color || "#f5b430";
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Folder Colour" },
      content: `<div style="padding:8px 0;display:flex;align-items:center;gap:12px">
                  <label for="kctg-color-pick">Colour:</label>
                  <input id="kctg-color-pick" type="color" name="folderColor" value="${cur}"
                         style="width:52px;height:32px;cursor:pointer;border:none;padding:0;background:none"/>
                </div>`,
      buttons: [
        { label: "Apply",         action: "apply",  default: true,
          callback: (_ev, b) => b.form.querySelector("[name=folderColor]")?.value || null },
        { label: "Remove colour", action: "reset",  callback: () => "RESET" },
        { label: "Cancel",        action: "cancel", callback: () => "CANCEL" },
      ],
    }).catch(() => "CANCEL");
    if (!result || result === "CANCEL") return;
    const folders = store.getFolders();
    const f = folders.find(f => f.id === folderId); if (!f) return;
    f.color = result === "RESET" ? null : result;
    await store.saveFolders(folders); render();
  });

  _item("fas fa-pencil-alt", "Rename", async () => {
    const name = await foundry.applications.api.DialogV2.prompt({
      window:  { title: "Rename Folder" },
      content: `<label style="display:flex;flex-direction:column;gap:4px;padding:4px 0">
                  Folder name
                  <input type="text" name="folderName" value="${esc(folder.name)}" autofocus style="width:100%"/>
                </label>`,
      ok: { label: "Rename", callback: (_ev, b) => new FormData(b.form).get("folderName") },
    }).catch(() => null);
    if (!name?.trim()) return;
    const folders = store.getFolders();
    const f = folders.find(f => f.id === folderId); if (!f) return;
    f.name = name.trim(); await store.saveFolders(folders); render();
  });

  entries.push("divider");

  _item("fas fa-trash", "Delete Folder", async () => {
    const recipes = store.getRecipes();
    recipes.forEach(r => { if (r.folderId === folderId) r.folderId = null; });
    await store.saveRecipes(recipes);
    await store.saveFolders(store.getFolders().filter(f => f.id !== folderId));
    render();
  }, true);

  _showCtxMenu(e, entries);
}

/**
 * Wire a rendered recipe list: folder collapse for everyone; context menu and
 * drag-and-drop only when `canWrite`. `rowSelector` targets the recipe rows
 * (".kctg-recipe-entry" in the Craft app, ".kctg-rm-recipe-row" in the manager).
 * Optional `recipeMenu(recipeId)` returns context-menu entries for recipe rows.
 */
function _wireRecipeFolderList(el, { store, canWrite, collapsedSet, rowSelector, render, recipeMenu = null }) {
  // ── Folder collapse ────────────────────────────────────────────────────────
  el.querySelectorAll(".kctg-group-row .kctg-group-main").forEach(div =>
    div.addEventListener("click", () => {
      const id = div.closest(".kctg-group-row").dataset.folderId;
      if (collapsedSet.has(id)) collapsedSet.delete(id); else collapsedSet.add(id);
      render();
    })
  );

  if (!canWrite) return;

  // ── Folder context menu ────────────────────────────────────────────────────
  el.querySelectorAll(".kctg-group-row").forEach(row =>
    row.addEventListener("contextmenu", e => _showRecipeFolderMenu(e, row.dataset.folderId, store, render))
  );

  // ── Recipe row context menu (e.g. Duplicate / Delete in the manager) ───────
  if (recipeMenu) {
    el.querySelectorAll(rowSelector).forEach(row =>
      row.addEventListener("contextmenu", e => _showCtxMenu(e, recipeMenu(row.dataset.id)))
    );
  }

  // ── Drag-and-drop ──────────────────────────────────────────────────────────
  let drag = null;
  const _clearDI = () =>
    el.querySelectorAll(".kctg-drag-above,.kctg-drag-below,.kctg-drag-into,.kctg-dragging")
      .forEach(n => n.classList.remove("kctg-drag-above", "kctg-drag-below", "kctg-drag-into", "kctg-dragging"));

  // Move a recipe next to another recipe; it adopts the target's folder.
  const _reorderRecipe = async (dragId, targetId, before) => {
    const recipes = store.getRecipes();
    const di = recipes.findIndex(r => r.id === dragId); if (di === -1) return;
    const [moved] = recipes.splice(di, 1);
    const target = recipes.find(r => r.id === targetId); if (!target) return;
    moved.folderId = target.folderId ?? null;
    const ti = recipes.findIndex(r => r.id === targetId);
    recipes.splice(before ? ti : ti + 1, 0, moved);
    await store.saveRecipes(recipes);
    render();
  };

  const _reorderFolder = async (dragId, targetId, before) => {
    const folders = store.getFolders();
    const di = folders.findIndex(f => f.id === dragId); if (di === -1) return;
    const [moved] = folders.splice(di, 1);
    const ti = folders.findIndex(f => f.id === targetId); if (ti === -1) return;
    folders.splice(before ? ti : ti + 1, 0, moved);
    await store.saveFolders(folders);
    render();
  };

  // Recipe rows
  el.querySelectorAll(rowSelector).forEach(row => {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", e => {
      drag = { type: "recipe", id: row.dataset.id };
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("kctg-dragging");
    });
    row.addEventListener("dragend", () => { drag = null; _clearDI(); });
    row.addEventListener("dragover", e => {
      if (drag?.type !== "recipe" || drag.id === row.dataset.id) return;
      e.preventDefault(); _clearDI();
      const { top, height } = row.getBoundingClientRect();
      row.classList.add(e.clientY < top + height / 2 ? "kctg-drag-above" : "kctg-drag-below");
    });
    row.addEventListener("dragleave", () => row.classList.remove("kctg-drag-above", "kctg-drag-below"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      const d = drag; drag = null; _clearDI();
      if (d?.type !== "recipe" || d.id === row.dataset.id) return;
      const { top, height } = row.getBoundingClientRect();
      await _reorderRecipe(d.id, row.dataset.id, e.clientY < top + height / 2);
    });
  });

  // Folder rows: reorder folders, or receive a dropped recipe
  el.querySelectorAll(".kctg-group-row").forEach(row => {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", e => {
      drag = { type: "folder", id: row.dataset.folderId };
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("kctg-dragging");
    });
    row.addEventListener("dragend", () => { drag = null; _clearDI(); });
    row.addEventListener("dragover", e => {
      if (!drag) return;
      e.preventDefault(); _clearDI();
      if (drag.type === "folder") {
        if (drag.id === row.dataset.folderId) return;
        const { top, height } = row.getBoundingClientRect();
        row.classList.add(e.clientY < top + height / 2 ? "kctg-drag-above" : "kctg-drag-below");
      } else {
        row.classList.add("kctg-drag-into");
      }
    });
    row.addEventListener("dragleave", () => row.classList.remove("kctg-drag-above", "kctg-drag-below", "kctg-drag-into"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      const d = drag; drag = null; _clearDI();
      if (!d) return;
      if (d.type === "folder") {
        if (d.id === row.dataset.folderId) return;
        const { top, height } = row.getBoundingClientRect();
        await _reorderFolder(d.id, row.dataset.folderId, e.clientY < top + height / 2);
      } else {
        const recipes = store.getRecipes();
        const r = recipes.find(r => r.id === d.id); if (!r) return;
        r.folderId = row.dataset.folderId;
        collapsedSet.delete(row.dataset.folderId); // reveal where it landed
        await store.saveRecipes(recipes);
        render();
      }
    });
  });
}

// ─── RECIPE TEXT IMPORT / EXPORT ──────────────────────────────────────────────

const EXPORT_HEADER = `# KCTG Forge — Recipe Export
# ─────────────────────────────────────────────────────────────────────────────
# HOW TO EDIT:
#   • Recipe names go between === markers.
#   • 'folder:', 'desc:', 'locked:' lines are optional.
#   • Item lines: "<qty>x <Item Name>  [UUID]"
#       The UUID in [brackets] is optional — the importer searches by name.
#   • Descriptors (ingredients only): {Label1: Value1 | Label2: Value2}
#   • prerequisites: section lists non-consumed required items (tools etc.)
#   • unlockItem: <Item Name>  [UUID]  — item that auto-reveals this recipe
#   • Separate recipes with  ---  on its own line.
# ─────────────────────────────────────────────────────────────────────────────

`;

function serializeRecipesToText(recipes, folders) {
  const folderMap = Object.fromEntries(folders.map(f => [f.id, f.name]));
  const parts = [];
  for (const recipe of recipes) {
    const lines = [];
    lines.push(`=== ${recipe.name} ===`);
    if (recipe.folderId && folderMap[recipe.folderId]) lines.push(`folder: ${folderMap[recipe.folderId]}`);
    if (recipe.description?.trim()) lines.push(`desc: ${recipe.description.trim()}`);
    if (recipe.craftDays) lines.push(`craftDays: ${recipe.craftDays}${recipe.craftTimeFlat ? " flat" : ""}`);
    if (recipe.locked) lines.push(`locked: true`);
    for (const u of (recipe.unlockItems ?? (recipe.unlockItem?.name ? [recipe.unlockItem] : []))) {
      lines.push(`unlockItem: ${u.name}  [${u.uuid ?? ""}]`);
    }
    lines.push("");
    if ((recipe.prerequisites ?? []).length) {
      lines.push("prerequisites:");
      for (const pre of recipe.prerequisites) lines.push(`  1x ${pre.name}  [${pre.uuid}]`);
      lines.push("");
    }
    lines.push("ingredients:");
    for (const ing of (recipe.ingredients ?? [])) {
      const d1l = ing.desc1?.label?.trim(), d1v = ing.desc1?.value?.trim() ?? "";
      const d2l = ing.desc2?.label?.trim(), d2v = ing.desc2?.value?.trim() ?? "";
      const dp = [];
      if (d1l) dp.push(`${d1l}: ${d1v}`);
      if (d2l) dp.push(`${d2l}: ${d2v}`);
      const dSuffix = dp.length ? `  {${dp.join(" | ")}}` : "";
      lines.push(`  ${ing.qty}x ${ing.name}  [${ing.uuid}]${dSuffix}`);
    }
    lines.push("");
    lines.push("results:");
    for (const res of (recipe.results ?? [])) lines.push(`  ${res.qty}x ${res.name}  [${res.uuid}]`);
    parts.push(lines.join("\n"));
  }
  return EXPORT_HEADER + parts.join("\n\n---\n\n") + (parts.length ? "\n\n---\n" : "");
}

function parseRecipeText(text) {
  const recipes = [];
  const blocks = text.split(/^---\s*$/m)
    .map(b => b.split("\n").filter(l => !l.trim().startsWith("#")).join("\n").trim())
    .filter(b => b);
  for (const block of blocks) {
    const lines = block.split("\n");
    let name = null, folderName = null, desc = "", section = null, locked = false;
    let craftDays = 0, craftTimeFlat = false;
    const unlockItems = [], ingredients = [], results = [], prerequisites = [];
    for (const rawLine of lines) {
      const t = rawLine.trim();
      if (!t) continue;
      const nameMatch = t.match(/^===\s*(.+?)\s*===$/);
      if (nameMatch) { name = nameMatch[1]; section = null; continue; }
      const folderMatch = t.match(/^folder:\s*(.+)$/i);  if (folderMatch) { folderName = folderMatch[1].trim(); continue; }
      const descMatch   = t.match(/^desc:\s*(.+)$/i);    if (descMatch)   { desc       = descMatch[1].trim();   continue; }
      const craftMatch  = t.match(/^craftDays:\s*(\d+)\s*(flat)?\s*$/i);
      if (craftMatch) { craftDays = parseInt(craftMatch[1]) || 0; craftTimeFlat = !!craftMatch[2]; continue; }
      const lockedMatch = t.match(/^locked:\s*true$/i);  if (lockedMatch) { locked = true; continue; }
      const unlockMatch = t.match(/^unlockItem:\s*(.+?)(?:\s+\[([^\]]*)\])?\s*$/i);
      if (unlockMatch) { unlockItems.push({ name: unlockMatch[1].trim(), uuid: unlockMatch[2]?.trim() ?? "" }); continue; }
      if (/^prerequisites:\s*$/i.test(t)) { section = "prerequisites"; continue; }
      if (/^ingredients:\s*$/i.test(t))   { section = "ingredients";   continue; }
      if (/^results:\s*$/i.test(t))       { section = "results";       continue; }
      if (section) {
        const m = t.match(/^(\d+)x\s+(.+?)(?:\s+\[([^\]]*)\])?(?:\s+\{([^}]*)\})?\s*$/i);
        if (m) {
          const qty = Math.max(1, parseInt(m[1]) || 1), iName = m[2].trim(), uuid = m[3]?.trim() ?? "", dStr = m[4]?.trim() ?? "";
          if (section === "prerequisites") {
            prerequisites.push({ name: iName, uuid, img: "icons/svg/item-bag.svg" });
          } else if (section === "ingredients") {
            const ing = { qty, name: iName, uuid, img: "icons/svg/item-bag.svg", desc1: { label: "", value: "" }, desc2: { label: "", value: "" } };
            if (dStr) {
              const dp = dStr.split("|").map(p => p.trim());
              const kv = s => { const i = s.indexOf(":"); return i === -1 ? { label: s.trim(), value: "" } : { label: s.slice(0, i).trim(), value: s.slice(i + 1).trim() }; };
              if (dp[0]) ing.desc1 = kv(dp[0]);
              if (dp[1]) ing.desc2 = kv(dp[1]);
            }
            ingredients.push(ing);
          } else {
            results.push({ qty, name: iName, uuid, img: "icons/svg/item-bag.svg" });
          }
        }
      }
    }
    if (name) recipes.push({ id: newId(), name, description: desc, folderId: null, _importFolder: folderName, locked, craftDays, craftTimeFlat, unlockItems, prerequisites, ingredients, results });
  }
  return recipes;
}

async function searchCompendiumsByName(name) {
  const results = [];
  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    try {
      const index = await pack.getIndex({ fields: ["name", "img", "type"] });
      const hits  = index.filter(e => e.name.toLowerCase() === name.toLowerCase());
      for (const hit of hits) results.push({ uuid: `Compendium.${pack.collection}.${hit._id}`, name: hit.name, img: hit.img ?? "icons/svg/item-bag.svg", source: pack.metadata.label ?? pack.collection });
    } catch { /* skip */ }
  }
  return results;
}

// ─── RESOLVER APP ─────────────────────────────────────────────────────────────

class ResolverApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(resolutionMap, options = {}) {
    super(options);
    this._resolutionMap = resolutionMap;
    this._resolve       = null;
  }
  static DEFAULT_OPTIONS = {
    id: "kctg-forge--resolver", classes: ["kctg-module", "kctg-resolver-app"],
    window: { title: "KCTG Forge — Resolve Import Items", resizable: false },
    position: { width: 580 }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/forge/resolver.hbs` } };
  async _prepareContext() {
    const rows = [];
    for (const [name, data] of this._resolutionMap) rows.push({ name, candidates: data.candidates, notFound: data.candidates.length === 0 });
    return { rows };
  }
  _onRender(context, options) {
    this.element.querySelector(".kctg-resolver-import")?.addEventListener("click", () => {
      const result = new Map();
      for (const [name] of this._resolutionMap) {
        const sel = this.element.querySelector(`[data-item-name="${CSS.escape(name)}"]`);
        result.set(name, sel?.value ?? "");
      }
      this._resolve?.(result); this.close();
    });
    this.element.querySelector(".kctg-resolver-cancel")?.addEventListener("click", () => { this._resolve?.(null); this.close(); });
  }
  async _onClose(options) { this._resolve?.(null); await super._onClose(options); }
}

async function showResolverDialog(resolutionMap) {
  return new Promise(resolve => { const app = new ResolverApp(resolutionMap); app._resolve = resolve; app.render(true); });
}

// ─── CHAT MESSAGE ─────────────────────────────────────────────────────────────

function formatItemList(results) {
  const parts = results.map(r => r.qty > 1 ? `${r.qty}\u00d7 ${esc(r.name)}` : (/^[aeiou]/i.test(r.name) ? "an " : "a ") + esc(r.name));
  if (!parts.length) return "nothing";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

async function postCraftMessage(actor, recipe, qty = 1) {
  const raw   = game.settings.get(MODULE_ID, "craftTemplates") ?? "";
  const lines = raw.split("|").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const tpl     = lines[Math.floor(Math.random() * lines.length)];
  const ingList = formatItemList((recipe.ingredients ?? []).map(i => ({ name: i.name, qty: i.qty * qty })));
  const resList = formatItemList((recipe.results     ?? []).map(r => ({ name: r.name, qty: r.qty * qty })));
  const msg = tpl.replace(/\{actor\}/g, esc(actor?.name ?? "The crafter"))
                 .replace(/\{recipe\}/g, esc(recipe.name ?? "the item"))
                 .replace(/\{ingredients\}/g, ingList)
                 .replace(/\{results\}/g, resList);

  const resThumbs = (recipe.results     ?? []).map(r => `<img src="${esc(r.img ?? "icons/svg/item-bag.svg")}" title="${esc(r.name)}" style="width:28px;height:28px;border-radius:4px;object-fit:cover;border:1px solid #f5b43088;margin:1px;">`).join("");
  const ingThumbs = (recipe.ingredients ?? []).map(i => `<img src="${esc(i.img ?? "icons/svg/item-bag.svg")}" title="${esc(i.name)}" style="width:22px;height:22px;border-radius:3px;object-fit:cover;border:1px solid #f5b43033;margin:1px;opacity:0.6;">`).join("");
  const { primary, secondary } = aggregateDescriptors(recipe.ingredients ?? []);
  let descriptorHtml = "";
  if (primary.length || secondary.length) {
    descriptorHtml = `<div style="margin-top:8px;border-top:1px solid #f5b43022;padding-top:6px;font-size:.82rem;line-height:1.8;">`;
    for (const d of primary)   { if (d.value) descriptorHtml += `<div><span style="color:#f5b430;font-weight:bold;">${esc(d.label)}:</span> <span style="color:#f8cc60;">${esc(d.value)}</span></div>`; }
    for (const d of secondary) { if (d.value) descriptorHtml += `<div><span style="color:#d06838;font-weight:bold;">${esc(d.label)}:</span> <span style="color:#e09090;">${esc(d.value)}</span></div>`; }
    descriptorHtml += `</div>`;
  }
  const sourceBadge = recipe._personal ? `<span style="float:right;font-size:.7rem;color:#f5b43088;font-style:italic;">personal recipe</span>` : "";
  const qtyBadge    = qty > 1           ? `<span style="float:right;font-size:.7rem;color:#f5b43088;font-style:italic;margin-right:6px;">×${qty}</span>` : "";
  await ChatMessage.create({
    content: `<div style="background:#111;border:1px solid #f5b43055;border-radius:6px;padding:10px 12px;font-family:Signika,serif;color:#e8e0d0;">${sourceBadge}${qtyBadge}<div style="font-size:.9rem;line-height:1.5;margin-bottom:${resThumbs ? "8px" : "0"}"><i class="fas fa-hammer" style="color:#f5b430;margin-right:5px;"></i>${msg}</div>${resThumbs ? `<div style="display:flex;flex-wrap:wrap;gap:2px;align-items:center;">${resThumbs}${ingThumbs ? `<span style="color:#f5b43055;margin:0 4px;font-size:.8rem;">\u2190 from</span>${ingThumbs}` : ""}</div>` : ""}${descriptorHtml}</div>`,
    speaker: ChatMessage.getSpeaker({ actor }),
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
  });
}


async function appendDescriptorsToItem(item, recipe) {
  if (!item) return;
  const { primary, secondary } = aggregateDescriptors(recipe.ingredients ?? []);
  const allDescs = [...primary, ...secondary].filter(d => d.value);
  if (!allDescs.length) return;
  try {
    const htmlPath  = "system.description.value";
    const plainPath = "system.description";
    const hasHtml   = foundry.utils.getProperty(item, htmlPath)  !== undefined;
    const hasPlain  = typeof foundry.utils.getProperty(item, plainPath) === "string";
    if (hasHtml) {
      const existing = foundry.utils.getProperty(item, htmlPath) ?? "";
      const appended = primary.filter(d => d.value).map(d => `<p><strong style="color:#f5b430">${d.label}:</strong> ${d.value}</p>`).join("")
                     + secondary.filter(d => d.value).map(d => `<p><strong style="color:#d06838">${d.label}:</strong> ${d.value}</p>`).join("");
      if (appended) await item.update({ [htmlPath]: existing + "<hr>" + appended });
    } else if (hasPlain) {
      const existing = foundry.utils.getProperty(item, plainPath) ?? "";
      await item.update({ [plainPath]: existing + "\n\n" + allDescs.map(d => `${d.label}: ${d.value}`).join("\n") });
    }
  } catch (err) { console.warn(`KCTG Forge | Could not append descriptors:`, err); }
}

// ─── CRAFT APP ────────────────────────────────────────────────────────────────

class CraftApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(actor, options = {}) {
    super(options);
    this.actor              = actor ?? null;
    this._selectedId        = null;
    this._crafting          = false;
    this._craftQty          = 1;
    this._pendingApprovalId = null; // set while waiting for GM decision
    this._listTab           = "world"; // "world" | "personal"
    this._collapsedFolders  = new Set();
  }

  static DEFAULT_OPTIONS = {
    id: "kctg-forge--craft", classes: ["kctg-module", "kctg-craft-app"],
    window: { title: "Crafting", resizable: true },
    position: { width: 560, height: 700 }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/forge/craft-app.hbs`, scrollable: [".kctg-recipe-list", ".kctg-recipe-detail"] } };

  // Singleton: the fixed id means only one CraftApp can exist; reuse it instead of
  // creating a second instance that would fight over the same DOM id.
  static open(actor = null) {
    const existing = foundry.applications.instances?.get("kctg-forge--craft");
    if (existing?.rendered) {
      if (actor) { existing.actor = actor; existing._selectedId = null; existing._craftQty = 1; existing.render(); }
      existing.bringToFront();
      return existing;
    }
    return new CraftApp(actor).render(true);
  }

  _findRecipe(id) {
    const world = getRecipes().find(r => r.id === id);
    if (world) return { recipe: world, source: "world" };
    const personal = getPersonalRecipes().find(r => r.id === id);
    if (personal) return { recipe: personal, source: "personal" };
    return null;
  }

  // Determine if a recipe is visible to the current player given their actor
  _isRecipeVisible(recipe) {
    if (game.user.isGM) return true;
    if (!recipe.locked) return true;
    if (!this.actor) return false;

    // Quest-based unlock: recipe requires one or more completed quests
    const requiredQuests = recipe.requiredQuestIds ?? [];
    if (requiredQuests.length > 0) {
      const completedQuestIds = new Set(
        game.journal.contents.flatMap(j =>
          j.pages.contents
            .filter(p => p.getFlag(MODULE_ID, "status") === "completed")
            .map(p => p.id)
        )
      );
      const allSatisfied = requiredQuests.every(id => completedQuestIds.has(id));
      if (!allSatisfied) return false;
    }

    // Item-based unlock
    const items = recipe.unlockItems ?? (recipe.unlockItem?.name ? [recipe.unlockItem] : []);
    if (!items.length) return requiredQuests.length > 0; // quest-only unlock
    const mode = recipe.unlockMode ?? "any";
    const check = u => !!this.actor.items.find(i => (u.uuid && i.uuid === u.uuid) || i.name === u.name);
    return mode === "all" ? items.every(check) : items.some(check);
  }

  async _prepareContext() {
    const allWorldRecipes    = getRecipes();
    const worldFolders       = getFolders();
    const allPersonalRecipes = canCreatePersonalRecipes() ? getPersonalRecipes() : [];
    const personalFolders    = canCreatePersonalRecipes() ? getPersonalFolders() : [];

    // Filter locked recipes for players
    const worldRecipes    = allWorldRecipes.filter(r => this._isRecipeVisible(r));
    const personalRecipes = allPersonalRecipes.filter(r => this._isRecipeVisible(r));

    const found          = this._selectedId ? this._findRecipe(this._selectedId) : null;
    const selected       = found?.recipe ?? null;
    const selectedSource = found?.source ?? null;

    let canCraft = false, enrichedIngredients = [], enrichedResults = [], enrichedPrereqs = [];
    let aggregated = { primary: [], secondary: [] };
    let prereqsMet = true;

    if (selected) {
      [enrichedPrereqs, enrichedIngredients, enrichedResults] = await Promise.all([
        Promise.all((selected.prerequisites ?? []).map(async pre => {
          const item = await safeFromUuid(pre.uuid);
          const has  = !!this.actor?.items.find(i => (pre.uuid && i.uuid === pre.uuid) || i.name === pre.name);
          return { ...pre, resolvedName: item?.name ?? pre.name ?? "Unknown Item", img: item?.img ?? pre.img ?? "icons/svg/item-bag.svg", has };
        })),
        Promise.all((selected.ingredients ?? []).map(async ing => {
          const item     = await safeFromUuid(ing.uuid);
          const needed   = ing.qty * this._craftQty;
          const ownedQty = this._actorQty(ing.uuid, ing.name);
          const has      = ownedQty >= needed;
          return { ...ing, resolvedName: item?.name ?? ing.name ?? "Unknown Item", img: item?.img ?? ing.img ?? "icons/svg/item-bag.svg", has, needed, missingQty: Math.max(0, needed - ownedQty), visibleDescs: visibleDescriptors(ing) };
        })),
        Promise.all((selected.results ?? []).map(async res => {
          const item = await safeFromUuid(res.uuid);
          return { ...res, resolvedName: item?.name ?? res.name ?? "Unknown Item", img: item?.img ?? res.img ?? "icons/svg/item-bag.svg", total: res.qty * this._craftQty };
        })),
      ]);
      prereqsMet = enrichedPrereqs.every(p => p.has);
      canCraft   = !!this.actor && prereqsMet && enrichedIngredients.every(i => i.has);
      aggregated = aggregateDescriptors(selected.ingredients ?? []);
    }

    // Quest-style list for the active tab. GMs see locked recipes with a marker.
    const canPersonal = canCreatePersonalRecipes();
    if (this._listTab === "personal" && !canPersonal) this._listTab = "world";
    let listItems = this._listTab === "personal"
      ? _buildRecipeListItems(game.user.isGM ? allPersonalRecipes : personalRecipes, personalFolders, this._collapsedFolders, this.actor)
      : _buildRecipeListItems(game.user.isGM ? allWorldRecipes : worldRecipes, worldFolders, this._collapsedFolders, this.actor);
    // Players shouldn't see world folders whose recipes are all hidden from them
    if (!game.user.isGM && this._listTab === "world") {
      listItems = listItems.filter(i => !i.isFolder || i.count > 0);
    }

    // ── Approval state ────────────────────────────────────────────────────────
    let approvalState = "none"; // "none" | "needed" | "pending" | "approved"
    const needsApproval = !game.user.isGM && game.settings.get(MODULE_ID, "requireApproval") && selected;
    if (needsApproval) {
      const hash            = _recipeHash(selected);
      const isPermApproved  = getCraftApproved().some(a => a.userId === game.user.id && a.recipeId === selected.id && a.hash === hash);
      const isOneTimeApproved = hasOneTimeApproval(game.user.id, selected.id, hash);
      const isApproved      = isPermApproved || isOneTimeApproved;
      const isPending       = !!this._pendingApprovalId && getPendingCrafts().some(a => a.id === this._pendingApprovalId && a.status === CRAFT_APPROVAL_STATUS.PENDING);
      if      (isApproved) approvalState = "approved";
      else if (isPending)  approvalState = "pending";
      else                 approvalState = "needed";
    }

    // Actor choices. Players see the actors they own. GMs see only actors with
    // crafting activity (pending requests, queued jobs) plus the saved roster,
    // so big campaigns don't flood the list with every player-owned actor.
    const byName = (a, b) => a.name.localeCompare(b.name);
    let ownActors = [], activeActors = [], rosterActors = [];
    if (game.user.isGM) {
      const activeIds = new Set();
      for (const u of game.users) {
        for (const r of getPendingCrafts(u)) if (r.status === CRAFT_APPROVAL_STATUS.PENDING && r.actorId) activeIds.add(r.actorId);
        for (const j of getCraftJobs(u)) if (j.actorId) activeIds.add(j.actorId);
      }
      rosterActors = getCraftNpcs().map(id => game.actors.get(id))
        .filter(a => a && a.type !== "group").sort(byName);
      activeActors = [...activeIds].map(id => game.actors.get(id))
        .filter(a => a && a.type !== "group" && !rosterActors.some(r => r.id === a.id)).sort(byName);
    } else {
      ownActors = (game.actors?.filter(a =>
        a.type !== "group" && a.testUserPermission(game.user, "OWNER")) ?? []).sort(byName);
    }
    // Keep the current selection selectable even after it leaves the lists
    const selectedOrphan = this.actor
      && ![...ownActors, ...activeActors, ...rosterActors].some(a => a.id === this.actor.id)
      ? this.actor : null;

    // ── Timed-craft queue (this user's jobs) ──────────────────────────────────
    const today = getCurrentDay();
    const craftJobs = getCraftJobs().map(j => {
      const elapsed  = Math.max(0, today - j.startDay);
      const daysLeft = Math.max(0, j.craftDays - elapsed);
      return {
        ...j,
        elapsed, daysLeft,
        progressPct: j.craftDays > 0 ? Math.min(100, Math.round((elapsed / j.craftDays) * 100)) : 100,
        isInProgress: j.status === CRAFT_JOB_STATUS.IN_PROGRESS,
        isReady:      j.status === CRAFT_JOB_STATUS.READY,
        isFailed:     j.status === CRAFT_JOB_STATUS.FAILED,
      };
    });
    const inProgressJobs = craftJobs.filter(j => j.isInProgress);
    const collectJobs    = craftJobs.filter(j => j.isReady || j.isFailed);

    // Crafting time for the current selection / quantity
    const selectedCraftDays = selected ? craftTotalDays(selected, this._craftQty) : 0;

    return {
      actor: this.actor, ownActors, activeActors, rosterActors, selectedOrphan,
      listTab: this._listTab, listItems,
      canPersonal,
      selected, selectedId: this._selectedId, selectedSource,
      enrichedIngredients, enrichedResults, enrichedPrereqs,
      prereqsMet, canCraft, crafting: this._crafting,
      craftQty: this._craftQty,
      selectedCraftDays, selectedIsTimed: selectedCraftDays > 0,
      inProgressJobs, collectJobs, hasCraftJobs: craftJobs.length > 0,
      isGM:          game.user.isGM,
      canForceCraft: game.user.isGM && !!this.actor && !!selected,
      aggregatedPrimary:   aggregated.primary.filter(d => d.value),
      aggregatedSecondary: aggregated.secondary.filter(d => d.value),
      approvalState,
    };
  }

  // Catch crafts that finished while the Forge was closed.
  async _preFirstRender(context, options) {
    await _checkCraftQueue();
  }

  _actorQty(uuid, name) {
    if (!this.actor) return 0;
    const item = this.actor.items.find(i => (uuid && i.uuid === uuid) || i.name === name);
    return item ? getItemQty(item) : 0;
  }

  // Dialog listing every rostered crafter; the GM ticks the ones to drop.
  async _manageCrafterRoster() {
    const actors = getCraftNpcs().map(id => game.actors.get(id)).filter(Boolean);
    if (!actors.length) return;
    const rows = actors.map(a => `
      <label style="display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer">
        <input type="checkbox" name="removeIds" value="${a.id}"/>
        <img src="${esc(a.img ?? "icons/svg/mystery-man.svg")}" onerror="this.src='icons/svg/mystery-man.svg'"
             style="width:22px;height:22px;object-fit:cover;border-radius:3px;border:none"/>
        <span>${esc(a.name)}</span>
      </label>`).join("");
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Manage Crafters" },
      content: `<div style="max-height:320px;overflow-y:auto;padding:4px 0">
                  <p style="margin:0 0 6px;font-size:.82rem;">Tick the actors to remove from the crafter list.</p>
                  ${rows}
                </div>`,
      buttons: [
        { label: "Remove Selected", action: "remove", default: true,
          callback: (_ev, b) => [...b.form.querySelectorAll("[name=removeIds]:checked")].map(c => c.value) },
        { label: "Cancel", action: "cancel", callback: () => null },
      ],
    }).catch(() => null);
    if (!Array.isArray(result) || !result.length) return;
    await saveCraftNpcs(getCraftNpcs().filter(id => !result.includes(id)));
    if (result.includes(this.actor?.id)) this.actor = null;
    this.render();
  }

  _onRender(context, options) {
    const el = this.element;
    _applyTheme(el);

    // (auto-craft on approval was removed — player must click Craft manually after approval)

    el.querySelector(".kctg-actor-select")?.addEventListener("change", e => {
      this.actor = game.actors.get(e.target.value) ?? null; this.render();
    });
    // Actor drop zone (GM only, adds any non-group actor to the crafter roster)
    const npcDrop = el.querySelector(".kctg-npc-actor-drop");
    if (npcDrop) {
      npcDrop.addEventListener("dragover",  e => e.preventDefault());
      npcDrop.addEventListener("dragenter", e => { e.preventDefault(); npcDrop.classList.add("kctg-drag-over"); });
      npcDrop.addEventListener("dragleave", () => npcDrop.classList.remove("kctg-drag-over"));
      npcDrop.addEventListener("drop", async e => {
        e.preventDefault(); npcDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Actor") return ui.notifications.warn("Drop an Actor here.");
        const actor = data.uuid ? await safeFromUuid(data.uuid) : game.actors.get(data.id);
        if (!actor) return ui.notifications.error("Could not resolve actor.");
        if (actor.type === "group") return ui.notifications.warn("Group actors can't craft.");
        if (!game.actors.get(actor.id)) return ui.notifications.warn("Import the actor into the world first.");
        await _rosterAddActors([actor.id]);
        this.actor = actor;
        this.render();
      });
    }
    el.querySelector(".kctg-roster-manage")?.addEventListener("click", () => this._manageCrafterRoster());
    el.querySelectorAll(".kctg-recipe-entry").forEach(row =>
      row.addEventListener("click", () => { this._selectedId = row.dataset.id; this._craftQty = 1; this.render(); })
    );

    // ── List source tabs (World / Personal) ──────────────────────────────────
    el.querySelectorAll(".kctg-recipe-tab").forEach(btn =>
      btn.addEventListener("click", () => {
        if (this._listTab === btn.dataset.tab) return;
        this._listTab = btn.dataset.tab;
        this.render();
      })
    );

    // ── Quest-style folder list: collapse, right-click edit, drag & drop ─────
    {
      const world = this._listTab !== "personal";
      _wireRecipeFolderList(el, {
        store: world
          ? { getRecipes, saveRecipes, getFolders, saveFolders }
          : { getRecipes: () => getPersonalRecipes(), saveRecipes: r => savePersonalRecipes(r),
              getFolders: () => getPersonalFolders(), saveFolders: f => savePersonalFolders(f) },
        canWrite:     world ? game.user.isGM : canCreatePersonalRecipes(),
        collapsedSet: this._collapsedFolders,
        rowSelector:  ".kctg-recipe-entry",
        render:       () => this.render(),
      });
    }
    el.querySelector(".kctg-craft-qty")?.addEventListener("change", e => {
      this._craftQty = Math.max(1, parseInt(e.target.value) || 1); this.render();
    });
    el.querySelector(".kctg-craft-btn")?.addEventListener("click",       () => this._doCraft("normal"));
    el.querySelector(".kctg-force-craft-btn")?.addEventListener("click", () => this._doCraft("force"));
    el.querySelector(".kctg-free-craft-btn")?.addEventListener("click",  () => this._doCraft("free"));
    el.querySelector(".kctg-request-approval-btn")?.addEventListener("click", () => this._requestApproval());
    el.querySelectorAll(".kctg-craft-collect").forEach(btn =>
      btn.addEventListener("click", async () => { await _collectCraftJob(btn.dataset.id); this.render(); })
    );
    el.querySelectorAll(".kctg-craft-cancel").forEach(btn =>
      btn.addEventListener("click", async () => {
        await saveCraftJobs(getCraftJobs().filter(j => j.id !== btn.dataset.id));
        this.render();
      })
    );
    el.querySelector(".kctg-open-recipe-manager-btn")?.addEventListener("click", () => {
      new RecipeManagerApp({ source: "world" }).render(true);
    });
    el.querySelector(".kctg-manage-personal-btn")?.addEventListener("click", () => {
      new RecipeManagerApp({ source: "personal" }).render(true);
    });
  }

  async _requestApproval() {
    const found = this._selectedId ? this._findRecipe(this._selectedId) : null;
    if (!found || !this.actor) return;
    const { recipe } = found;

    // Don't allow requesting approval for a craft the actor can't actually make.
    const missingIng = (recipe.ingredients ?? []).some(ing =>
      this._actorQty(ing.uuid, ing.name) < ing.qty * this._craftQty);
    const missingPre = (recipe.prerequisites ?? []).some(pre =>
      !this.actor.items.find(i => (pre.uuid && i.uuid === pre.uuid) || i.name === pre.name));
    if (missingIng || missingPre) {
      ui.notifications.warn("You don't have the required ingredients to request approval for this craft.");
      return;
    }

    const reqId = newId();
    const request = {
      id:             reqId,
      ts:             Date.now(),
      userId:         game.user.id,
      userName:       game.user.name,
      actorId:        this.actor.id,
      actorName:      this.actor.name,
      recipeId:       recipe.id,
      recipeName:     recipe.name,
      recipeHash:     _recipeHash(recipe),
      recipeSnapshot: foundry.utils.deepClone(recipe),
      qty:            this._craftQty,
      status:         CRAFT_APPROVAL_STATUS.PENDING,
    };
    // Save to player's own user flag — works even if GM is offline
    const existing = getPendingCrafts().filter(r => !(r.recipeId === recipe.id && r.status === CRAFT_APPROVAL_STATUS.PENDING));
    await savePendingCrafts([...existing, request]);
    this._pendingApprovalId = reqId;
    // Optional live ping — GM sees notification if currently online, but request persists regardless
    game.socket.emit(`module.${MODULE_ID}`, { type: "approvalPing", userName: game.user.name, recipeName: recipe.name });
    ui.notifications.info("Craft approval request sent to the GM.");
    this.render();
  }

  async _doCraft(mode = "normal", { bypassApproval = false } = {}) {
    if (this._crafting) return;
    const found = this._selectedId ? this._findRecipe(this._selectedId) : null;
    if (!found || !this.actor) return;
    const { recipe, source } = found;

    // ── Approval gate for non-GM players ─────────────────────────────────────
    let _consumeOneTime = false;
    if (!bypassApproval && !game.user.isGM && game.settings.get(MODULE_ID, "requireApproval")) {
      const hash            = _recipeHash(recipe);
      const isPermApproved  = getCraftApproved().some(a => a.userId === game.user.id && a.recipeId === recipe.id && a.hash === hash);
      const hasOneTime      = hasOneTimeApproval(game.user.id, recipe.id, hash);
      if (!isPermApproved && !hasOneTime) {
        ui.notifications.warn("This recipe requires GM approval before crafting.");
        return;
      }
      if (!isPermApproved && hasOneTime) _consumeOneTime = true;
    }
    const qty = this._craftQty;
    this._crafting = true; await this.render();

    // Prerequisites check (never consumed, always required for normal/force)
    if (mode !== "free") {
      for (const pre of (recipe.prerequisites ?? [])) {
        const has = !!this.actor.items.find(i => (pre.uuid && i.uuid === pre.uuid) || i.name === pre.name);
        if (!has) {
          ui.notifications.error(`Prerequisite missing: ${pre.name}`);
          this._crafting = false; return this.render();
        }
      }
    }

    // ── Timed craft: queue instead of producing immediately ──────────────────
    // Applies to normal crafts only; force/free are GM overrides and stay instant.
    const craftDays = craftTotalDays(recipe, qty);
    if (mode === "normal" && craftDays > 0) {
      // Verify ingredients are present now (a friendly early check); they are NOT
      // consumed yet — consumption happens on completion.
      const missing = (recipe.ingredients ?? []).find(ing => {
        if (ing.consume === false) return !this.actor.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name);
        const item = this.actor.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name);
        return !item || getItemQty(item) < ing.qty * qty;
      });
      if (missing) { ui.notifications.error(`Missing ingredient: ${missing.name}`); this._crafting = false; return this.render(); }

      const job = {
        id: newId(),
        recipeId: recipe.id, recipeName: recipe.name,
        recipeSnapshot: foundry.utils.deepClone(recipe),
        source,
        actorId: this.actor.id, actorName: this.actor.name,
        qty, mode,
        startDay: getCurrentDay(),
        craftDays,
        status: CRAFT_JOB_STATUS.IN_PROGRESS,
      };
      await saveCraftJobs([...getCraftJobs(), job]);
      if (_consumeOneTime) await consumeOneTimeApproval(game.user.id, recipe.id, _recipeHash(recipe));
      await _postCraftStartedMsg(job);
      ui.notifications.info(`${recipe.name} started — ready in ${craftDays} day${craftDays !== 1 ? "s" : ""}.`);
      this._crafting = false;
      return this.render();
    }

    if (mode === "normal") {
      for (const ing of (recipe.ingredients ?? [])) {
        const shouldConsume = ing.consume !== false;
        const item   = this.actor.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name);
        const needed = ing.qty * qty;
        if (!item) { ui.notifications.error(`Missing ingredient: ${ing.name}`); this._crafting = false; return this.render(); }
        if (!shouldConsume) continue; // require-only — just presence check
        const have = getItemQty(item);
        if (have <= needed) await item.delete();
        else await item.update({ "system.quantity": have - needed });
      }
    } else if (mode === "force") {
      for (const ing of (recipe.ingredients ?? [])) {
        if (ing.consume === false) continue; // require-only, skip
        const item = this.actor.items.find(i => (ing.uuid && i.uuid === ing.uuid) || i.name === ing.name);
        if (!item) continue;
        const needed = ing.qty * qty;
        const have   = getItemQty(item);
        if (have <= needed) await item.delete();
        else await item.update({ "system.quantity": have - needed });
      }
    }
    // mode === "free": skip all ingredient consumption

    for (const res of (recipe.results ?? [])) {
      const total = res.qty * qty;
      const src   = await safeFromUuid(res.uuid) ?? game.items.find(i => i.name === res.name) ?? null;
      if (src) {
        const craftedItem = await addItemToActor(this.actor, src, total);
        await appendDescriptorsToItem(craftedItem, recipe);
      } else {
        const itemType = fallbackItemType();
        const created  = await this.actor.createEmbeddedDocuments("Item", [{
          name: res.name, img: res.img ?? "icons/svg/item-bag.svg", type: itemType,
        }]);
        const newItem = created?.[0] ?? null;
        if (newItem) {
          if (newItem.system?.quantity !== undefined) await newItem.update({ "system.quantity": total });
          await appendDescriptorsToItem(newItem, recipe);
        } else {
          ui.notifications.warn(`Could not create result item: ${res.name}`);
        }
      }
    }

    // Log the craft
    await appendCraftLogEntry({
      actorId: this.actor.id, actorName: this.actor.name,
      userId: game.user.id,   userName: game.user.name,
      recipeId: recipe.id,    recipeName: recipe.name,
      qty, mode,
      ingredients: (recipe.ingredients ?? []).map(i => `${i.qty * qty}x ${i.name}`),
      results:     (recipe.results     ?? []).map(r => `${r.qty * qty}x ${r.name}`),
    });

    // Consume one-time approval after successful craft
    if (_consumeOneTime) await consumeOneTimeApproval(game.user.id, recipe.id, _recipeHash(recipe));

    this._crafting = false;
    await postCraftMessage(this.actor, { ...recipe, _personal: source === "personal" }, qty);
    await logActivity("craft", `${this.actor.name} crafted ${recipe.name}${qty > 1 ? ` ×${qty}` : ""}`);
    this.render();
  }
}

// ─── RECIPE MANAGER ───────────────────────────────────────────────────────────

class RecipeManagerApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(options = {}) {
    super(options);
    this._editingId        = null;
    this._collapsedFolders = new Set();
    this._collapsedPlayers = new Set();
    this._playerViewUserId = null;
    // Chart tab state — selectedIds, filter and collapse are UI state
    // (instance-level); nodePos / pan / zoom live in the module-level
    // _chartState object. knownIds lets newly created recipes default to
    // selected without resurrecting ones the GM deselected.
    this._chartSelectedIds = new Set(getRecipes().map(r => r.id));
    this._chartKnownIds    = new Set(this._chartSelectedIds);
    this._chartCollapsed   = new Set();
    this._chartFilter      = "";
    if      (options.source === "personal")  this._source = "personal";
    else if (options.source === "players")   this._source = "players";
    else if (options.source === "log")       this._source = "log";
    else if (options.source === "approvals") this._source = "approvals";
    else if (options.source === "chart")     this._source = "chart";
    else this._source = game.user.isGM ? "world" : "personal";
  }

  static DEFAULT_OPTIONS = {
    id: "kctg-forge--recipe-manager", classes: ["kctg-module", "kctg-recipe-manager"],
    window: { title: "Crafting Recipe Manager", resizable: true },
    position: { width: 860, height: 700 }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/forge/recipe-manager.hbs`, scrollable: [".kctg-rm-editor", ".kctg-rm-list", ".kctg-rm-ingredient-list", ".kctg-rm-result-list", ".kctg-rm-log-list"] } };

  _getRecipes()         { return this._source === "world" ? getRecipes()   : getPersonalRecipes(); }
  async _saveRecipes(r) { return this._source === "world" ? saveRecipes(r) : savePersonalRecipes(r); }
  _getFolders()         { return this._source === "world" ? getFolders()   : getPersonalFolders(); }
  async _saveFolders(f) { return this._source === "world" ? saveFolders(f) : savePersonalFolders(f); }

  _canWrite() {
    if (this._source === "world")    return game.user.isGM;
    if (this._source === "personal") return canCreatePersonalRecipes() || game.user.isGM;
    return false;
  }

  _findPlayerRecipe(recipeId) {
    if (!recipeId) return null;
    for (const user of game.users.filter(u => !u.isGM)) {
      const r = getPersonalRecipes(user).find(r => r.id === recipeId);
      if (r) return { recipe: r, user };
    }
    return null;
  }

  async _prepareContext() {
    // ── Chart tab ─────────────────────────────────────────────────────────────
    if (this._source === "chart") {
      const all = getRecipes();
      // Newly created recipes default to selected (once) — deselected ones stay off
      all.forEach(r => { if (!this._chartKnownIds.has(r.id)) { this._chartKnownIds.add(r.id); this._chartSelectedIds.add(r.id); } });
      const chartItems = _buildChartListItems(all, getFolders(), this._chartSelectedIds, this._chartFilter, this._chartCollapsed);
      return { source: "chart", isGM: true, canWrite: false, canPersonal: canCreatePersonalRecipes(),
               chartItems, chartFilter: this._chartFilter,
               pendingCount: getAllPendingCrafts().filter(a => a.status === CRAFT_APPROVAL_STATUS.PENDING).length,
               folders: [], editing: null, editingId: null, entries: [], grouped: [], playerEntries: [],
               approvals: [], viewing: null, viewingUser: null, enrichedIngredients: [], enrichedResults: [],
               enrichedPrereqs: [], aggregatedPrimary: [], aggregatedSecondary: [], alreadyInWorld: false };
    }

    // ── Approvals tab ─────────────────────────────────────────────────────────
    if (this._source === "approvals") {
      const pending = getAllPendingCrafts().filter(a => a.status === CRAFT_APPROVAL_STATUS.PENDING).slice().reverse();
      const enriched = await Promise.all(pending.map(async req => {
        const snap = req.recipeSnapshot ?? {};
        const ings = await Promise.all((snap.ingredients ?? []).map(async ing => {
          const item = await safeFromUuid(ing.uuid);
          const resolvedType = item?.type ?? null;
          const dangerous    = (ing.consume !== false) && resolvedType && DANGEROUS_TYPES.has(resolvedType);
          const requireOnly  = ing.consume === false;
          return { ...ing, img: item?.img ?? ing.img ?? "icons/svg/item-bag.svg", resolvedType, dangerous, requireOnly };
        }));
        const res = await Promise.all((snap.results ?? []).map(async r => {
          const item = await safeFromUuid(r.uuid);
          return { ...r, img: item?.img ?? r.img ?? "icons/svg/item-bag.svg" };
        }));
        const dangerList = ings.filter(i => i.dangerous).map(i => `${i.name} (${i.resolvedType})`);
        return { ...req, enrichedIngredients: ings, enrichedResults: res, dangerList };
      }));
      const pendingCount = enriched.length;
      return { source: "approvals", isGM: true, canWrite: false, canPersonal: canCreatePersonalRecipes(),
               approvals: enriched, pendingCount,
               folders: [], editing: null, editingId: null, entries: [], grouped: [], playerEntries: [],
               viewing: null, viewingUser: null, enrichedIngredients: [], enrichedResults: [], enrichedPrereqs: [],
               aggregatedPrimary: [], aggregatedSecondary: [], alreadyInWorld: false };
    }

    // ── Log tab ──────────────────────────────────────────────────────────────
    if (this._source === "log") {
      const rawLog = getCraftLog().slice().reverse(); // newest first
      const entries = rawLog.map(e => ({
        ...e,
        dateStr: new Date(e.ts).toLocaleDateString(),
        timeStr: new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        ingStr:  (e.ingredients ?? []).join(", "),
        resStr:  (e.results     ?? []).join(", "),
        modeLabel: e.mode === "free" ? "Free" : e.mode === "force" ? "Force" : "",
      }));
      return { source: "log", isGM: true, canWrite: false, canPersonal: canCreatePersonalRecipes(), entries, folders: [], editing: null, editingId: null, grouped: [], playerEntries: [], viewing: null, viewingUser: null, enrichedIngredients: [], enrichedResults: [], enrichedPrereqs: [], aggregatedPrimary: [], aggregatedSecondary: [], alreadyInWorld: false, approvals: [], pendingCount: getAllPendingCrafts().filter(a => a.status === CRAFT_APPROVAL_STATUS.PENDING).length };
    }

    // ── Players tab ──────────────────────────────────────────────────────────
    if (this._source === "players") {
      const playerEntries = getPlayerRecipeEntries().map(e => ({
        ...e, collapsed: this._collapsedPlayers.has(e.user.id),
        grouped: _buildGroupedRecipes(e.recipes, e.folders, this._collapsedFolders),
      }));
      let viewing = null, enrichedIngredients = [], enrichedResults = [], enrichedPrereqs = [];
      let aggregated = { primary: [], secondary: [] }, viewingUser = null;
      if (this._editingId) {
        const found = this._findPlayerRecipe(this._editingId);
        if (found) {
          viewing = found.recipe; viewingUser = found.user;
          [enrichedPrereqs, enrichedIngredients, enrichedResults] = await Promise.all([
            Promise.all((viewing.prerequisites ?? []).map(async pre => {
              const item = await safeFromUuid(pre.uuid);
              return { ...pre, img: item?.img ?? pre.img ?? "icons/svg/item-bag.svg", resolvedName: item?.name ?? pre.name };
            })),
            Promise.all((viewing.ingredients ?? []).map(async ing => {
              const item = await safeFromUuid(ing.uuid);
              return { ...ing, img: item?.img ?? ing.img ?? "icons/svg/item-bag.svg", resolvedName: item?.name ?? ing.name, visibleDescs: visibleDescriptors(ing) };
            })),
            Promise.all((viewing.results ?? []).map(async res => {
              const item = await safeFromUuid(res.uuid);
              return { ...res, img: item?.img ?? res.img ?? "icons/svg/item-bag.svg", resolvedName: item?.name ?? res.name };
            })),
          ]);
          aggregated = aggregateDescriptors(viewing.ingredients ?? []);
        }
      }
      const alreadyInWorld = viewing ? getRecipes().some(r => r.name === viewing.name) : false;
      return {
        source: "players", isGM: true, canWrite: false, canPersonal: canCreatePersonalRecipes(),
        playerEntries, editing: null, editingId: this._editingId,
        viewing, viewingUser: viewingUser ? { id: viewingUser.id, name: viewingUser.name, avatar: viewingUser.avatar ?? "icons/svg/mystery-man.svg", active: viewingUser.active } : null,
        enrichedIngredients, enrichedResults, enrichedPrereqs,
        aggregatedPrimary: aggregated.primary.filter(d => d.value), aggregatedSecondary: aggregated.secondary.filter(d => d.value),
        alreadyInWorld, folders: [], entries: [], approvals: [],
        pendingCount: getAllPendingCrafts().filter(a => a.status === CRAFT_APPROVAL_STATUS.PENDING).length,
      };
    }

    // ── World / Personal tab ─────────────────────────────────────────────────
    const recipes = this._getRecipes();
    const folders = this._getFolders();
    const editing = recipes.find(r => r.id === this._editingId) ?? null;
    const grouped = _buildGroupedRecipes(recipes, folders, this._collapsedFolders);
    const listItems = _buildRecipeListItems(recipes, folders, this._collapsedFolders);
    let enrichedIngredients = [], enrichedResults = [], enrichedPrereqs = [];
    let aggregated = { primary: [], secondary: [] };

    if (editing) {
      [enrichedPrereqs, enrichedIngredients, enrichedResults] = await Promise.all([
        Promise.all((editing.prerequisites ?? []).map(async pre => {
          const item = await safeFromUuid(pre.uuid);
          return { ...pre, img: item?.img ?? pre.img ?? "icons/svg/item-bag.svg", resolvedName: item?.name ?? pre.name };
        })),
        Promise.all((editing.ingredients ?? []).map(async ing => {
          const item = await safeFromUuid(ing.uuid);
          return { ...ing, img: item?.img ?? ing.img ?? "icons/svg/item-bag.svg", resolvedName: item?.name ?? ing.name, desc1Label: ing.desc1?.label ?? "", desc1Value: ing.desc1?.value ?? "", desc2Label: ing.desc2?.label ?? "", desc2Value: ing.desc2?.value ?? "" };
        })),
        Promise.all((editing.results ?? []).map(async res => {
          const item = await safeFromUuid(res.uuid);
          return { ...res, img: item?.img ?? res.img ?? "icons/svg/item-bag.svg", resolvedName: item?.name ?? res.name };
        })),
      ]);
      aggregated = aggregateDescriptors(editing.ingredients ?? []);
    }

    return {
      recipes, folders, grouped, listItems, editing, editingId: this._editingId,
      enrichedIngredients, enrichedResults, enrichedPrereqs,
      aggregatedPrimary: aggregated.primary.filter(d => d.value), aggregatedSecondary: aggregated.secondary.filter(d => d.value),
      source: this._source, isGM: game.user.isGM, canWrite: this._canWrite(), canPersonal: canCreatePersonalRecipes(),
      viewing: null, viewingUser: null, playerEntries: [], entries: [], approvals: [],
      pendingCount: getAllPendingCrafts().filter(a => a.status === CRAFT_APPROVAL_STATUS.PENDING).length,
    };
  }

  _onRender(context, options) {
    const el = this.element;
    _applyTheme(el);

    // ── Source tabs ───────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-rm-source-tab").forEach(btn =>
      btn.addEventListener("click", () => {
        if (!game.user.isGM) return;
        this._source = btn.dataset.source; this._editingId = null; this._collapsedFolders.clear(); this.render();
      })
    );

    // ── Log tab actions ───────────────────────────────────────────────────────
    el.querySelector(".kctg-rm-log-clear")?.addEventListener("click", async () => {
      await saveCraftLog([]); this.render();
    });

    // ── Approvals tab actions ─────────────────────────────────────────────────
    el.querySelectorAll(".kctg-rm-approve-btn").forEach(btn =>
      btn.addEventListener("click", async () => {
        const remember = !!btn.closest(".kctg-rm-approval-actions")?.querySelector(".kctg-rm-remember-check")?.checked;
        await this._resolveApproval(btn.dataset.reqId, true, remember);
      })
    );
    el.querySelectorAll(".kctg-rm-reject-btn").forEach(btn =>
      btn.addEventListener("click", async () => {
        await this._resolveApproval(btn.dataset.reqId, false);
      })
    );

    // ── Folder collapse (players tab still uses compact headers) ─────────────
    el.querySelectorAll(".kctg-folder-header[data-folder-id]").forEach(hdr =>
      hdr.addEventListener("click", (e) => {
        if (e.target.closest("input, button")) return;
        const fid = hdr.dataset.folderId;
        if (this._collapsedFolders.has(fid)) this._collapsedFolders.delete(fid); else this._collapsedFolders.add(fid);
        this.render();
      })
    );

    // ── Quest-style folder list (world/personal): collapse, right-click edit,
    //    drag & drop of recipes into folders and folder reordering ─────────────
    if (this._source === "world" || this._source === "personal") {
      _wireRecipeFolderList(el, {
        store: { getRecipes: () => this._getRecipes(), saveRecipes: r => this._saveRecipes(r),
                 getFolders: () => this._getFolders(), saveFolders: f => this._saveFolders(f) },
        canWrite:     this._canWrite(),
        collapsedSet: this._collapsedFolders,
        rowSelector:  ".kctg-rm-recipe-row",
        render:       () => this.render(),
        recipeMenu:   id => [
          { icon: "far fa-clone", label: "Duplicate", cb: async () => {
              const recipes = this._getRecipes(), src = recipes.find(r => r.id === id); if (!src) return;
              const copy = foundry.utils.deepClone(src); copy.id = newId(); copy.name = src.name + " (Copy)";
              recipes.splice(recipes.indexOf(src) + 1, 0, copy); // next to the original (array order = display order)
              await this._saveRecipes(recipes); this._editingId = copy.id; this.render();
          } },
          "divider",
          { icon: "fas fa-trash", label: "Delete Recipe", danger: true, cb: async () => {
              if (this._editingId === id) this._editingId = null;
              await this._saveRecipes(this._getRecipes().filter(r => r.id !== id)); this.render();
          } },
        ],
      });
    }
    el.querySelectorAll(".kctg-player-header").forEach(hdr =>
      hdr.addEventListener("click", () => {
        const uid = hdr.dataset.userId;
        if (this._collapsedPlayers.has(uid)) this._collapsedPlayers.delete(uid); else this._collapsedPlayers.add(uid);
        this.render();
      })
    );

    // ── Recipe selection ───────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-rm-recipe-row").forEach(row =>
      row.addEventListener("click", () => { this._editingId = row.dataset.id; this.render(); })
    );

    // ── Players tab: promote ──────────────────────────────────────────────────
    el.querySelector(".kctg-rm-promote-copy")?.addEventListener("click", () => this._promoteRecipe(false));
    el.querySelector(".kctg-rm-promote-move")?.addEventListener("click", () => this._promoteRecipe(true));

    // ── Sidebar resize handle ─────────────────────────────────────────────────
    const handle = el.querySelector(".kctg-rm-resize-handle"), sidebar = el.querySelector(".kctg-rm-sidebar");
    if (handle && sidebar) {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const startX = e.clientX, startWidth = sidebar.getBoundingClientRect().width;
        const onMove = (ev) => { sidebar.style.width = `${Math.min(500, Math.max(160, startWidth + (ev.clientX - startX)))}px`; };
        const onUp   = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
      });
    }

    // ── Chart tab ─────────────────────────────────────────────────────────────
    if (context.source === "chart") {
      el.querySelector(".kctg-chart-filter")?.addEventListener("input", e => {
        this._chartFilter = e.target.value; this.render();
      });
      el.querySelector(".kctg-chart-select-all")?.addEventListener("click", () => {
        getRecipes().forEach(r => this._chartSelectedIds.add(r.id)); this.render();
      });
      el.querySelector(".kctg-chart-select-none")?.addEventListener("click", () => {
        this._chartSelectedIds.clear(); this.render();
      });
      _wireChartSidebarList(el, this, this._chartSelectedIds, this._chartCollapsed, () => this._chartFilter);
      _wireChartToolbar(el, () => this._buildChart(el));
      this._buildChart(el);
      return; // skip rest of _onRender for chart tab
    }

    // ── Export / Import ───────────────────────────────────────────────────────
    el.querySelector(".kctg-rm-export-btn")?.addEventListener("click", () => this._exportRecipes());
    el.querySelector(".kctg-rm-import-btn")?.addEventListener("click", () => this._importRecipes());

    if (!this._canWrite()) return;

    // ── Folder management (rename / color / delete live in the right-click menu)
    el.querySelector(".kctg-rm-add-folder")?.addEventListener("click", async () => {
      const folders = this._getFolders(); folders.push({ id: newId(), name: "New Folder" });
      await this._saveFolders(folders); this.render();
    });

    // ── Recipe CRUD ───────────────────────────────────────────────────────────
    el.querySelector(".kctg-rm-add-recipe")?.addEventListener("click", async () => {
      const recipes = this._getRecipes();
      const r = { id: newId(), name: "New Recipe", description: "", folderId: null, locked: false, unlockMode: "any", unlockItems: [], prerequisites: [], ingredients: [], results: [] };
      recipes.push(r); await this._saveRecipes(recipes); this._editingId = r.id; this.render();
    });
    // (Duplicate / Delete recipe moved to the row right-click menu — see recipeMenu above)

    // ── Editor: meta fields ───────────────────────────────────────────────────
    el.querySelector(".kctg-rm-name-input")?.addEventListener("change", async e => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
      if (r) { r.name = e.target.value; await this._saveRecipes(recipes); this.render(); }
    });
    el.querySelector(".kctg-rm-desc-input")?.addEventListener("change", async e => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
      if (r) { r.description = e.target.value; await this._saveRecipes(recipes); }
    });
    // Crafting time: days per batch. Scales with quantity unless "flat total" is set.
    el.querySelector(".kctg-rm-craftdays-input")?.addEventListener("change", async e => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
      if (r) { r.craftDays = Math.max(0, parseInt(e.target.value) || 0); await this._saveRecipes(recipes); this.render(); }
    });
    el.querySelector(".kctg-rm-craftflat-toggle")?.addEventListener("change", async e => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
      if (r) { r.craftTimeFlat = e.target.checked; await this._saveRecipes(recipes); }
    });
    el.querySelector(".kctg-rm-folder-select")?.addEventListener("change", async e => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
      if (r) { r.folderId = e.target.value || null; await this._saveRecipes(recipes); this.render(); }
    });

    // ── Discovery: lock toggle + unlock item ──────────────────────────────────
    el.querySelector(".kctg-rm-lock-toggle")?.addEventListener("change", async e => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
      if (r) { r.locked = e.target.checked; await this._saveRecipes(recipes); this.render(); }
    });
    el.querySelector(".kctg-rm-unlock-mode")?.addEventListener("change", async e => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
      if (r) { r.unlockMode = e.target.value; await this._saveRecipes(recipes); }
    });
    el.querySelectorAll(".kctg-rm-unlock-remove").forEach(btn =>
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
        if (r) { (r.unlockItems ??= []).splice(idx, 1); await this._saveRecipes(recipes); this.render(); }
      })
    );
    this._setupDrop(el.querySelector(".kctg-rm-unlock-drop"), async (item, uuid) => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId); if (!r) return;
      r.unlockItems ??= [];
      if (r.unlockItems.some(u => u.uuid === uuid || u.name === item.name)) return ui.notifications.warn("Already an unlock condition.");
      r.unlockItems.push({ uuid, name: item.name, img: item.img }); await this._saveRecipes(recipes); this.render();
    });

    // ── Prerequisites ─────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-rm-remove-pre").forEach(btn =>
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
        if (r) { r.prerequisites.splice(idx, 1); await this._saveRecipes(recipes); this.render(); }
      })
    );
    this._setupDrop(el.querySelector(".kctg-rm-prereq-drop"), async (item, uuid) => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId); if (!r) return;
      r.prerequisites ??= [];
      if (r.prerequisites.some(p => p.uuid === uuid || p.name === item.name)) return ui.notifications.warn("Already a prerequisite.");
      r.prerequisites.push({ uuid, name: item.name, img: item.img }); await this._saveRecipes(recipes); this.render();
    });

    // ── Ingredient list ───────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-rm-remove-ing").forEach(btn =>
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
        if (r) { r.ingredients.splice(idx, 1); await this._saveRecipes(recipes); this.render(); }
      })
    );
    el.querySelectorAll(".kctg-rm-ing-qty").forEach(input =>
      input.addEventListener("change", async e => {
        const idx = parseInt(input.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
        if (r?.ingredients[idx]) { r.ingredients[idx].qty = Math.max(1, parseInt(e.target.value) || 1); await this._saveRecipes(recipes); }
      })
    );
    const descFields = [["kctg-rm-desc1-label","desc1","label"],["kctg-rm-desc1-value","desc1","value"],["kctg-rm-desc2-label","desc2","label"],["kctg-rm-desc2-value","desc2","value"]];
    for (const [cls, slot, prop] of descFields) {
      el.querySelectorAll(`.${cls}`).forEach(input =>
        input.addEventListener("change", async e => {
          const idx = parseInt(input.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
          if (!r?.ingredients[idx]) return;
          r.ingredients[idx][slot] ??= { label: "", value: "" };
          r.ingredients[idx][slot][prop] = e.target.value;
          await this._saveRecipes(recipes);
        })
      );
    }
    el.querySelectorAll(".kctg-rm-ing-consume").forEach(cb =>
      cb.addEventListener("change", async e => {
        const idx = parseInt(cb.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
        if (r?.ingredients[idx] !== undefined) { r.ingredients[idx].consume = cb.checked; await this._saveRecipes(recipes); }
      })
    );

    // ── Result list ───────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-rm-remove-res").forEach(btn =>
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
        if (r) { r.results.splice(idx, 1); await this._saveRecipes(recipes); this.render(); }
      })
    );
    el.querySelectorAll(".kctg-rm-res-qty").forEach(input =>
      input.addEventListener("change", async e => {
        const idx = parseInt(input.dataset.idx), recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId);
        if (r?.results[idx]) { r.results[idx].qty = Math.max(1, parseInt(e.target.value) || 1); await this._saveRecipes(recipes); }
      })
    );

    // ── Drop zones ────────────────────────────────────────────────────────────
    this._setupDrop(el.querySelector(".kctg-rm-ingredient-drop"), async (item, uuid) => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId); if (!r) return;
      if (r.ingredients.some(i => i.uuid === uuid)) return ui.notifications.warn("Already an ingredient.");
      r.ingredients.push({ uuid, name: item.name, img: item.img, qty: 1, desc1: { label: "", value: "" }, desc2: { label: "", value: "" } });
      await this._saveRecipes(recipes); this.render();
    });
    this._setupDrop(el.querySelector(".kctg-rm-result-drop"), async (item, uuid) => {
      const recipes = this._getRecipes(), r = recipes.find(r => r.id === this._editingId); if (!r) return;
      r.results.push({ uuid, name: item.name, img: item.img, qty: 1 }); await this._saveRecipes(recipes); this.render();
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  async _exportRecipes() {
    const recipes = this._getRecipes(), folders = this._getFolders();
    if (!recipes.length) return ui.notifications.warn("No recipes to export.");
    const text = serializeRecipesToText(recipes, folders);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    const tag = this._source === "world" ? "world" : `personal-${game.user.name.replace(/\s+/g, "-")}`;
    a.download = `kctg-forge-recipes-${tag}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click(); URL.revokeObjectURL(url);
    ui.notifications.info(`Exported ${recipes.length} recipe(s).`);
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  _importRecipes() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".txt,.kctg";
    input.onchange = async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      try { await this._processImport(await file.text()); }
      catch (err) { ui.notifications.error("Failed to read the file."); console.error("KCTG Forge | Import error:", err); }
    };
    input.click();
  }

  async _processImport(text) {
    const rawRecipes = parseRecipeText(text);
    if (!rawRecipes.length) return ui.notifications.warn("No recipes found in the file. Check the format.");

    const allEntries = rawRecipes.flatMap(r => [
      ...(r.prerequisites ?? []).map(i => ({ name: i.name, uuid: i.uuid })),
      ...(r.ingredients   ?? []).map(i => ({ name: i.name, uuid: i.uuid })),
      ...(r.results       ?? []).map(i => ({ name: i.name, uuid: i.uuid })),
      ...(r.unlockItems ?? []).map(u => ({ name: u.name, uuid: u.uuid })),
    ]);
    const nameMap = new Map();
    for (const e of allEntries) { if (!nameMap.has(e.name.toLowerCase())) nameMap.set(e.name.toLowerCase(), e); }

    const resolvedMap = new Map(), needsDialog = new Map();
    ui.notifications.info(`KCTG Forge: Resolving ${nameMap.size} item(s)…`);
    for (const [lcName, { name, uuid }] of nameMap) {
      if (uuid) { const item = await safeFromUuid(uuid); if (item) { resolvedMap.set(lcName, uuid); continue; } }
      const candidates = await searchCompendiumsByName(name);
      if (candidates.length === 1) resolvedMap.set(lcName, candidates[0].uuid);
      else needsDialog.set(name, { candidates });
    }
    if (needsDialog.size > 0) {
      const chosen = await showResolverDialog(needsDialog); if (chosen === null) return;
      for (const [name, uuid] of chosen) { if (uuid) resolvedMap.set(name.toLowerCase(), uuid); }
    }

    const folders = this._getFolders(), newFolders = [...folders];
    const folderNameToId = Object.fromEntries(folders.map(f => [f.name.toLowerCase(), f.id]));
    for (const recipe of rawRecipes) {
      if (!recipe._importFolder) continue;
      const key = recipe._importFolder.toLowerCase();
      if (!folderNameToId[key]) { const fid = newId(); newFolders.push({ id: fid, name: recipe._importFolder }); folderNameToId[key] = fid; }
      recipe.folderId = folderNameToId[key];
    }

    const applyRes = (items) => items.map(item => ({ ...item, uuid: resolvedMap.get(item.name.toLowerCase()) ?? item.uuid ?? "" }));
    const finalRecipes = rawRecipes.map(r => ({
      id: r.id, name: r.name, description: r.description, folderId: r.folderId ?? null,
      locked: r.locked ?? false,
      unlockItems: (r.unlockItems ?? []).map(u => ({ ...u, uuid: resolvedMap.get(u.name.toLowerCase()) ?? u.uuid ?? "" })),
      prerequisites: applyRes(r.prerequisites ?? []),
      ingredients:   applyRes(r.ingredients   ?? []),
      results:       applyRes(r.results       ?? []),
    }));

    await this._saveRecipes([...this._getRecipes(), ...finalRecipes]);
    if (newFolders.length !== folders.length) await this._saveFolders(newFolders);
    ui.notifications.info(`KCTG Forge: Imported ${finalRecipes.length} recipe(s).`);
    this.render();
  }

  // ── Promote player recipe to world ─────────────────────────────────────────
  async _promoteRecipe(removeFromPlayer) {
    const found = this._findPlayerRecipe(this._editingId); if (!found) return;
    const { recipe, user } = found;
    const worldRecipes = getRecipes();
    const promoted = foundry.utils.deepClone(recipe); promoted.id = newId(); promoted.folderId = null;
    worldRecipes.push(promoted); await saveRecipes(worldRecipes);
    if (removeFromPlayer) {
      await savePersonalRecipes(getPersonalRecipes(user).filter(r => r.id !== recipe.id), user);
      ui.notifications.info(`"${recipe.name}" moved to World Recipes and removed from ${user.name}'s list.`);
      this._editingId = null;
    } else {
      ui.notifications.info(`"${recipe.name}" copied to World Recipes. ${user.name} still has their copy.`);
    }
    this.render();
  }

  async _resolveApproval(reqId, approved, remember = false) {
    const req = getAllPendingCrafts().find(a => a.id === reqId);
    if (!req) return;
    const owner = game.users.get(req._userId ?? req.userId);
    if (owner) await savePendingCrafts(getPendingCrafts(owner).filter(r => r.id !== reqId), owner);
    if (approved && remember) {
      const stored = getCraftApproved().filter(a => !(a.userId === req.userId && a.recipeId === req.recipeId));
      stored.push({ userId: req.userId, recipeId: req.recipeId, hash: req.recipeHash });
      await saveCraftApproved(stored);
    } else if (approved && owner) {
      // One-time approval: record it in the GM-only world setting (not the player's
      // flag — that would be self-bypassable). Persists across sessions, so it survives
      // the player being offline at approval time, and the player can only read it.
      const list = getCraftApprovedOnce().filter(a => !(a.userId === owner.id && a.recipeId === req.recipeId && a.hash === req.recipeHash));
      await saveCraftApprovedOnce([...list, { userId: owner.id, recipeId: req.recipeId, hash: req.recipeHash }]);
    }
    game.socket.emit(`module.${MODULE_ID}`, approved
      ? { type: "approvalDecision", requestId: reqId, approved: true, userId: req.userId, actorId: req.actorId, recipeId: req.recipeId, hash: req.recipeHash, qty: req.qty }
      : { type: "approvalDecision", requestId: reqId, approved: false, userId: req.userId }
    );
    ui.notifications.info(`${approved ? "Approved" : "Rejected"} craft request from ${req.userName}.${approved && remember ? " (Remembered — future crafts auto-pass.)" : approved ? " Player can now craft." : ""}`);
    this.render();
  }

  _setupDrop(zone, onDrop) {
    if (!zone) return;
    zone.addEventListener("dragover",  e => e.preventDefault());
    zone.addEventListener("dragenter", e => { e.preventDefault(); zone.classList.add("kctg-drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("kctg-drag-over"));
    zone.addEventListener("drop", async e => {
      e.preventDefault(); zone.classList.remove("kctg-drag-over");
      if (!this._editingId) return ui.notifications.warn("Select a recipe first.");
      let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
      if (data.type !== "Item") return ui.notifications.warn("Drop an Item here.");
      const uuid = data.uuid; if (!uuid) return;
      const item = await safeFromUuid(uuid); if (!item) return ui.notifications.error("Could not resolve item UUID.");
      await onDrop(item, uuid);
    });
  }
  // ── Chart rendering — delegates to shared helper ──────────────────────────
  _buildChart(el) {
    const wrap = el.querySelector(".kctg-chart-canvas");
    if (!wrap) return;
    const recipes = getRecipes().filter(r => this._chartSelectedIds.has(r.id));
    _buildRecipeChart(wrap, recipes, el);
  }
}

// ─── SHARED CHART STATE & HELPERS ────────────────────────────────────────────
// Module-level state so node positions, pan, and zoom survive app close/reopen.
const _chartState = {
  nodePos: new Map(),         // nodeId → {x, y}
  pan:     { x: 20, y: 20 }, // canvas pan offset
  zoom:    1,                 // canvas scale
};

/** Update the zoom label inside the toolbar, if present. */
function _updateZoomLabel(el, zoom) {
  const lbl = el?.querySelector(".kctg-chart-zoom-label");
  if (lbl) lbl.textContent = Math.round(zoom * 100) + "%";
}

function _redrawChartLines(svg, edges, domNodes, NW, NH) {
  svg.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const goldRaw = getComputedStyle(svg).getPropertyValue("--kctg-gold").trim() || "#f5b430";
  for (const edge of edges) {
    const a = domNodes.get(edge.from), b = domNodes.get(edge.to);
    if (!a || !b) continue;
    const ax = parseFloat(a.style.left), ay = parseFloat(a.style.top);
    const bx = parseFloat(b.style.left), by = parseFloat(b.style.top);
    const aH = a.offsetHeight || NH, bH = b.offsetHeight || NH;
    const x1 = ax + NW, y1 = ay + aH / 2, x2 = bx, y2 = by + bH / 2, cx = (x1 + x2) / 2;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d",            `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`);
    path.setAttribute("fill",         "none");
    path.setAttribute("stroke",       goldRaw);
    path.setAttribute("stroke-opacity", edge.style === "dashed" ? "0.5" : "0.75");
    path.setAttribute("stroke-width", "1.5");
    if (edge.style === "dashed") path.setAttribute("stroke-dasharray", "5,3");
    svg.appendChild(path);
  }
}

/**
 * Build (or rebuild) the recipe dependency chart into `wrap`.
 * Uses `_chartState` for nodePos, pan, and zoom — all persisted at module level.
 * Previous window event listeners are cleaned up via AbortController.
 *
 * @param {HTMLElement} wrap    — the `.kctg-chart-canvas` element
 * @param {object[]}    recipes — already-filtered recipe array
 * @param {HTMLElement} rootEl  — the app root element (for toolbar updates)
 */
function _buildRecipeChart(wrap, recipes, rootEl) {
  // Abort any listeners from the previous build to prevent accumulation
  wrap._chartAC?.abort();
  const ac = new AbortController();
  wrap._chartAC = ac;
  const sig = { signal: ac.signal };

  wrap.innerHTML = "";

  if (!recipes.length) {
    wrap.innerHTML = `<div class="kctg-chart-empty">Select recipes from the list to visualise them.</div>`;
    return;
  }

  // ── Build node + edge data ──────────────────────────────────────────────────
  const itemNodes   = new Map();
  const recipeNodes = new Map();
  for (const recipe of recipes) {
    recipeNodes.set(recipe.id, { id: `r:${recipe.id}`, kind: "recipe", label: recipe.name, img: null });
  }
  const addItem = (name, img, kind = "item") => {
    if (!itemNodes.has(name)) itemNodes.set(name, { id: `i:${name}`, kind, label: name, img: img ?? "icons/svg/item-bag.svg" });
    return itemNodes.get(name);
  };
  const edges = [];
  for (const recipe of recipes) {
    const rn = recipeNodes.get(recipe.id);
    for (const pre of (recipe.prerequisites ?? [])) { const n = addItem(pre.name, pre.img, "prereq"); edges.push({ from: n.id, to: rn.id, style: "dashed" }); }
    for (const ing of (recipe.ingredients  ?? [])) { const n = addItem(ing.name, ing.img);             edges.push({ from: n.id, to: rn.id, style: "solid"  }); }
    for (const res of (recipe.results      ?? [])) { const n = addItem(res.name, res.img);             edges.push({ from: rn.id, to: n.id, style: "solid"  }); }
  }
  const allNodes = [...itemNodes.values(), ...recipeNodes.values()];

  // ── Layer assignment (longest-path layering) ────────────────────────────────
  const outEdges = new Map(allNodes.map(n => [n.id, []]));
  const inCount  = new Map(allNodes.map(n => [n.id, 0]));
  for (const e of edges) { outEdges.get(e.from)?.push(e.to); inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1); }
  const layer = new Map();
  const queue = allNodes.filter(n => (inCount.get(n.id) ?? 0) === 0).map(n => n.id);
  queue.forEach(id => layer.set(id, 0));
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi], l = layer.get(id) ?? 0;
    for (const nxt of (outEdges.get(id) ?? [])) {
      const nl = l + 1;
      if (!layer.has(nxt) || layer.get(nxt) < nl) layer.set(nxt, nl);
      if (!queue.includes(nxt)) queue.push(nxt);
    }
  }
  allNodes.forEach(n => { if (!layer.has(n.id)) layer.set(n.id, 0); });

  // ── Assign positions for nodes not already in state ─────────────────────────
  const NW = 100, NH = 64, HGAP = 70, VGAP = 12, PAD = 24;
  const layerGroups = new Map();
  for (const n of allNodes) {
    const l = layer.get(n.id) ?? 0;
    if (!layerGroups.has(l)) layerGroups.set(l, []);
    layerGroups.get(l).push(n);
  }
  for (const [l, nodes] of layerGroups) {
    let y = PAD;
    for (const n of nodes) {
      if (!_chartState.nodePos.has(n.id)) _chartState.nodePos.set(n.id, { x: PAD + l * (NW + HGAP), y });
      y += NH + VGAP;
    }
  }

  // ── SVG + container ─────────────────────────────────────────────────────────
  const totalW = Math.max(600, PAD * 2 + (Math.max(...[...layer.values()], 0) + 1) * (NW + HGAP));
  const totalH = Math.max(400, PAD * 2 + Math.max(...allNodes.map(n => (_chartState.nodePos.get(n.id)?.y ?? 0) + NH + VGAP)));

  const container = document.createElement("div");
  container.className = "kctg-chart-container";
  container.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;`;
  container.style.transform = `translate(${_chartState.pan.x}px,${_chartState.pan.y}px) scale(${_chartState.zoom})`;
  wrap.appendChild(container);

  const NS  = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.classList.add("kctg-chart-svg");
  svg.setAttribute("width", totalW); svg.setAttribute("height", totalH);
  container.appendChild(svg);

  // ── DOM nodes with per-node drag ────────────────────────────────────────────
  const domNodes = new Map();
  for (const n of allNodes) {
    const pos = _chartState.nodePos.get(n.id) ?? { x: PAD, y: PAD };
    const div = document.createElement("div");
    div.className = `kctg-chart-node kctg-chart-node--${n.kind}`;
    div.dataset.id = n.id;
    div.style.cssText = `left:${pos.x}px;top:${pos.y}px;width:${NW}px;`;
    if (n.img) { const img = document.createElement("img"); img.src = n.img; img.alt = ""; img.className = "kctg-chart-node-img"; div.appendChild(img); }
    const lbl = document.createElement("span"); lbl.className = "kctg-chart-node-label"; lbl.textContent = n.label; lbl.title = n.label;
    div.appendChild(lbl);
    container.appendChild(div);
    domNodes.set(n.id, div);

    let nodeDragging = false, ox = 0, oy = 0;
    div.addEventListener("mousedown", e => {
      e.stopPropagation();
      nodeDragging = true;
      // Account for zoom: mouse coords are in screen space, pos is in content space
      ox = e.clientX / _chartState.zoom - pos.x;
      oy = e.clientY / _chartState.zoom - pos.y;
      div.style.zIndex = "10";
    });
    window.addEventListener("mousemove", e => {
      if (!nodeDragging) return;
      pos.x = e.clientX / _chartState.zoom - ox;
      pos.y = e.clientY / _chartState.zoom - oy;
      _chartState.nodePos.set(n.id, { x: pos.x, y: pos.y });
      div.style.left = pos.x + "px";
      div.style.top  = pos.y + "px";
      _redrawChartLines(svg, edges, domNodes, NW, NH);
    }, sig);
    window.addEventListener("mouseup", () => { nodeDragging = false; div.style.zIndex = ""; }, sig);
  }
  _redrawChartLines(svg, edges, domNodes, NW, NH);
  _updateZoomLabel(rootEl, _chartState.zoom);

  // ── Canvas pan (drag background) ────────────────────────────────────────────
  let panDragging = false, px = 0, py = 0;
  wrap.addEventListener("mousedown", e => {
    if (e.target !== wrap) return;
    panDragging = true;
    px = e.clientX - _chartState.pan.x;
    py = e.clientY - _chartState.pan.y;
    wrap.style.cursor = "grabbing";
  }, sig);
  window.addEventListener("mousemove", e => {
    if (!panDragging) return;
    _chartState.pan.x = e.clientX - px;
    _chartState.pan.y = e.clientY - py;
    container.style.transform = `translate(${_chartState.pan.x}px,${_chartState.pan.y}px) scale(${_chartState.zoom})`;
  }, sig);
  window.addEventListener("mouseup", () => { panDragging = false; wrap.style.cursor = ""; }, sig);

  // ── Mouse-wheel zoom (zoom toward cursor) ────────────────────────────────────
  wrap.addEventListener("wheel", e => {
    e.preventDefault();
    const rect   = wrap.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor  = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.min(3, Math.max(0.2, _chartState.zoom * factor));
    // Adjust pan so the point under the mouse stays fixed
    _chartState.pan.x = mouseX - (mouseX - _chartState.pan.x) * (newZoom / _chartState.zoom);
    _chartState.pan.y = mouseY - (mouseY - _chartState.pan.y) * (newZoom / _chartState.zoom);
    _chartState.zoom  = newZoom;
    container.style.transform = `translate(${_chartState.pan.x}px,${_chartState.pan.y}px) scale(${_chartState.zoom})`;
    _updateZoomLabel(rootEl, _chartState.zoom);
  }, { passive: false, signal: ac.signal });
}

/** Wire the chart toolbar buttons (zoom +/-, reset view, reset layout).
 *  Called from _onRender of both RecipeManagerApp and RecipeChartApp. */
function _wireChartToolbar(el, rebuildFn) {
  const ZOOM_STEP = 1.2;
  el.querySelector(".kctg-chart-zoom-in")?.addEventListener("click", () => {
    _chartState.zoom = Math.min(3, _chartState.zoom * ZOOM_STEP);
    const container = el.querySelector(".kctg-chart-container");
    if (container) container.style.transform = `translate(${_chartState.pan.x}px,${_chartState.pan.y}px) scale(${_chartState.zoom})`;
    _updateZoomLabel(el, _chartState.zoom);
  });
  el.querySelector(".kctg-chart-zoom-out")?.addEventListener("click", () => {
    _chartState.zoom = Math.max(0.2, _chartState.zoom / ZOOM_STEP);
    const container = el.querySelector(".kctg-chart-container");
    if (container) container.style.transform = `translate(${_chartState.pan.x}px,${_chartState.pan.y}px) scale(${_chartState.zoom})`;
    _updateZoomLabel(el, _chartState.zoom);
  });
  el.querySelector(".kctg-chart-reset-view")?.addEventListener("click", () => {
    _chartState.pan.x = 20; _chartState.pan.y = 20; _chartState.zoom = 1;
    rebuildFn();
  });
  el.querySelector(".kctg-chart-reset-pos")?.addEventListener("click", () => {
    _chartState.nodePos.clear();
    rebuildFn();
  });
}

/** Wire the chart sidebar's folder-grouped checkbox list (collapse, folder
 *  checkboxes, recipe checkboxes). Shared by RecipeManagerApp's Chart tab and
 *  the standalone RecipeChartApp. Re-renders the app so counts, folder
 *  checkbox states and the chart itself stay in sync. */
function _wireChartSidebarList(el, app, selectedIds, collapsedSet, getFilter) {
  // Folder collapse / expand
  el.querySelectorAll(".kctg-chart-group-row .kctg-group-main").forEach(main =>
    main.addEventListener("click", () => {
      const id = main.closest(".kctg-chart-group-row")?.dataset.folderId;
      if (!id) return;
      if (collapsedSet.has(id)) collapsedSet.delete(id); else collapsedSet.add(id);
      app.render();
    })
  );

  // Folder checkbox — toggles every recipe in that folder (respecting the filter)
  el.querySelectorAll(".kctg-chart-folder-check").forEach(cb => {
    if (cb.dataset.indeterminate) cb.indeterminate = true;
    cb.addEventListener("change", () => {
      const fid = cb.dataset.folderId;
      const f = (getFilter() ?? "").toLowerCase();
      for (const r of getRecipes()) {
        if (r.folderId !== fid) continue;
        if (f && !r.name.toLowerCase().includes(f)) continue;
        if (cb.checked) selectedIds.add(r.id); else selectedIds.delete(r.id);
      }
      app.render();
    });
  });

  // Individual recipe checkbox
  el.querySelectorAll(".kctg-chart-recipe-check").forEach(cb =>
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIds.add(cb.dataset.id); else selectedIds.delete(cb.dataset.id);
      app.render();
    })
  );
}

// ─── RECIPE CHART ─────────────────────────────────────────────────────────────

class RecipeChartApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(options = {}) {
    super(options);
    this._selectedIds = new Set(getRecipes().map(r => r.id));
    this._knownIds    = new Set(this._selectedIds);
    this._collapsed   = new Set();
    this._filter      = "";
    // nodePos / pan / zoom live in module-level _chartState (shared with inline tab)
  }

  static DEFAULT_OPTIONS = {
    id: "kctg-forge--chart", classes: ["kctg-module", "kctg-chart-app"],
    window: { title: "Recipe Dependency Chart", resizable: true },
    position: { width: 1000, height: 700 }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/forge/recipe-chart.hbs` } };

  async _prepareContext() {
    const recipes = getRecipes();
    // Newly created recipes default to selected (once) — deselected ones stay off
    recipes.forEach(r => { if (!this._knownIds.has(r.id)) { this._knownIds.add(r.id); this._selectedIds.add(r.id); } });
    const chartItems = _buildChartListItems(recipes, getFolders(), this._selectedIds, this._filter, this._collapsed);
    return { chartItems, chartFilter: this._filter };
  }

  _onRender(context, options) {
    const el = this.element;
    _applyTheme(el);

    el.querySelector(".kctg-chart-filter")?.addEventListener("input", e => {
      this._filter = e.target.value; this.render();
    });
    el.querySelector(".kctg-chart-select-all")?.addEventListener("click", () => {
      getRecipes().forEach(r => this._selectedIds.add(r.id)); this.render();
    });
    el.querySelector(".kctg-chart-select-none")?.addEventListener("click", () => {
      this._selectedIds.clear(); this.render();
    });
    _wireChartSidebarList(el, this, this._selectedIds, this._collapsed, () => this._filter);

    _wireChartToolbar(el, () => this._buildChart(el));
    this._buildChart(el);
  }

  // ── Build chart — delegates to shared helper ──────────────────────────
  _buildChart(el) {
    const wrap = el.querySelector(".kctg-chart-canvas");
    if (!wrap) return;
    const recipes = getRecipes().filter(r => this._selectedIds.has(r.id));
    _buildRecipeChart(wrap, recipes, el);
  }
}

// ─── OPEN HELPERS ─────────────────────────────────────────────────────────────

function openCraft(actor) {
  const target = actor ?? canvas.tokens?.controlled?.[0]?.actor ?? game.user?.character ?? null;
  CraftApp.open(target);
}

function openChart() {
  new RecipeChartApp().render(true);
}

// Campaign dashboard open hook
Hooks.on("kctg:openForge", () => openCraft());

// ─── CROSS-MODULE: re-render forge if a quest unlocks a recipe ────────────────
Hooks.on("kctg:questCompleted", () => {
  for (const app of foundry.applications.instances?.values() ?? []) {
    if (app instanceof CraftApp && app.rendered) app.render();
  }
});

// ─── TOKEN CONTROLS ───────────────────────────────────────────────────────────

Hooks.on("getSceneControlButtons", controls => {
  _addToKctgGroup(controls, {
    name: "kctg-forge-open", title: "Forge",
    icon: "fas fa-hammer", button: true,
    onChange: () => {
      const ex = foundry.applications.instances?.get("kctg-forge--craft");
      if (ex?.rendered) ex.close(); else openCraft();
    },
  });
});

// ─── READY ────────────────────────────────────────────────────────────────────

// ─── REACTIVE RE-RENDER ───────────────────────────────────────────────────────
// Re-render open Forge apps whenever any Forge data setting changes, so a
// second GM client sees updates immediately without polling.

const _FORGE_DATA_KEYS = new Set([
  `${MODULE_ID}.recipes`, `${MODULE_ID}.folders`, `${MODULE_ID}.craftingLog`,
  `${MODULE_ID}.craftApprovals`, `${MODULE_ID}.craftApproved`, `${MODULE_ID}.craftApprovedOnce`, `${MODULE_ID}.craftNpcActors`,
  `${MODULE_ID}.craftTemplates`,
]);
Hooks.on("updateSetting", setting => {
  if (!_FORGE_DATA_KEYS.has(setting.key)) return;
  foundry.applications.instances?.get("kctg-forge--recipe-manager")?.render();
  foundry.applications.instances?.get("kctg-forge--craft")?.render();
  foundry.applications.instances?.get("kctg-forge--chart")?.render();
});

// Player-side: re-render the open Forge when THIS user's own flags change. The GM's
// approval writes the one-time approval (and clears the pending request) onto the
// player's user flag, so this flips the "Request GM Approval" gate to "Craft" without
// the player needing to reopen the app. Also keeps the craft-job queue display fresh.
Hooks.on("updateUser", (user, changes) => {
  if (user.id !== game.user.id) return;
  if (foundry.utils.getProperty(changes, `flags.${MODULE_ID}`) !== undefined) {
    foundry.applications.instances?.get("kctg-forge--craft")?.render();
  }
});

Hooks.once("ready", async () => {
  // ── Socket handler ──────────────────────────────────────────────────────────
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    // GM receives a live notification ping when a player submits (request already saved in player flag)
    if (data.type === "approvalPing" && game.user.isGM) {
      ui.notifications.info(`⚒️ Craft approval request from ${data.userName}: "${data.recipeName}"`);
      foundry.applications.instances?.get("kctg-forge--recipe-manager")?.render();
    }

    // Players can't write world settings — the single responsible GM handles
    // craft log entries on their behalf (and rosters the crafting actor).
    if (data.type === "craftLogEntry" && game.user.isGM
        && game.users.find(u => u.isGM && u.active)?.id === game.user.id) {
      const log = getCraftLog();
      log.push(data.entry);
      if (log.length > 200) log.splice(0, log.length - 200);
      await saveCraftLog(log);
      await _rosterAddActors([data.entry?.actorId]);
    }

    if (data.type === "approvalDecision" && data.userId === game.user.id) {
      // The authoritative one-time approval is already recorded GM-side in the
      // craftApprovedOnce world setting; the player just refreshes their UI.
      const craftApp = foundry.applications.instances?.get("kctg-forge--craft");
      if (data.approved) {
        ui.notifications.info("✅ Craft approved! Open the Forge and click Craft to proceed.");
      } else {
        ui.notifications.warn("❌ Your craft request was rejected by the GM.");
      }
      if (craftApp) { craftApp._pendingApprovalId = null; craftApp.render(); }
    }

    // Player-delegated consumption of a one-time approval (players can't write world settings).
    if (data.type === "consumeOneTimeApproval" && game.user.isGM
        && game.users.find(u => u.isGM && u.active)?.id === game.user.id) {
      await consumeOneTimeApproval(data.userId, data.recipeId, data.hash);
    }
  });

  // ── Drain craft log entries buffered while no GM was online ─────────────────
  if (game.user.isGM) {
    const log = getCraftLog();
    let changed = false;
    const drainedActorIds = [];
    for (const user of game.users.filter(u => !u.isGM)) {
      const pending = user.getFlag(MODULE_ID, "pendingLogEntries") ?? [];
      if (pending.length) {
        log.push(...pending);
        drainedActorIds.push(...pending.map(e => e.actorId));
        await user.setFlag(MODULE_ID, "pendingLogEntries", []);
        changed = true;
      }
    }
    if (changed) {
      if (log.length > 200) log.splice(0, log.length - 200);
      await saveCraftLog(log);
      await _rosterAddActors(drainedActorIds);
    }
  }

  const _forgeMod = game.modules.get(MODULE_ID);
  _forgeMod.api ??= {};
  Object.assign(_forgeMod.api, {
    openCraft,
    openChart,
    openRecipeManager:   () => new RecipeManagerApp({ source: "world" }).render(true),
    openPersonalManager: () => new RecipeManagerApp({ source: "personal" }).render(true),
    openPlayersManager:  () => new RecipeManagerApp({ source: "players" }).render(true),
    openLog:             () => new RecipeManagerApp({ source: "log" }).render(true),
    openApprovals:       () => new RecipeManagerApp({ source: "approvals" }).render(true),
  });
  console.log("%c⚒️ KCTG Forge | Ready", "color:#c9a84c;font-weight:bold;");
});
