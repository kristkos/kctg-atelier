/**
 * KCTG – Quests  |  FoundryVTT v14
 *
 * Storage  : one JournalEntry, pages = groups + quests
 * Groups   : page with flags.kctg-quests.isGroup = true
 * Quests   : page with flags.kctg-quests.* data
 * Chaining : objective.triggersQuestId → reveals a hidden quest on completion
 */

import { MODULE_ID, applyTheme as _applyTheme, _addToKctgGroup, safeFromUuid, newId, esc, logActivity } from "./main.mjs";
const JOURNAL_FLAG = "isQuestJournal";

// Quest lifecycle. NOTE: these values ("in-progress"/"completed") intentionally differ
// from Workshop task statuses ("active"/"complete", workshop.mjs) and Forge craft-job
// statuses ("inprogress"/"ready", forge.mjs). Each domain owns its own enum and they are
// never compared across domains (the Dashboard counts each separately).
const STATUS = {
  IN_PROGRESS: "in-progress",
  COMPLETED:   "completed",
  FAILED:      "failed",
  HIDDEN:      "hidden",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function statusLabel(s) {
  return { "in-progress": "In Progress", completed: "Completed", failed: "Failed", hidden: "Hidden" }[s] ?? "In Progress";
}

function statusIcon(s) {
  return {
    "in-progress": "fas fa-spinner",
    completed:     "fas fa-check-circle",
    failed:        "fas fa-times-circle",
    hidden:        "fas fa-eye-slash",
  }[s] ?? "fas fa-spinner";
}

const VIS_ICON = { world: "globe", party: "users", personal: "user-lock" };

// ─── INIT ─────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {

  game.settings.register(MODULE_ID, "journalId", {
    name: "Quest Journal ID", scope: "world", config: false, type: String, default: "",
  });

  game.keybindings.register(MODULE_ID, "openQuests", {
    name:     "Open Quest Journal",
    hint:     "Toggles the KCTG Quest tracker.",
    editable: [{ key: "KeyJ" }],
    onDown:   () => { QuestApp.toggle(); return true; },
  });

});

// ─── JOURNAL HELPERS ──────────────────────────────────────────────────────────

function getQuestJournal() {
  const stored = game.settings.get(MODULE_ID, "journalId");
  return game.journal.get(stored) ?? game.journal.find(j => j.getFlag(MODULE_ID, JOURNAL_FLAG));
}

async function getOrCreateJournal() {
  let j = getQuestJournal();
  if (!j) {
    j = await JournalEntry.create({
      name:      "Quest Journal",
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    });
    await j.setFlag(MODULE_ID, JOURNAL_FLAG, true);
  }
  await game.settings.set(MODULE_ID, "journalId", j.id);
  return j;
}

async function syncOwnership(page, visibility, ownerIds = []) {
  const { NONE, OBSERVER, OWNER } = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const ownership = { default: NONE };
  if (visibility === "world" || visibility === "party") ownership.default = OBSERVER;
  else if (visibility === "personal") for (const uid of ownerIds) ownership[uid] = OWNER;
  await page.update({ ownership });
}

/** Serialise a quest page into a plain object for templates. */
function pageToQuest(page) {
  const f   = page.flags?.[MODULE_ID] ?? {};
  const st  = f.status     ?? STATUS.IN_PROGRESS;
  const vis = f.visibility ?? "world";
  return {
    id:          page.id,
    name:        page.name,
    img:         page.src ?? "",
    status:      st,
    statusIcon:  statusIcon(st),
    statusLabel: statusLabel(st),
    visibility:  vis,
    visIcon:     VIS_ICON[vis] ?? "globe",
    groupId:     f.groupId     ?? "",
    ownerIds:    f.ownerIds    ?? [],
    description: f.description ?? "",
    // Migrate legacy single-giver fields to givers array on the fly
    givers: (f.givers ?? (f.giverUuid ? [{ id: f.giverUuid, uuid: f.giverUuid, name: f.giverName ?? "", img: f.giverImg ?? "" }] : [])),
    rewards:     f.rewards     ?? [],
    objectives:  (f.objectives ?? []).map(o => ({
      ...o,
      parentId:         o.parentId         ?? "",
      status:           o.status           ?? STATUS.IN_PROGRESS,
      triggersQuestId:  o.triggersQuestId  ?? "",
      hidden:           o.hidden           ?? false,
      highlighted:      o.highlighted      ?? false,
      statusIcon:       statusIcon(o.status ?? STATUS.IN_PROGRESS),
    })),
  };
}

function openFilePicker(current, cb) {
  new foundry.applications.apps.FilePicker.implementation({ type: "image", current: current || "icons/", callback: cb, activeSource: "data" }).render(true);
}

/** Returns non-GM users who are allowed to see a quest page. */
function _getUsersForQuest(page) {
  const f   = page.flags?.[MODULE_ID] ?? {};
  const vis = f.visibility ?? "world";
  return game.users.filter(u => {
    if (u.isGM) return false;
    if (f.status === STATUS.HIDDEN) return false;
    if (vis === "personal") return (f.ownerIds ?? []).includes(u.id);
    return true;
  });
}

// ─── QUEST APP ────────────────────────────────────────────────────────────────

class QuestApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(options = {}) {
    super(options);
    this._selectedId = null;
    this._filter     = "all";
    this._editMode   = false;
    this._collapsed  = new Set();
    this._activeTab  = "quests";
    this._listDrag   = null;
  }

  static DEFAULT_OPTIONS = {
    id:       "kctg-quests--app",
    classes:  ["kctg-module", "kctg-quest-app"],
    window:   { title: "Quest Journal", resizable: true },
    position: { width: 820, height: 660 },
  };

  static PARTS = {
    main: {
      template:   `modules/${MODULE_ID}/templates/quests/quest-app.hbs`,
      scrollable: [".kctg-quest-list", ".kctg-quest-detail-scroll"],
    },
  };

  // ── Singleton: one persistent instance, state survives open/close ──────────
  static _instance = null;

  static open() {
    if (QuestApp._instance && !QuestApp._instance.rendered) {
      QuestApp._instance.render(true);
      return QuestApp._instance;
    }
    if (QuestApp._instance?.rendered) {
      QuestApp._instance.bringToFront();
      return QuestApp._instance;
    }
    QuestApp._instance = new QuestApp();
    QuestApp._instance.render(true);
    return QuestApp._instance;
  }

  static toggle() {
    if (QuestApp._instance?.rendered) {
      QuestApp._instance.close();
      return null;
    }
    return QuestApp.open();
  }
  // ── Context ──────────────────────────────────────────────────────────────

  async _prepareContext() {
    const journal = getQuestJournal();
    const isGM    = game.user.isGM;

    // Separate group-pages from quest-pages
    const groups      = [];  // { id, name, collapsed, questCount }
    const groupMap    = {};  // id → group
    const byGroup     = {};  // groupId → quest[]
    const ungrouped   = [];

    if (journal) {
      const sorted = [...journal.pages].sort((a, b) => a.sort - b.sort);

      // First pass: collect groups (respecting saved groupOrder)
      const groupOrder = journal.getFlag(MODULE_ID, "groupOrder") ?? [];
      const rawGroups  = [];
      for (const page of sorted) {
        if (!page.testUserPermission(game.user, "OBSERVER")) continue;
        const f = page.flags?.[MODULE_ID] ?? {};
        if (!f.isGroup) continue;
        const g = { id: page.id, name: page.name, collapsed: this._collapsed.has(page.id), color: page.flags?.[MODULE_ID]?.groupColor || null };
        rawGroups.push(g);
        groupMap[page.id] = g;
        byGroup[page.id]  = [];
      }
      // Sort by saved order; any unordered groups go to the end
      rawGroups.sort((a, b) => {
        const ia = groupOrder.indexOf(a.id);
        const ib = groupOrder.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
      groups.push(...rawGroups);

      // Second pass: collect quests
      const questOrder = journal.getFlag(MODULE_ID, "questOrder") ?? [];
      for (const page of sorted) {
        if (!page.testUserPermission(game.user, "OBSERVER")) continue;
        const f = page.flags?.[MODULE_ID] ?? {};
        if (f.isGroup) continue;
        const q = pageToQuest(page);
        if (!isGM && q.status === STATUS.HIDDEN) continue;
        if (f.groupId && groupMap[f.groupId]) byGroup[f.groupId].push(q);
        else ungrouped.push(q);
      }
      // Sort quests by explicit questOrder flag (unordered quests go to end)
      const _byOrder = arr => arr.sort((a, b) => {
        const ia = questOrder.indexOf(a.id), ib = questOrder.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1; if (ib === -1) return -1;
        return ia - ib;
      });
      for (const gId of Object.keys(byGroup)) _byOrder(byGroup[gId]);
      _byOrder(ungrouped);
    }

    // Mark unread quests (client-side localStorage)
    const unreadIds = _getUnreadIds();
    for (const list of [ungrouped, ...Object.values(byGroup)]) {
      for (const q of list) q.isUnread = unreadIds.includes(q.id);
    }

    // Apply filter
    const applyFilter = qs => this._filter === "all" ? qs : qs.filter(q => q.status === this._filter);

    // Build flat list items for template
    const filterActive = this._filter !== "all";
    const listItems = [];
    for (const g of groups) {
      const gQuests    = applyFilter(byGroup[g.id] ?? []);
      const totalInGrp = (byGroup[g.id] ?? []).length;
      // Non-GMs should not see folders whose quests are all invisible to them
      if (!isGM && totalInGrp === 0) continue;
      // When a status filter is active, suppress folder headers entirely
      if (!filterActive) {
        listItems.push({ isGroup: true, ...g, questCount: totalInGrp, filteredCount: gQuests.length, isGM });
      }
      if (filterActive || !g.collapsed) {
        for (const q of gQuests) listItems.push({ isGroup: false, inGroup: !filterActive, ...q });
      }
    }
    for (const q of applyFilter(ungrouped)) listItems.push({ isGroup: false, inGroup: false, ...q });

    // Guard: ensure selectedId still refers to a visible quest
    const allQuests = [...ungrouped, ...Object.values(byGroup).flat()];
    if (this._selectedId && !allQuests.find(q => q.id === this._selectedId)) {
      this._selectedId = null;
      this._editMode   = false;
    }

    const selected = allQuests.find(q => q.id === this._selectedId) ?? null;

    let canEdit = false;
    if (selected && journal) {
      const page = journal.pages.get(selected.id);
      canEdit = page?.canUserModify(game.user, "update") ?? false;
    }

    // Enrich rewards — non-GMs never see hidden ones
    let enrichedRewards = [];
    if (selected) {
      const visibleRewards = isGM ? selected.rewards : (selected.rewards ?? []).filter(r => !r.hidden);
      enrichedRewards = await Promise.all(visibleRewards.map(async r => {
        if (r.type !== "item") return { ...r };
        const item = await safeFromUuid(r.uuid);
        return { ...r, resolvedName: item?.name ?? r.name ?? "Unknown", img: item?.img ?? "icons/svg/item-bag.svg" };
      }));
    }

    // Objectives visible to this user (non-GMs skip hidden ones)
    const visibleObjectives = selected
      ? (isGM ? selected.objectives : (selected.objectives ?? []).filter(o => !o.hidden))
      : [];

    const allUsers = game.users
      .filter(u => !u.isGM)
      .map(u => ({ id: u.id, name: u.name, isOwner: (selected?.ownerIds ?? []).includes(u.id) }));

    // Group options for the assignment dropdown (in detail edit)
    const groupOptions = [
      { id: "", name: "(No Group)" },
      ...groups.map(g => ({ id: g.id, name: g.name })),
    ];

    // Quest options for objective chaining (all visible quests)
    const allQuestOptions = [
      { id: "", name: "(None — no trigger)" },
      ...allQuests.map(q => ({ id: q.id, name: q.name })),
    ];

    // Build objective tree (main objectives + their sub-objectives)
    const mainObjs  = visibleObjectives.filter(o => !o.parentId);
    const subObjMap = {};
    for (const o of visibleObjectives) {
      if (o.parentId) {
        if (!subObjMap[o.parentId]) subObjMap[o.parentId] = [];
        subObjMap[o.parentId].push(o);
      }
    }
    const objectiveTree = mainObjs.map(o => ({ ...o, subObjectives: subObjMap[o.id] ?? [] }));

    // Enrich description HTML so @UUID links, entity links, etc. work in view mode
    let enrichedDescription = "";
    if (selected) {
      const descPage = journal?.pages.get(selected.id);
      try {
        enrichedDescription = await foundry.applications.ux.TextEditor.implementation.enrichHTML(selected.description ?? "", {
          async:      true,
          relativeTo: descPage,
        });
      } catch { enrichedDescription = selected.description ?? ""; }
    }

    // Build a context-safe selected that has filtered objectives
    const selectedCtx = selected ? { ...selected, objectives: visibleObjectives, objectiveTree } : null;

    // Completion announcement (edit UI). Speaker = explicit override, else the first quest giver.
    let announce = null;
    if (selected) {
      const a = journal?.pages.get(selected.id)?.flags?.[MODULE_ID]?.announce ?? {};
      let speaker = null;
      if (a.actorUuid) {
        const sp = await safeFromUuid(a.actorUuid);
        speaker = {
          name:       sp?.name ?? a.name ?? "Unknown",
          img:        sp?.img  ?? a.img  ?? "icons/svg/mystery-man.svg",
          isOverride: true,
        };
      } else if (selected.givers?.length) {
        speaker = { name: selected.givers[0].name, img: selected.givers[0].img, isOverride: false };
      }
      announce = { text: a.text ?? "", onSave: !!a.onSave, speaker };
    }

    return {
      listItems, selected: selectedCtx, canEdit, isGM,
      editMode:          this._editMode && canEdit,
      filter:            this._filter,
      selectedId:        this._selectedId,
      enrichedRewards,   allUsers,
      groupOptions,      allQuestOptions,
      journalMissing:    !journal,
      enrichedDescription,
      announce,
    };
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  _onRender(context, options) {  // NOTE: not async — PM init runs in an async IIFE below
    // Apply selected theme class
    _applyTheme(this.element);
    const el      = this.element;
    const journal = getQuestJournal();
    const selPage = () => journal?.pages.get(this._selectedId);

    // ── Filter buttons ───────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-q-filter-btn").forEach(btn =>
      btn.addEventListener("click", () => { this._filter = btn.dataset.filter; this.render(); })
    );

    // ── Group collapse toggle ────────────────────────────────────────────────
    el.querySelectorAll(".kctg-group-main").forEach(div =>
      div.addEventListener("click", () => {
        const id = div.closest(".kctg-group-row").dataset.id;
        if (this._collapsed.has(id)) this._collapsed.delete(id);
        else this._collapsed.add(id);
        this.render();
      })
    );

    // ── Group right-click context menu (GM only) ─────────────────────────────
    if (game.user.isGM) {
      const _showGroupMenu = (e, id) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        document.querySelector(".kctg-ctx-menu")?.remove();
        const page = journal?.pages.get(id); if (!page) return;

        const menu = document.createElement("div");
        menu.className = "kctg-ctx-menu";
        const x = Math.min(e.clientX, window.innerWidth  - 165);
        const y = Math.min(e.clientY, window.innerHeight - 130);
        // Set position explicitly inline — don't rely solely on the CSS class
        // so Foundry's app transforms can't affect it.
        menu.style.position = "fixed";
        menu.style.left = x + "px";
        menu.style.top  = y + "px";

        const _item = (icon, label, cb, danger = false) => {
          const btn = document.createElement("button");
          btn.className = "kctg-ctx-item" + (danger ? " kctg-ctx-danger" : "");
          btn.innerHTML = `<i class="${icon}"></i>${label}`;
          btn.addEventListener("click", () => { menu.remove(); cb(); });
          menu.appendChild(btn);
        };

        _item("fas fa-palette", "Change Color", async () => {
          const cur = page.flags?.[MODULE_ID]?.groupColor || "#f5b430";
          const result = await foundry.applications.api.DialogV2.wait({
            window: { title: "Folder Colour" },
            content: `<div style="padding:8px 0;display:flex;align-items:center;gap:12px">
                        <label for="kctg-color-pick">Colour:</label>
                        <input id="kctg-color-pick" type="color" name="groupColor" value="${cur}"
                               style="width:52px;height:32px;cursor:pointer;border:none;padding:0;background:none"/>
                      </div>`,
            buttons: [
              { label: "Apply",         action: "apply",  default: true,
                callback: (_ev, b) => b.form.querySelector("[name=groupColor]")?.value || null },
              { label: "Remove colour", action: "reset",  callback: () => "RESET" },
              { label: "Cancel",        action: "cancel", callback: () => "CANCEL" },
            ],
          }).catch(() => "CANCEL");
          if (!result || result === "CANCEL") return;
          await page.setFlag(MODULE_ID, "groupColor", result === "RESET" ? null : result);
          this.render();
        });

        _item("fas fa-pencil-alt", "Rename", async () => {
          const name = await foundry.applications.api.DialogV2.prompt({
            window:  { title: "Rename Group" },
            content: `<label style="display:flex;flex-direction:column;gap:4px;padding:4px 0">
                        Group name
                        <input type="text" name="groupName" value="${page.name}" autofocus style="width:100%"/>
                      </label>`,
            ok: { label: "Rename", callback: (_ev, b) => new FormData(b.form).get("groupName") },
          }).catch(() => null);
          if (name?.trim()) { await page.update({ name: name.trim() }); this.render(); }
        });

        menu.appendChild(Object.assign(document.createElement("div"), { className: "kctg-ctx-divider" }));

        _item("fas fa-trash", "Delete Group", async () => {
          const members = [...journal.pages].filter(p => p.flags?.[MODULE_ID]?.groupId === id);
          for (const p of members) await p.setFlag(MODULE_ID, "groupId", "");
          await page.delete(); this.render();
        }, true);

        document.body.appendChild(menu);
        const close = ev => {
          if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("mousedown", close); }
        };
        setTimeout(() => document.addEventListener("mousedown", close), 0);
      };

      el.querySelectorAll(".kctg-group-row").forEach(row =>
        row.addEventListener("contextmenu", e => _showGroupMenu(e, row.dataset.id))
      );
    }

    // ── Quest row selection ──────────────────────────────────────────────────
    el.querySelectorAll(".kctg-quest-row").forEach(row =>
      row.addEventListener("click", () => {
        _clearUnreadId(row.dataset.id);
        row.classList.remove("kctg-quest-unread");
        if (this._selectedId === row.dataset.id) return;
        this._selectedId = row.dataset.id;
        this._editMode   = false;
        this.render();
      })
    );

    // ── New quest ────────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-new-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const jrn = await getOrCreateJournal();
      const [page] = await jrn.createEmbeddedDocuments("JournalEntryPage", [{
        name:      "New Quest",
        type:      "text",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        flags: {
          [MODULE_ID]: {
            status: STATUS.IN_PROGRESS, visibility: "world",
            objectives: [], rewards: [], ownerIds: [], description: "",
            givers: [], groupId: "",
          },
        },
      }]);
      this._selectedId = page.id;
      this._editMode   = true;
      this.render();
    });

    // ── New group ────────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-new-group-btn")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const jrn = await getOrCreateJournal();
      await jrn.createEmbeddedDocuments("JournalEntryPage", [{
        name:  "New Group",
        type:  "text",
        flags: { [MODULE_ID]: { isGroup: true } },
      }]);
      this.render();
    });

    // ── Edit / Done ──────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-edit-btn")?.addEventListener("click", async () => {
      const wasEditing = this._editMode;
      this._editMode = !this._editMode;
      if (wasEditing && this._selectedId) {
        const page = journal?.pages.get(this._selectedId);
        // Flush PM editor content NOW — disconnectedCallback fires after render(), too late.
        const pmEl = el.querySelector("[name='kctg-desc']");
        if (pmEl?.value !== undefined) await page?.setFlag(MODULE_ID, "description", pmEl.value);

        // Flush announcement fields straight from the DOM (their change events may not
        // have committed yet), then post the line if "Send on Done" is ticked.
        if (page) {
          const annText   = el.querySelector(".kctg-q-announce-text")?.value;
          const annOnSave = el.querySelector(".kctg-q-announce-onsave")?.checked;
          if (annText !== undefined || annOnSave !== undefined) {
            const cur = page.flags?.[MODULE_ID]?.announce ?? {};
            const next = { ...cur };
            if (annText   !== undefined) next.text   = annText;
            if (annOnSave !== undefined) next.onSave = annOnSave;
            await page.setFlag(MODULE_ID, "announce", next);
          }
          const ann = page.flags?.[MODULE_ID]?.announce;
          if (ann?.onSave && String(ann.text ?? "").trim()) {
            // publishedOnce is set just below, so it still reads false on a first publish.
            const isNew = !page.flags?.[MODULE_ID]?.publishedOnce;
            await _postQuestAnnouncement(page, isNew);
          }
        }
        if (page && page.flags?.[MODULE_ID]?.status !== STATUS.HIDDEN) {
          const isNew = !page.flags?.[MODULE_ID]?.publishedOnce;
          if (isNew) await page.setFlag(MODULE_ID, "publishedOnce", true);
          _showQuestToast(page, isNew);
          // Persist notification for offline-eligible users so they see it on next login
          for (const u of _getUsersForQuest(page)) {
            if (u.active) continue; // online players get the socket broadcast
            const pending = u.getFlag(MODULE_ID, "pendingNotifs") ?? [];
            if (!pending.find(n => n.pageId === page.id)) {
              pending.push({ pageId: page.id, isNew });
              await u.setFlag(MODULE_ID, "pendingNotifs", pending);
            }
          }
          game.socket.emit(`module.${MODULE_ID}`, { type: "kctg-quest-notify", pageId: page.id, isNew });
        }
      }
      this.render();
    });

    // ── Delete quest ─────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-delete-btn")?.addEventListener("click", async () => {
      if (!context.isGM) return;
      await selPage()?.delete();
      this._selectedId = null;
      this._editMode   = false;
      this.render();
    });

    // ── Name ─────────────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-name-input")?.addEventListener("change", async e => {
      await selPage()?.update({ name: e.target.value });
    });

    // ── Description — v14 ProseMirror via HTMLProseMirrorElement ────────────────
    const pmWrap = el.querySelector(".kctg-desc-pm-wrap");
    if (pmWrap && context.editMode) {
      const page    = selPage();
      const rawHtml = page?.flags?.[MODULE_ID]?.description ?? "";
      const pmEl    = foundry.applications.elements.HTMLProseMirrorElement.create({
        name:  "kctg-desc",
        value: rawHtml,
      });
      pmEl.style.minHeight = "160px";
      pmWrap.appendChild(pmEl);
      // change fires when the editor saves (also on disconnectedCallback → auto-saves on re-render/close)
      pmEl.addEventListener("change", async () => {
        await page?.setFlag(MODULE_ID, "description", pmEl.value);
      });
    }




    // ── Status ───────────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-status-select")?.addEventListener("change", async e => {
      await selPage()?.setFlag(MODULE_ID, "status", e.target.value);
      this.render();
    });

    // ── Visibility ───────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-vis-select")?.addEventListener("change", async e => {
      const page = selPage(); if (!page) return;
      const vis      = e.target.value;
      const ownerIds = page.flags[MODULE_ID]?.ownerIds ?? [];
      await page.setFlag(MODULE_ID, "visibility", vis);
      await syncOwnership(page, vis, ownerIds);
      this.render();
    });

    // ── Group assignment ─────────────────────────────────────────────────────
    el.querySelector(".kctg-q-group-select")?.addEventListener("change", async e => {
      await selPage()?.setFlag(MODULE_ID, "groupId", e.target.value);
      this.render();
    });

    // ── Image picker ─────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-img-pick")?.addEventListener("click", () => {
      const page = selPage();
      openFilePicker(page?.src ?? "icons/", async path => {
        await page?.update({ src: path });
        this.render();
      });
    });

    // ── Image clear ───────────────────────────────────────────────────────────
    el.querySelector(".kctg-q-img-clear")?.addEventListener("click", async () => {
      await selPage()?.update({ src: "" });
      this.render();
    });

    // ── Ownership (no re-render — avoids race with async write) ─────────────
    el.querySelectorAll(".kctg-q-owner-toggle").forEach(cb =>
      cb.addEventListener("change", async e => {
        const page = selPage(); if (!page) return;
        let ownerIds = [...(page.flags[MODULE_ID]?.ownerIds ?? [])];
        if (e.target.checked) { if (!ownerIds.includes(e.target.value)) ownerIds.push(e.target.value); }
        else ownerIds = ownerIds.filter(id => id !== e.target.value);
        const vis = page.flags[MODULE_ID]?.visibility ?? "world";
        await page.setFlag(MODULE_ID, "ownerIds", ownerIds);
        await syncOwnership(page, vis, ownerIds);
      })
    );

    // ── Quest givers (multiple) ──────────────────────────────────────────────
    const giverDrop = el.querySelector(".kctg-q-giver-drop");
    if (giverDrop) {
      giverDrop.addEventListener("dragover",  e => e.preventDefault());
      giverDrop.addEventListener("dragenter", e => { e.preventDefault(); giverDrop.classList.add("kctg-drag-over"); });
      giverDrop.addEventListener("dragleave", () => giverDrop.classList.remove("kctg-drag-over"));
      giverDrop.addEventListener("drop", async e => {
        e.preventDefault(); giverDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        const actor = await safeFromUuid(data.uuid);
        if (!actor || actor.documentName !== "Actor") return ui.notifications.warn("Drop an Actor onto the Quest Givers zone.");
        const page   = selPage(); if (!page) return;
        const givers = [...(page.flags[MODULE_ID]?.givers ?? [])];
        if (givers.find(g => g.uuid === data.uuid)) return; // already added
        givers.push({ id: newId(), uuid: data.uuid, name: actor.name, img: actor.img });
        await page.setFlag(MODULE_ID, "givers", givers);
        this.render();
      });
    }

    el.querySelectorAll(".kctg-q-remove-giver").forEach(btn =>
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const page   = selPage(); if (!page) return;
        const givers = (page.flags[MODULE_ID]?.givers ?? []).filter(g => g.id !== btn.dataset.id);
        await page.setFlag(MODULE_ID, "givers", givers);
        this.render();
      })
    );

    // ── Completion announcement: speaker drop / clear / message ───────────────
    const announceDrop = el.querySelector(".kctg-q-announce-speaker");
    if (announceDrop) {
      announceDrop.addEventListener("dragover",  e => e.preventDefault());
      announceDrop.addEventListener("dragenter", e => { e.preventDefault(); announceDrop.classList.add("kctg-drag-over"); });
      announceDrop.addEventListener("dragleave", () => announceDrop.classList.remove("kctg-drag-over"));
      announceDrop.addEventListener("drop", async e => {
        e.preventDefault(); announceDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        const actor = await safeFromUuid(data.uuid);
        if (!actor || actor.documentName !== "Actor") return ui.notifications.warn("Drop an Actor to set the announcement speaker.");
        const page = selPage(); if (!page) return;
        const cur  = page.flags[MODULE_ID]?.announce ?? {};
        await page.setFlag(MODULE_ID, "announce", { ...cur, actorUuid: data.uuid, name: actor.name, img: actor.img });
        this.render();
      });
    }

    // Clear the speaker override (recursive merge can't delete keys → use -= removal)
    el.querySelector(".kctg-q-announce-clear")?.addEventListener("click", async () => {
      const page = selPage(); if (!page) return;
      await page.update({
        [`flags.${MODULE_ID}.announce.-=actorUuid`]: null,
        [`flags.${MODULE_ID}.announce.-=name`]:      null,
        [`flags.${MODULE_ID}.announce.-=img`]:       null,
      });
      this.render();
    });

    // Message text: save without re-render so focus/caret are preserved
    el.querySelector(".kctg-q-announce-text")?.addEventListener("change", async e => {
      const page = selPage(); if (!page) return;
      const cur  = page.flags[MODULE_ID]?.announce ?? {};
      await page.setFlag(MODULE_ID, "announce", { ...cur, text: e.target.value });
    });

    // "Send on Done" toggle
    el.querySelector(".kctg-q-announce-onsave")?.addEventListener("change", async e => {
      const page = selPage(); if (!page) return;
      const cur  = page.flags[MODULE_ID]?.announce ?? {};
      await page.setFlag(MODULE_ID, "announce", { ...cur, onSave: e.target.checked });
    });

    // ── Lightbox for quest image ─────────────────────────────────────────────
    el.querySelector(".kctg-q-detail-img")?.addEventListener("click", () => {
      const img = el.querySelector(".kctg-q-detail-img");
      const src = img?.getAttribute("src");
      if (!src) return;
      new foundry.applications.apps.ImagePopout({
        src,
        window: { title: context.selected?.name ?? "Quest Image" },
      }).render(true);
    });

    // ── Objectives ───────────────────────────────────────────────────────────

    el.querySelector(".kctg-q-add-obj")?.addEventListener("click", async () => {
      const page = selPage(); if (!page) return;
      const objs = [...(page.flags[MODULE_ID]?.objectives ?? [])];
      objs.push({ id: newId(), name: "New objective", status: STATUS.IN_PROGRESS, triggersQuestId: "", parentId: "" });
      await page.setFlag(MODULE_ID, "objectives", objs);
      this.render();
    });

    // Add sub-objective under a specific parent
    el.querySelectorAll(".kctg-q-add-sub-obj").forEach(btn =>
      btn.addEventListener("click", async () => {
        const page = selPage(); if (!page) return;
        const objs = [...(page.flags[MODULE_ID]?.objectives ?? [])];
        objs.push({
          id:             newId(),
          name:           "New sub-objective",
          status:         STATUS.IN_PROGRESS,
          triggersQuestId: "",
          parentId:       btn.dataset.parentId,
        });
        await page.setFlag(MODULE_ID, "objectives", objs);
        this.render();
      })
    );

    el.querySelectorAll(".kctg-obj-name-input").forEach(input =>
      input.addEventListener("change", async e => {
        const page = selPage(); if (!page) return;
        const objs = [...(page.flags[MODULE_ID]?.objectives ?? [])];
        const obj  = objs.find(o => o.id === e.target.dataset.id);
        if (obj) { obj.name = e.target.value; await page.setFlag(MODULE_ID, "objectives", objs); }
      })
    );

    // Objective chain selector (which quest to trigger on completion)
    el.querySelectorAll(".kctg-obj-trigger").forEach(sel =>
      sel.addEventListener("change", async e => {
        const page = selPage(); if (!page) return;
        const objs = [...(page.flags[MODULE_ID]?.objectives ?? [])];
        const obj  = objs.find(o => o.id === e.target.dataset.id);
        if (obj) { obj.triggersQuestId = e.target.value; await page.setFlag(MODULE_ID, "objectives", objs); }
      })
    );

    // Objective status cycle — also fires chain trigger on completion
    el.querySelectorAll(".kctg-obj-cycle").forEach(btn =>
      btn.addEventListener("click", async () => {
        const page = selPage(); if (!page) return;
        const objs  = [...(page.flags[MODULE_ID]?.objectives ?? [])];
        const obj   = objs.find(o => o.id === btn.dataset.id);
        if (!obj) return;
        const cycle = [STATUS.IN_PROGRESS, STATUS.COMPLETED, STATUS.FAILED];
        obj.status  = cycle[(cycle.indexOf(obj.status) + 1) % cycle.length];
        await page.setFlag(MODULE_ID, "objectives", objs);

        // Chain trigger: reveal a hidden quest when this objective is completed
        if (obj.status === STATUS.COMPLETED && obj.triggersQuestId) {
          const targetPage = journal?.pages.get(obj.triggersQuestId);
          if (targetPage && targetPage.flags?.[MODULE_ID]?.status === STATUS.HIDDEN) {
            await targetPage.setFlag(MODULE_ID, "status", STATUS.IN_PROGRESS);
            ui.notifications.info(`New quest unlocked: "${targetPage.name}"!`);
          }
        }

        this.render();
      })
    );

    el.querySelectorAll(".kctg-obj-remove").forEach(btn =>
      btn.addEventListener("click", async () => {
        const page = selPage(); if (!page) return;
        const objs = (page.flags[MODULE_ID]?.objectives ?? []).filter(o => o.id !== btn.dataset.id);
        await page.setFlag(MODULE_ID, "objectives", objs);
        this.render();
      })
    );

    // Objective hide toggle (GM only)
    el.querySelectorAll(".kctg-obj-hide").forEach(btn =>
      btn.addEventListener("click", async () => {
        const page = selPage(); if (!page) return;
        const objs = [...(page.flags[MODULE_ID]?.objectives ?? [])];
        const obj  = objs.find(o => o.id === btn.dataset.id);
        if (!obj) return;
        obj.hidden = !obj.hidden;
        await page.setFlag(MODULE_ID, "objectives", objs);
        this.render();
      })
    );

    // Objective highlight star button — toggle blue text, no full re-render
    el.querySelectorAll(".kctg-obj-highlight-btn").forEach(btn =>
      btn.addEventListener("click", async () => {
        const page = selPage(); if (!page) return;
        const objs = [...(page.flags[MODULE_ID]?.objectives ?? [])];
        const obj  = objs.find(o => o.id === btn.dataset.id);
        if (!obj) return;
        obj.highlighted = !obj.highlighted;
        // Instantly reflect: swap solid/regular star and blue class
        const icon = btn.querySelector("i");
        if (icon) {
          icon.className = obj.highlighted ? "fas fa-star" : "far fa-star";
        }
        btn.classList.toggle("kctg-is-highlighted", obj.highlighted);
        btn.title = obj.highlighted ? "Remove highlight" : "Highlight objective";
        const span = btn.closest("li")?.querySelector(".kctg-obj-name");
        if (span) span.classList.toggle("kctg-obj-blue", obj.highlighted);
        await page.setFlag(MODULE_ID, "objectives", objs);
      })
    );

    // Reward hide toggle (GM only)
    el.querySelectorAll(".kctg-reward-hide").forEach(btn =>
      btn.addEventListener("click", async () => {
        const page = selPage(); if (!page) return;
        const rewards = [...(page.flags[MODULE_ID]?.rewards ?? [])];
        const r = rewards.find(r => r.id === btn.dataset.id);
        if (!r) return;
        r.hidden = !r.hidden;
        await page.setFlag(MODULE_ID, "rewards", rewards);
        this.render();
      })
    );

    // Send item rewards to an actor (GM only)
    el.querySelector(".kctg-reward-send-btn")?.addEventListener("click", async () => {
      const page = selPage(); if (!page) return;
      const itemRewards = (page.flags[MODULE_ID]?.rewards ?? []).filter(r => r.type === "item" && !r.hidden);
      if (!itemRewards.length) return ui.notifications.warn("No item rewards to send.");

      // Build actor options from all world actors
      const actorOpts = game.actors
        .map(a => `<option value="${a.id}">${esc(a.name)}</option>`)
        .join("");

      if (!actorOpts) return ui.notifications.warn("No actors in this world.");

      const result = await foundry.applications.api.DialogV2.prompt({
        window:  { title: "Send Rewards to Actor" },
        content: `
          <label style="display:flex;flex-direction:column;gap:6px;padding:4px 0">
            <span>Choose an actor to receive the item rewards:</span>
            <select name="actorId" style="width:100%">${actorOpts}</select>
          </label>`,
        ok: { label: "Send", callback: (_e, btn) => new FormData(btn.form).get("actorId") },
      }).catch(() => null);

      if (!result) return;
      const actor = game.actors.get(result);
      if (!actor) return;

      const toCreate = [];
      for (const r of itemRewards) {
        const srcItem = await safeFromUuid(r.uuid);
        if (!srcItem) continue;
        const itemData = srcItem.toObject();
        if (r.qty > 1 && itemData.system?.quantity !== undefined) {
          itemData.system.quantity = r.qty;
        }
        toCreate.push(itemData);
      }

      if (toCreate.length) {
        await actor.createEmbeddedDocuments("Item", toCreate);
        ui.notifications.info(`Sent ${toCreate.length} item(s) to ${actor.name}.`);
      } else {
        ui.notifications.warn("Could not resolve any items to send.");
      }
    });

    // ── Rewards ──────────────────────────────────────────────────────────────

    const rewardDrop = el.querySelector(".kctg-q-reward-drop");
    if (rewardDrop) {
      rewardDrop.addEventListener("dragover",  e => e.preventDefault());
      rewardDrop.addEventListener("dragenter", e => { e.preventDefault(); rewardDrop.classList.add("kctg-drag-over"); });
      rewardDrop.addEventListener("dragleave", () => rewardDrop.classList.remove("kctg-drag-over"));
      rewardDrop.addEventListener("drop", async e => {
        e.preventDefault(); rewardDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item") return ui.notifications.warn("Drop an Item here as a reward.");
        const item = await safeFromUuid(data.uuid); if (!item) return;
        const page = selPage(); if (!page) return;
        const rewards = [...(page.flags[MODULE_ID]?.rewards ?? [])];
        rewards.push({ id: newId(), type: "item", uuid: data.uuid, name: item.name, img: item.img, qty: 1 });
        await page.setFlag(MODULE_ID, "rewards", rewards);
        this.render();
      });
    }

    el.querySelector(".kctg-q-add-text-reward")?.addEventListener("click", async () => {
      const page = selPage(); if (!page) return;
      const rewards = [...(page.flags[MODULE_ID]?.rewards ?? [])];
      rewards.push({ id: newId(), type: "text", text: "Reward description" });
      await page.setFlag(MODULE_ID, "rewards", rewards);
      this.render();
    });

    el.querySelectorAll(".kctg-q-reward-text").forEach(input =>
      input.addEventListener("change", async e => {
        const page = selPage(); if (!page) return;
        const rewards = [...(page.flags[MODULE_ID]?.rewards ?? [])];
        const r = rewards.find(r => r.id === e.target.dataset.id);
        if (r) { r.text = e.target.value; await page.setFlag(MODULE_ID, "rewards", rewards); }
      })
    );

    el.querySelectorAll(".kctg-q-reward-qty").forEach(input =>
      input.addEventListener("change", async e => {
        const page = selPage(); if (!page) return;
        const rewards = [...(page.flags[MODULE_ID]?.rewards ?? [])];
        const r = rewards.find(r => r.id === e.target.dataset.id);
        if (r) { r.qty = Math.max(1, parseInt(e.target.value) || 1); await page.setFlag(MODULE_ID, "rewards", rewards); }
      })
    );

    el.querySelectorAll(".kctg-q-remove-reward").forEach(btn =>
      btn.addEventListener("click", async () => {
        const page = selPage(); if (!page) return;
        const rewards = (page.flags[MODULE_ID]?.rewards ?? []).filter(r => r.id !== btn.dataset.id);
        await page.setFlag(MODULE_ID, "rewards", rewards);
        this.render();
      })
    );

    // ── Resizable left panel ────────────────────────────────────────────────
    const resizeHandle = el.querySelector(".kctg-resize-handle");
    const listPanel    = el.querySelector(".kctg-quest-list-panel");
    if (resizeHandle && listPanel) {
      let startX, startW;
      resizeHandle.addEventListener("mousedown", e => {
        e.preventDefault();
        startX = e.clientX;
        startW = listPanel.getBoundingClientRect().width;
        const onMove = ev => {
          listPanel.style.width = Math.max(300, Math.min(420, startW + (ev.clientX - startX))) + "px";
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup",  onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
      });
    }

    // ── Drag-and-drop list reordering ───────────────────────────────────────
    {
      const _clearDI = () =>
        el.querySelectorAll(".kctg-drag-above,.kctg-drag-below,.kctg-drag-into")
          .forEach(n => n.classList.remove("kctg-drag-above", "kctg-drag-below", "kctg-drag-into"));

      const _reorderQuest = async (dragId, targetId, insertBefore) => {
        const jrn = getQuestJournal(); if (!jrn) return;
        const order = [...el.querySelectorAll(".kctg-quest-row")].map(r => r.dataset.id);
        const filtered = order.filter(id => id !== dragId);
        const ti = filtered.indexOf(targetId);
        filtered.splice(insertBefore ? ti : ti + 1, 0, dragId);
        const dragPage   = jrn.pages.get(dragId);
        const targetPage = jrn.pages.get(targetId);
        if (dragPage && targetPage) {
          const fromGroup = dragPage.flags?.[MODULE_ID]?.groupId ?? "";
          const toGroup   = targetPage.flags?.[MODULE_ID]?.groupId ?? "";
          if (fromGroup !== toGroup) await dragPage.setFlag(MODULE_ID, "groupId", toGroup);
        }
        await jrn.setFlag(MODULE_ID, "questOrder", filtered);
        this.render();
      };

      const _reorderGroup = async (dragId, targetId, insertBefore) => {
        const jrn = getQuestJournal(); if (!jrn) return;
        const order = [...el.querySelectorAll(".kctg-group-row")].map(r => r.dataset.id);
        const filtered = order.filter(id => id !== dragId);
        const ti = filtered.indexOf(targetId);
        filtered.splice(insertBefore ? ti : ti + 1, 0, dragId);
        await jrn.setFlag(MODULE_ID, "groupOrder", filtered);
        this.render();
      };

      // Quest rows
      el.querySelectorAll(".kctg-quest-row").forEach(row => {
        row.setAttribute("draggable", "true");
        row.addEventListener("dragstart", e => {
          this._listDrag = { type: "quest", id: row.dataset.id };
          e.dataTransfer.effectAllowed = "move";
        });
        row.addEventListener("dragend",  () => { this._listDrag = null; _clearDI(); });
        row.addEventListener("dragover", e => {
          if (this._listDrag?.type !== "quest") return;
          e.preventDefault(); _clearDI();
          const { top, height } = row.getBoundingClientRect();
          row.classList.add(e.clientY < top + height / 2 ? "kctg-drag-above" : "kctg-drag-below");
        });
        row.addEventListener("dragleave", () => row.classList.remove("kctg-drag-above", "kctg-drag-below"));
        row.addEventListener("drop", async e => {
          e.preventDefault();
          const drag = this._listDrag; if (drag?.type !== "quest") return;
          _clearDI();
          if (drag.id === row.dataset.id) return;
          const { top, height } = row.getBoundingClientRect();
          await _reorderQuest(drag.id, row.dataset.id, e.clientY < top + height / 2);
        });
      });

      // Group rows
      el.querySelectorAll(".kctg-group-row").forEach(row => {
        if (game.user.isGM) {
          row.setAttribute("draggable", "true");
          row.addEventListener("dragstart", e => {
            this._listDrag = { type: "group", id: row.dataset.id };
            e.dataTransfer.effectAllowed = "move";
          });
          row.addEventListener("dragend", () => { this._listDrag = null; _clearDI(); });
        }
        row.addEventListener("dragover", e => {
          if (!this._listDrag) return;
          e.preventDefault(); _clearDI();
          if (this._listDrag.type === "group") {
            const { top, height } = row.getBoundingClientRect();
            row.classList.add(e.clientY < top + height / 2 ? "kctg-drag-above" : "kctg-drag-below");
          } else if (this._listDrag.type === "quest") {
            row.classList.add("kctg-drag-into");
          }
        });
        row.addEventListener("dragleave", () => row.classList.remove("kctg-drag-above", "kctg-drag-below", "kctg-drag-into"));
        row.addEventListener("drop", async e => {
          e.preventDefault();
          const drag = this._listDrag; if (!drag) return;
          _clearDI();
          if (drag.type === "group") {
            if (drag.id === row.dataset.id) return;
            const { top, height } = row.getBoundingClientRect();
            await _reorderGroup(drag.id, row.dataset.id, e.clientY < top + height / 2);
          } else if (drag.type === "quest") {
            const page = journal?.pages.get(drag.id); if (!page) return;
            await page.setFlag(MODULE_ID, "groupId", row.dataset.id);
            this.render();
          }
        });
      });
    }

    // ── Quick status cycle from list badge ───────────────────────────────────
    el.querySelectorAll(".kctg-q-status-cycle").forEach(btn =>
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const page = journal?.pages.get(btn.dataset.id);
        if (!page || !page.canUserModify(game.user, "update")) return;
        const cur   = page.flags[MODULE_ID]?.status ?? STATUS.IN_PROGRESS;
        const full  = [STATUS.IN_PROGRESS, STATUS.COMPLETED, STATUS.FAILED, STATUS.HIDDEN];
        const cycle = game.user.isGM ? full : full.filter(s => s !== STATUS.HIDDEN);
        const idx   = cycle.indexOf(cur);
        await page.setFlag(MODULE_ID, "status", cycle[(idx < 0 ? 0 : idx + 1) % cycle.length]);
        this.render();
      })
    );
  }
}

