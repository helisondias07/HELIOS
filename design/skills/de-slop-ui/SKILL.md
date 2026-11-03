---
name: de-slop-ui
description: Strip "AI-generated" look from a web/desktop UI (lists, sidebars, inboxes, settings). Use when reviewing or building HELIOS screens or any app UI that feels cluttered, boxed-in, over-colored or emoji-heavy. Derived from a before/after redesign of a messages list (references/). HELIOS DESIGN.md always wins on conflict.
license: local (sem licença externa)
---

# De-slop UI

Reference: `references/frame_0.5s.png` (before/slop) → `frame_8s.png` (the applied tokens) → `frame_13.5s.png` (final).
The redesign changed only ~10 tokens; no new features. Fix tokens first, components second.

## 1. Spacing scale (4px base)
- Use only: 4, 8, 12, 16, 24, 32, 48. Frame values: gap 14→round to 12/16, gutter 24, chips h36, radius 22 for large surfaces.
- Page gutter **24px** on both sides; every left edge (title, search, chips, avatars) sits on that same line.
- Rows breathe: list row height ~**72–96px** on mobile-like lists; desktop sidebars 40px (kit: menu item h40). Never 56px-cramped rows with dividers.
- Section gap (header→search→chips→list) 16–24px, consistent.

## 2. Typography hierarchy (max 4 sizes per screen)
- Title 27–28/600 left-aligned, large (not a small centered bordered label). Item name 16/500–600. Body/preview 14/400. Meta (time, counts) 12/400 muted.
- Hierarchy through size + weight + grey, not color or boxes. Read items: preview in secondary text; unread: primary text.

## 3. Color restraint
- One neutral canvas (flat, slightly off-white/off-black), one accent. Accent used only for: unread dot, focus ring, the single primary action.
- Remove colored badges with counts (red "2", "3") → small 8px accent dot. Count badges only when the number matters.
- Avatar placeholders: muted/desaturated or real images; never rainbow initials.

## 4. Lists / rows
- **Dividers 0px.** Separate rows with whitespace, not lines. No zebra, no cards per row.
- Row = avatar/icon · (name over preview) · (time over status) aligned top-right. Truncate preview to 1 line.
- No "filler" rows/banners inside the list (the "✨ AI smart replies" strip was deleted: filler 0).

## 5. Controls
- Filter chips: h36 pills, neutral fill, selected = slightly darker neutral fill (not solid blue); unselected have no outline.
- Search: h44–48, large radius, subtle fill, no hard border; focus = accent ring (kit: border ouro + brilho).
- Primary action: one icon button (+) neutral circle, top-right; not a saturated blob with emoji.

## 6. Icons
- Thin-stroke, monochrome, one family, 16–20px. No emoji as icons (✨ ✏️ removed). No icon on every label.

## 7. Alignment
- Single left edge, single right edge. Meta column right-aligned to the gutter. Title baseline aligned with action button center.

## 8. Borders & shadows
- Prefer fill differences over borders. Borders only for inputs/secondary buttons, 1px low-contrast.
- Shadows: soft, large blur, low opacity, only on floating layers (popovers, the "glass" search). Never on list rows.

## 9. Empty states
- One muted icon/mark, one sentence (14/400 secondary), one action button. Centered vertically in the area. No illustrations zoo, no emoji, no marketing copy.

## 10. Anti-patterns that read as AI-generated (remove on sight)
- Sparkle ✨ "AI" banners, emojis in UI, gradient or saturated tinted strips.
- Outlined everything (title box, chips, search all bordered).
- Bright blue solid selected chip + red count badges + blue FAB all on one screen (3+ competing accents).
- Hairline dividers between every row; cramped rows.
- Small centered title; mixed alignments; random spacing (13, 15, 18px).
- Generic copy ("Find a conversation" is fine; "Unlock AI-powered insights ✨" is not).

## Conflicts with HELIOS kit (`/workspace/design/kit-claude/DESIGN.md`) — kit wins
- Accent is **ouro** (not blue); max 1 filled gold element per screen. Unread dot = ouro.
- Kit's active menu item uses a 3px gold left bar + basalto fill (keep it, even though reference uses fill only). Exactly one bar.
- Kit radii (button 10, field 12, chip 8) override the reference's 22/pill radii. Kit fonts: Inter UI (title 28/600, body 15, label 14, caption 12) override SF Pro sizes.
- Kit field keeps a 1px brasa border (reference drops borders).
- Kit says dark; the user decided **light theme is primary** — apply these rules to both, light first, using kit tokens.
- Cinzel only for wordmark/brand titles.

## Checklist before shipping a screen
1. Only scale spacing values? 2. ≤4 type sizes? 3. ≤1 filled accent element? 4. No dividers in lists? 5. No emoji/sparkles? 6. One left edge? 7. Shadows only on floating layers? 8. Empty state = icon+sentence+button?
