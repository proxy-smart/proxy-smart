#!/usr/bin/env python3
"""
Categorize commit messages into changelog sections.
Fallback when AI generation is unavailable.
Reads commit_messages.txt and outputs changelog_entry.txt.
"""

import re
import sys
from pathlib import Path


def categorize_commits(input_file: str = "commit_messages.txt", output_file: str = "changelog_entry.txt") -> None:
    """Categorize commits from input file and write changelog entry."""
    features = []
    fixes = []
    docs = []
    chores = []
    breaking = []
    others = []
    seen = set()

    input_path = Path(input_file)
    if not input_path.exists():
        print(f"❌ Input file not found: {input_file}", file=sys.stderr)
        sys.exit(1)

    with open(input_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            match = re.match(r"\[[a-f0-9]+\] [^:]+: (.+)", line)
            msg = match.group(1) if match else line
            msg_lower = msg.lower()

            if any(skip in msg_lower for skip in ["merge", "[skip ci]", "update version metadata"]):
                continue

            conventional = re.match(
                r"^(?P<type>feat|feature|fix|docs|chore|ci|build|style|refactor|perf|test)"
                r"(?P<scope>\([^)]*\))?(?P<breaking>!)?:\s*(?P<subject>.+)$",
                msg,
                flags=re.I,
            )

            if conventional:
                kind = conventional.group("type").lower()
                scope = (conventional.group("scope") or "").strip("()")
                subject = conventional.group("subject")
                text = f"**{scope}**: {subject}" if scope else subject
            else:
                kind = None
                text = msg

            if text in seen:
                continue
            seen.add(text)

            if conventional and conventional.group("breaking"):
                breaking.append(text)
            elif kind in ("feat", "feature"):
                features.append(text)
            elif kind == "fix":
                fixes.append(text)
            elif kind == "docs":
                docs.append(text)
            elif kind in ("chore", "ci", "build", "style", "refactor", "perf", "test"):
                chores.append(text)
            elif "fix " in msg_lower or "bug" in msg_lower:
                fixes.append(text)
            else:
                others.append(text)

    changelog = ""

    if breaking:
        changelog += "\n### \u26a0\ufe0f Breaking Changes\n\n"
        for b in breaking:
            changelog += f"- {b}\n"

    if features:
        changelog += "\n### ✨ Features\n\n"
        for f in features:
            changelog += f"- {f}\n"

    if fixes:
        changelog += "\n### 🐛 Bug Fixes\n\n"
        for f in fixes:
            changelog += f"- {f}\n"

    if docs:
        changelog += "\n### 📚 Documentation\n\n"
        for d in docs:
            changelog += f"- {d}\n"

    if chores:
        changelog += "\n### 🔧 Maintenance\n\n"
        for c in chores:
            changelog += f"- {c}\n"

    if others:
        changelog += "\n### 📦 Other Changes\n\n"
        for o in others:
            changelog += f"- {o}\n"

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(changelog)

    print(
        f"✅ Categorized {len(breaking)} breaking, {len(features)} features, {len(fixes)} fixes, "
        f"{len(docs)} docs, {len(chores)} chores, {len(others)} others"
    )


if __name__ == "__main__":
    categorize_commits()
