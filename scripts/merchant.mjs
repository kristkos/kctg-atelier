/**
 * KCTG – Merchants  |  FoundryVTT v14
 * Standalone merchant system — no item-piles dependency.
 *
 * Entry points (GM):
 *   • Scene control button  →  opens MerchantsApp
 *   • Token right-click     →  "Configure Merchant" / "Enable as Merchant"
 *   • Token double-click    →  opens config for that merchant
 *   • Actor sheet header button  →  opens MerchantsApp pre-selected
 *
 * Entry points (Player):
 *   • Token double-click on merchant  →  opens shop (if within distance & open)
 *   • MerchantsApp shows read-only shop view
 */

import { MODULE_ID, _addToKctgGroup, newId, safeFromUuid, getItemQty, addItemToActor, esc, COIN_RATES,
  getCurrentDay, onDayAdvance, logActivity, isInventoryItem,
  actorCopperValue as getActorCopper,
  debitCurrency   as deductCurrencyFromActor,
  creditCurrency  as addCurrencyToActor } from "./main.mjs";
import { getSpellAdapter } from "./spell-stock.mjs";

// ─── PHYSICAL ITEM FILTER ─────────────────────────────────────────────────────
// The system-agnostic physical check lives in main.mjs (isInventoryItem); this
// wrapper additionally excludes coin items so currency never shows as shop stock.

// PF2e coin names that should never show as shop inventory
const COIN_NAMES = new Set(["Copper Pieces","Silver Pieces","Gold Pieces","Platinum Pieces","Electrum Pieces","Copper","Silver","Gold","Platinum"]);

function isPhysicalItem(item) {
  if (!isInventoryItem(item)) return false;
  // Filter out currency-type items (PF2e treasure items that are coins)
  if (item.system?.category === "currency") return false;
  if (item.system?.isCurrency === true) return false;
  if (COIN_NAMES.has(item.name)) return false;
  return true;
}

// ─── INFLUENCE (reputation) ───────────────────────────────────────────────────
// Per player, per merchant: points earned by trade (and/or awarded by the GM) map
// to GM-configurable tiers, each granting a buy discount. Discounts may be negative
// (a surcharge for low standing). Tiers are stored per-merchant and fully editable.

const DEFAULT_INFLUENCE_TIERS = [
  { id: "t0", label: "Unknown",      min: 0,   discount: 0,  color: "#7a6e60" },
  { id: "t1", label: "Acquainted",   min: 50,  discount: 3,  color: "#c9b897" },
  { id: "t2", label: "Favored",      min: 150, discount: 8,  color: "#f5b430" },
  { id: "t3", label: "Influential",  min: 400, discount: 13, color: "#d06838" },
  { id: "t4", label: "Inner Circle", min: 800, discount: 20, color: "#cc88ff" },
];

// VOCABULARY: the player-facing term is "Influence" (tiers, discounts, the whole UI).
// The storage layer still uses the legacy "rep"/"reputation" name — the per-user flag
// key (rep_<actorId>), the settings repEnabled/repGoldPerPoint, and getReputation/
// earnReputation/resetMerchantReputation. These are kept as-is to avoid a flag/setting
// migration; treat "rep*" and "influence" as the same concept.
const _repKey = actorId => `rep_${actorId}`;

/** Resolve a merchant's influence tiers (configured, else default), sorted by points. */
function _influenceTiers(mData) {
  const tiers = (mData?.influenceTiers?.length ? mData.influenceTiers : DEFAULT_INFLUENCE_TIERS);
  return [...tiers].sort((a, b) => (a.min ?? 0) - (b.min ?? 0));
}

/** Human label for a tier's discount (positive = discount, negative = surcharge). */
function _discountText(discount) {
  const d = Number(discount) || 0;
  if (d > 0) return `−${d}% off`;
  if (d < 0) return `+${-d}% surcharge`;
  return "no change";
}

function getReputation(actorId, mData = null) {
  const tiers   = _influenceTiers(mData ?? getMerchantData(game.actors.get(actorId)));
  const points  = game.user.getFlag(MODULE_ID, _repKey(actorId)) ?? 0;
  let tierIdx = 0;
  tiers.forEach((t, i) => { if ((t.min ?? 0) <= points) tierIdx = i; });
  const tier = tiers[tierIdx] ?? { label: "—", discount: 0, color: "#888", min: 0 };
  const next = tiers[tierIdx + 1] ?? null;
  const span = next ? (next.min - tier.min) : 0;
  return {
    points, tier, next,
    progress: next ? Math.min(1, Math.max(0, (points - tier.min) / (span || 1))) : 1,
    discountText: _discountText(tier.discount),
  };
}

function _tierForPoints(tiers, points) {
  let t = tiers[0];
  for (const tier of tiers) if ((tier.min ?? 0) <= points) t = tier;
  return t;
}

async function earnReputation(actorId, copper, mData = null) {
  const d = mData ?? getMerchantData(game.actors.get(actorId));
  if (d?.repEnabled === false) return;
  // 1 point per `repGoldPerPoint` gp of trade (configurable per merchant; default 10).
  const goldPerPoint = Math.max(1, d?.repGoldPerPoint ?? 10);
  const gain = Math.floor((copper / 100) / goldPerPoint);
  if (gain <= 0) return;
  const old  = game.user.getFlag(MODULE_ID, _repKey(actorId)) ?? 0;
  const next = old + gain;
  await game.user.setFlag(MODULE_ID, _repKey(actorId), next);
  const tiers    = _influenceTiers(d);
  const prevTier = _tierForPoints(tiers, old);
  const newTier  = _tierForPoints(tiers, next);
  if (newTier?.id !== prevTier?.id) {
    const actor = game.actors.get(actorId);
    ui.notifications.info(`Your influence with ${actor?.name ?? "the merchant"} is now ${newTier?.label ?? "—"}!`);
  }
}

/** GM: clear every user's influence with a merchant (resets all players to the lowest tier). */
async function resetMerchantReputation(merchantId) {
  for (const u of game.users) {
    if (u.getFlag(MODULE_ID, _repKey(merchantId)) != null) {
      await u.unsetFlag(MODULE_ID, _repKey(merchantId));
    }
  }
}

/** GM: directly set a specific user's influence points with a merchant. */
async function setUserInfluence(merchantId, userId, points) {
  const u = game.users.get(userId);
  if (!u) return;
  await u.setFlag(MODULE_ID, _repKey(merchantId), Math.max(0, Math.round(points) || 0));
}

// ─── DEFAULT CATEGORIES & AUTO-CATEGORISATION ─────────────────────────────────

const DEFAULT_MERCHANT_CATEGORIES = ["General", "Weapons", "Armor", "Consumables", "Treasure", "Tools"];

// Maps item type → default category name (covers PF2e, dnd5e, and generic systems)
const TYPE_TO_CATEGORY = (() => {
  const sys = () => game.system?.id ?? "";
  return {
    // PF2e
    weapon:       "Weapons",
    armor:        "Armor",
    shield:       "Armor",
    consumable:   "Consumables",
    treasure:     "Treasure",
    equipment:    "Tools",
    backpack:     "Tools",
    kit:          "Tools",
    // dnd5e (equipment with armour subtype handled in _autoCategory below)
    loot:         "Treasure",
    tool:         "Tools",
    container:    "Tools",
    // generic
    gear:         "Tools",
    supply:       "Consumables",
    good:         "Treasure",
    potion:       "Consumables",
    scroll:       "Consumables",
    wand:         "Consumables",
  };
})();

function _autoCategory(item, categories) {
  const findCat = name => categories.find(c => c.name.toLowerCase() === name.toLowerCase());

  const t   = item.type?.toLowerCase() ?? "";
  const sys = game.system?.id ?? "";

  // dnd5e: "equipment" covers both armour and non-armour; disambiguate.
  // Only true armour subtypes map to Armor — clothing/trinkets/wands are General.
  if (sys === "dnd5e" && t === "equipment") {
    const sub = item.system?.type?.value ?? "";
    if (["light","medium","heavy","bonus","natural","shield"].includes(sub))
      return findCat("Armor");
    return findCat("General");
  }

  const catName = TYPE_TO_CATEGORY[t];
  if (catName) return findCat(catName);

  // Fuzzy fallback: partial type-name match
  if (t.includes("weapon"))     return findCat("Weapons");
  if (t.includes("armor"))      return findCat("Armor");
  if (t.includes("consumable")) return findCat("Consumables");
  if (t.includes("treasure"))   return findCat("Treasure");
  if (t.includes("tool"))       return findCat("Tools");

  return findCat("General"); // final fallback
}

// ─── FLAG DATA MODEL ──────────────────────────────────────────────────────────

const MERCHANT_DEFAULT = {
  enabled:          false,
  openForBusiness:  true,
  distanceLimit:    0,      // scene units; 0 = unlimited
  hideWhenClosed:   false,  // hide token when closed
  priceModifier:    100,    // % of base sell price
  purchaseOnly:     false,  // disable selling to this merchant
  buyModifier:      50,     // % of base paid to player when buying from them
  onlyBasePrice:    false,  // sold items must use base price
  infiniteCurrency: false,  // buying never depletes merchant currency
  hideNewlySold:    false,  // auto-hide items sold TO merchant
  infiniteQuantity: false,  // merchant never runs out
  keepZeroQuantity: false,  // show sold-out items as unavailable
  logActivity:      false,  // log buy/sell to chat
  repEnabled:       true,   // influence/discount system active for this merchant
  repGoldPerPoint:  10,     // gp of trade required to earn 1 influence point
  influenceTiers:   DEFAULT_INFLUENCE_TIERS,  // configurable tiers (deep-cloned on read)
  hiddenItems:      [],     // item IDs hidden from players
  stockTables:      [],     // [{id,tableUuid,tableName,tableImg,rollFormula,qtyFormula,unique,resetBeforeAdd,enabled,
                            //   spellFormat,wandShare,spellRankFormula}] (spell* fields: see spell-stock.mjs)
  categories:       [],     // [{id,name}]
  itemCategories:   {},     // {itemId: categoryId}
  priceOverrides:   {},     // {itemId: {value, denom}} — GM-set price for 0-value items
  // Special orders. status: "pending" (player requested) → "ready" (GM priced it, sets
  // priceLabel) → closed by GM deletion. ("fulfilled" is reserved for a future
  // player-collect flow and is filtered for but not yet written.) priceLabel is the
  // human price string actually shown; priceC/depositC are reserved numeric fields.
  specialOrders:    [],     // [{id,userId,characterName,description,status,depositC,priceC,priceLabel,createdAt}]
  linkedQuestId:    null,   // JournalEntryPage UUID; when quest completes → auto-restock
  restockEveryDays: 0,      // auto-restock every N workshop days (0 = off)
  lastRestockDay:   null,   // workshop day of the last restock (any kind); schedule anchor
};

function getMerchantData(actor) {
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(MERCHANT_DEFAULT),
    actor?.getFlag(MODULE_ID, "merchant") ?? {},
    { inplace: false }
  );
}
async function saveMerchantData(actor, data) {
  await actor.setFlag(MODULE_ID, "merchant", data);
}
export function isMerchant(actor) {
  return actor?.getFlag(MODULE_ID, "merchant")?.enabled === true;
}
function getMerchants() {
  return (game.actors?.contents ?? []).filter(a => isMerchant(a));
}