// ─── QUEST TOAST NOTIFICATION ─────────────────────────────────────────────────

const _unreadKey  = () => `kctg-unread-quests-${game.user?.id ?? "anon"}`;
function _getUnreadIds()      { try { return JSON.parse(localStorage.getItem(_unreadKey()) ?? "[]"); } catch { return []; } }
function _addUnreadId(id)     { const s = _getUnreadIds(); if (!s.includes(id)) { s.push(id); localStorage.setItem(_unreadKey(), JSON.stringify(s)); } }
function _clearUnreadId(id)   { const s = _getUnreadIds().filter(x => x !== id); localStorage.setItem(_unreadKey(), JSON.stringify(s)); }

function _showQuestToast(page, isNew = true) {
  if (document.querySelector(`.kctg-quest-toast[data-page-id="${page.id}"]`)) return;

  let container = document.getElementById("kctg-quest-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "kctg-quest-toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = "kctg-quest-toast";
  toast.dataset.pageId = page.id;
  const label = isNew ? "New Quest" : "Quest Updated";
  toast.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${label}: <span class="kctg-toast-name">${esc(page.name)}</span>`;
  container.appendChild(toast);

  toast.animate([{ opacity: 0, transform: "translateY(-24px) scale(0.95)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
    { duration: 350, easing: "cubic-bezier(0.2, 0, 0.15, 1)", fill: "forwards" });

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    toast.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "ease-in" })
      .onfinish = () => { toast.remove(); if (container.children.length === 0) container.remove(); };
  };

  toast.addEventListener("mouseup", e => { dismiss(); if (e.button === 0) QuestApp.open(); });
  setTimeout(dismiss, 8000);
}

// Campaign dashboard can request the Quest app to open
Hooks.on("kctg:openQuests", () => QuestApp.toggle());

// ─── CROSS-MODULE HOOKS ───────────────────────────────────────────────────────

/**
 * Post the quest's chat announcement: an in-character line spoken by the quest giver
 * (or a chosen speaker). Triggered directly by the editing user clicking Done when the
 * quest's "Send on Done" toggle is on, so no multi-client de-duplication is needed.
 * The speaker is set as the message's actor so the system renders the token + name in
 * the chat header at native size; the card body is text only.
 */
async function _postQuestAnnouncement(page, isNew = false) {
  const f    = page.flags?.[MODULE_ID] ?? {};
  const a    = f.announce ?? {};
  const text = String(a.text ?? "").trim();
  if (!text) return;

  // Resolve the speaker: explicit override, else the first quest giver, else the quest.
  let actor = a.actorUuid ? await safeFromUuid(a.actorUuid) : null;
  if (!actor) {
    const giverUuid = (f.givers ?? [])[0]?.uuid;
    if (giverUuid) actor = await safeFromUuid(giverUuid);
  }
  const speakerName = actor?.name ?? a.name ?? page.name;

  const status = f.status ?? STATUS.IN_PROGRESS;
  const tag = status === STATUS.COMPLETED ? "Quest Completed"
            : status === STATUS.FAILED    ? "Quest Failed"
            : isNew                        ? "New Quest"
            :                                "Quest Updated";

  const content = `<div style="background:rgba(9,8,14,0.85);border:1px solid rgba(245,180,48,0.25);border-left:3px solid #f5b430;border-radius:6px;padding:9px 12px;font-family:Signika,serif;color:#efe6d8;">
    <div style="font-size:.70rem;font-weight:500;letter-spacing:.02em;color:#877a66;margin-bottom:4px;"><i class="fas fa-scroll" style="margin-right:5px;opacity:.7;"></i>${esc(page.name)} <span style="opacity:.85;">- ${tag}</span></div>
    <div style="font-size:.88rem;font-style:italic;">“${esc(text)}”</div>
  </div>`;

  const msg = {
    content,
    speaker: actor ? ChatMessage.getSpeaker({ actor }) : { alias: speakerName },
    style:   CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
  };

  // world → public; party/personal → whisper to eligible players plus all GMs.
  const vis = f.visibility ?? "world";
  if (vis !== "world") {
    const playerIds = _getUsersForQuest(page).map(u => u.id);
    const gmIds     = game.users.filter(u => u.isGM).map(u => u.id);
    msg.whisper     = [...new Set([...playerIds, ...gmIds])];
  }

  await ChatMessage.create(msg);
}

// Fires kctg:questCompleted(pageId, questName) whenever a quest page reaches "completed".
// Forge listens to unlock recipes; Merchant listens to trigger auto-restock.
Hooks.on("updateJournalEntryPage", (page, changes) => {
  const newStatus = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.status`);
  if (newStatus === STATUS.COMPLETED) {
    Hooks.callAll("kctg:questCompleted", page.id, page.name ?? "Unknown Quest");
    // The hook fires on every client; only the responsible GM writes the feed entry.
    if (game.users.find(u => u.isGM && u.active)?.id === game.user.id)
      logActivity("quest", `Quest completed: ${page.name ?? "Unknown Quest"}`);
  }
});

