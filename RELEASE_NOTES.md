# Release Notes

## v1.0.0 (2025-03-09)

**Initial Mermate release**

Mermate is an AI architecture copilot for Mermaid, built to turn raw ideas into expert system diagrams.

### Features

- **Three input modes**: Simple Idea (plain English), Markdown Spec, and raw Mermaid
- **Diagram compilation**: High-resolution PNG and SVG output via @mermaid-js/mermaid-cli
- **Auto-detection**: Flowchart, sequence, state, ER, gantt, pie, mindmap, and more
- **Fullscreen view**: GPU-accelerated pan/zoom canvas
- **Diagram history**: Sidebar with previous diagrams, delete support
- **Download**: PNG + SVG bundled as ZIP
- **Optional AI enhancement**: Connect any LLM at `http://localhost:8100` for copilot and refinement

### Requirements

- Node.js >= 20
- npm >= 9
- Python >= 3.9 (optional, for gpt-oss enhancer)

### Quick start

```bash
git clone https://github.com/DylanCkawalec/Mermate.git
cd Mermate
npm install
./mermaid.sh start
```

Open http://localhost:3333