// The actor a player buys/sells as: their assigned character, else the actor of
// their currently controlled token (must be one they own to mutate currency/items).
function _buyerActor() {
  const c = game.user.character;
  if (c) return c;
  const t = canvas?.tokens?.controlled?.find(t => t.actor?.isOwner);
  return t?.actor ?? null;
}

// Enable an actor as a merchant. No actor-ownership changes are needed: open
// merchant tokens are made viewable to everyone via the _canView patch, and world
// actor data is replicated to all clients so the shop can display its stock.
async function _enableMerchant(actor) {
  if (!actor) return;
  const d = getMerchantData(actor);
  d.enabled = true;
  if (!d.categories.length) d.categories = DEFAULT_MERCHANT_CATEGORIES.map(name => ({ id: newId(), name }));
  await saveMerchantData(actor, d);
}

// ─── PRICE HELPER ─────────────────────────────────────────────────────────────

function formatPrice(item) {
  const s = item.system;
  if (!s) return null;
  if (s.price?.denomination != null) return `${s.price.value ?? 0} ${s.price.denomination}`;
  if (s.price?.value != null) {
    const pv = s.price.value;
    if (typeof pv === "object")
      return Object.entries(pv).filter(([,v])=>v).map(([k,v])=>`${v} ${k}`).join(" ") || null;
    return `${pv} gp`;
  }
  const v = s.cost ?? s.value ?? null;
  return v != null ? `${v} gp` : null;
}

// ─── CURRENCY HELPERS ─────────────────────────────────────────────────────────
// COIN_RATES / copperToCoinObj are shared from main.mjs (single source of coin math).

function parsePriceCopper(item) {
  const s = item.system;
  if (!s) return { copper: 0, label: "free" };
  if (s.price?.denomination != null) {
    const d = s.price.denomination.toLowerCase();
    const v = s.price.value ?? 0;
    return { copper: Math.round(v * (COIN_RATES[d] ?? 100)), label: `${v} ${d}` };
  }
  if (s.price?.value != null) {
    const pv = s.price.value;
    if (typeof pv === "object") {
      const copper = Object.entries(pv).reduce((t, [d, v]) => t + (v ?? 0) * (COIN_RATES[d] ?? 0), 0);
      return { copper, label: Object.entries(pv).filter(([,v])=>v).map(([k,v])=>`${v} ${k}`).join(" ") || "free" };
    }
    return { copper: (pv ?? 0) * 100, label: `${pv} gp` };
  }
  const v = s.cost ?? s.value ?? null;
  return v != null ? { copper: v * 100, label: `${v} gp` } : { copper: 0, label: "free" };
}

function _copperToLabel(copper) {
  if (copper <= 0) return "free";
  // Express in gp/sp/cp — gp is the standard price unit (so 190000cp → "1900 gp",
  // not "190 pp"). pp is intentionally omitted from price display.
  const parts = [];
  let rem = copper;
  for (const [d, r] of [["gp",100],["sp",10],["cp",1]]) {
    const n = Math.floor(rem / r); rem %= r;
    if (n) parts.push(`${n} ${d}`);
  }
  return parts.join(" ") || "free";
}

// getActorCopper / deductCurrencyFromActor / addCurrencyToActor are the shared
// composition-preserving currency helpers from main.mjs (imported under their
// legacy local names above).

// ─── GM DELEGATION ──────────────────────────────────────────────────────────
// Players don't own merchant NPC actors, so they can't write the merchant's
// stock or currency directly. When a non-owner transacts, the merchant-side
// mutations are delegated to an active GM over the module socket. The buyer/
// seller's OWN character (which they own) is still mutated locally.

function _canWriteMerchant(actor) {
  return actor?.isOwner === true; // GM owns everything; a player only if explicitly granted
}
function _activeGM() {
  return game.users.find(u => u.isGM && u.active) ?? null;
}

/** Reduce merchant stock after a purchase. Must run on a client that owns the merchant. */
// Apply the merchant-side stock reduction of a purchase. Runs with merchant-owner
// privilege (possibly via socket delegation), so `qty` is untrusted: clamp it to a
// sane positive integer before touching the merchant's items.
async function _applyBuyStock(merchantActor, itemId, qty) {
  const mData = getMerchantData(merchantActor);
  if (mData.infiniteQuantity) return;
  const item = merchantActor.items.get(itemId);
  if (!item) return;
  const safeQty = Math.max(1, Math.floor(Number(qty) || 0));
  const newQty = getItemQty(item) - safeQty;
  if (newQty <= 0) {
    if (mData.keepZeroQuantity) await item.update({ "system.quantity": 0 });
    else                        await merchantActor.deleteEmbeddedDocuments("Item", [item.id]);
  } else {
    await item.update({ "system.quantity": newQty });
  }
}

/**
 * Apply the merchant-side effects of a sale (pay out, stock the item). Runs with
 * merchant-owner privilege (possibly via socket delegation from a non-owner seller),
 * so the payout is NOT trusted from the caller: it is recomputed GM-side from the
 * merchant's own price config and the sold item. `qty` is clamped to a positive int.
 */
async function _applySellToMerchant(merchantActor, itemData, qty) {
  if (!itemData?.name) return;
  const mData = getMerchantData(merchantActor);
  qty = Math.max(1, Math.floor(Number(qty) || 0));
  // Recompute the payout from the merchant's buy modifier + the item's base price —
  // never accept a client-supplied total (it could drain the merchant's currency).
  const base   = getEffectivePrice(itemData, mData.priceOverrides);
  const unitC  = Math.max(0, Math.round(base.copper * (mData.buyModifier / 100)));
  const totalC = unitC * qty;
  if (totalC > 0 && !mData.infiniteCurrency) await deductCurrencyFromActor(merchantActor, totalC);
  const existing = merchantActor.items.find(i => i.name === itemData.name && isPhysicalItem(i));
  if (existing) {
    await existing.update({ "system.quantity": getItemQty(existing) + qty });
  } else {
    const data = foundry.utils.deepClone(itemData);
    delete data._id;
    if (data.system?.quantity !== undefined) data.system.quantity = qty;
    const created = await merchantActor.createEmbeddedDocuments("Item", [data]);
    if (mData.hideNewlySold && created[0]) {
      const d = getMerchantData(merchantActor);
      d.hiddenItems.push(created[0].id);
      await saveMerchantData(merchantActor, d);
    }
  }
}

// ─── STOCK ITEM DROP (GM stocking) ───────────────────────────────────────────
// Drag an Item document (compendium, sidebar, or another sheet) onto a category
// section of the Stock Tables / Inventory tabs to add it as merchant stock.
// Owner-gated: stocking writes the merchant actor directly (no socket path).
async function _handleStockItemDrop(merchantActor, uuid, catId, app) {
  if (!merchantActor?.isOwner) return;
  const item = await safeFromUuid(uuid);
  if (!item || item.documentName !== "Item") return;
  if (!isPhysicalItem(item))
    return ui.notifications.warn(`"${item.name}" is not a physical item and can't be sold as stock.`);

  const qty = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Stock — ${item.name}` },
    content: `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 2px;">
        <img src="${esc(item.img ?? "icons/svg/item-bag.svg")}" onerror="this.src='icons/svg/item-bag.svg'"
             style="width:40px;height:40px;border-radius:5px;object-fit:cover;border:1px solid rgba(255,255,255,.15);" />
        <label style="display:flex;align-items:center;gap:8px;font-size:.85rem;">Quantity:
          <input type="number" name="qty" value="${Math.max(1, getItemQty(item) ?? 1)}" min="1"
                 style="width:64px;text-align:center;padding:3px 6px;" />
        </label>
      </div>`,
    ok: {
      icon: "fas fa-box-open", label: "Add to Stock",
      callback: (_e, btn) => Math.max(1, parseInt(btn.form.elements.qty.value) || 1),
    },
  }).catch(() => null);
  if (!qty) return;

  const added = await addItemToActor(merchantActor, item, qty);
  if (!added) return ui.notifications.error(`Could not add "${item.name}" to ${merchantActor.name}.`);
  if (catId) {
    const d = getMerchantData(merchantActor);
    d.itemCategories[added.id] = catId;
    await saveMerchantData(merchantActor, d);
  }
  ui.notifications.info(`Stocked ${qty}× ${item.name}.`);
  app?.render();
}

// ─── BUY FLOW ─────────────────────────────────────────────────────────────────

async function _handleBuy(merchantActor, itemId, app) {
  const character = _buyerActor();
  if (!character) return ui.notifications.warn("No buyer: assign a character in User Settings or select a token you own.");

  const item = merchantActor.items.get(itemId);
  if (!item) return;

  const mData   = getMerchantData(merchantActor);
  const base    = getEffectivePrice(item, mData.priceOverrides);
  const rep     = getReputation(merchantActor.id, mData);
  const discount = mData.repEnabled === false ? 0 : (Number(rep.tier.discount) || 0);
  const unitC   = Math.max(0, Math.round(base.copper * (mData.priceModifier / 100) * (1 - discount / 100)));
  const maxQty  = mData.infiniteQuantity ? 99 : Math.max(1, getItemQty(item));
  const unitLbl = _copperToLabel(unitC);

  // Build buy dialog HTML inline (no template needed)
  const content = `
    <div style="display:flex;flex-direction:column;gap:12px;padding:8px 2px;font-family:var(--font-primary,sans-serif);">
      <div style="display:flex;align-items:center;gap:12px;">
        <img src="${esc(item.img)}" onerror="this.src='icons/svg/item-bag.svg'"
             style="width:52px;height:52px;border-radius:6px;object-fit:cover;border:1px solid rgba(255,255,255,.15);" />
        <div>
          <div style="font-size:1rem;font-weight:700;margin-bottom:3px;">${esc(item.name)}</div>
          <div style="font-size:.8rem;opacity:.65;">Unit price: <strong>${unitC === 0 ? "free" : unitLbl}</strong></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <label style="font-size:.85rem;white-space:nowrap;">Quantity:</label>
        <input type="number" name="qty" value="1" min="1" max="${maxQty}"
               style="width:64px;text-align:center;padding:4px 6px;" />
        <span style="font-size:.76rem;opacity:.55;">${mData.infiniteQuantity ? "(unlimited)" : `max ${maxQty}`}</span>
      </div>
      ${unitC > 0 ? `<div style="font-size:.82rem;opacity:.8;">Your gold: <strong>${_copperToLabel(getActorCopper(character))}</strong></div>` : ""}
    </div>`;

  const qty = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Buy — ${item.name}` },
    content,
    ok: {
      icon: "fas fa-shopping-cart", label: "Purchase",
      callback: (_e, btn) => Math.max(1, Math.min(parseInt(btn.form.elements.qty.value) || 1, maxQty)),
    },
  }).catch(() => null);

  if (!qty) return;

  const totalC = unitC * qty;

  if (totalC > 0 && getActorCopper(character) < totalC)
    return ui.notifications.warn(`${character.name} cannot afford this. Needs ${_copperToLabel(totalC)}.`);

  // A non-owner buyer needs a GM online to apply the merchant-side stock change.
  const delegate = !_canWriteMerchant(merchantActor);
  if (delegate && !_activeGM())
    return ui.notifications.warn("A GM must be online to trade with this merchant.");

  // Deduct currency
  if (totalC > 0) {
    const ok = await deductCurrencyFromActor(character, totalC);
    if (!ok) return ui.notifications.error("Failed to deduct currency.");
  }

  // Add item to buyer
  await addItemToActor(character, item, qty);

  // Reduce merchant stock (delegate to GM when the buyer doesn't own the merchant)
  if (delegate) {
    game.socket.emit(`module.${MODULE_ID}`, { type: "merchantTx", op: "buyStock", merchantId: merchantActor.id, itemId: item.id, qty });
  } else {
    await _applyBuyStock(merchantActor, item.id, qty);
  }

  // Always post to chat so all players see the purchase
  ChatMessage.create({
    content: `<div style="background:rgba(9,8,14,0.85);border:1px solid rgba(245,180,48,0.25);border-left:3px solid #f5b430;border-radius:6px;padding:9px 12px;font-family:Signika,serif;color:#efe6d8;">
      <div style="font-size:.8rem;font-weight:700;color:#f5b430;margin-bottom:4px;"><i class="fas fa-store" style="margin-right:5px;"></i>${esc(merchantActor.name)}</div>
      <div style="font-size:.84rem;"><strong>${esc(character.name)}</strong> purchased <strong>${qty}× ${esc(item.name)}</strong>${totalC > 0 ? ` for <strong>${_copperToLabel(totalC)}</strong>` : " (free)"}.
      </div></div>`,
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
  });

  // Earn reputation
  if (totalC > 0) await earnReputation(merchantActor.id, totalC, mData);

  ui.notifications.info(`Bought ${qty}× ${item.name}${totalC > 0 ? ` for ${_copperToLabel(totalC)}` : ""}.`);
  app?.render();
}

