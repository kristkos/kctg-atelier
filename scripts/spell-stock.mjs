/**
 * KCTG – Spell Stock  |  FoundryVTT v14
 *
 * System adapters that turn a spell Item into a sellable consumable source
 * (PF2e: scroll / wand / cantrip deck). The merchant restock pipeline calls
 * getSpellAdapter(); on systems without an adapter, or when the installed
 * system version lacks the required config, the null adapter is returned and
 * rolled spells are skipped rather than stocked raw.
 *
 * Adapter contract (dispatcher pattern mirrors Campaign Codex's
 * ActorDropperBalanceDialogHelper: core code depends only on this contract,
 * per-system objects supply the behaviour, game.system.id picks one):
 *   id                        system family the adapter serves
 *   canConvertSpells          feature-detected at call time, never cached
 *   formats()                 [{key,label}] ranked-spell output formats
 *   isConvertibleSpell(item)  true for spells this adapter can convert
 *   rankRange(spell)          {min,max} valid ranks, or null for cantrips
 *   spellToItemSource(spell, {format, rank})  plain Item source, or null
 */

const NULL_ADAPTER = {
  id: "none",
  get canConvertSpells() { return false; },
  formats() { return []; },
  isConvertibleSpell() { return false; },
  rankRange() { return null; },
  async spellToItemSource() { return null; },
};

// Template item sources are fetched once per uuid and cloned per use, so a
// 1000-spell restock does at most one compendium read per (format, rank).
const _templateCache = new Map();
async function _templateSource(uuid) {
  if (!_templateCache.has(uuid)) {
    const doc = await fromUuid(uuid).catch(() => null);
    _templateCache.set(uuid, doc?.toObject?.() ?? null);
  }
  const src = _templateCache.get(uuid);
  return src ? foundry.utils.deepClone(src) : null;
}

// ─── PF2E (and the sf2e fork) ────────────────────────────────────────────────
// Everything is read from CONFIG.PF2E.spellcastingItems, the same registry the
// system's own SpellcastingItemCreator dialog uses (verified on pf2e 8.3.0:
// entries are { name, nameTemplate, compendiumUuids: {1..10}, cantripsOnly? };
// scroll ranks 1-10, wand 1-9, cantripDeck5 carries cantripsOnly with its deck
// template at rank 1). The generated source embeds the spell at system.spell
// with system.location.heightenedLevel, matching createConsumableFromSpell.

const PF2E_MAGIC_TRADITIONS = ["arcane", "divine", "occult", "primal"];

const PF2E_ADAPTER = {
  id: "pf2e",

  get canConvertSpells() {
    return Object.values(CONFIG.PF2E?.spellcastingItems ?? {}).some(e => e && !e.cantripsOnly);
  },

  /** Ranked-spell output formats, data-driven so sf2e's spell-gem works unchanged. */
  formats() {
    return Object.entries(CONFIG.PF2E?.spellcastingItems ?? {})
      .filter(([, e]) => e && !e.cantripsOnly)
      .map(([key, e]) => ({ key, label: game.i18n.localize(e.name ?? key) }));
  },

  isConvertibleSpell(item) {
    return item?.type === "spell" && !item.isRitual;
  },

  rankRange(spell) {
    if (spell.isCantrip) return null;
    const min = Number(spell.baseRank ?? spell.system?.level?.value ?? 1) || 1;
    return { min: Math.min(10, Math.max(1, min)), max: 10 };
  },

  async spellToItemSource(spell, { format = "scroll", rank } = {}) {
    const registry = CONFIG.PF2E?.spellcastingItems ?? {};
    let entry, useRank;
    if (spell.isCantrip) {
      entry   = Object.values(registry).find(e => e?.cantripsOnly) ?? null;
      useRank = 1;
    } else {
      const range = this.rankRange(spell);
      useRank = Math.min(range.max, Math.max(range.min, Math.floor(Number(rank)) || range.min));
      entry   = registry[format] ?? null;
      // No template at this rank for the chosen format (wands stop at 9):
      // fall back to any ranked format that has one.
      if (!entry?.compendiumUuids?.[useRank])
        entry = Object.values(registry).find(e => e && !e.cantripsOnly && e.compendiumUuids?.[useRank]) ?? null;
    }

    const uuid = entry?.compendiumUuids?.[useRank] ?? null;
    const src  = uuid ? await _templateSource(uuid) : null;
    if (!src) return null;
    delete src._id;

    src.name = entry.nameTemplate
      ? game.i18n.format(entry.nameTemplate, { name: spell.name, level: useRank })
      : `${spell.name} (Rank ${useRank})`;

    // Trait merge mirrors the system's createConsumableFromSpell: union the
    // spell's traits, adopt its rarity, drop "magical" once a tradition trait
    // is present, and keep the list sorted.
    const traits = src.system?.traits;
    if (traits && Array.isArray(traits.value)) {
      traits.value = [...new Set([...traits.value, ...(spell.system?.traits?.value ?? [])])];
      const rarity = spell.rarity ?? spell.system?.traits?.rarity;
      if (rarity) traits.rarity = rarity;
      if (traits.value.includes("magical") && traits.value.some(t => PF2E_MAGIC_TRADITIONS.includes(t)))
        traits.value.splice(traits.value.indexOf("magical"), 1);
      traits.value.sort();
    }

    const spellUuid = spell.sourceId ?? spell.uuid ?? null;
    const link = spellUuid ? `@UUID[${spellUuid}]{${spell.name}}` : spell.name;
    if (src.system?.description)
      src.system.description.value = `<p>${link}</p><hr />${src.system.description.value ?? ""}`;

    // Cantrip decks are self-contained; everything else embeds the spell at
    // the heightened rank so the consumable casts correctly.
    if (!entry.cantripsOnly) {
      src.system.spell = foundry.utils.mergeObject(
        spell.toObject(),
        { _id: foundry.utils.randomID(), system: { location: { value: null, heightenedLevel: useRank } } },
        { inplace: false }
      );
    }
    return src;
  },
};