// ─── SCENE CONTROLS ───────────────────────────────────────────────────────────

Hooks.on("getSceneControlButtons", controls => {
  _addToKctgGroup(controls, {
    name:     "kctg-quests-open",
    title:    "Quest Journal [J]",
    icon:     "fas fa-book-open",
    button:   true,
    onChange: () => QuestApp.toggle(),
  });
});

// ─── READY ────────────────────────────────────────────────────────────────────

Hooks.once("ready", async () => {
  // Socket: online clients receive broadcast, show toast, mark quest unread
  game.socket.on(`module.${MODULE_ID}`, data => {
    if (data.type !== "kctg-quest-notify") return;
    const journal = getQuestJournal();
    const page    = journal?.pages.get(data.pageId);
    if (!page) return;
    if (!page.testUserPermission(game.user, "OBSERVER")) return;
    _showQuestToast(page, data.isNew);
    _addUnreadId(page.id);
    if (QuestApp._instance?.rendered) QuestApp._instance.render();
  });

  // On login: show any notifications that arrived while this user was offline
  if (!game.user.isGM) {
    const pending = game.user.getFlag(MODULE_ID, "pendingNotifs") ?? [];
    if (pending.length) {
      const journal = getQuestJournal();
      for (const { pageId, isNew } of pending) {
        const page = journal?.pages.get(pageId);
        if (!page || !page.testUserPermission(game.user, "OBSERVER")) continue;
        _addUnreadId(pageId);
        _showQuestToast(page, isNew);
      }
      await game.user.setFlag(MODULE_ID, "pendingNotifs", []);
    }
  }

  const _questsMod = game.modules.get(MODULE_ID);
  _questsMod.api ??= {};
  Object.assign(_questsMod.api, { open: () => QuestApp.open(), toggle: () => QuestApp.toggle() });
  console.log("%c📖 KCTG Quests | Ready", "color:#c9a84c;font-weight:bold;");
});
