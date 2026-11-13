#!/usr/bin/env python3
"""One-shot migration for badge/toast/dialog color recipes.

Rewrites unreadable color combinations to the *-bg / *-text / *-border token
pairs. Idempotent: running twice is a no-op.

Patterns rewritten (per token C in {success, accent, warning, danger, info}):
  bg-[var(--color-C)](/N)? text-[var(--color-C)]
    -> bg-[var(--color-C-bg)] text-[var(--color-C-text)]
  bg-[var(--color-accent)](/N)? text-[var(--color-accent-strong)]
    -> bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]
  bg-[var(--color-C)]/N (standalone)                 -> bg-[var(--color-C-bg)]
  border-[var(--color-C)]/N (standalone)             -> border-[var(--color-C-border)]
  dark:bg-[var(--color-...) ](/N) dark:text-[var(--color-...)]  -> removed
  dark:bg-[var(--color-X-bg)]/N dark:text-[var(--color-X-border)]  -> removed
  hover:bg-[var(--color-X-bg)]  (next to bg-[var(--color-X-bg)] same) -> hover:opacity-90
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

COLORS = ("success", "accent", "warning", "danger", "info")
COLOR_OR_STRONG = r"(?:success|accent|warning|danger|info)(?:-strong)?"

# Order matters: most-specific first.
RULES: list[tuple[re.Pattern[str], str]] = []

# 1. Accent special: bg-accent / text-accent-strong (BEFORE generic same-tone rule).
RULES.append((
    re.compile(r"bg-\[var\(--color-accent\)\](?:/\d+)?\s+text-\[var\(--color-accent-strong\)\]"),
    "bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]",
))
RULES.append((
    re.compile(r"text-\[var\(--color-accent-strong\)\]\s+bg-\[var\(--color-accent\)\](?:/\d+)?"),
    "text-[var(--color-accent-text)] bg-[var(--color-accent-bg)]",
))

# 2. Same-tone bg+text pairs (1:1 contrast) for each color.
for c in COLORS:
    RULES.append((
        re.compile(rf"bg-\[var\(--color-{c}\)\](?:/\d+)?\s+text-\[var\(--color-{c}\)\]"),
        f"bg-[var(--color-{c}-bg)] text-[var(--color-{c}-text)]",
    ))
    RULES.append((
        re.compile(rf"text-\[var\(--color-{c}\)\]\s+bg-\[var\(--color-{c}\)\](?:/\d+)?"),
        f"text-[var(--color-{c}-text)] bg-[var(--color-{c}-bg)]",
    ))

# 3. Standalone bg-[var(--color-X)]/N  (alert/dialog wrappers).
for c in COLORS:
    RULES.append((
        re.compile(rf"bg-\[var\(--color-{c}\)\]/\d+"),
        f"bg-[var(--color-{c}-bg)]",
    ))

# 4. border-[var(--color-X)]/N  (badge borders).
for c in COLORS:
    RULES.append((
        re.compile(rf"border-\[var\(--color-{c}\)\]/\d+"),
        f"border-[var(--color-{c}-border)]",
    ))

# 5. Standalone text-[var(--color-X)] when paired with bg-[var(--color-X-bg)] on same element.
#    Handled per-line below (needs context).

# 6. Remove redundant dark: overrides that re-state same-tone pairs. Tokens already swap.
RULES.append((
    re.compile(
        rf"\s+dark:bg-\[var\(--color-{COLOR_OR_STRONG}\)\]/\d+\s+dark:text-\[var\(--color-{COLOR_OR_STRONG}\)\]"
    ),
    "",
))
RULES.append((
    re.compile(
        r"\s+dark:bg-\[var\(--color-(success|accent|warning|danger|info)-bg\)\]/\d+"
        r"\s+dark:text-\[var\(--color-(?:success|accent|warning|danger|info)-(?:border|text)\)\]"
    ),
    "",
))
# Also remove the half-form `dark:text-[var(--color-X-border)]` left behind when the
# light side used `text-[var(--color-X-text)]` (warning/danger pre-existing patterns).
RULES.append((
    re.compile(
        r"\s+dark:text-\[var\(--color-(warning|danger)-border\)\]"
        r"(?=[^\"'`]*text-\[var\(--color-\1-text\)\])"
    ),
    "",
))
# Light-side text-text + redundant dark border override (order independent).
RULES.append((
    re.compile(
        r"(text-\[var\(--color-(warning|danger)-text\)\])\s+dark:text-\[var\(--color-\2-border\)\]"
    ),
    r"\1",
))

# 6b. Solid-fill buttons that use text-[var(--color-text)] for their label.
#     In dark mode --color-text is light-gray on light-blue accent → poor contrast.
#     If the SAME class-string contains both a solid color fill and text-text,
#     rewrite the text token to --color-on-primary (mode-aware: white in light,
#     near-black in dark — the existing canonical token for "label on solid fill").
SOLID_FILL_RE = re.compile(
    r"bg-\[var\(--color-(accent|accent-strong|danger|primary|primary-hover)\)\]"
)
TEXT_TEXT_TOKEN = "text-[var(--color-text)]"
TEXT_ON_PRIMARY = "text-[var(--color-on-primary)]"
CLASS_BLOCK_RE = re.compile(r'(class=["`])([^"`\n]*)(["`])')


def fix_solid_fill_button_labels(text: str) -> tuple[str, int]:
    fixes = 0

    def _fix(m: re.Match[str]) -> str:
        nonlocal fixes
        opener, body, closer = m.group(1), m.group(2), m.group(3)
        if SOLID_FILL_RE.search(body) and TEXT_TEXT_TOKEN in body:
            body = body.replace(TEXT_TEXT_TOKEN, TEXT_ON_PRIMARY)
            fixes += 1
        return f"{opener}{body}{closer}"

    return CLASS_BLOCK_RE.sub(_fix, text), fixes


# 6c. No-op hovers: `hover:bg-[var(--color-X)]` where X is the same as the
#     element's static bg. Replace with hover:opacity-90 (matches Button.svelte
#     danger variant).
NOOP_HOVER_RES = [
    (re.compile(r"bg-\[var\(--color-danger\)\] ([^\"`\n]*?)hover:bg-\[var\(--color-danger\)\]"),
     r"bg-[var(--color-danger)] \1hover:opacity-90"),
]


def fix_noop_hovers(text: str) -> tuple[str, int]:
    fixes = 0
    for pat, repl in NOOP_HOVER_RES:
        text, n = pat.subn(repl, text)
        fixes += n
    return text, fixes


# 7. Collapse leftover double-spaces inside SINGLE-LINE class="..." strings only.
#    Multi-line class={`...`} or class={...} expressions are skipped to preserve
#    template-literal indentation.
SINGLE_LINE_CLASS_RE = re.compile(r'(class=")([^"\n]*)"')


def collapse_double_spaces_in_class(text: str) -> str:
    def _fix(m: re.Match[str]) -> str:
        body = re.sub(r" {2,}", " ", m.group(2)).strip()
        return f'{m.group(1)}{body}"'
    return SINGLE_LINE_CLASS_RE.sub(_fix, text)


# Targets: src/ tree, .svelte and .ts files.
def iter_targets(root: Path):
    for ext in (".svelte", ".ts", ".tsx"):
        yield from root.rglob(f"*{ext}")


def migrate(root: Path) -> dict[Path, tuple[int, int]]:
    """Return {path: (rules_applied, double_space_collapses)} for changed files."""
    changed: dict[Path, tuple[int, int]] = {}
    for path in iter_targets(root):
        # Don't touch the contrast test itself or the design system Pill/Button
        # (handled by exact Edits elsewhere — we still allow if untouched).
        if "node_modules" in path.parts or ".svelte-kit" in path.parts:
            continue
        try:
            original = path.read_text()
        except UnicodeDecodeError:
            continue
        text = original
        applied = 0
        for pat, repl in RULES:
            new_text, n = pat.subn(repl, text)
            if n:
                applied += n
                text = new_text
        text, n_solid = fix_solid_fill_button_labels(text)
        applied += n_solid
        text, n_hover = fix_noop_hovers(text)
        applied += n_hover
        before_collapse = text
        text = collapse_double_spaces_in_class(text)
        collapses = 0 if text == before_collapse else 1
        if text != original:
            path.write_text(text)
            changed[path] = (applied, collapses)
    return changed


if __name__ == "__main__":
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("frontend/src")
    if not root.exists():
        sys.exit(f"missing target dir: {root}")
    changes = migrate(root)
    if not changes:
        print("no changes")
        sys.exit(0)
    width = max(len(str(p)) for p in changes)
    for p, (n, c) in sorted(changes.items()):
        print(f"{str(p):<{width}}  {n:3d} rule hits  {'+collapse' if c else ''}")
    total_hits = sum(n for n, _ in changes.values())
    print(f"\n{len(changes)} files changed, {total_hits} rule hits.")
