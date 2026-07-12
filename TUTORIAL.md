# KCTG Atelier - Full Tutorial

> [!NOTE]
> **AI disclosure:** This tutorial was written with the assistance of AI (Anthropic's Claude), working from the module's actual source code and templates. The module's code itself was also developed with AI assistance. The content has been reviewed against the live module, but if you spot anything that no longer matches the current version, please open an issue.

KCTG Atelier is a Foundry VTT (v14) module that bundles five connected campaign tools:

| Tool | What it does |
|---|---|
| **Forge** | Recipe-based crafting with ingredients, craft times, and GM approval |
| **Quests** | A quest journal with objectives, rewards, visibility control, and quest chains |
| **Workshop** | A downtime base manager: workers, timed tasks, a trade map, trade orders, inventory, and progress trackers |
| **Merchants** | Turn any actor into a shop with rollable stock, pricing rules, and player influence |
| **Dashboard** | A compact launcher with campaign stats, an activity feed, and data backup |

It is system-agnostic and has been verified on **PF2e** and **D&D 5e**. All five tools share one workshop day clock, so advancing a single day moves tasks, crafts, deadlines, and merchant restocks together.

---

## Table of Contents

1. [Opening the tools](#opening-the-tools)
2. [The shared day clock](#the-shared-day-clock)
3. [Campaign Dashboard](#campaign-dashboard)
4. [Forge (crafting)](#forge-crafting)
5. [Quests](#quests)
6. [Workshop](#workshop)
7. [Merchants](#merchants)
8. [Message Templates](#message-templates)
9. [Campaign backup (export / import)](#campaign-backup-export--import)
10. [Module settings reference](#module-settings-reference)
11. [Permissions and multiplayer notes](#permissions-and-multiplayer-notes)

---

## Opening the tools

All apps live under the **KCTG** group (d20 icon) in the scene controls on the left edge of the screen:

- **Forge** opens the crafting window.
- **Quest Journal** opens the quest tracker. You can also press **J** (rebindable under *Configure Controls*).
- **Workshop** opens the workshop hub.
- **Merchants** opens the merchant manager (GM) or the nearest available shop (players).
- **Campaign Dashboard** opens the launcher panel.

Merchants have extra entry points:

- **GM:** every actor sheet gets a **Merchant / Make Merchant** button in its window header. Double-clicking a merchant's token opens its configuration.
- **Players:** double-clicking a merchant token opens the shop, if the merchant is open for business and the player's token is within the distance limit.

---

## The shared day clock

Workshop tasks, Forge craft times, trade order deadlines, morale drift, and merchant restocks all run off one day counter. It has two modes, switched by the world setting **Bind Workshop Day to World Clock** (*Configure Settings > KCTG Atelier*):

- **Standalone (default):** the day is an internal counter. The GM advances it with the **-10 / -1 / +1 / +10** buttons or the direct day input on the Workshop's **Tasks** tab.
- **World-bound:** the day follows Foundry's world time (and therefore modules like Simple Calendar). Advancing game time advances the workshop day. When you toggle the binding, the module keeps the current day number continuous, so nothing jumps.

A second world setting, **Fine Calendar Control**, replaces the single day counter with separate Year / Month / Day fields on the Tasks tab, which is useful for system-specific calendars.

Whenever a day passes, the module automatically:

- completes any Workshop tasks whose duration has elapsed,
- finishes (or fails) queued Forge crafts,
- checks trade order deadlines and announces overdue or expired orders,
- drifts worker morale toward the baseline (if morale automation is on),
- restocks merchants that are on a restock schedule.

**Tasks tab extras (GM):** the **Mark opened today** button stamps the current day as the workshop's opening day, which drives the "open for N days" line on the Overview tab.

---

## Campaign Dashboard

A small always-useful panel with one row per tool. Each row is a button that opens the tool, with live stats beside it:

- **Quests:** active / completed / total counts.
- **Merchants:** how many are open and configured.
- **Workshop** (GM only): current day, active tasks, worker count.
- **Forge** (GM only): unlocked and locked recipe counts.

The dashboard refreshes itself automatically when quests, merchants, settings, or the day change. The refresh button forces it manually.

**Header buttons (GM):**

- **Export** and **Import** for campaign backups (see [Campaign backup](#campaign-backup-export--import)).
- **Message Templates** opens the chat-flavour editor (see [Message Templates](#message-templates)).

**Recent Activity:** the bottom of the dashboard shows the latest events from the shared activity feed: completed tasks, fulfilled orders, crafts, completed quests, restocks, and imports, each stamped with the workshop day. The GM can clear the feed with the trash button.

---

## Forge (crafting)

### The Craft window

The Forge window has a recipe list on the left and the selected recipe's details on the right.

**Character selector (top bar).** Crafting always happens *as* an actor: ingredients are taken from and results delivered to that actor's inventory.

- **Players** see the actors they own.
- **GMs** see two groups: **Crafting Now** (anyone with a pending request or a craft in progress, listed automatically) and **Crafters** (a persistent roster). Add to the roster by dropping any actor, PC or NPC, on the drop zone below the bar. It also grows automatically: any actor that completes a craft is added. The **Manage Crafters** button opens a checkbox dialog to remove entries.

**Recipe list.** Two tabs: **World** (shared recipes) and **Personal** (your own, if the GM has enabled player recipe creation). Recipes can be organised into colored folders; click a folder to collapse it. Each recipe row shows an availability dot: green (all ingredients on the selected actor), yellow (some), red (none). Recipes marked **Locked** show a lock dot and cannot be crafted until the GM unlocks them.

**Recipe details.** For the selected recipe you see:

- **Required Tools:** items the actor must possess but which are *not consumed*.
- **Ingredients:** what will be consumed, with quantities. Missing items are highlighted.
- **Produces:** the results and their quantities.

**Crafting.** Set a **Quantity** and press **Craft**. Ingredients are removed and results are added to the actor, with a flavour message posted to chat.

- **Timed recipes:** if the recipe has a craft time, the button reads **Begin Craft** and queues a job instead. A progress section at the top of the window tracks it. Ingredients are consumed *when the job finishes*, not when it starts; if they are missing at that point, the job fails. Finished jobs sit under **Ready to Collect** until you press **Collect**. In-progress jobs can be cancelled at no cost.
- **GM overrides:** the GM additionally gets **Force Craft** (consume whatever the actor has, skip the rest) and **Free Craft** (consume nothing). These are always instant.

**GM approval flow.** When the world setting **Require GM Approval for Player Crafting** is on, a player's first craft of any recipe (or the first after the recipe changes) shows **Request GM Approval** instead of Craft. The request appears in the Recipe Manager's **Approvals** tab, where the GM can:

- **Approve** once (the player is notified and crafts it themselves), or
- tick **Remember** before approving, which whitelists that player + recipe permanently, or
- **Reject** it.

### The Recipe Manager (GM) / My Recipes (players)

Opened from the button in the Craft window's top bar. Tabs:

- **World:** create and edit the shared recipe library. **New** creates a recipe; the sidebar supports folders (create with the folder button; right-click a folder for **Change Color / Rename / Delete**; right-click a recipe for **Duplicate / Delete**; drag recipes into folders or reorder them).
- **Players:** a read-only view of every player's personal recipes. Each one can be **Copy to World** or **Move to World**.
- **Personal:** the same editor for your own recipes (this is what players get as "My Recipes", when enabled).
- **Chart:** a visual dependency chart of recipes. Tick recipes in the folder-grouped sidebar to add them as nodes; drag nodes, pan, and zoom. A standalone chart window with the same controls also exists.
- **Approvals:** pending player craft requests (see above). The tab shows a badge when requests are waiting.
- **Log:** a permanent crafting log: who crafted what, when, in which mode, what was used and produced. **Clear Log** empties it.

**The recipe editor.** Name, description, and folder assignment at the top, then:

- **Craft time:** days to craft (0 = instant), and a **flat** toggle: off means the time multiplies by quantity, on means it is a flat total.
- **Locked:** hides the craft button until unlocked; useful for recipes the party must discover.
- **Ingredients / Required tools / Results:** drag items from the sidebar or compendia into each list, and set quantities.

**Import / Export:** recipes serialize to a plain text format for sharing. On import, items that cannot be matched automatically open a **resolver** dialog where you pick the correct compendium entry per item (or skip and fix later).

---

## Quests

### Layout

Quest list on the left, selected quest on the right (drag the divider to resize).

**Toolbar (GM):** **+ Quest** creates a quest, the folder button creates a **group** (a named, colored section header; right-click it to edit, click to collapse). Everyone gets status filters: **All / In Progress / Completed / Failed**, plus **Hidden** for the GM.

**Quest rows** show an unread dot when a quest is new or was updated since you last looked at it. A small status badge on non-active quests can be clicked to cycle the status directly from the list.

### Viewing and editing a quest

Select a quest to see its detail pane, with the first quest giver's portrait as background art. Anyone with edit rights gets an **Edit** button that switches the pane into edit mode; the GM also gets a delete button.

In edit mode you can set:

- **Status:** In Progress / Completed / Failed / Hidden (Hidden is GM-only and invisible to players).
- **Visibility:** **World** (everyone), **Party** (all players), or **Personal**. Personal quests reveal a **Quest Owners** checkbox list where the GM picks exactly which players can see the quest.
- **Group:** which section header it sits under.
- **Name, image** (with an image picker; players can click the image to expand it), and a rich-text **description**.

**Objectives.** Add objectives with the **+** button. Each objective supports:

- click-to-cycle status (open / completed / failed), with strikethrough on completion,
- **sub-objectives** (indent button) that work the same way,
- **hide from players** (eye icon, GM): hidden objectives show a badge to the GM only,
- **highlight** (star, GM): draws attention to the current objective,
- **quest chaining:** pick another quest in the objective's dropdown, and completing the objective unlocks that quest. Chained objectives show a link badge.

**Rewards.** Drag items into the drop zone, or add a free-**Text** reward (for gold, favours, etc.). Rewards can be individually hidden from players (GM). Outside edit mode the GM gets a **Send** button that delivers the item rewards straight to a chosen actor.

**Quest givers.** Drag actors into the drop zone. The first giver's portrait becomes the pane's background art.

**Quest announcement.** In edit mode, a section at the bottom lets you write an in-character line and choose a speaker (defaults to the first quest giver; drop another actor to override). If the checkbox is ticked, the line is posted to chat as that speaker each time you press **Done**.

### Quests elsewhere

Completing a quest ripples through the other tools: merchants linked to that quest restock, trade orders locked behind it unlock (with a toast and chat notice), and map pins tied to it change their badge. Players get a toast notification when a quest is created or updated for them.

---

## Workshop

The Workshop hub has seven tabs: **Overview, Workers, Tasks, Map, Trade Orders, Inventory, Tracker**.

The **Participation Mode** world setting controls how much players can do here: **Autonomous** (workers operate on their own; players watch), **Collaborative** (players can assist), or higher involvement. The current mode is shown as a badge on the Overview tab.

### Overview

- **Banner:** the GM clicks the banner area to pick an image (× clears it).
- **Workshop name:** editable by the GM; shown with a "has been open for N days" tagline (using the opening day stamped on the Tasks tab) and, when world-bound, the real calendar date.
- **Treasury:** if a **Retainer** actor is set (see Workers), their coinage is shown here.
- **Stat cards:** workers, idle, active, tasks, trade orders.
- **Worker list:** every worker with their current task or idle status, morale, and loyalty.

### Workers

Workers are the labour pool that runs tasks.

- **Adding:** drop any actor onto the drop zone, or press **Add manually** and type a name (no actor needed).
- **Worker cards** show art (if from an actor) and two editable stats, **Morale** and **Loyalty** (0-10). These matter:
  - Morale 10 gives a chance of a **bonus roll** on task result tables; morale 0 gives a chance the roll is **skipped** entirely.
  - Loyalty 10 gives a chance the task **finishes faster**; loyalty 0 gives a chance of a **slowdown**.
  - All four chances are percentages you tune in the **Settings** strip (GM, gear button in the toolbar).
- **Morale automation** (Settings strip, default off): when on, morale drifts one point toward a configurable **baseline** every N days, and workers get +1 morale when they complete a task. When off, morale only changes when you edit it.
- **Groups:** create named teams with **Add Group**, then add members from the dropdown. Groups can be assigned to tasks as a unit.
- **Folders:** organisational folders for the roster; drag worker cards into them, collapse them, rename or delete them.
- **The Retainer:** the special card at the front of the roster. Drop an actor there to make it the workshop's shared body: its inventory becomes the Workshop **Inventory** tab, task loot is delivered to it, trade orders consume from and pay into it, and its coins are the treasury.

### Tasks

Timed jobs your workers carry out.

- **Day strip (GM):** the day controls described in [The shared day clock](#the-shared-day-clock), plus **Event Tables** and **Add Task**.
- **Creating a task:** press **Add Task**, name it, and pick a **type**: Forage, Trade, Patrol, Scout, or General. The type sets the icon and which chat-title templates are used.
- **Duration:** each task has **Travel** days and **Task** days; total duration = travel + task + travel (the crew must come home). An active task shows a progress bar with phase markers for "arrived" and "returning".
- **Trade tasks** can select a **route** from the Trade Map, which presets the travel days. **Patrol tasks** can select a map **location** as their destination. Either way, the assigned workers appear as moving miniatures on the Map tab while the task runs.
- **Workers:** assign idle workers (or whole groups) from the dropdown; remove them with the × on their tag.
- **Result table:** drop a RollTable onto the task's table slot. When the task completes, the table is drawn and the results are announced.
- **Buttons:**
  - **Activate** starts the clock on a task. When the day counter reaches its duration it auto-completes: the result table is drawn, a templated completion message is posted to chat, and everyone gets a toast.
  - **Run** (GM) draws the table and completes the task immediately, without waiting.
  - **Event** rolls a random event for the task from the event tables.
  - **Collect** appears when the results included items; it delivers them to the Retainer and logs them in the Inventory tab.
  - **Reset** returns a completed task to idle so it can be run again.
- **Event Tables** (GM): a config window with one RollTable slot per task type (Forage, Trade, Patrol, Scout, General). The **Event** button uses the matching table.

### Map

A pannable, zoomable trade map used by Trade tasks, Patrol tasks, and Trade Orders. Also available as its own window ("Trade Map").

- **Edit mode (GM):** toggle **Edit ON**, then:
  - **Set BG** picks the map image (× removes it).
  - **Place Pin** then click the map to drop a location. **Double-click a pin** to edit it: name, icon, tint color, and whether it is the **home** location. Pins can be dragged in edit mode.
  - **Place Route** then click two pins to connect them. Routes appear in the **Routes** panel below the map, where you set each route's **travel days** (the preset that Trade tasks pick up) or delete it.
  - **Place WP** (waypoints) lets you bend routes: click a route to add a node, drag nodes to shape the path, right-click to remove.
- **View controls (everyone):** zoom buttons, and a reset button that returns to the saved view. The GM can **Set View** to store the current pan/zoom as that reset point.
- **Live decorations:** workers on travelling tasks animate along their routes with a phase badge; pins whose location has a linked quest show an active-quest or completed-quest badge.

Every pin you place is also a **city** for the Trade Orders tab.

### Trade Orders

Contracts from the map's cities: deliver goods, get paid.

- **Layout:** cities on the left (with order-count badges), the selected city's order cards on the right. Cards collapse to just their title and description.
- **Creating orders (GM only):**
  - **Add** creates a blank order.
  - **Random** generates one. If the city has a RollTable in its **Drop table** slot, the needed items are drawn from it; quantity and payment are controlled by the settings strip (gear icon): **Min Qty / Max Qty / Variance %**.
- **Editing:** an order has a name, description, a **Needs** column (drop items, set quantities) and a **Pays** column (drop items or add currency in gp/sp/cp). Each need shows a live **"N in stock"** badge against the Retainer's inventory.
- **Deadlines (optional):** set a **Due day**. After it passes, the order either **expires** (cannot be fulfilled normally) or goes **late at a loss** (still deliverable, with the payment reduced by a configurable percentage). Badges on the card header show due / overdue / expired states, and the module announces the transition in chat once.
- **Quest locks (optional):** drop a quest journal page onto the order. The order stays locked (players cannot even see it) until that quest is completed, at which point everyone is notified.
- **Fulfilling:** with a Retainer set, the **Fulfill Order** button lights up when the workshop holds every needed item. Fulfilling consumes the goods from the Retainer, pays the reward into it, marks the order fulfilled (dimmed, with a check), and posts to chat. Fulfilled orders are kept as reopenable contracts: **Reopen** re-arms them.
- **Force (GM):** when enabled in the settings strip, a **Force** button completes an order *without* the goods, granting the reward. Meant for speculative or random orders; it also works on expired orders as the GM override. Uses a random flavour message from the [Message Templates](#message-templates).
- **Permissions:** creating orders is always GM-only. Editing them is GM-only unless the GM turns on **Players Edit** in the settings strip. Fulfilling is a play action available to players who have the stock.

### Inventory

A live view of the Retainer's items, collected task loot, and coin totals.

- Rows show icon, name, price, and quantity. The info button expands an inline item description. **Removing an item here also removes it from the Retainer's sheet.**
- **Folders (GM):** create folders, drag items between them with the grip handle, rename, collapse, delete.
- Coin chips at the top show the Retainer's gp/sp/cp.

### Tracker

Free-form progress bars for anything: reputation, construction, collections.

- **Add Entry** (GM) creates a row. Each entry has a label, an optional **actor avatar** (drop an actor; identity only), and a progress bar.
- **Numeric mode (default):** the GM sets *current / total* by hand.
- **Item mode:** drop items onto the entry to track them individually, each with its own *current / target* count (GM-editable). The bar becomes the sum of all item progress.
- Entries can be dragged to reorder, and turn green at 100%.

---

## Merchants

### Setting one up (GM)

1. Open **Merchants** from the scene controls (or the actor sheet header button, or double-click the actor's token).
2. Drop any actor onto the left panel's drop zone, select it, and press **Enable as Merchant**.

The GM view has four tabs per merchant:

### Stock Tables

Rollable inventory generation.

- Drag **RollTables** from the sidebar into the drop zone. Per table you can set:
  - **Rolls:** how many draws (a number or a dice formula like `1d4+1`),
  - **Qty:** quantity per drawn item (number or dice),
  - **No duplicates:** skip repeat draws within one restock,
  - **Clear first:** wipe the inventory before this table rolls,
  - an enable checkbox to bench a table without deleting it.
- **Spells in tables:** on systems with spell support, rolled spells convert to consumables. Choose the format (scrolls, wands, or a mix with a **Wands %** share on PF2e; scrolls on 5e), and optionally a **Rank/Level formula** (number or dice, clamped to each spell's valid range). Cantrips use the system's cantrip format.
- **Roll Preview** rolls everything and shows the results for review before adding; **Restock Now** rolls and stocks immediately.
- **Current Stock** below shows the resulting inventory grouped by category, with per-item hide toggles.

### Inventory

Organise what the merchant carries.

- **Add Category** creates named sections; items are dragged between them (Shift/Ctrl+click to multi-select). Uncategorised items live in a General section.
- Items without a system price get an inline **custom price** editor (value + denomination).
- Per item: an info button (inline description), a **hide from players** eye toggle, and a remove button. **Clear All** empties the merchant.
- You can also stock a merchant manually by dragging items onto the merchant actor's sheet, as usual in Foundry.

### Orders

Player special requests (see the player view below) arrive here. For each pending request the GM can **Mark Ready** (sets the price and moves it to *Ready for Collection*) or **Decline**.

### Settings (per merchant)

- **Availability:** **Open for Business** (master switch for player access), **Distance Limit** in grid units (0 = unlimited; players must be within range to interact), **Hide Token When Closed**.
- **Pricing:** **Sell Price Modifier** (% of base price players pay), **Purchase Only** (players cannot sell here); when selling is allowed: **Buy Price** (% of base paid to players), **Only Base Price** (refuse custom-priced items), **Infinite Currency**, and **Hide Sold Items** (things players sell are auto-hidden from other players).
- **Stock:** **Infinite Quantity** (never runs out), **Keep Zero-Qty Items** (show "Sold out" instead of removing), **Log Activity** (post every transaction to chat).
- **Quest Link:** drop a quest journal page; the merchant restocks when that quest completes.
- **Scheduled Restock:** roll the stock tables automatically every N workshop days (0 = off).
- **Influence:** an optional per-player reputation system.
  - Players earn points automatically by trading (**Gold per Point** sets the exchange; set it very high to rely on manual awards) or by GM edits.
  - Define **tiers** (label, points threshold, discount %). Positive discounts lower purchase prices at that tier; negative values are surcharges for low standing.
  - The per-player standings table shows and lets you edit everyone's points; **Reset All** clears them.

**GM shopping preview:** if the GM selects a player-owned token and opens the merchant, they see the shop exactly as that character would, with a banner noting the preview.

### The player's shop view

Players (within range, while the shop is open) see:

- an **influence bar** (tier, progress to the next tier, current discount) when influence is enabled,
- the stock grouped by category, with prices already adjusted for their influence tier; **Buy** buttons, sold-out labels, and item descriptions,
- **selling:** drag an item from their sheet onto the sell zone, or press **Sell Items** for a picker. Payment is computed from the merchant's buy price,
- **Special Orders:** request something the merchant does not stock, either by dragging an item in or by pressing **Request an Item** and describing it. The request shows as *Awaiting merchant* until the GM marks it ready, then as *Ready* with its price for collection.

---

## Message Templates

*Dashboard > message bubble icon (GM).* Controls the random flavour text the module posts to chat. Six tabs:

- **Forge:** craft messages. Tokens: `{actor}`, `{recipe}`, `{ingredients}`, `{results}`.
- **Forage / Trade / Patrol / Scout:** task completion titles. Tokens: `{task}`, `{workers}`.
- **Orders:** messages for force-completed trade orders. Tokens: `{actor}`, `{order}`, `{city}`, `{payment}`.

Each tab is a simple list: **Add** writes a new template, the × removes one, **Reset Defaults** restores the built-in set. One template is picked at random each time the event fires.

---

## Campaign backup (export / import)

*Dashboard header (GM).*

- **Export** downloads a single JSON file containing every module world setting (recipes, quests journal reference, workshop state, trade orders, tracker, templates...), every user's module data (personal recipes, craft jobs), and every actor's merchant configuration and influence standings.
- **Import** picks a backup file, confirms, and restores it. Settings are restored for known keys (unknown ones are reported and skipped); user and actor data are matched by id, falling back to name. Restores merge: imported keys win, data created since the export survives.

Note: quest journal *pages* are regular Foundry world data and are not in the backup; use Foundry's own world backup for those. Day-clock values bound to world time only restore meaningfully into the same world.

---

## Module settings reference

*Configure Settings > KCTG Atelier* (all world-scope):

| Setting | Effect |
|---|---|
| **Bind Workshop Day to World Clock** | Day follows Foundry world time instead of the manual counter |
| **Fine Calendar Control** | Year/Month/Day fields instead of a single day counter |
| **Participation Mode** | How much players can do in the Workshop (Autonomous / Collaborative / ...) |
| **Require GM Approval for Player Crafting** | First craft of each recipe needs GM sign-off |
| **Player Recipe Creation** | Minimum role allowed to create personal recipes (or GM only) |

Everything else (morale chances, trade order generation, permission toggles, templates) is configured inside the apps themselves, as described above.

---

## Permissions and multiplayer notes

- Player actions that need world writes (fulfilling orders, logging crafts, one-time approvals) are relayed to a GM client over the module socket. **A GM must be logged in** for those actions to complete; the module blocks the action up front when no GM is online rather than leaving things half-done.
- Approval state lives in GM-only world settings, so players cannot grant themselves crafting approval.
- With multiple GMs online, exactly one acts as the authority for automated completions, so nothing fires twice.
- UI gates (player order editing, force completion, participation mode) are enforced on the GM side as well, not just hidden in the interface.

---

*This document was produced with AI assistance (Anthropic's Claude) and reviewed against the module source. Found an error? Open an issue.*
