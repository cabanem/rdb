#!/usr/bin/env python3
"""
workato_schema_breakdown.py

Read one or more Workato schema JSON files and print a Workato-style field
breakdown: nested tree, type, required/optional, and hints.

Accepts any of:
  - a bare schema array           [{"name": "email", "type": "string", ...}, ...]
  - a recipe export               schemas found under input/output/*_schema keys,
                                  including ones Workato stores as JSON strings
  - a connector SDK dump          {"output_fields": [...], "input_fields": [...]}

Usage:
  python workato_schema_breakdown.py schema.json [more.json ...]
  python workato_schema_breakdown.py recipe_export.json --format md
  python workato_schema_breakdown.py schema.json --format json > flat.json
"""

import argparse
import json
import sys
from pathlib import Path

TYPE_LABELS = {
    "string": "String",
    "integer": "Integer",
    "number": "Number",
    "boolean": "Boolean",
    "date": "Date",
    "date_time": "Date/Time",
    "timestamp": "Timestamp",
    "object": "Object",
    "array": "Array",
}

# Recipe-export keys that are worth *not* descending into (huge, schema-free)
SKIP_KEYS = {"version_no", "description", "uuid"}


# --------------------------------------------------------------------------- #
# 1. Locate schemas inside whatever JSON we were handed
# --------------------------------------------------------------------------- #
def is_schema(obj):
    """A Workato schema is a non-empty list of dicts that each carry a name
    plus at least one schema-ish key."""
    if not isinstance(obj, list) or not obj:
        return False
    marker = {"type", "control_type", "label", "properties", "of", "optional"}
    return all(
        isinstance(f, dict) and "name" in f and (marker & f.keys())
        for f in obj
    )


def find_schemas(obj, path=""):
    """Yield (path, schema) for every schema found anywhere in obj."""
    if isinstance(obj, str):
        # Workato recipe exports embed extended_*_schema as JSON strings
        s = obj.lstrip()
        if s.startswith("[") or s.startswith("{"):
            try:
                yield from find_schemas(json.loads(obj), path)
            except json.JSONDecodeError:
                pass
        return
    if is_schema(obj):
        yield (path or "(root)", obj)
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in SKIP_KEYS:
                continue
            yield from find_schemas(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from find_schemas(v, f"{path}[{i}]")


# --------------------------------------------------------------------------- #
# 2. Flatten a schema into rows
# --------------------------------------------------------------------------- #
def type_label(field):
    t = field.get("type") or "string"
    if t == "array":
        inner = field.get("of") or ("object" if field.get("properties") else "string")
        return f"Array of {TYPE_LABELS.get(inner, inner)}"
    return TYPE_LABELS.get(t, t)


def flatten(schema, parent_path="", depth=0):
    """Depth-first walk producing one dict per field."""
    rows = []
    for f in schema:
        name = f.get("name", "")
        path = f"{parent_path}.{name}" if parent_path else name
        is_array = (f.get("type") == "array")
        rows.append({
            "depth": depth,
            "path": path,
            "name": name,
            "label": f.get("label") or name,
            "type": type_label(f),
            "optional": bool(f.get("optional", False)),
            "control_type": f.get("control_type"),
            "hint": f.get("hint"),
            "pick_list": f.get("pick_list"),
        })
        children = f.get("properties") or []
        if children:
            child_path = path + "[]" if is_array else path
            rows.extend(flatten(children, child_path, depth + 1))
    return rows


# --------------------------------------------------------------------------- #
# 3. Renderers
# --------------------------------------------------------------------------- #
def render_tree(rows):
    out = []
    # Precompute which rows are the last child at their depth (for └─ vs ├─)
    for i, r in enumerate(rows):
        depth = r["depth"]
        # last sibling if no later row exists at this depth before a shallower one
        last = True
        for later in rows[i + 1:]:
            if later["depth"] < depth:
                break
            if later["depth"] == depth:
                last = False
                break
        # Build the vertical guide prefix from ancestors
        prefix = ""
        for d in range(depth):
            # is there a later sibling at ancestor depth d?
            has_more = False
            for later in rows[i + 1:]:
                if later["depth"] < d:
                    break
                if later["depth"] == d:
                    has_more = True
                    break
            prefix += "│  " if has_more else "   "
        branch = "└─ " if last else "├─ "

        head = r["label"]
        if r["name"] != r["label"]:
            head += f"  <{r['name']}>"
        tags = [r["type"]]
        if r["optional"]:
            tags.append("optional")
        if r["pick_list"]:
            tags.append(f"pick_list={r['pick_list']}")
        line = f"{prefix}{branch}{head}  [{', '.join(tags)}]"
        if r["hint"]:
            line += f"  — {r['hint']}"
        out.append(line)
    return "\n".join(out)


def render_md(rows):
    out = ["| Field | Name / path | Type | Required | Hint |",
           "|---|---|---|---|---|"]
    for r in rows:
        indent = "&nbsp;&nbsp;" * r["depth"]
        req = "optional" if r["optional"] else "required"
        hint = (r["hint"] or "").replace("|", "\\|")
        out.append(
            f"| {indent}{r['label']} | `{r['path']}` | {r['type']} | {req} | {hint} |"
        )
    return "\n".join(out)


RENDERERS = {"tree": render_tree, "md": render_md}


# --------------------------------------------------------------------------- #
# 4. CLI
# --------------------------------------------------------------------------- #
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", type=Path, help="JSON file(s) to read")
    ap.add_argument("--format", choices=["tree", "md", "json"], default="tree")
    args = ap.parse_args(argv)

    all_json = []
    for fp in args.files:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"!! {fp}: {e}", file=sys.stderr)
            continue

        found = list(find_schemas(data))
        if not found:
            print(f"!! {fp}: no Workato schema found", file=sys.stderr)
            continue

        for where, schema in found:
            rows = flatten(schema)
            if args.format == "json":
                all_json.append({"file": str(fp), "location": where, "fields": rows})
                continue
            title = f"{fp.name}  ·  {where}  ·  {len(rows)} field(s)"
            print(title)
            print("=" * len(title))
            print(RENDERERS[args.format](rows))
            print()

    if args.format == "json":
        json.dump(all_json, sys.stdout, indent=2)
        print()


if __name__ == "__main__":
    main()
