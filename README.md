# ROOMFIT

**Know it fits before you buy it.** A spatial planning tool that checks whether furniture physically fits a room, including collisions, door swings, clearances, walking paths and budget, before you buy.

Plain HTML, CSS and JavaScript. No build step. Open `index.html` in a browser.

## Run

- **App:** open `index.html` (works from `file://`). Three.js r147 and fonts load from CDNs.
- **Engine tests:** open `tests/engine.html`. It should say `ALL PASSED`.
- **Visual checks:** `tests/visual.html` (plans with validation) and `tests/mobile.html` (390 px frames).
- **Gemini (optional):** copy `.env.example` to `.env`, add `GEMINI_API_KEY`, then run
  `powershell -ExecutionPolicy Bypass -File proxy\dev-proxy.ps1` and set **Settings → Proxy URL** to `http://localhost:8787`.
  For hosting, deploy `proxy/worker.js` to Cloudflare Workers with the key as a secret. The key never reaches the browser.

Deep links: `#/design?ask=I need a study + gaming room under ₹70,000|I want the desk near the window` runs requests in order. `#/fit?check=desk_004` or `#/fit?check=210x90x85` runs a fit check.

## Architecture

```
Photo ──► AI perception (Gemini, estimates) ──► structured room model ──► geometry engine ──► valid layouts ──► explanation
                         the AI proposes                                   the engine decides     (facts only)
```

| File | Role |
|---|---|
| `js/rules.js` | Every clearance number (walkway, door angle, landing, window sill, accessibility multipliers). Configurable in the UI. |
| `js/engine.js` | **Source of truth.** Collision, inside-room, door-leaf sweep, entry landing, window coverage, front/side/back clearance (required vs available), wall-mount, grid-based circulation (door → every usable zone at walkway width), widest-path search, fix suggestions, fit search. |
| `js/layout.js` | Constraint-based optimizer: beam search over wall placements with strategy scoring (floor space, storage, workspace, balanced, lowest cost). Only layouts that pass `RF.validate` are offered. Includes budget handling, metrics, and explanation facts. |
| `js/nl.js` | Deterministic offline parser: text → `{budget, required[], constraints{}, intent}`. |
| `js/ai.js` | `AIProvider` interface: `LocalProvider` plus `GeminiProxyProvider` with structured-output schemas. All AI output is sanitized and clamped. Explanations are rejected if they contain numbers that aren't in the computed facts. |
| `js/catalog.js` | **Sample** catalog (typical sizes, illustrative INR prices, no links). `RF.catalog.registerSource()` plugs in real feeds. |
| `js/plan2d.js` / `js/view3d.js` | SVG plan and Three.js room: orbit, top/perspective, select, drag, rotate, clearance zones, wall cutaway. |
| `js/app.js` | State, routing, UI. |
| `db/schema.sql` | Target PostgreSQL/Supabase schema with RLS, including the future delivery-path graph (room → door → corridor → lift → entry). |

## Honest limits of this MVP

- **Storage is per browser** (`localStorage`). No accounts yet; `db/schema.sql` is the planned model. "Delete all my data" in Settings clears everything. Photos are never saved.
- **Photo analysis needs the proxy.** Without it, dimensions are entered by hand. AI dimensions are always marked *Estimated* until you add a tape measurement (the "Rescale estimates" control).
- **Furniture is modelled as rectangles at 90° rotations.** L-shaped pieces use their bounding box, which is conservative.
- **Delivery-path checks** (will the sofa get through the corridor and lift?) are modelled in the data but not computed.
- **Star ratings** in Compare are fixed thresholds on measured values: storage m³ ≥ 0.4/0.9/1.5/2.2, desk width cm ≥ 70/100/130/160. There's no overall "best" score.

## Find furniture (AI Shop)

Design workspace → **Find furniture**. Ask in plain language ("Find me a study desk under ₹15,000", then "only wooden ones", "less than 130 cm wide", "cheaper"). Follow-ups modify the structured search instead of starting over.

```
request → Gemini (intent → ProductSearchRequest)            js/shop.js  parseRequest
        → /api/products/search  (proxy holds GEMINI_API_KEY) proxy/dev-proxy.ps1, proxy/worker.js
             Gemini + Google Search grounding → JSON products; proxy checks every product link is live
        → sanitize: name + https link required; link must be live or on a grounded domain; 404s dropped
        → RF.findPlacement / RF.validate  (existing engine)  validateProductAgainstRoom
        → Fits / Does not fit / Cannot verify / Some dimensions could not be verified
```

- Gemini never decides fit. Every "Why it fits" number (available width, remaining, clearance) is computed by the geometry engine.
- Missing width or depth means "Cannot verify" with an **Enter dimensions** option. A missing height means a provisional result.
- Room context sent to search is dimensions only: wall runs, openings and existing furniture sizes. Never photos.
- Results are cached for 6 hours in this browser and shown with their retrieval time. Prices and availability are never presented as current.
- Without the proxy, results come from the bundled **sample catalog** and are labelled as not real listings.
- Providers: `GeminiProductSearchProvider`, `InternalCatalogProvider`, `RetailerAPIProvider` (stub for official feeds).
- **Shop this room** searches once per piece in the design, constrained to that piece's footprint. It totals listed prices, and **Optimize budget** proposes cheaper fitting swaps that you apply explicitly.
- Tests: `tests/shop.html` (mocked proxy).