// ─── SELL FLOW ────────────────────────────────────────────────────────────────

async function _executeSell(merchantActor, sellerItem, qty, mData, app) {
  const character = _buyerActor();
  if (!character) return;

  // Never sell more than the seller actually owns (guards against tampered inputs).
  qty = Math.max(1, Math.min(Math.floor(qty) || 1, getItemQty(sellerItem)));

  const base     = getEffectivePrice(sellerItem, mData.priceOverrides);
  const unitC    = Math.max(0, Math.round(base.copper * (mData.buyModifier / 100)));
  const totalC   = unitC * qty;

  // A non-owner seller needs a GM online to apply the merchant-side payout/stock change.
  const delegate = !_canWriteMerchant(merchantActor);
  if (delegate && !_activeGM())
    return ui.notifications.warn("A GM must be online to trade with this merchant.");

  // Snapshot the item source before removing it from the seller (needed to stock the merchant)
  const itemData = sellerItem.toObject();

  // Remove from seller
  const currentQty = getItemQty(sellerItem);
  if (currentQty <= qty) await character.deleteEmbeddedDocuments("Item", [sellerItem.id]);
  else                    await sellerItem.update({ "system.quantity": currentQty - qty });

  // Pay the seller
  if (totalC > 0) await addCurrencyToActor(character, totalC);

  // Merchant-side effects (charge merchant currency + stock the item) — delegate when not owner
  if (delegate) {
    game.socket.emit(`module.${MODULE_ID}`, { type: "merchantTx", op: "sellToMerchant", merchantId: merchantActor.id, itemData, qty });
  } else {
    await _applySellToMerchant(merchantActor, itemData, qty);
  }

  ChatMessage.create({
    content: `<div style="background:rgba(9,8,14,0.85);border:1px solid rgba(245,180,48,0.25);border-left:3px solid #f5b430;border-radius:6px;padding:9px 12px;font-family:Signika,serif;color:#efe6d8;">
      <div style="font-size:.8rem;font-weight:700;color:#f5b430;margin-bottom:4px;"><i class="fas fa-store" style="margin-right:5px;"></i>${esc(merchantActor.name)}</div>
      <div style="font-size:.84rem;"><strong>${esc(character.name)}</strong> sold <strong>${qty}× ${esc(sellerItem.name)}</strong>${totalC > 0 ? ` for <strong>${_copperToLabel(totalC)}</strong>` : ""}.
      </div></div>`,
    style: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
  });

  ui.notifications.info(`Sold ${qty}× ${sellerItem.name}${totalC > 0 ? ` for ${_copperToLabel(totalC)}` : ""}.`);
  app?.render();
}

async function _handleSellDrop(merchantActor, itemUuid, app) {
  const character = _buyerActor();
  if (!character) return ui.notifications.warn("No seller: assign a character or select a token you own.");

  const mData = getMerchantData(merchantActor);
  if (mData.purchaseOnly) return ui.notifications.warn(`${merchantActor.name} does not buy items.`);

  const droppedItem = await safeFromUuid(itemUuid);
  if (!droppedItem || droppedItem.documentName !== "Item") return;

  // Verify the item belongs to the player's character
  const sellerItem = character.items.get(droppedItem.id) ?? character.items.find(i => i.name === droppedItem.name);
  if (!sellerItem) return ui.notifications.warn("That item doesn't belong to your character.");
  if (!isPhysicalItem(sellerItem)) return;

  const base   = getEffectivePrice(sellerItem, mData.priceOverrides);
  const unitC  = Math.max(0, Math.round(base.copper * (mData.buyModifier / 100)));
  const maxQty = getItemQty(sellerItem);

  const content = `
    <div style="display:flex;flex-direction:column;gap:12px;padding:8px 2px;font-family:var(--font-primary,sans-serif);">
      <div style="display:flex;align-items:center;gap:12px;">
        <img src="${esc(sellerItem.img)}" onerror="this.src='icons/svg/item-bag.svg'"
             style="width:52px;height:52px;border-radius:6px;object-fit:cover;border:1px solid rgba(255,255,255,.15);" />
        <div>
          <div style="font-size:1rem;font-weight:700;margin-bottom:3px;">${esc(sellerItem.name)}</div>
          <div style="font-size:.8rem;opacity:.65;">Sell price: <strong>${_copperToLabel(unitC)}</strong> each</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <label style="font-size:.85rem;white-space:nowrap;">Quantity:</label>
        <input type="number" name="qty" value="${maxQty}" min="1" max="${maxQty}"
               style="width:64px;text-align:center;padding:4px 6px;" />
        <span style="font-size:.76rem;opacity:.55;">max ${maxQty}</span>
      </div>
    </div>`;

  const qty = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Sell — ${sellerItem.name}` },
    content,
    ok: {
      icon: "fas fa-hand-holding-usd", label: "Sell",
      callback: (_e, btn) => Math.max(1, Math.min(parseInt(btn.form.elements.qty.value) || 1, maxQty)),
    },
  }).catch(() => null);

  if (!qty) return;
  await _executeSell(merchantActor, sellerItem, qty, mData, app);
}

async function _openSellPicker(merchantActor, app) {
  const character = _buyerActor();
  if (!character) return ui.notifications.warn("No seller: assign a character or select a token you own.");
  const mData = getMerchantData(merchantActor);
  if (mData.purchaseOnly) return ui.notifications.warn(`${merchantActor.name} does not buy items.`);

  const items = character.items.filter(i => isPhysicalItem(i) && getItemQty(i) > 0);
  if (!items.length) return ui.notifications.info(`${character.name} has nothing to sell.`);

  const rows = items.map(item => {
    const base  = parsePriceCopper(item);
    const unitC = Math.max(0, Math.round(base.copper * (mData.buyModifier / 100)));
    const maxQ  = getItemQty(item);
    return `<tr style="border-bottom:1px solid rgba(255,255,255,.06);">
      <td style="padding:5px 4px;"><img src="${esc(item.img)}" onerror="this.src='icons/svg/item-bag.svg'" style="width:26px;height:26px;border-radius:3px;object-fit:cover;vertical-align:middle;" /></td>
      <td style="padding:5px 8px;font-size:.85rem;flex:1;">${esc(item.name)}</td>
      <td style="padding:5px 8px;font-size:.78rem;opacity:.65;white-space:nowrap;">${_copperToLabel(unitC)} ea.</td>
      <td style="padding:5px 4px;white-space:nowrap;">
        <input type="number" name="qty_${item.id}" min="0" max="${maxQ}" value="0"
               style="width:50px;text-align:center;padding:2px 4px;" />
        <span style="font-size:.7rem;opacity:.5;">${maxQ > 1 ? `/${maxQ}` : ""}</span>
      </td>
    </tr>`;
  }).join("");

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Sell to ${merchantActor.name}` },
    content: `<table style="width:100%;border-collapse:collapse;">${rows}</table>`,
    ok: {
      icon: "fas fa-hand-holding-usd", label: "Sell Selected",
      callback: (_e, btn) => items
        .map(i => ({ item: i, qty: Math.min(parseInt(btn.form.elements[`qty_${i.id}`]?.value) || 0, getItemQty(i)) }))
        .filter(({ qty }) => qty > 0),
    },
  }).catch(() => null);

  if (!result?.length) return;
  for (const { item, qty } of result) await _executeSell(merchantActor, item, qty, mData, app);
}

// ─── SPECIAL ORDERS ────────────────────────────────────────────────────────
// Place a special order. `prefill` may carry a dragged item (uuid/img/name) so the
// dialog opens pre-populated; players writing to a merchant they don't own are
// delegated to an active GM (same as buy/sell).
async function _requestSpecialOrder(merchantActor, app, prefill = {}) {
  const character = _buyerActor();
  if (!character) return ui.notifications.warn("No character: assign one or select a token you own.");

  const imgHtml = prefill.itemImg
    ? `<div style="display:flex;align-items:center;gap:10px;">
         <img src="${esc(prefill.itemImg)}" onerror="this.src='icons/svg/item-bag.svg'" style="width:40px;height:40px;border-radius:5px;object-fit:cover;border:1px solid rgba(255,255,255,.15);" />
         <span style="font-size:.85rem;font-weight:600;">${esc(prefill.itemName ?? prefill.description ?? "")}</span>
       </div>`
    : "";

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Place a Special Order" },
    content: `<div style="padding:8px;display:flex;flex-direction:column;gap:10px;">
      ${imgHtml}
      <div><label style="font-size:.82rem;font-weight:600;">What item are you looking for?</label>
      <input type="text" name="description" value="${esc(prefill.description ?? "")}" placeholder="e.g. Masterwork Longsword, rare alchemical reagent…"
             style="width:100%;margin-top:4px;" /></div>
      <div><label style="font-size:.82rem;font-weight:600;">Additional notes (optional)</label>
      <textarea name="note" rows="2" placeholder="Any specific requirements…"
                style="width:100%;margin-top:4px;resize:vertical;"></textarea></div></div>`,
    ok: { icon: "fas fa-paper-plane", label: "Place Order", callback: (_e, btn) => ({
      description: btn.form.elements.description.value.trim(),
      note:        btn.form.elements.note.value.trim(),
    })},
  }).catch(() => null);
  if (!result?.description) return;

  const order = {
    id: newId(), userId: game.user.id, characterName: character.name,
    description: result.description, note: result.note,
    itemUuid: prefill.itemUuid ?? null, itemImg: prefill.itemImg ?? null, itemName: prefill.itemName ?? null,
    status: "pending", depositC: 0, priceC: 0, createdAt: Date.now(),
  };
  if (_canWriteMerchant(merchantActor)) {
    const d = getMerchantData(merchantActor);
    d.specialOrders.push(order);
    await saveMerchantData(merchantActor, d);
  } else if (_activeGM()) {
    game.socket.emit(`module.${MODULE_ID}`, { type: "merchantTx", op: "placeOrder", merchantId: merchantActor.id, order });
  } else {
    return ui.notifications.warn("A GM must be online to place an order with this merchant.");
  }
  ui.notifications.info("Order placed! The merchant will notify you when it's ready.");
  app?.render();
}

