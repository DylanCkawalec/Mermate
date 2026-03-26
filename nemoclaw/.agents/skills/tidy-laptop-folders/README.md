# tidy-laptop-folders

Organize messy laptop folders like Desktop, Downloads, and Documents into smart categories — with dynamic folder depth that adapts to how many files you have.

## Install

```bash
npx skills add mahavir-teraiya/tidy-laptop-folders
```

## What It Does

1. **Scans** your Desktop, Downloads, or Documents folder
2. **Groups** files into smart categories (Work, Finance, Photos, Media, Code, etc.)
3. **Adapts depth** — 10 files get a flat folder, 200 files get `Year/Topic/` subfolders
4. **Shows a plan** before touching anything
5. **Moves files** only after you say yes
6. **Logs everything** so you can undo anytime

## Quick Start

Just tell your AI assistant:

```
Tidy my Downloads
```

Or be specific:

```
Organize all my folders
What's the mess in my Downloads?
Show me duplicates
Undo the last tidy
```

## Features

- **Smart categories** — sorts by purpose, not just file extension (a PDF named "invoice" goes to Finance, not Documents)
- **Dynamic depth** — folder nesting adapts to file volume automatically
- **Cross-platform** — works on macOS, Windows, and Linux
- **Safe** — never deletes, never overwrites, always asks first
- **Undo-friendly** — every move is logged for easy reversal
- **Duplicate detection** — finds identical files across folders

## How Depth Works

| Files in Category | Structure |
|---|---|
| 1-10 | Flat: `Finance/` |
| 11-50 | One level: `Finance/Tax/` |
| 51-200 | Two levels: `Finance/2025/Tax/` |
| 200+ | Three levels max: `Finance/2025/Q1/Tax/` |

Never deeper than 3 levels. Humans get lost beyond that.

## Safety

- Never deletes files — only moves them
- Never touches system/hidden files
- Never overwrites — renames on conflict
- Always shows the plan before executing
- Creates an undo log (`_tidy-log.txt`)

## License

Apache 2.0