// ─── DND5E ───────────────────────────────────────────────────────────────────
// Built on the system's own Item5e.createScrollFromSpell (public API, verified on
// dnd5e 5.3.3): passing { dialog: false, level } suppresses the CreateScrollDialog
// and heightens the spell to `level`; compendium spells auto-route to
// createScrollFromCompendiumSpell. The call returns an ephemeral (unsaved) Item5e
// whose toObject() is exactly the plain source the adapter contract needs.
// Cantrip scrolls are legal in dnd5e (CONFIG.DND5E.spellScrollIds[0]), so level-0
// spells convert at level 0 rather than being skipped.

const DND5E_ADAPTER = {
  id: "dnd5e",

  get canConvertSpells() {
    return typeof globalThis.dnd5e?.documents?.Item5e?.createScrollFromSpell === "function"
      && Object.keys(CONFIG.DND5E?.spellScrollIds ?? {}).length > 0;
  },

  formats() {
    return [{ key: "scroll", label: game.i18n.localize("DND5E.SpellScroll") }];
  },

  isConvertibleSpell(item) {
    return item?.type === "spell";
  },

  rankRange(spell) {
    const base = Number(spell.system?.level ?? 0) || 0;
    if (base <= 0) return null; // cantrip — scroll is created at level 0
    return { min: base, max: 9 };
  },

  async spellToItemSource(spell, { rank } = {}) {
    const base  = Number(spell.system?.level ?? 0) || 0;
    let level   = 0;
    if (base > 0) {
      const range = this.rankRange(spell);
      level = Math.min(range.max, Math.max(range.min, Math.floor(Number(rank)) || range.min));
    }
    // Heightened compendium spells must NOT take the system's compendium shortcut:
    // createScrollFromCompendiumSpell keys the scroll template, price, and DC off
    // the spell's BASE level and only casts at the higher one. Passing plain data
    // forces the standard route, which prices and describes the scroll at `level`.
    const arg = (level > base && spell.pack) ? spell.toObject() : spell;
    const scroll = await globalThis.dnd5e.documents.Item5e
      .createScrollFromSpell(arg, {}, { dialog: false, level });
    const src = scroll?.toObject?.() ?? null;
    if (!src) return null;
    delete src._id;
    // Heightened scrolls of the same spell must not stack with base-level ones:
    // key the level into the name (base-level scrolls keep the system's name).
    if (base > 0 && level > base) src.name = `${src.name} (Level ${level})`;
    return src;
  },
};

const ADAPTERS = { pf2e: PF2E_ADAPTER, sf2e: PF2E_ADAPTER, dnd5e: DND5E_ADAPTER };

/** The spell adapter for the running system; NULL_ADAPTER when unsupported. */
export function getSpellAdapter() {
  const adapter = ADAPTERS[game.system?.id] ?? NULL_ADAPTER;
  return adapter.canConvertSpells ? adapter : NULL_ADAPTER;
}