function getEffectivePrice(item, priceOverrides) {
  const ov = priceOverrides?.[item.id];
  if (ov?.value > 0) {
    const d = (ov.denom ?? "gp").toLowerCase();
    const v = ov.value;
    return { copper: Math.round(v * (COIN_RATES[d] ?? 100)), label: `${v} ${d}` };
  }
  return parsePriceCopper(item);
}

// ─── DISTANCE CHECK ───────────────────────────────────────────────────────────

function getDistanceToMerchant(merchantActor) {
  const merchantToken = canvas?.tokens?.placeables.find(t => t.actor?.id === merchantActor.id);
  if (!merchantToken) return 0; // not on scene → unrestricted
  const playerTokens = canvas.tokens.controlled;
  if (!playerTokens.length) return Infinity;
  let minDist = Infinity;
  for (const pt of playerTokens) {
    try {
      const dist = canvas.grid.measurePath([pt.center, merchantToken.center]).distance;
      if (dist < minDist) minDist = dist;
    } catch { /* fallback: allow */ }
  }
  return minDist;
}

// ─── RESTOCK ─────────────────────────────────────────────────────────────────

/** Evaluate a quantity formula: a flat number ("20") or a dice expression ("2d4+3"). */
async function _evalQtyFormula(formula) {
  const f = String(formula ?? "1").trim() || "1";
  if (/^\d+$/.test(f)) return Math.max(1, parseInt(f));
  try { const r = new Roll(f); await r.evaluate(); return Math.max(1, Math.floor(r.total)); }
  catch { return 1; }
}

/** Pick the output format for a rolled spell per the table's config. "mixed"
 *  rolls the wand-share chance; unknown/unavailable formats fall back to the
 *  adapter's first offering so a stale config can't break a restock. */
function _pickSpellFormat(entry, adapter) {
  const keys = adapter.formats().map(o => o.key);
  const f = entry.spellFormat ?? "scroll";
  if (f === "mixed") {
    if (keys.includes("wand") && keys.includes("scroll")) {
      const share = Math.max(0, Math.min(100, Number(entry.wandShare ?? 25)));
      return Math.random() * 100 < share ? "wand" : "scroll";
    }
    return keys[0] ?? "scroll";
  }
  return keys.includes(f) ? f : (keys[0] ?? "scroll");
}

/** Evaluate a table's spell-rank formula (empty = base rank; flat number or
 *  dice), clamped to the spell's valid range. Cantrips (null range) ignore it. */
async function _evalSpellRank(formula, range) {
  if (!range) return 1;
  const f = String(formula ?? "").trim();
  let n = range.min;
  if (f) {
    if (/^\d+$/.test(f)) n = parseInt(f);
    else { try { const r = new Roll(f); await r.evaluate(); n = Math.floor(r.total); } catch { n = range.min; } }
  }
  return Math.min(range.max, Math.max(range.min, n || range.min));
}

/** Convert a rolled spell into a consumable item source, or null if the
 *  adapter can't handle it (ritual, missing template, conversion error). */
async function _spellResultSource(spell, entry, adapter) {
  if (!adapter.isConvertibleSpell(spell)) return null;
  const format = _pickSpellFormat(entry, adapter);
  const rank   = await _evalSpellRank(entry.spellRankFormula, adapter.rankRange(spell));
  try { return await adapter.spellToItemSource(spell, { format, rank }); }
  catch (err) { console.warn(`KCTG | Spell conversion failed for "${spell.name}":`, err); return null; }
}

/** Roll every active stock table and return the rolled item results — no mutation.
 *  Each result: { uuid, name, img, qty, tableName } for regular items, or
 *  { itemData, name, img, qty, tableName } for spells converted to consumables
 *  (scrolls/wands/cantrip decks) via the system spell adapter. `clearFirst` is
 *  true if any active table is flagged to clear inventory before adding. */
async function _rollStockResults(actor) {
  const data    = getMerchantData(actor);
  const active  = data.stockTables.filter(t => t.enabled !== false);
  const adapter = getSpellAdapter();
  const results = [];
  let clearFirst = false;
  let warnedSpells = false;
  for (const entry of active) {
    if (entry.resetBeforeAdd) clearFirst = true;
    const table = await safeFromUuid(entry.tableUuid);
    if (!table) { ui.notifications.warn(`Table not found: ${entry.tableName ?? entry.tableUuid}`); continue; }

    let rolls = 1;
    try { const r = new Roll(String(entry.rollFormula ?? "1")); await r.evaluate(); rolls = Math.max(1, Math.floor(r.total)); }
    catch { rolls = Math.max(1, parseInt(entry.rollFormula) || 1); }

    const seen = new Set();
    for (let i = 0; i < rolls; i++) {
      let draw; try { draw = await table.draw({ displayChat: false }); } catch { continue; }
      for (const result of draw.results ?? []) {
        const uuid = result.documentUuid ?? (result.documentId ? `Item.${result.documentId}` : null);
        if (!uuid) continue;
        const doc = await safeFromUuid(uuid);
        if (!doc || doc.documentName !== "Item") continue;
        if (doc.type === "spell") {
          // Spells never enter stock raw (isPhysicalItem would hide them):
          // convert to a scroll/wand/cantrip deck, or skip with one warning.
          const src = await _spellResultSource(doc, entry, adapter);
          if (!src) {
            if (!warnedSpells) {
              ui.notifications.warn("Rolled spells were skipped: ritual spells, or this system has no spell-to-item support.");
              warnedSpells = true;
            }
            continue;
          }
          // Uniqueness keys on the generated name so the same spell can
          // coexist at different ranks or in different formats.
          if (entry.unique && seen.has(src.name)) continue;
          seen.add(src.name);
          const qty = await _evalQtyFormula(entry.qtyFormula);
          results.push({ itemData: src, name: src.name, img: src.img ?? "icons/svg/item-bag.svg", qty, tableName: entry.tableName ?? table.name });
          continue;
        }
        if (entry.unique && seen.has(doc.name)) continue;
        seen.add(doc.name);
        const qty = await _evalQtyFormula(entry.qtyFormula);
        results.push({ uuid, name: doc.name, img: doc.img ?? "icons/svg/item-bag.svg", qty, tableName: entry.tableName ?? table.name });
      }
    }
  }
  return { results, clearFirst };
}

/** Add a set of rolled results to the actor (optionally clearing inventory first). */
async function _commitRestock(actor, results, clearFirst) {
  if (clearFirst && actor.items.size > 0)
    await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
  let total = 0;
  for (const r of results) {
    if (r.itemData) {
      // Generated source (spell converted to scroll/wand/deck): raw-data path.
      const created = await addItemToActor(actor, r.itemData, r.qty, true);
      if (created) total += r.qty;
      continue;
    }
    const doc = await safeFromUuid(r.uuid);
    if (doc) { await addItemToActor(actor, doc, r.qty); total += r.qty; }
  }
  // Any restock (manual, preview, quest-linked, scheduled) re-anchors the schedule.
  const d = getMerchantData(actor);
  d.lastRestockDay = getCurrentDay();
  await saveMerchantData(actor, d);
  await logActivity("restock", `${actor.name} restocked (${total} item${total === 1 ? "" : "s"})`);
  ui.notifications.info(`Restocked ${actor.name} — ${total} item(s) added.`);
}

/**
 * Scheduled restock: merchants with restockEveryDays > 0 restock automatically
 * every N workshop days. Runs only on the single responsible GM (actor writes),
 * same gate as the quest-linked auto-restock below. A merchant with no schedule
 * anchor yet is armed silently so enabling the setting doesn't restock instantly.
 */
async function _checkScheduledRestocks() {
  if (_activeGM()?.id !== game.user.id) return;
  const curDay = getCurrentDay();
  for (const actor of getMerchants()) {
    const d = getMerchantData(actor);
    const every = Math.max(0, Math.round(Number(d.restockEveryDays) || 0));
    if (!every) continue;
    if (!d.stockTables.some(t => t.enabled !== false)) continue; // nothing to roll; skip silently
    if (d.lastRestockDay == null || d.lastRestockDay > curDay) {
      d.lastRestockDay = curDay; // first run, or the clock was rewound: re-arm
      await saveMerchantData(actor, d);
      continue;
    }
    if (curDay - d.lastRestockDay >= every) await restockMerchant(actor);
  }
}
onDayAdvance(() => _checkScheduledRestocks());

/** Direct restock: roll and add everything immediately. */
async function restockMerchant(actor) {
  const { results, clearFirst } = await _rollStockResults(actor);
  if (!results.length && !clearFirst) return ui.notifications.warn("No active stock tables configured, or nothing rolled.");
  await _commitRestock(actor, results, clearFirst);
}

