# Typography Breakpoint Variables — Figma plugin

A Figma plugin that turns a typographic scale into **Variables** with one
**mode per breakpoint** (Desktop / Tablet / Mobile). Each token becomes a set
of grouped variables, and every breakpoint gets its own responsive value — so a
frame switched to the Mobile mode instantly picks up the mobile type sizes.

<div dir="rtl">

## מה זה עושה

הפלאגין יוצר **Variable Collection** לטיפוגרפיה עם **mode לכל נקודת שבירה**
(דסקטופ / טאבלט / מובייל). כל טוקן (למשל `heading/h1`) הופך לקבוצת variables —
`fontSize`, `lineHeight`, `letterSpacing`, `fontWeight`, `fontFamily` — כשלכל
breakpoint יש ערך משלו. כשמחליפים את ה-mode של פריים לפי הרוחב שלו, הטיפוגרפיה
מתעדכנת אוטומטית.

</div>

## Features

- **Responsive type scale** — edit a table of tokens with separate values for
  Desktop, Tablet and Mobile.
- **Auto-fill** — fill Tablet/Mobile from the Desktop values using scale factors
  (defaults: tablet ×0.9, mobile ×0.8).
- **Import from text styles** — pull your existing local text styles in as tokens.
- **Apply modes by frame width** — select frames and the plugin assigns each the
  matching breakpoint mode based on its actual width (e.g. 375px → Mobile).
- **Idempotent** — re-running updates existing variables instead of duplicating.

## What gets created

For a token `heading/h1` you get variables:

```
Typography (collection)
├─ modes: Desktop · Tablet · Mobile
├─ heading/h1/fontFamily   (STRING)
├─ heading/h1/fontWeight   (FLOAT)
├─ heading/h1/fontSize     (FLOAT)   Desktop 40 · Tablet 36 · Mobile 32
├─ heading/h1/lineHeight   (FLOAT)   Desktop 48 · Tablet 43.2 · Mobile 38.4
└─ heading/h1/letterSpacing(FLOAT)
```

Each variable has the correct binding **scope** (font size, line height, etc.),
so Figma offers it in the right place when you bind text properties.

## How to use

1. **Load the plugin** in Figma:
   - `Menu → Plugins → Development → Import plugin from manifest…`
   - Pick `manifest.json` from this folder.
2. **Generate tab** — click *Load default scale* (or *Import text styles*), tweak
   values, then **Create / update variables**.
3. In your text layers, bind font size / line height / letter spacing to the new
   variables (right-click the property → *Apply variable*).
4. Put each responsive layout in its own frame. On the **Apply modes** tab, select
   the frames and click *Apply mode to selected frames* — or set the mode manually
   from the frame's right-panel Variables section.

### Settings

- **Collection name**, **breakpoint names + min widths**.
- **Which properties** to generate.
- **Scale factors** for auto-fill and **rounding** decimals.

## Notes

- **Multiple variable modes require a paid Figma plan** (Professional or above).
  On a free plan the first breakpoint is created and the extra modes are skipped
  with a warning.
- No build step — the plugin ships as plain `code.js` + `ui.html`. For editor
  type-checking run `npm install` then `npm run typecheck`.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin manifest |
| `code.js` | Main thread (sandbox): variable/mode creation, import, apply-modes |
| `ui.html` | Plugin UI and interaction logic |
| `package.json` / `tsconfig.json` | Optional dev tooling (Figma typings) |
