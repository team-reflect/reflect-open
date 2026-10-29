---
name: reflect-design
description: Use this skill to generate well-branded interfaces and assets for Reflect (reflect.app, the minimalist networked note-taking app), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read `readme.md` in this skill, then explore the other files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets
out and create static HTML files for the user to view. If working on production code,
you can copy assets and read the rules here to become an expert in designing with this
brand.

If the user invokes this skill without any other guidance, ask them what they want to
build or design, ask some questions, and act as an expert designer who outputs HTML
artifacts _or_ production code, depending on the need.

## Quick map
- `readme.md` — the full design guide: product context, voice, visual foundations,
  iconography, and a file index. **Start here.**
- `styles.css` — link this one file to inherit every token + the Inter webfont.
- `tokens/` — colors (indigo brand + cool greys + marketing purples; `.dark` and
  `.reflect-space` theme scopes), typography, spacing/radii/shadow/motion.
- `assets/` — Inter Variable fonts, the graph app icon, logo, and graph hero image.
- `components/` — React primitives (Button, IconButton, ShortcutKey, Input,
  SearchField, Checkbox, Toggle, Card, Badge, Avatar, MenuItem). Each has a
  `.prompt.md` with usage.
- `guidelines/` — foundation specimen cards.
- `ui_kits/app/` — the notes app (daily notes, ⌘K search, tasks, map).
- `ui_kits/marketing/` — the deep-space homepage.

## The one-paragraph brief
Reflect is a fast, minimalist, **networked** note-taking app — a writing tool where
prose is the hero and chrome is quiet. Two surfaces share one purple soul: the **app**
is a calm near-white (or deep-navy dark) canvas with **indigo `#4F46E5`** as the only
saturated accent and cool grey everything-else; the **marketing site** is a near-black
`#030014` "deep space" lit by **purple glows** and glassmorphic borders. One typeface:
**Inter**. Sentence case everywhere, no emoji, benefit-led copy. Gentle 8px radii,
mostly-flat surfaces with hairline borders, short calm motion (no bounce).
