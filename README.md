# Responsive Breakpoint Variables — Figma plugin

A Figma plugin that turns your design system into **Variables** with one
**mode per breakpoint** (Desktop / Tablet / Mobile) — for both **typography**
_and_ **layout** (size, padding, gap, corner radius). Bind any element's fields
to those variables, then switch a frame's mode and everything reflows.

<div dir="rtl">

## מה זה עושה

הפלאגין יוצר **Variable Collections** רספונסיביים עם **mode לכל נקודת שבירה**
(דסקטופ / טאבלט / מובייל):

- **Typography** — לכל טוקן: `fontSize`, `lineHeight`, `letterSpacing`, משקל ופונט.
- **Layout** — טוקנים של רוחב/גובה, padding, gap ורדיוס פינות.

בטאב **Bind** מחברים כל אלמנט שנבחר לשדה (רוחב, גובה, padding, gap, רדיוס) ל-variable.
כשמחליפים את ה-mode של הפריים לפי הרוחב שלו — הטיפוגרפיה **וגם** המידות מתעדכנות אוטומטית.

> **align (יישור):** ב-Figma זו תכונת enum ולא ניתן לקשר אותה ל-variable. הפלאגין
> מיישם align ישירות על ה-auto-layout שנבחר, אבל הוא **לא** מתחלף אוטומטית עם ה-mode.

</div>

## Tabs

### Type
Editable responsive type scale (H1–H6, body, caption, …). Each token becomes
grouped variables like `heading/h1/fontSize`, with a value per breakpoint.
- **Load default scale**, **Import text styles**, **Auto-fill T/M** (from Desktop
  via scale factors), **+ Add token**.

### Layout
Spacing / sizing / radius scalars — one FLOAT variable per token
(`space/md`, `radius/lg`, `size/container`, …), one value per breakpoint.

### Bind
1. **Apply mode by frame width** — select frames; each gets the breakpoint mode
   matching its width, on **both** collections at once (375px → Mobile, 1440px → Desktop).
2. **Bind element field → variable** — select elements, pick a field
   (width, height, min/max, padding per-side or all, gap, corner radius per-corner
   or all) and a variable, then bind. Padding/gap require an auto-layout frame.
3. **Alignment** — set horizontal/vertical alignment on selected auto-layout frames
   (applied directly; see note above).

### Settings
Collection names, breakpoint names + min widths, which typography properties to
generate, auto-scale factors and rounding.

## Which fields can bind to variables?

| Field | Bindable? | Notes |
|-------|-----------|-------|
| Width / Height | ✅ | Also min/max width & height |
| Padding (all sides) | ✅ | Requires auto-layout |
| Gap (item spacing) | ✅ | Requires auto-layout |
| Corner radius (per corner) | ✅ | |
| Font size / line height / letter spacing | ✅ | On text layers |
| **Alignment** | ❌ | Enum — not variable-bindable in Figma; applied directly |

## Typical workflow

1. **Type** → *Load default scale* → tweak → *Create / update typography variables*.
2. **Layout** → *Load defaults* → tweak → *Create / update layout variables*.
3. In text layers, bind size/line-height to the type variables (right-click →
   *Apply variable*), or use the **Bind** tab for layout fields on any element.
4. Put each responsive layout in its own frame. **Bind → Apply mode by frame width**
   assigns the correct mode; switching modes reflows type + layout together.

## How to load

`Menu → Plugins → Development → Import plugin from manifest…` and pick
`manifest.json` from this folder.

## Notes

- **Multiple variable modes require a paid Figma plan** (Professional+). On a free
  plan the first breakpoint is created and extra modes are skipped with a warning.
- Re-running is **idempotent** — existing variables are updated, not duplicated.
- No build step — plain `code.js` + `ui.html`. For editor type-checking:
  `npm install && npm run typecheck`.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin manifest |
| `code.js` | Main thread: variable/mode creation, import, bind, apply-modes, alignment |
| `ui.html` | Plugin UI and interaction logic |
| `package.json` / `tsconfig.json` | Optional dev tooling (Figma typings) |