/** Preview restock: roll, then let the GM review/edit/uncheck before adding. */
async function previewRestock(actor, app) {
  const { results, clearFirst } = await _rollStockResults(actor);
  if (!results.length) return ui.notifications.info("Nothing was rolled (no active tables, or only empty/text results).");

  const rows = results.map((r, idx) => `
    <tr style="border-bottom:1px solid rgba(255,255,255,.06);">
      <td style="padding:4px;text-align:center;"><input type="checkbox" name="add_${idx}" checked /></td>
      <td style="padding:4px;"><img src="${esc(r.img)}" onerror="this.src='icons/svg/item-bag.svg'" style="width:26px;height:26px;border-radius:3px;object-fit:cover;vertical-align:middle;" /></td>
      <td style="padding:4px 8px;font-size:.85rem;">
        ${r.uuid
          ? `<a class="content-link" data-uuid="${esc(r.uuid)}" onclick="game.modules.get('${MODULE_ID}')?.api?.openItem?.('${esc(r.uuid)}')" style="cursor:pointer;">${esc(r.name)}</a>`
          : esc(r.name)}
        <div style="font-size:.68rem;opacity:.5;">${esc(r.tableName)}</div>
      </td>
      <td style="padding:4px;"><input type="number" name="qty_${idx}" value="${r.qty}" min="0" style="width:54px;text-align:center;" /></td>
    </tr>`).join("");

  const content = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <p style="font-size:.8rem;opacity:.8;margin:0;">Rolled ${results.length} item(s). Uncheck anything you don't want, adjust quantities, then add. Click a name to inspect it.</p>
      ${clearFirst ? `<p style="font-size:.78rem;color:#e0a050;margin:0;"><i class="fas fa-exclamation-triangle"></i> A table is set to <strong>Clear first</strong> — existing stock will be removed when you add.</p>` : ""}
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="font-size:.7rem;opacity:.6;text-align:left;"><th style="padding:2px 4px;">Add</th><th></th><th style="padding:2px 8px;">Item</th><th style="padding:2px 4px;">Qty</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const chosen = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Restock Preview — ${actor.name}`, resizable: true },
    position: { width: 460 },
    content,
    ok: {
      icon: "fas fa-check", label: "Add Selected",
      callback: (_e, btn) => results
        .map((r, idx) => ({ ...r, _add: btn.form.elements[`add_${idx}`]?.checked, qty: Math.max(0, parseInt(btn.form.elements[`qty_${idx}`]?.value) || 0) }))
        .filter(r => r._add && r.qty > 0),
    },
  }).catch(() => null);

  if (!chosen?.length) return;
  await _commitRestock(actor, chosen, clearFirst);
  app?.render();
}

// ─── ITEM DESCRIPTION EXPANSION ──────────────────────────────────────────────
// Toggle an inline, enriched description panel under an item row (lazy-loaded).
async function _toggleItemDesc(row, itemId, actor) {
  if (!row) return;
  const existing = row.querySelector(":scope > .kctg-item-desc");
  if (existing) { existing.remove(); return; }
  const panel = document.createElement("div");
  panel.className = "kctg-item-desc";
  panel.innerHTML = `<em class="kctg-dim">Loading…</em>`;
  row.appendChild(panel);
  const item = actor?.items?.get(itemId);
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

// ─── MERCHANTS APP ────────────────────────────────────────────────────────────

class MerchantsApp extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(options = {}) {
    super(options);
    this._selectedId        = null;
    this._detailTab         = "tables";
    this._selectedItemIds   = new Set();   // for drag-and-drop multi-select
    this._lastClickedItemId = null;
  }

  setPosition(pos = {}) {
    if (!this.element) return pos;
    try { return super.setPosition(pos); } catch { return pos; }
  }

  static DEFAULT_OPTIONS = {
    id: "kctg-merchants",
    classes: ["kctg-module", "kctg-merchants-app"],
    window: { title: "Merchants", resizable: true },
    position: { width: 860, height: 620, top: 70, left: 120 }
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/merchant/merchants.hbs`,
      scrollable: [".kctg-merchant-list", ".kctg-merch-tab-content"]
    }
  };

  static open(actorId = null) {
    // Non-GM players opening via scene control (no specific actorId): restore last visited
    if (!actorId && !game.user.isGM) {
      actorId = game.user.getFlag(MODULE_ID, "lastMerchant") ?? null;
      if (!actorId) {
        ui.notifications.info("Visit a merchant by double-clicking their token first.");
        return null;
      }
    }
    const existing = foundry.applications.instances?.get("kctg-merchants");
    if (existing?.rendered) {
      if (actorId) { existing._selectedId = actorId; existing.render(); }
      existing.bringToFront();
      return existing;
    }
    const app = new MerchantsApp();
    if (actorId) app._selectedId = actorId;
    app.render(true);
    return app;
  }

  async _prepareContext() {
    const isGM = game.user.isGM;

    // GM-as-shopper: when a GM has one of their own tokens selected, preview the
    // shop exactly as that token's actor sees it (and buy/sell on its behalf).
    // (asShopper is finalised below, once the selected merchant is known.)
    const _ctrlActor = canvas?.tokens?.controlled?.find(t => t.actor?.isOwner)?.actor ?? null;

    // Merchant list — GM sees all, players see only open ones
    let merchants = getMerchants().sort((a,b) => a.name.localeCompare(b.name));
    if (!isGM) merchants = merchants.filter(a => getMerchantData(a).openForBusiness);

    // Discard stale selection
    if (this._selectedId && !game.actors.get(this._selectedId)) this._selectedId = null;
    if (!this._selectedId && merchants.length) this._selectedId = merchants[0].id;

    const selActor = this._selectedId ? game.actors.get(this._selectedId) : null;
    let   mData    = selActor ? getMerchantData(selActor) : null;

    // Finalise shopper mode: a GM only previews as a shopper when the selected token
    // is NOT the merchant being viewed (otherwise they'd be buying for its own stock).
    const asShopper   = isGM && !!_ctrlActor && _ctrlActor.id !== selActor?.id;
    const shopperView = !isGM || asShopper;   // render the shop view
    const gmManage    = isGM && !asShopper;   // render GM management UI

    // Auto-migrate: merchants enabled before categories feature was added get defaults
    if (mData?.enabled && !mData.categories.length && selActor) {
      mData.categories = DEFAULT_MERCHANT_CATEGORIES.map(name => ({ id: newId(), name }));
      await saveMerchantData(selActor, mData);
    }

    // Resolve table names (+ spell-conversion view fields when the system
    // adapter supports turning rolled spells into scrolls/wands/decks)
    const spellAdapter  = getSpellAdapter();
    const rankedFormats = spellAdapter.formats();
    const formatChoices = rankedFormats.length > 1
      ? [...rankedFormats, { key: "mixed", label: "Mixed" }]
      : rankedFormats;
    let stockTables = [];
    if (mData) {
      for (const t of mData.stockTables) {
        const tbl = await safeFromUuid(t.tableUuid);
        const fmt = t.spellFormat ?? "scroll";
        stockTables.push({ ...t, enabled: t.enabled !== false,
          tableName: tbl?.name ?? t.tableName ?? "Unknown",
          tableImg:  tbl?.img  ?? "icons/svg/d20-black.svg",
          spellRankFormula: t.spellRankFormula ?? "",
          wandShare: Math.max(0, Math.min(100, Number(t.wandShare ?? 25))),
          isMixed:   fmt === "mixed",
          formatOptions: formatChoices.map(o => ({ ...o, selected: o.key === fmt })),
        });
      }
    }

    // Physical inventory with category + hidden flags + price override awareness
    const priceOverrides = mData?.priceOverrides ?? {};
    const cats           = mData?.categories    ?? [];
    const physItems = selActor
      ? selActor.items.filter(isPhysicalItem).map(i => {
          const effective  = getEffectivePrice(i, priceOverrides);
          const basePrice  = parsePriceCopper(i);
          const hasPrice   = basePrice.copper > 0;
          const ov         = priceOverrides[i.id];
          // Manual assignment takes precedence; fall back to auto-category by item type
          const manualCatId = mData?.itemCategories?.[i.id] ?? null;
          const autoCat     = manualCatId ? null : _autoCategory(i, cats);
          const categoryId  = manualCatId ?? autoCat?.id ?? null;
          return {
            id: i.id, name: i.name, img: i.img,
            qty:        getItemQty(i),
            priceLabel: effective.label !== "free" ? effective.label : null,
            categoryId,
            hidden:     (mData?.hiddenItems ?? []).includes(i.id),
            hasPrice,
            ovValue:    ov?.value  ?? 0,
            ovDenom:    ov?.denom  ?? "gp",
          };
        })
      : [];

    // Track last-visited merchant for players (used when opening via scene control)
    if (!isGM && selActor) {
      game.user.setFlag(MODULE_ID, "lastMerchant", selActor.id).catch(() => {});
    }

    // Build categorized inventory
    const categories = mData?.categories ?? [];
    const inventoryByCategory = _buildCategoryGroups(physItems, categories);

    // Player shop items — hide GM-hidden items and (unless kept) sold-out stock.
    // Items always show their real name/icon (no unidentified placeholder).
    const shopItems = physItems
      .filter(i => !shopperView || !i.hidden)
      .filter(i => !shopperView || getMerchantData(selActor)?.keepZeroQuantity || i.qty > 0);

    const shopByCategory = _buildCategoryGroups(shopItems, categories);

    // Category options for the item-category select
    const categoryOptions = [
      { id: "", name: "— Uncategorized —" },
      ...categories.map(c => ({ id: c.id, name: c.name })),
    ];

    // Influence (shopper view) — GM management sees the orders list instead.
    // Hidden when the merchant has influence disabled.
    const rep = (shopperView && selActor && mData?.repEnabled !== false) ? getReputation(selActor.id, mData) : null;

    // Special orders
    const allOrders    = mData?.specialOrders ?? [];
    const myOrders     = gmManage ? allOrders : allOrders.filter(o => o.userId === game.user.id && o.status !== "fulfilled");
    const pendingOrders = gmManage ? allOrders.filter(o => o.status === "pending") : [];
    const readyOrders   = gmManage ? allOrders.filter(o => o.status === "ready")   : [];

    // Influence standings per player (GM management view) — points are editable.
    const _tiers = _influenceTiers(mData);
    const repStandings = (gmManage && selActor) ? game.users.filter(u => !u.isGM).map(u => {
      const pts  = u.getFlag(MODULE_ID, _repKey(selActor.id)) ?? 0;
      const tier = _tierForPoints(_tiers, pts);
      return { userId: u.id, name: u.name, points: pts, tierLabel: tier?.label ?? "—", tierColor: tier?.color ?? "#888" };
    }) : [];
    // Tier rows for the settings editor
    const influenceTiers = gmManage ? _tiers : [];

    // Linked quest name
    let linkedQuestName = null;
    if (mData?.linkedQuestId) {
      const qPage = await foundry.utils.fromUuid(mData.linkedQuestId).catch(() => null);
      linkedQuestName = qPage?.name ?? mData.linkedQuestId;
    }

    return {
      isGM, gmManage, asShopper,
      shopperName: _ctrlActor?.name ?? null,
      gridUnits: canvas?.grid?.units ?? "ft",
      merchants: merchants.map(a => ({
        id:    a.id, name: a.name, img: a.img,
        isSelected:      a.id === this._selectedId,
        openForBusiness: getMerchantData(a).openForBusiness,
      })),
      selected: selActor ? {
        id: selActor.id, name: selActor.name, type: selActor.type,
        img: selActor.img,
        ...mData,
        stockTables,
      } : null,
      inventory:           physItems,
      inventoryByCategory,
      shopItems,
      shopByCategory,
      categoryOptions,
      rep, myOrders, pendingOrders, readyOrders, repStandings, influenceTiers,
      linkedQuestName,
      canConvertSpells: formatChoices.length > 0,
      detailTab:      this._detailTab,
      isTabTables:    this._detailTab === "tables",
      isTabInventory: this._detailTab === "inventory",
      isTabSettings:  this._detailTab === "settings",
      isTabOrders:    this._detailTab === "orders",
    };
  }

  _onRender(context, options) {
    const el  = this.element;
    const act = () => game.actors.get(this._selectedId);

    // ── Left panel: select merchant ──────────────────────────────────────────
    el.querySelectorAll(".kctg-merchant-list-row").forEach(row =>
      row.addEventListener("click", () => { this._selectedId = row.dataset.id; this.render(); })
    );

    // ── Left panel: drop actor ────────────────────────────────────────────────
    const listPanel = el.querySelector(".kctg-merchant-list-panel");
    if (listPanel) {
      listPanel.addEventListener("dragover", e => e.preventDefault());
      listPanel.addEventListener("drop", async e => {
        e.preventDefault();
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Actor") return;
        const actor = await foundry.utils.fromUuid(data.uuid).catch(() => null);
        if (!actor) return;
        await _enableMerchant(actor);
        this._selectedId = actor.id;
        this.render();
      });
    }

    // ── Detail tabs ──────────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-merchant-tab-btn").forEach(btn =>
      btn.addEventListener("click", () => { this._detailTab = btn.dataset.tab; this.render(); })
    );

    // ── Enable (with default categories) ─────────────────────────────────────
    el.querySelector(".kctg-merch-enable-btn")?.addEventListener("click", async () => {
      await _enableMerchant(act()); this.render();
    });

    // ── Disable (× button) ────────────────────────────────────────────────────
    el.querySelector(".kctg-merch-disable-btn")?.addEventListener("click", async () => {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Disable Merchant" },
        content: `<p>Remove <strong>${esc(act()?.name)}</strong> as a merchant?<br><small style="opacity:.7">Items remain on the actor.</small></p>`
      });
      if (!ok) return;
      await act().unsetFlag(MODULE_ID, "merchant");
      this._selectedId = null; this.render();
    });

    // ── Stock table drop ──────────────────────────────────────────────────────
    const tableDrop = el.querySelector(".kctg-merch-table-drop");
    if (tableDrop) {
      tableDrop.addEventListener("dragover", e => { e.preventDefault(); tableDrop.classList.add("kctg-drag-over"); });
      tableDrop.addEventListener("dragleave", () => tableDrop.classList.remove("kctg-drag-over"));
      tableDrop.addEventListener("drop", async e => {
        e.preventDefault(); tableDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "RollTable") return;
        const tbl = await foundry.utils.fromUuid(data.uuid).catch(() => null);
        if (!tbl) return;
        const d = getMerchantData(act());
        // Same table twice is allowed when the rows differ in spell format
        // (e.g. once as scrolls, once as wands); new rows default to scroll.
        if (d.stockTables.find(t => t.tableUuid === tbl.uuid && (t.spellFormat ?? "scroll") === "scroll"))
          return ui.notifications.warn(`${tbl.name} is already listed. To roll it again for a different output, change the existing row's Spells format first.`);
        d.stockTables.push({ id: newId(), tableUuid: tbl.uuid, tableName: tbl.name,
          tableImg: tbl.img ?? "icons/svg/d20-black.svg",
          rollFormula: "1d4+1", qtyFormula: "1", unique: false, resetBeforeAdd: false, enabled: true,
          spellFormat: "scroll", wandShare: 25, spellRankFormula: "" });
        await saveMerchantData(act(), d); this.render();
      });
    }

    // ── Per-table settings ────────────────────────────────────────────────────
    const updateTable = async (id, patch) => {
      const d = getMerchantData(act());
      const t = d.stockTables.find(t => t.id === id); if (!t) return;
      Object.assign(t, patch); await saveMerchantData(act(), d);
    };
    el.querySelectorAll(".kctg-tbl-formula").forEach(inp =>
      inp.addEventListener("change", e => updateTable(inp.dataset.id, { rollFormula: e.target.value.trim() || "1" })));
    el.querySelectorAll(".kctg-tbl-qty").forEach(inp =>
      inp.addEventListener("change", e => updateTable(inp.dataset.id, { qtyFormula: e.target.value.trim() || "1" })));
    el.querySelectorAll(".kctg-tbl-unique").forEach(cb =>
      cb.addEventListener("change", e => updateTable(cb.dataset.id, { unique: e.target.checked })));
    el.querySelectorAll(".kctg-tbl-reset").forEach(cb =>
      cb.addEventListener("change", e => updateTable(cb.dataset.id, { resetBeforeAdd: e.target.checked })));
    el.querySelectorAll(".kctg-tbl-active").forEach(cb =>
      cb.addEventListener("change", e => updateTable(cb.dataset.id, { enabled: e.target.checked })));
    el.querySelectorAll(".kctg-tbl-spellformat").forEach(sel =>
      sel.addEventListener("change", async e => {
        await updateTable(sel.dataset.id, { spellFormat: e.target.value });
        this.render(); // show/hide the wand-share input
      }));
    el.querySelectorAll(".kctg-tbl-wandshare").forEach(inp =>
      inp.addEventListener("change", e => updateTable(inp.dataset.id,
        { wandShare: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) })));
    el.querySelectorAll(".kctg-tbl-rank").forEach(inp =>
      inp.addEventListener("change", e => updateTable(inp.dataset.id, { spellRankFormula: e.target.value.trim() })));
    el.querySelectorAll(".kctg-tbl-remove").forEach(btn =>
      btn.addEventListener("click", async () => {
        const d = getMerchantData(act());
        d.stockTables = d.stockTables.filter(t => t.id !== btn.dataset.id);
        await saveMerchantData(act(), d); this.render();
      }));

    // ── Restock ───────────────────────────────────────────────────────────────
    el.querySelector(".kctg-merch-restock-btn")?.addEventListener("click", async () => {
      await restockMerchant(act()); this.render();
    });
    el.querySelector(".kctg-merch-preview-btn")?.addEventListener("click", () => previewRestock(act(), this));

    // ── Item description expand (stock / inventory / shop rows) ───────────────
    el.querySelectorAll(".kctg-item-info").forEach(btn =>
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const row = btn.closest("li");
        await _toggleItemDesc(row, btn.dataset.itemId, act());
      })
    );

    // ── Inventory: multi-select (click / shift-click / ctrl-click) ────────────
    // Cover both inventory rows and stock-tab rows — both are draggable + selectable
    const allRows = [...el.querySelectorAll("[data-item-id][draggable='true']")];
    const allIds  = allRows.map(r => r.dataset.itemId);

    const refreshSelection = () => allRows.forEach(r =>
      r.classList.toggle("kctg-item-selected", this._selectedItemIds.has(r.dataset.itemId))
    );

    allRows.forEach((row, idx) => {
      row.addEventListener("click", e => {
        // Ignore clicks on buttons/selects inside the row
        if (e.target.closest("button, select, input")) return;
        const id = row.dataset.itemId;
        if (e.shiftKey && this._lastClickedItemId) {
          const lastIdx = allIds.indexOf(this._lastClickedItemId);
          const [from, to] = [Math.min(lastIdx, idx), Math.max(lastIdx, idx)];
          for (let i = from; i <= to; i++) this._selectedItemIds.add(allIds[i]);
        } else if (e.ctrlKey || e.metaKey) {
          if (this._selectedItemIds.has(id)) this._selectedItemIds.delete(id);
          else this._selectedItemIds.add(id);
        } else {
          this._selectedItemIds.clear();
          this._selectedItemIds.add(id);
        }
        this._lastClickedItemId = id;
        refreshSelection();
      });
    });

    // ── Inventory: drag items → category sections ─────────────────────────────
    allRows.forEach(row => {
      row.addEventListener("dragstart", e => {
        const id  = row.dataset.itemId;
        const ids = this._selectedItemIds.has(id) ? [...this._selectedItemIds] : [id];
        e.dataTransfer.setData("text/plain", JSON.stringify({ type: "kctg-items", ids }));
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("kctg-item-dragging");
        // Ensure dragged item is in selection visually
        if (!this._selectedItemIds.has(id)) { this._selectedItemIds.clear(); this._selectedItemIds.add(id); refreshSelection(); }
      });
      row.addEventListener("dragend", () => row.classList.remove("kctg-item-dragging"));
    });

    el.querySelectorAll(".kctg-merch-cat-section[data-cat-id]").forEach(section => {
      section.addEventListener("dragover", e => { e.preventDefault(); section.classList.add("kctg-drag-over"); });
      section.addEventListener("dragleave", () => section.classList.remove("kctg-drag-over"));
      section.addEventListener("drop", async e => {
        e.preventDefault(); section.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        // External Item drag (compendium / sidebar / sheet) → add as stock in this category
        if (data.type === "Item" && data.uuid)
          return _handleStockItemDrop(act(), data.uuid, section.dataset.catId || null, this);
        if (data.type !== "kctg-items") return;
        const catId = section.dataset.catId || null;
        const d = getMerchantData(act());
        for (const itemId of data.ids) {
          if (catId) d.itemCategories[itemId] = catId;
          else delete d.itemCategories[itemId];
        }
        await saveMerchantData(act(), d);
        this._selectedItemIds.clear();
        this.render();
      });
    });

    // ── Inventory: toggle item hidden ─────────────────────────────────────────
    el.querySelectorAll(".kctg-merch-item-hide").forEach(btn =>
      btn.addEventListener("click", async () => {
        const d = getMerchantData(act());
        const itemId = btn.dataset.id;
        const idx = d.hiddenItems.indexOf(itemId);
        if (idx === -1) d.hiddenItems.push(itemId); else d.hiddenItems.splice(idx, 1);
        await saveMerchantData(act(), d); this.render();
      })
    );

    // ── Inventory: remove item ─────────────────────────────────────────────────
    el.querySelectorAll(".kctg-merch-inv-remove").forEach(btn =>
      btn.addEventListener("click", async () => {
        await act().deleteEmbeddedDocuments("Item", [btn.dataset.id]); this.render();
      })
    );
    el.querySelector(".kctg-merch-clear-inv")?.addEventListener("click", async () => {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Clear Inventory" },
        content: `<p>Remove all items from <strong>${esc(act().name)}</strong>?</p>`
      });
      if (!ok) return;
      await act().deleteEmbeddedDocuments("Item", act().items.map(i => i.id)); this.render();
    });

    // ── Categories: add ───────────────────────────────────────────────────────
    el.querySelector(".kctg-merch-cat-add")?.addEventListener("click", async () => {
      const d = getMerchantData(act());
      d.categories.push({ id: newId(), name: "New Category" });
      await saveMerchantData(act(), d); this.render();
    });

    // ── Categories: rename ────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-merch-cat-name").forEach(inp =>
      inp.addEventListener("change", async e => {
        const d = getMerchantData(act());
        const cat = d.categories.find(c => c.id === inp.dataset.id);
        if (cat) { cat.name = e.target.value.trim() || cat.name; await saveMerchantData(act(), d); }
      })
    );

    // ── Categories: remove ────────────────────────────────────────────────────
    el.querySelectorAll(".kctg-merch-cat-remove").forEach(btn =>
      btn.addEventListener("click", async () => {
        const d = getMerchantData(act());
        d.categories = d.categories.filter(c => c.id !== btn.dataset.id);
        // Unassign any items in this category
        for (const [k,v] of Object.entries(d.itemCategories)) {
          if (v === btn.dataset.id) delete d.itemCategories[k];
        }
        await saveMerchantData(act(), d); this.render();
      })
    );

    // ── Settings ──────────────────────────────────────────────────────────────
    const saveSetting = async (key, value) => {
      const d = getMerchantData(act()); d[key] = value; await saveMerchantData(act(), d);
    };
    el.querySelector(".kctg-merch-open")?.addEventListener("change",          async e => {
      await saveSetting("openForBusiness", e.target.checked);
      _applyTokenVisibility(act());
      this.render();
    });
    el.querySelector(".kctg-merch-distance")?.addEventListener("change",     e => { saveSetting("distanceLimit", Math.max(0, parseInt(e.target.value)||0)); this.render(); });
    el.querySelector(".kctg-merch-hide-closed")?.addEventListener("change",  async e => {
      await saveSetting("hideWhenClosed", e.target.checked);
      _applyTokenVisibility(act());
    });
    el.querySelector(".kctg-merch-price-mod")?.addEventListener("change",    e => saveSetting("priceModifier",    Math.max(1, parseInt(e.target.value)||100)));
    el.querySelector(".kctg-merch-purchase-only")?.addEventListener("change",async e => { await saveSetting("purchaseOnly", e.target.checked); this.render(); });
    el.querySelector(".kctg-merch-buy-mod")?.addEventListener("change",      e => saveSetting("buyModifier",      Math.max(1, parseInt(e.target.value)||50)));
    el.querySelector(".kctg-merch-base-price-only")?.addEventListener("change", e => saveSetting("onlyBasePrice",   e.target.checked));
    el.querySelector(".kctg-merch-inf-currency")?.addEventListener("change", e => saveSetting("infiniteCurrency", e.target.checked));
    el.querySelector(".kctg-merch-hide-sold")?.addEventListener("change",    e => saveSetting("hideNewlySold",    e.target.checked));
    el.querySelector(".kctg-merch-infinite")?.addEventListener("change",     e => saveSetting("infiniteQuantity", e.target.checked));
    el.querySelector(".kctg-merch-zero-qty")?.addEventListener("change",     e => saveSetting("keepZeroQuantity", e.target.checked));
    el.querySelector(".kctg-merch-log")?.addEventListener("change",          e => saveSetting("logActivity",      e.target.checked));
    el.querySelector(".kctg-merch-rep-enabled")?.addEventListener("change",  async e => { await saveSetting("repEnabled", e.target.checked); this.render(); });
    el.querySelector(".kctg-merch-rep-gpp")?.addEventListener("change",      e => saveSetting("repGoldPerPoint", Math.max(1, parseInt(e.target.value) || 10)));
    el.querySelector(".kctg-merch-rep-reset")?.addEventListener("click", async () => {
      const lowestTier = _influenceTiers(getMerchantData(act()))[0]?.label ?? "the lowest tier";
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Reset Reputation" },
        content: `<p>Reset <strong>all players'</strong> reputation with <strong>${esc(act()?.name)}</strong> back to ${esc(lowestTier)}?</p>`
      });
      if (!ok) return;
      await resetMerchantReputation(act().id);
      ui.notifications.info("Influence reset.");
      this.render();
    });

    // ── Influence tier editor ─────────────────────────────────────────────────
    const updateTier = async (id, patch) => {
      const d = getMerchantData(act());
      const t = (d.influenceTiers ?? []).find(t => t.id === id); if (!t) return;
      Object.assign(t, patch); await saveMerchantData(act(), d); this.render();
    };
    el.querySelectorAll(".kctg-merch-tier-label").forEach(inp =>
      inp.addEventListener("change", e => updateTier(inp.dataset.id, { label: e.target.value.trim() || "Tier" })));
    el.querySelectorAll(".kctg-merch-tier-min").forEach(inp =>
      inp.addEventListener("change", e => updateTier(inp.dataset.id, { min: Math.max(0, parseInt(e.target.value) || 0) })));
    el.querySelectorAll(".kctg-merch-tier-discount").forEach(inp =>
      inp.addEventListener("change", e => updateTier(inp.dataset.id, { discount: parseInt(e.target.value) || 0 }))); // negatives allowed (surcharge)
    el.querySelectorAll(".kctg-merch-tier-remove").forEach(btn =>
      btn.addEventListener("click", async () => {
        const d = getMerchantData(act());
        const tiers = d.influenceTiers ?? [];
        if (tiers.length <= 1) return ui.notifications.warn("A merchant needs at least one influence tier.");
        d.influenceTiers = tiers.filter(t => t.id !== btn.dataset.id);
        await saveMerchantData(act(), d); this.render();
      }));
    el.querySelector(".kctg-merch-tier-add")?.addEventListener("click", async () => {
      const d = getMerchantData(act());
      d.influenceTiers = d.influenceTiers ?? [];
      const maxMin = d.influenceTiers.reduce((m, t) => Math.max(m, t.min ?? 0), 0);
      d.influenceTiers.push({ id: newId(), label: "New Tier", min: maxMin + 100, discount: 0, color: "#f5b430" });
      await saveMerchantData(act(), d); this.render();
    });
    // Manually set a player's influence points
    el.querySelectorAll(".kctg-merch-inf-points").forEach(inp =>
      inp.addEventListener("change", async e => {
        await setUserInfluence(act().id, inp.dataset.userId, parseInt(e.target.value) || 0);
        this.render();
      }));

    // ── Special orders: player creates order (button or drag-and-drop) ────────
    el.querySelector(".kctg-merch-request-order-btn")?.addEventListener("click", () =>
      _requestSpecialOrder(act(), this));

    const orderDrop = el.querySelector(".kctg-merch-order-drop");
    if (orderDrop) {
      orderDrop.addEventListener("dragover",  e => { e.preventDefault(); orderDrop.classList.add("kctg-drag-over"); });
      orderDrop.addEventListener("dragleave", () => orderDrop.classList.remove("kctg-drag-over"));
      orderDrop.addEventListener("drop", async e => {
        e.preventDefault(); orderDrop.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item" || !data.uuid) return ui.notifications.warn("Drop an Item (e.g. from a compendium) here to request it.");
        const item = await safeFromUuid(data.uuid);
        if (!item) return ui.notifications.warn("Could not resolve that item.");
        _requestSpecialOrder(act(), this, { description: item.name, itemUuid: data.uuid, itemImg: item.img, itemName: item.name });
      });
    }

    // ── Special orders: GM marks ready ───────────────────────────────────────
    el.querySelectorAll(".kctg-merch-order-ready-btn").forEach(btn =>
      btn.addEventListener("click", async () => {
        const orderId = btn.dataset.id;
        const priceStr = await foundry.applications.api.DialogV2.prompt({
          window: { title: "Set Order Price" },
          content: `<div style="padding:8px;"><label>Final price (e.g. 15 gp):</label>
            <input type="text" name="price" placeholder="15 gp" style="width:100%;margin-top:4px;" /></div>`,
          ok: { label: "Mark Ready", callback: (_e, btn) => btn.form.elements.price.value.trim() },
        }).catch(() => null);
        if (!priceStr) return;
        const d = getMerchantData(act());
        const order = d.specialOrders.find(o => o.id === orderId);
        if (!order) return;
        order.status = "ready"; order.priceLabel = priceStr;
        await saveMerchantData(act(), d);
        // Notify player via chat
        ChatMessage.create({ content: `<div style="background:rgba(9,8,14,.85);border:1px solid rgba(245,180,48,.25);border-left:3px solid #f5b430;border-radius:6px;padding:9px 12px;font-family:Signika,serif;color:#efe6d8;"><div style="font-size:.8rem;font-weight:700;color:#f5b430;margin-bottom:4px;"><i class="fas fa-store" style="margin-right:5px;"></i>Special Order Ready</div><div style="font-size:.84rem;"><strong>${esc(order.characterName)}</strong>'s order for <em>${esc(order.description)}</em> is ready — <strong>${esc(priceStr)}</strong>.</div></div>`, whisper: [order.userId] });
        this.render();
      })
    );

    // ── Special orders: GM rejects ────────────────────────────────────────────
    el.querySelectorAll(".kctg-merch-order-reject-btn").forEach(btn =>
      btn.addEventListener("click", async () => {
        const d = getMerchantData(act());
        d.specialOrders = d.specialOrders.filter(o => o.id !== btn.dataset.id);
        await saveMerchantData(act(), d); this.render();
      })
    );

    // ── Linked quest: drag journal page ───────────────────────────────────────
    const questSlot = el.querySelector(".kctg-merch-quest-slot");
    if (questSlot) {
      questSlot.addEventListener("dragover", e => { e.preventDefault(); questSlot.classList.add("kctg-drag-over"); });
      questSlot.addEventListener("dragleave", () => questSlot.classList.remove("kctg-drag-over"));
      questSlot.addEventListener("drop", async e => {
        e.preventDefault(); questSlot.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (!["JournalEntryPage","JournalEntry"].includes(data.type)) return;
        const doc = await foundry.utils.fromUuid(data.uuid).catch(() => null);
        if (!doc) return;
        const d = getMerchantData(act());
        d.linkedQuestId = doc.uuid;
        await saveMerchantData(act(), d); this.render();
      });
    }
    el.querySelector(".kctg-merch-quest-clear")?.addEventListener("click", async () => {
      const d = getMerchantData(act()); d.linkedQuestId = null;
      await saveMerchantData(act(), d); this.render();
    });

    // ── Scheduled restock interval ────────────────────────────────────────────
    el.querySelector(".kctg-merch-restock-days")?.addEventListener("change", async e => {
      const d = getMerchantData(act());
      d.restockEveryDays = Math.max(0, parseInt(e.target.value) || 0);
      await saveMerchantData(act(), d); this.render();
    });

    // ── Price overrides (0-value items) ──────────────────────────────────────
    const saveOverride = async (itemId, value, denom) => {
      const d = getMerchantData(act());
      if (!d.priceOverrides) d.priceOverrides = {};
      if (value > 0) d.priceOverrides[itemId] = { value, denom };
      else delete d.priceOverrides[itemId];
      await saveMerchantData(act(), d);
    };
    el.querySelectorAll(".kctg-merch-price-ov-val").forEach(inp =>
      inp.addEventListener("change", e => {
        const row   = inp.closest("[data-item-id]");
        const denom = row?.querySelector(".kctg-merch-price-ov-denom")?.value ?? "gp";
        saveOverride(inp.dataset.id, Math.max(0, parseFloat(e.target.value) || 0), denom);
      })
    );
    el.querySelectorAll(".kctg-merch-price-ov-denom").forEach(sel =>
      sel.addEventListener("change", e => {
        const row = sel.closest("[data-item-id]");
        const val = parseFloat(row?.querySelector(".kctg-merch-price-ov-val")?.value) || 0;
        saveOverride(sel.dataset.id, val, e.target.value);
      })
    );

    // ── Buy buttons (player shop view) ───────────────────────────────────────
    el.querySelectorAll(".kctg-merch-buy-btn").forEach(btn =>
      btn.addEventListener("click", () => _handleBuy(act(), btn.dataset.itemId, this))
    );

    // ── Sell drop zone (player drags item from actor sheet) ────────────────────
    const sellZone = el.querySelector(".kctg-merch-sell-zone");
    if (sellZone) {
      sellZone.addEventListener("dragover", e => { e.preventDefault(); sellZone.classList.add("kctg-drag-over"); });
      sellZone.addEventListener("dragleave", () => sellZone.classList.remove("kctg-drag-over"));
      sellZone.addEventListener("drop", async e => {
        e.preventDefault(); sellZone.classList.remove("kctg-drag-over");
        let data; try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (data.type !== "Item" || !data.uuid) return;
        await _handleSellDrop(act(), data.uuid, this);
      });
    }

    // ── Sell picker button ─────────────────────────────────────────────────────
    el.querySelector(".kctg-merch-sell-picker-btn")?.addEventListener("click", () =>
      _openSellPicker(act(), this)
    );

    // ── Resize handle ─────────────────────────────────────────────────────────
    const handle    = el.querySelector(".kctg-resize-handle");
    const leftPanel = el.querySelector(".kctg-merchant-list-panel");
    if (handle && leftPanel) {
      let sx, sw;
      handle.addEventListener("mousedown", e => {
        sx = e.clientX; sw = leftPanel.offsetWidth;
        const onMove = ev => {
          leftPanel.style.width = `${Math.min(380, Math.max(140, sw + (ev.clientX - sx)))}px`;
        };
        const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
  }
}

// ─── CATEGORY GROUPING HELPER ─────────────────────────────────────────────────

function _buildCategoryGroups(items, categories) {
  const groups = [];
  for (const cat of categories) {
    const catItems = items.filter(i => i.categoryId === cat.id);
    groups.push({ id: cat.id, name: cat.name, items: catItems });
  }
  const uncategorized = items.filter(i => !i.categoryId || !categories.find(c => c.id === i.categoryId));
  if (uncategorized.length) {
    groups.push({ id: null, name: "General", items: uncategorized });
  }
  return groups;
}

// ─── TOKEN VISIBILITY HELPER ─────────────────────────────────────────────────

function _applyTokenVisibility(actor) {
  if (!actor || !game.user.isGM) return;
  const data   = getMerchantData(actor);
  if (!data.hideWhenClosed) return;
  const hidden = !data.openForBusiness;
  canvas?.tokens?.placeables
    .filter(t => t.actor?.id === actor.id)
    .forEach(t => t.document.update({ hidden }));
}

// ─── HOOKS ────────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  // Merchant-side transaction delegation: a non-owner buyer/seller emits the
  // merchant write here; the single responsible (first active) GM applies it.
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (data?.type !== "merchantTx" || !game.user.isGM) return;
    if (_activeGM()?.id !== game.user.id) return; // only one GM performs the write
    const merchant = game.actors.get(data.merchantId);
    if (!merchant) return;
    if      (data.op === "buyStock")       await _applyBuyStock(merchant, data.itemId, data.qty);
    else if (data.op === "sellToMerchant") await _applySellToMerchant(merchant, data.itemData, data.qty);
    else if (data.op === "placeOrder") {
      const d = getMerchantData(merchant);
      d.specialOrders.push(data.order);
      await saveMerchantData(merchant, d);
    }
  });

  // When a quest completes, restock any merchant linked to it.
  // Restock writes to the actor, so only the responsible GM should run it (avoids
  // duplicate restocks across multiple GMs and permission errors on player clients).
  Hooks.on("kctg:questCompleted", async (questPageId, questName) => {
    if (_activeGM()?.id !== game.user.id) return;
    for (const actor of getMerchants()) {
      const d = getMerchantData(actor);
      if (!d.linkedQuestId) continue;
      const page = await foundry.utils.fromUuid(d.linkedQuestId).catch(() => null);
      if (!page || page.id !== questPageId) continue;
      await restockMerchant(actor);
      ChatMessage.create({ content: `<div style="background:rgba(9,8,14,.85);border:1px solid rgba(245,180,48,.25);border-left:3px solid #f5b430;border-radius:6px;padding:9px 12px;font-family:Signika,serif;color:#efe6d8;"><div style="font-size:.8rem;font-weight:700;color:#f5b430;margin-bottom:4px;"><i class="fas fa-store" style="margin-right:5px;"></i>${esc(actor.name)}</div><div style="font-size:.84rem;">Quest <em>${esc(questName)}</em> completed — the shop has been restocked!</div></div>` });
    }
  });

  const rerender = (doc) => {
    const app = foundry.applications.instances?.get("kctg-merchants");
    if (!app?.rendered) return;
    const actorId = doc?.id ?? doc?.parent?.id;
    if (!actorId) return;
    if (actorId === app._selectedId ||
        foundry.utils.hasProperty(doc, `flags.${MODULE_ID}`))
      app.render();
  };
  Hooks.on("updateActor", rerender);
  Hooks.on("createItem",  i => rerender(i.parent));
  Hooks.on("updateItem",  i => rerender(i.parent));
  Hooks.on("deleteItem",  i => rerender(i.parent));

  // GM-as-shopper toggles on token selection — re-render so the view switches live.
  Hooks.on("controlToken", () => {
    if (!game.user.isGM) return;
    const app = foundry.applications.instances?.get("kctg-merchants");
    if (app?.rendered) app.render();
  });

  // Tiny API used by the restock-preview dialog to open an item for inspection.
  const _mod = game.modules.get(MODULE_ID);
  _mod.api ??= {};
  _mod.api.openItem = async (uuid) => { (await safeFromUuid(uuid))?.sheet?.render(true); };
});

