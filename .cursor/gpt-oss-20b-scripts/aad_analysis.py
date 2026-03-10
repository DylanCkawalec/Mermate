"""Architecture-Aware Deterministic (AAD) analysis for complex Mermaid diagrams.

This module provides advisory checks for architecture-grade diagrams.
It does NOT auto-modify content — all findings are reported as warnings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class AADReport:
    """Results of AAD analysis."""
    is_aad_applicable: bool
    advisories: list[str] = field(default_factory=list)
    subgraph_labels: dict[str, str] = field(default_factory=dict)
    has_legend: bool = False
    classdef_count: int = 0
    cross_subgraph_edges: int = 0


def analyze(source: str, subgraph_count: int, has_class_defs: bool, complexity: str) -> AADReport:
    """Run AAD analysis on a diagram source.

    Only applies when subgraph_count > 2, has_class_defs, and complexity is 'complex'.
    """
    report = AADReport(is_aad_applicable=False)

    if subgraph_count <= 2 or not has_class_defs or complexity != "complex":
        return report

    report.is_aad_applicable = True
    lines = source.splitlines()

    # Count classDefs
    report.classdef_count = sum(1 for ln in lines if ln.strip().startswith("classDef "))

    # Extract subgraph labels
    for ln in lines:
        m = re.match(r'^\s*subgraph\s+(\w+)\["?([^"\]]*)"?\]', ln)
        if m:
            report.subgraph_labels[m.group(1)] = m.group(2)
        else:
            m2 = re.match(r'^\s*subgraph\s+(\w+)\s*$', ln)
            if m2:
                report.subgraph_labels[m2.group(1)] = ""

    # Check for subgraphs without descriptive labels
    for sg_id, label in report.subgraph_labels.items():
        if not label or label == sg_id:
            report.advisories.append(
                f"Subgraph '{sg_id}' has no descriptive label — consider adding one"
            )

    # Check for legend
    report.has_legend = any(
        re.match(r'^\s*subgraph\s+\w*[Ll]egend', ln) for ln in lines
    )
    if not report.has_legend:
        report.advisories.append(
            "No legend subgraph found — consider adding one for complex architecture diagrams"
        )

    # Count cross-subgraph edges (edges outside any subgraph block)
    in_subgraph = 0
    edge_pattern = re.compile(r"-->|==>|-.->|--\>|--x|--o|\|\|--")
    for ln in lines:
        stripped = ln.strip()
        if re.match(r"^\s*subgraph\b", ln):
            in_subgraph += 1
        elif stripped == "end":
            in_subgraph = max(0, in_subgraph - 1)
        elif in_subgraph == 0 and edge_pattern.search(ln):
            report.cross_subgraph_edges += 1

    # Advisory: governance flows should use dotted arrows
    governance_keywords = ("policy", "approval", "deny", "constrain", "govern")
    for ln in lines:
        lower = ln.lower()
        if any(kw in lower for kw in governance_keywords):
            if "-->" in ln and "-.->" not in ln:
                report.advisories.append(
                    f"Governance-related edge uses solid arrow — consider dotted (-.->): {ln.strip()[:80]}"
                )

    return report