// ── Actor sheet header: inject store icon button ──────────────────────────────
// v14: ApplicationV2 sheets (dnd5e/pf2e) fire `renderActorSheetV2`, while legacy
// AppV1 sheets fire `renderActorSheet`. Register both so the button appears
// regardless of the system's sheet implementation.
function _injectMerchantHeaderButton(app, html, context) {
  if (!game.user.isGM) return;
  const actor  = app.document ?? app.actor;
  if (!actor) return;
  if (actor.type === "character") return;
  // app.element is the full window frame for both v1 (jQuery) and v2 (HTMLElement)
  const windowEl = app.element instanceof HTMLElement ? app.element : app.element?.[0];
  if (!windowEl) return;
  if (windowEl.querySelector(".kctg-merchant-header-btn")) return;
  const header = windowEl.querySelector(".window-header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `kctg-merchant-header-btn${isMerchant(actor) ? " kctg-merchant-header-btn--active" : ""}`;
  btn.title = isMerchant(actor) ? "Configure Merchant" : "Make Merchant";
  btn.innerHTML = `<i class="fas fa-store"></i> <span>${isMerchant(actor) ? "Merchant" : "Make Merchant"}</span>`;
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!isMerchant(actor)) await _enableMerchant(actor);
    MerchantsApp.open(actor.id);
  });

  // v2 ApplicationV2: controls live in .window-controls — prepend so we appear before close
  const winControls = header.querySelector(".window-controls");
  if (winControls) {
    winControls.prepend(btn);
  } else {
    // v1 Application: close is an <a>, not a <button>
    const closeEl =
      header.querySelector("[data-action='close']") ??
      header.querySelector("a.close") ??
      header.querySelector("a.header-button.close") ??
      header.querySelector("button.close") ??
      header.querySelector(".header-control.close") ??
      null;
    if (closeEl) closeEl.before(btn); else header.appendChild(btn);
  }
}
Hooks.on("renderActorSheet",   _injectMerchantHeaderButton);
Hooks.on("renderActorSheetV2", _injectMerchantHeaderButton);

// ── Token double-click ────────────────────────────────────────────────────────
// Open the shop when a merchant token is double-clicked, instead of the actor sheet.
//
// Why this is fiddly:
//   • Correct class — systems (e.g. PF2e) replace CONFIG.Token.objectClass with a
//     subclass that overrides _onClickLeft2, so patching the base Token prototype
//     is shadowed and never runs.
//   • Correct timing — each token's MouseInteractionManager captures a reference to
//     `_onClickLeft2` when the token is *drawn*, so the patch must be in place
//     before any draw. We patch at "setup" and again on "canvasInit" (fires before
//     placeables are drawn on every scene load) in case the class is swapped late.
//   • A one-time guard on the prototype prevents double-wrapping.
// Resolve a token's merchant actor — for unlinked tokens the flag may live on the
// base (world) actor, so check both. Returns the merchant Actor or null.
function _tokenMerchantActor(token) {
  if (isMerchant(token?.actor)) return token.actor;
  if (isMerchant(token?.document?.baseActor)) return token.document.baseActor;
  return null;
}

function _patchTokenDoubleClick() {
  const TokenCls = CONFIG.Token?.objectClass ?? foundry.canvas.placeables.Token;
  if (!TokenCls || TokenCls.prototype._kctgMerchantDblClick) return;

  // 1) Allow ANY user to double-click an OPEN merchant token, regardless of actor
  //    ownership. _canView is the permission gate the interaction manager checks
  //    before firing clickLeft2; core requires LIMITED ownership, which we bypass
  //    for open merchants so no permission setup is needed. (World actor data is
  //    replicated to all clients, so the shop still has the stock to display.)
  const _origCanView = TokenCls.prototype._canView;
  TokenCls.prototype._canView = function(user, event) {
    const m = _tokenMerchantActor(this);
    if (m && (game.user.isGM || getMerchantData(m).openForBusiness)) return true;
    return _origCanView?.call(this, user, event) ?? false;
  };

  // 2) Open the shop on double-click instead of the actor sheet.
  const _orig = TokenCls.prototype._onClickLeft2;
  TokenCls.prototype._onClickLeft2 = function(event) {
    const actor = _tokenMerchantActor(this);
    if (!actor) return _orig?.call(this, event);

    if (game.user.isGM) return MerchantsApp.open(actor.id);

    // Player — open & distance check
    const data = getMerchantData(actor);
    if (!data.openForBusiness) return ui.notifications.info(`${actor.name} is currently closed.`);
    if (data.distanceLimit > 0) {
      const dist = getDistanceToMerchant(actor);
      if (dist > data.distanceLimit)
        return ui.notifications.warn(`You are too far away from ${actor.name}. (${Math.round(dist)} / ${data.distanceLimit} ${canvas.grid.units})`);
    }
    MerchantsApp.open(actor.id);
  };
  TokenCls.prototype._kctgMerchantDblClick = true;
}
Hooks.once("setup", _patchTokenDoubleClick);
Hooks.on("canvasInit", _patchTokenDoubleClick);

// NOTE: A canvas-token right-click context menu entry ("Configure Merchant")
// previously lived here via a `getTokenContextOptions` hook. That hook does not
// exist in Foundry v14 (core has no canvas-token context menu), so the handler
// never fired. The same entry points are covered by token double-click
// (Token._onClickLeft2 override above) and the actor-sheet header button.

// Cross-module open hook (fired by the Campaign Dashboard)
Hooks.on("kctg:openMerchants", () => MerchantsApp.open());

// ── Scene control button ───────────────────────────────────────────────────────
Hooks.on("getSceneControlButtons", controls => {
  _addToKctgGroup(controls, {
    name: "kctg-merchants-open", title: "Merchants",
    icon: "fas fa-store", button: true,
    onChange: () => {
      const ex = foundry.applications.instances?.get("kctg-merchants");
      if (ex?.rendered) return ex.close();
      const merchants = getMerchants();
      if (!merchants.length && game.user.isGM)
        return ui.notifications.info("No merchants yet. Drop an Actor onto the Merchants panel or right-click a token.");
      MerchantsApp.open();
    },
  });
});
