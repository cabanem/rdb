#!/usr/bin/env python
"""
gen_sdc_docs.py - build the generated (Layer B) reference docs for the SDC estate
from Workato project exports.

Usage (Git Bash on the dev VM, system Python 3.12):

    python tools/gen_sdc_docs.py --golden "Randstad_DataBridge_20261109_1051.zip" \
                                 --base   "BASE_20261109_1050.zip" \
                                 --out    docs/generated

Each --golden / --base value is either the export .zip or an already-unzipped folder.
Only the Python standard library is used. All files are read and written as UTF-8.

Outputs (overwritten every run):
    <out>/wfa-map.md        pages -> components -> recipes -> inputs/outputs -> tables
    <out>/recipes.md        every recipe: trigger, callers, callees, tables, connectors, warnings
    <out>/api-contracts.md  API collections and endpoints with request/response schemas
    <out>/data-tables.md    table columns plus writer/reader lists
    <out>/manifest.json     what was read (file names, counts, export timestamp)

Nothing in here is hand-maintained. Edit the exports in Workato, re-export, re-run.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import io
import json
import os
import re
import sys
import tempfile
import zipfile

NBSP = "\u00a0"

# ----------------------------------------------------------------------------- loading

def load_export(path: str) -> tuple[str, str]:
    """Return (root_dir, label). Unzips to a temp dir when given a .zip."""
    if os.path.isdir(path):
        root = path
    elif zipfile.is_zipfile(path):
        tmp = tempfile.mkdtemp(prefix="sdcexp_")
        with zipfile.ZipFile(path) as z:
            for m in z.infolist():
                if m.filename.startswith("__MACOSX/") or m.is_dir():
                    continue
                z.extract(m, tmp)
        root = tmp
    else:
        sys.exit(f"not a folder or zip: {path}")
    # An export is one folder holding collection-level files plus one project folder.
    entries = [e for e in os.listdir(root) if not e.startswith("__MACOSX")]
    if len(entries) == 1 and os.path.isdir(os.path.join(root, entries[0])):
        root = os.path.join(root, entries[0])
    return root, os.path.basename(root)


def read_json(path: str):
    with io.open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def rel(path: str, root: str) -> str:
    return os.path.relpath(path, root).replace(os.sep, "/")


def walk_files(root: str, suffix: str) -> list[str]:
    return sorted(glob.glob(os.path.join(root, "**", "*" + suffix), recursive=True))


# ----------------------------------------------------------------------------- model

def short_code(name: str) -> str:
    """First whitespace-delimited token, e.g. 'WFA-009a' from 'WFA-009a Add supplier ...'."""
    return re.split(r"\s+", name.replace(NBSP, " ").strip(), maxsplit=1)[0]


def parse_schema(value):
    """Recipe schema fields are stored as JSON strings inside the recipe JSON."""
    if value in (None, ""):
        return []
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return []
    return value


def ref_name(ref):
    """Export references are {zip_name, name, folder}; unresolved ones are bare ids."""
    if isinstance(ref, dict):
        return ref.get("name"), True
    if ref in (None, ""):
        return None, False
    return str(ref), False


class Project:
    def __init__(self, root: str, label: str):
        self.root = root
        self.label = label
        self.recipes: dict[str, dict] = {}       # name -> record
        self.tables: dict[str, dict] = {}        # name -> record
        self.pages: dict[str, dict] = {}         # name -> record
        self.app: dict | None = None
        self.groups: list[dict] = []
        self.endpoints: list[dict] = []
        self.adapters: list[dict] = []
        self.connections: list[dict] = []
        self.properties: dict = {}
        self.tags: list[dict] = []
        self.project_name = None
        self.load()

    # -- loading -------------------------------------------------------------
    def load(self):
        for f in walk_files(self.root, ".api_group.json"):
            d = read_json(f); d["_file"] = rel(f, self.root); self.groups.append(d)
        for f in walk_files(self.root, ".api_endpoint.json"):
            d = read_json(f); d["_file"] = rel(f, self.root); self.endpoints.append(d)
        for f in walk_files(self.root, ".custom_adapter.json"):
            d = read_json(f); d["_file"] = rel(f, self.root); self.adapters.append(d)
        for f in walk_files(self.root, ".connection.json"):
            d = read_json(f); d["_file"] = rel(f, self.root); self.connections.append(d)
        for f in walk_files(self.root, "properties.json"):
            d = read_json(f)
            self.properties[rel(f, self.root)] = d.get("data", d)
        for f in walk_files(self.root, "tags.json"):
            self.tags = read_json(f)
        for f in walk_files(self.root, ".workato_db_table.json"):
            d = read_json(f)
            self.tables[d["name"]] = {"name": d["name"], "file": rel(f, self.root),
                                      "schema": d.get("schema", []),
                                      "project": d.get("project_name")}
            self.project_name = self.project_name or d.get("project_name")
        for f in walk_files(self.root, ".lcap_app.json"):
            d = read_json(f); d["_file"] = rel(f, self.root); self.app = d
        for f in walk_files(self.root, ".lcap_page.json"):
            d = read_json(f)
            self.pages[d["name"]] = {"name": d["name"], "path": d.get("path"), "tags": d.get("tags") or [],
                                     "file": rel(f, self.root), "content": d.get("content", {})}
        for f in walk_files(self.root, ".recipe.json"):
            self.recipes_add(read_json(f), rel(f, self.root))
        self.resolve_graph()

    def recipes_add(self, d: dict, file: str):
        code = d.get("code", {})
        rec = {
            "name": d["name"], "code": short_code(d["name"]), "file": file,
            "version": d.get("version"), "concurrency": d.get("concurrency"),
            "trigger": f"{code.get('provider')}.{code.get('name')}",
            "trigger_input": code.get("input", {}) or {},
            "calls": [], "unresolved_calls": [], "tables": collections.defaultdict(set),
            "unresolved_tables": [], "connector_actions": [], "wfa_actions": [],
            "py_steps": 0, "steps": 0, "step_index": [],
        }
        self._walk(code.get("block", []), rec, depth=0)
        self.recipes[d["name"]] = rec

    def _walk(self, block, rec, depth):
        for s in block:
            rec["steps"] += 1
            p, n, kw = s.get("provider"), s.get("name"), s.get("keyword")
            inp = s.get("input", {}) or {}
            desc = s.get("comment") or s.get("description") or ""
            rec["step_index"].append((depth, s.get("number"), kw, p, n, desc))
            if p == "workato_recipe_function" and n == "call_recipe":
                name, ok = ref_name(inp.get("flow_id"))
                hint = (s.get("dynamicPickListSelection") or {}).get("flow_id")
                if ok:
                    rec["calls"].append(name)
                else:
                    rec["unresolved_calls"].append({"step": s.get("number"), "id": name, "hint": hint})
            elif p == "workato_db_table":
                name, ok = ref_name(inp.get("table_id"))
                if ok:
                    rec["tables"][name].add(n)
                else:
                    rec["unresolved_tables"].append({"step": s.get("number"), "id": name, "op": n})
            elif p and "connector_" in p:
                rec["connector_actions"].append(f"{p.split('_connector')[0]}.{n}")
            elif p == "workato_workflow_task" and kw == "action":
                rec["wfa_actions"].append(n)
            elif p == "py_eval":
                rec["py_steps"] += 1
            if "block" in s:
                self._walk(s["block"], rec, depth + 1)

    def resolve_graph(self):
        self.callers = collections.defaultdict(set)
        for r in self.recipes.values():
            for c in r["calls"]:
                self.callers[c].add(r["name"])
        self.table_writers = collections.defaultdict(set)
        self.table_readers = collections.defaultdict(set)
        for r in self.recipes.values():
            for t, ops in r["tables"].items():
                if ops - {"get_records", "search_records", "get_record"}:
                    self.table_writers[t].add(r["name"])
                if ops & {"get_records", "search_records", "get_record"}:
                    self.table_readers[t].add(r["name"])

    # -- helpers ---------------------------------------------------------------
    def trigger_kind(self, r) -> str:
        t = r["trigger"]
        return {
            "workato_recipe_function.execute": "recipe function",
            "workato_workflow_task.app_function_generic_request": "WFA function (action)",
            "workato_workflow_task.app_function_load_dropdown_request": "WFA function (dropdown)",
            "workato_workflow_task.app_function_load_table_request": "WFA function (table)",
            "workato_api_platform.receive_request": "API endpoint",
            "clock.scheduled_event": "scheduled",
            "workato_webhooks.new_event": "webhook",
            "workato_db_table.updated_records_realtime": "data-table trigger",
        }.get(t, t)

    def recipe_params(self, r):
        return parse_schema(r["trigger_input"].get("parameters_schema_json"))

    def recipe_outputs(self, r):
        ti = r["trigger_input"]
        if "output_schema_json" in ti:
            return parse_schema(ti["output_schema_json"])
        if "result_schema_json" in ti:
            return parse_schema(ti["result_schema_json"])
        if "table_schema_json" in ti:
            return parse_schema(ti["table_schema_json"])
        return []

    def request_columns(self) -> dict[str, str]:
        """Column id -> title for the app's request table (pills with source=request use ids)."""
        if not self.app:
            return {}
        tname, _ = ref_name(self.app.get("workato_db_table"))
        t = self.tables.get(tname or "")
        if not t:
            return {}
        return {c["id"]: c["title"] for c in t["schema"]}


# ----------------------------------------------------------------------------- markdown helpers

def md_escape(s) -> str:
    if s is None:
        return ""
    return str(s).replace("|", "\\|").replace(NBSP, "·").replace("\n", " ")


def fields_inline(fields, limit=None) -> str:
    """Compact 'name:type' list; nested properties shown one level with dots."""
    out = []
    for f in fields or []:
        t = f.get("type", "?")
        if f.get("of"):
            t = f"{t}<{f['of']}>"
        req = "" if f.get("optional", True) else "*"
        out.append(f"`{f.get('name')}`:{t}{req}")
        for sub in f.get("properties") or []:
            st = sub.get("type", "?")
            out.append(f"`{f.get('name')}.{sub.get('name')}`:{st}")
    if limit and len(out) > limit:
        return ", ".join(out[:limit]) + f", … (+{len(out) - limit} more)"
    return ", ".join(out) if out else "—"


def schema_tree(fields, depth=0, out=None):
    if out is None:
        out = []
    for f in fields or []:
        t = f.get("type", "?")
        if f.get("of"):
            t = f"{t}<{f['of']}>"
        req = " **required**" if f.get("optional") is False else ""
        hint = f" — {f['hint']}" if f.get("hint") else ""
        out.append("  " * depth + f"- `{f.get('name')}`: {t}{req}{hint}")
        if f.get("properties"):
            schema_tree(f["properties"], depth + 1, out)
    return out


# ----------------------------------------------------------------------------- page analysis

PILL_RE = re.compile(r"_dp\('(\{.*?\})'\)")

OP_LEGEND = {
    # group codes (first element of a `visible` / `condition` array)
    "group": {1: "ALL of", 2: "ANY of"},
    # operator codes seen in the 2026-11-09 export; meanings inferred from usage, not documented by Workato
    "op": {1: "equals", 2: "not equals", 7: "equals (text; possibly case-insensitive)", 9: "numeric cmp (a)", 10: "numeric cmp (b)",
           11: "is true", 12: "is false", 13: "is not empty", 14: "is empty"},
}


class PageAnalyzer:
    def __init__(self, project: Project):
        self.p = project
        self.req_cols = project.request_columns()

    def analyze(self, page) -> dict:
        c = page["content"]
        self.vars = {v["id"]: v for v in c.get("variables", [])}
        self.widgets = {}
        self._index_widgets(c.get("layout", []))
        info = {"variables": list(self.vars.values()), "widgets": self.widgets,
                "invocations": [], "conditional": [], "recipes": set(), "unresolved": []}
        for ev, h in (c.get("handlers") or {}).items():
            self._handler(h, f"page `{ev}`", info)
        self._components(c.get("layout", []), info)
        return info

    # resolve a pill to a readable token
    def pill(self, raw: str) -> str:
        def repl(m):
            try:
                j = json.loads(m.group(1))
            except json.JSONDecodeError:
                return "{pill}"
            src = j.get("source"); path = j.get("path") or []
            if src == "widget":
                w = self.widgets.get(j.get("id"))
                name = w[1] if w else j.get("id")
                suffix = "" if path == ["value"] else "." + ".".join(map(str, path))
                return f"{{widget:{name}{suffix}}}"
            if src == "page-variable":
                v = self.vars.get(j.get("id"))
                return f"{{var:{v['name'] if v else j.get('id')}}}"
            if src == "request":
                col = path[1] if len(path) > 1 else "?"
                return f"{{request:{self.req_cols.get(col, col)}}}"
            if src == "project-property":
                return f"{{property:{j.get('id') or j.get('name') or '?'}}}"
            if src == "user":
                return f"{{user:{'.'.join(map(str, path))}}}"
            return f"{{{src}}}"
        out = PILL_RE.sub(repl, raw)
        # "#{_dp(...)}" becomes "#{{var:x}}" after substitution; drop the interpolation wrapper
        return re.sub(r"#\{(\{[^{}]*\})\}", r"\1", out)

    def cond(self, arr) -> str:
        if not isinstance(arr, list) or not arr:
            return str(arr)
        grp = OP_LEGEND["group"].get(arr[0], f"group{arr[0]}")
        parts = []
        for item in arr[1:]:
            if isinstance(item, list) and item:
                op = OP_LEGEND["op"].get(item[0], f"op{item[0]}")
                args = [self.pill(str(a)) if isinstance(a, str) else json.dumps(a) for a in item[1:]]
                parts.append(f"[{item[0]}:{op}] " + " , ".join(args))
            else:
                parts.append(str(item))
        return f"{grp}: " + " ; ".join(parts)

    def _index_widgets(self, node):
        if isinstance(node, dict):
            t = node.get("type"); wid = node.get("id")
            if t and wid and isinstance(wid, str) and len(wid) == 8 and "name" in node and t not in ("variable",):
                self.widgets[wid] = (t, node.get("name"))
            for k, v in node.items():
                if k != "handlers" and isinstance(v, (dict, list)):
                    self._index_widgets(v)
        elif isinstance(node, list):
            for x in node:
                self._index_widgets(x)

    def _entity(self, ent) -> str:
        if not isinstance(ent, dict):
            return "?"
        if ent.get("type") == "variable":
            v = self.vars.get(ent.get("id")); return f"var:{v['name'] if v else ent.get('id')}"
        if ent.get("type") == "widget":
            w = self.widgets.get(ent.get("id")); return f"widget:{w[1] if w else ent.get('id')}"
        return f"{ent.get('type')}:{ent.get('id')}"

    def _handler(self, h, where, info):
        chain = []
        while isinstance(h, dict):
            t = h.get("type")
            if t == "invoke-app-function":
                opts = h.get("appFunctionOptions") or {}
                rname, ok = ref_name((opts.get("recipeMeta") or {}).get("id"))
                inputs = [(k, self.pill(str((v or {}).get("value", "")))) for k, v in (opts.get("input") or {}).items()]
                outputs = [(m["param"]["name"], self._entity(m.get("entity"))) for m in h.get("outputMapping") or []]
                info["invocations"].append({"where": where, "recipe": rname, "resolved": ok,
                                            "inputs": inputs, "outputs": outputs})
                if ok:
                    info["recipes"].add(rname)
                else:
                    info["unresolved"].append((where, rname))
                chain.append(f"invoke {short_code(rname) if rname else '?'}")
            elif t == "set-value":
                els = [f"{self._entity(e.get('entity'))} = {self.pill(str(e.get('value', '')))}" for e in h.get("elements") or []]
                chain.append("set-value(" + "; ".join(els) + ")")
            elif t == "reset-widgets-values":
                chain.append("reset(" + ",".join(map(str, h.get("ids") or [])) + ")")
            elif t == "open-webpage":
                chain.append("open-webpage(" + self.pill(str(h.get("url") or "")) + (f", {h.get('target')}" if h.get("target") else "") + ")")
            else:
                chain.append(t or "?")
            h = h.get("followUpAction")
        if chain and not any(x.startswith("invoke") for x in chain):
            info["invocations"].append({"where": where, "recipe": None, "resolved": True,
                                        "inputs": [], "outputs": [], "chain": chain})
        elif chain:
            info["invocations"][-1]["chain"] = chain

    def _components(self, node, info):
        if isinstance(node, dict):
            t = node.get("type"); nm = node.get("name"); wid = node.get("id")
            if t in ("dropdown", "table") and node.get("appFunctionOptions"):
                opts = node["appFunctionOptions"]
                rname, ok = ref_name((opts.get("recipeMeta") or {}).get("id"))
                inputs = [(k, self.pill(str((v or {}).get("value", "")))) for k, v in (opts.get("input") or {}).items()]
                cols = [cs.get("id") for cs in node.get("columnsSettings") or []] if t == "table" else []
                info["invocations"].append({"where": f"{t} `{nm}` data source", "recipe": rname, "resolved": ok,
                                            "inputs": inputs, "outputs": [], "columns": cols})
                if ok:
                    info["recipes"].add(rname)
                else:
                    info["unresolved"].append((f"{t} {nm}", rname))
            if isinstance(node.get("visible"), list):
                info["conditional"].append((t, nm, self.cond(node["visible"])))
            if t and wid:
                for k, v in node.items():
                    if k in ("handlers", "visible", "appFunctionOptions") or not isinstance(v, str):
                        continue
                    for prop in re.findall(r'"source":"project-property","id":"([A-Za-z0-9_]+)"', v):
                        info.setdefault("properties", []).append((t, nm, k, prop))
            for ev, h in (node.get("handlers") or {}).items():
                self._handler(h, f"{t} `{nm}` on `{ev}`", info)
            for k, v in node.items():
                if k != "handlers" and isinstance(v, (dict, list)):
                    self._components(v, info)
        elif isinstance(node, list):
            for x in node:
                self._components(x, info)


# ----------------------------------------------------------------------------- binding check

def binding_check(project: Project, page_infos: dict) -> list[str]:
    """Compare every page binding with the recipe trigger schema it points at."""
    issues = []
    for pname, info in page_infos.items():
        for inv in info["invocations"]:
            r = project.recipes.get(inv["recipe"] or "")
            if inv["recipe"] is None:
                continue
            if not r:
                issues.append(f"[{pname}] {inv['where']}: recipe not in export: {inv['recipe']}")
                continue
            params = {f.get("name") for f in project.recipe_params(r)}
            outs = {f.get("name") for f in project.recipe_outputs(r)}
            for k, _ in inv["inputs"]:
                if k not in params:
                    issues.append(f"[{pname}] {inv['where']} → {r['code']}: page sends input `{k}` that the recipe does not declare")
            for pn, _ in inv["outputs"]:
                if pn not in outs:
                    issues.append(f"[{pname}] {inv['where']} → {r['code']}: page binds output `{pn}` that the recipe does not declare")
            for col in inv.get("columns") or []:
                if col not in outs:
                    issues.append(f"[{pname}] {inv['where']} → {r['code']}: table column `{col}` not in recipe table schema")
    return issues


# ----------------------------------------------------------------------------- renderers

def hdr(stamp: str, source: str) -> list[str]:
    return [f"> Generated {stamp} from `{source}` by `tools/gen_sdc_docs.py`. Do not edit by hand; re-export and re-run.", ""]


def render_wfa_map(p: Project, infos: dict, issues: list[str], stamp: str) -> str:
    L = ["# WFA map — pages, components, recipes, tables", ""] + hdr(stamp, p.label)
    app = p.app or {}
    L += ["## Workflow app", ""]
    if app:
        tname, _ = ref_name(app.get("workato_db_table"))
        L += [f"- Name: **{app.get('name')}** (`{app['_file']}`)",
              f"- Request table: `{tname}`",
              f"- Displayed columns: {len(app.get('displayed_columns') or [])} configured", ""]
        L += ["### Stages", "", "| Stage | Task page | Details page |", "|---|---|---|"]
        page_use = collections.defaultdict(list)
        for st in app.get("workflow_stages") or []:
            tp, _ = ref_name(st.get("task_page")); dp, _ = ref_name(st.get("details_page"))
            if tp: page_use[tp].append(f"task page of stage “{st['name']}”")
            if dp: page_use[dp].append(f"details page of stage “{st['name']}”")
            L.append(f"| {st['name']} | {tp or '—'} | {dp or '—'} |")
        L += ["", "### Tabs", "", "| Tab | Kind | Visibility | Page |", "|---|---|---|---|"]
        for tb in app.get("tabs") or []:
            pg, _ = ref_name(tb.get("page"))
            if pg: page_use[pg].append(f"tab “{tb['name']}”")
            L.append(f"| {tb['name']} | {tb.get('kind')} | {tb.get('visibility')} | {pg or '—'} |")
        L.append("")
    else:
        page_use = {}
        L += ["_No .lcap_app.json in this export._", ""]

    # binding check first: it is the thing an editor needs to see
    L += ["## Binding check", ""]
    if issues:
        L += [f"**{len(issues)} mismatch(es)** between page bindings and recipe trigger schemas:", ""]
        L += [f"- {i}" for i in issues]
    else:
        L += ["**0 mismatches.** Every page input, output mapping and table column matches the recipe trigger schema it points at."]
    L.append("")
    # properties the pages read vs. properties the export declares
    declared = set()
    for data in p.properties.values():
        declared |= set((data or {}).keys())
    referenced = set()
    for info in infos.values():
        referenced |= {x[3] for x in info.get("properties", [])}
        for inv in info["invocations"]:
            blob = json.dumps(inv)
            referenced |= set(re.findall(r"\{property:([A-Za-z0-9_]+)\}", blob))
        for _, _, cnd in info["conditional"]:
            referenced |= set(re.findall(r"\{property:([A-Za-z0-9_]+)\}", cnd))
    missing = sorted(referenced - declared)
    for pname, info in infos.items():
        for t, nm, k, prop in info.get("properties", []):
            L.append(f"- [{pname}] {t} `{md_escape(nm)}`.{k} reads property `{prop}`")
    if referenced:
        L += ["Properties read by pages: " + ", ".join(f"`{x}`" for x in sorted(referenced))
              + (f". **Not in the exported property list:** " + ", ".join(f"`{x}`" for x in missing) + " — must exist in the target workspace." if missing else "."), ""]

    # recipe -> pages index
    L += ["## WFA functions and the pages that use them", "", "| Recipe | Kind | Used on |", "|---|---|---|"]
    used = collections.defaultdict(set)
    for pname, info in infos.items():
        for r in info["recipes"]:
            used[r].add(pname)
    for r in sorted(p.recipes.values(), key=lambda x: x["code"]):
        if not r["trigger"].startswith("workato_workflow_task"):
            continue
        pages = ", ".join(sorted(used.get(r["name"], []))) or "_not referenced by any page_"
        L.append(f"| `{r['code']}` {md_escape(r['name'][len(short_code(r['name'])):].strip())} | {p.trigger_kind(r)} | {pages} |")
    L.append("")

    # per page
    L += ["## Pages", ""]
    order = sorted(p.pages.values(), key=lambda pg: (pg["name"] not in page_use, pg["name"]))
    for pg in order:
        info = infos[pg["name"]]
        L += [f"### {pg['name']}", "",
              f"- Path: `{pg['path']}` · File: `{pg['file']}` · Tags: {', '.join('`%s`' % t for t in pg['tags']) or '—'}",
              f"- Wired as: {'; '.join(page_use.get(pg['name'], [])) or '**not wired into the app** (no stage or tab references it)'}",
              f"- Variables: {len(info['variables'])} · Components: {len(info['widgets'])} · Recipes used: "
              + (", ".join(f'`{short_code(r)}`' for r in sorted(info['recipes'])) or "none"), ""]
        # tables touched via recipes
        touched_r = set(); touched_w = set()
        for rn in info["recipes"]:
            stack = [rn]; seen = set()
            while stack:
                cur = stack.pop()
                if cur in seen or cur not in p.recipes:
                    continue
                seen.add(cur)
                for t, ops in p.recipes[cur]["tables"].items():
                    (touched_w if ops - {"get_records", "search_records", "get_record"} else touched_r).add(t)
                stack.extend(p.recipes[cur]["calls"])
        if touched_r or touched_w:
            L += [f"- Tables reached through those recipes (including callees) — written: "
                  + (", ".join(f'`{t}`' for t in sorted(touched_w)) or "none")
                  + "; read only: " + (", ".join(f'`{t}`' for t in sorted(touched_r - touched_w)) or "none"), ""]
        if info["variables"]:
            L += ["<details><summary>Page variables</summary>", "", "| Name | Type | id |", "|---|---|---|"]
            for v in info["variables"]:
                L.append(f"| `{v['name']}` | {v.get('dataType')} | `{v['id']}` |")
            L += ["", "</details>", ""]
        if info["invocations"]:
            L += ["**Recipe calls and action chains**", ""]
            for inv in info["invocations"]:
                if inv["recipe"]:
                    r = p.recipes.get(inv["recipe"])
                    code = r["code"] if r else inv["recipe"]
                    L.append(f"- {inv['where']} → **`{code}`**" + ("" if inv["resolved"] else " _(unresolved recipe reference)_"))
                    if inv["inputs"]:
                        L.append("  - inputs: " + "; ".join(f"`{k}` ← {md_escape(v)}" for k, v in inv["inputs"]))
                    if inv["outputs"]:
                        L.append("  - outputs: " + "; ".join(f"`{k}` → {md_escape(v)}" for k, v in inv["outputs"]))
                    if inv.get("columns"):
                        L.append("  - table columns: " + ", ".join(f"`{c}`" for c in inv["columns"]))
                    chain = inv.get("chain") or []
                    if len(chain) > 1:
                        L.append("  - then: " + " → ".join(md_escape(x) for x in chain[1:]))
                else:
                    L.append(f"- {inv['where']}: " + " → ".join(md_escape(x) for x in inv.get("chain") or []))
            L.append("")
        if info["conditional"]:
            L += ["<details><summary>Conditional visibility</summary>", ""]
            for t, nm, cnd in info["conditional"]:
                L.append(f"- {t} `{md_escape(nm)}`: {md_escape(cnd)}")
            L += ["", "</details>", ""]
    L += ["## Condition code legend (inferred)", "",
          "Conditions are stored as `[group, [op, lhs, rhs?], …]`. Meanings below were inferred from how the codes are used "
          "in this export and are **not** documented by Workato; confirm in the page editor before relying on one.", ""]
    L += [f"- group `{k}` = {v}" for k, v in OP_LEGEND["group"].items()]
    L += [f"- op `{k}` = {v}" for k, v in OP_LEGEND["op"].items()]
    L.append("")
    return "\n".join(L)


def render_recipes(projects: list[Project], infos_by_project: dict, stamp: str) -> str:
    L = ["# Recipes — triggers, call graph, tables, connectors", ""] + hdr(stamp, " + ".join(p.label for p in projects))
    for p in projects:
        used_on = collections.defaultdict(set)
        for pname, info in infos_by_project.get(p.label, {}).items():
            for r in info["recipes"]:
                used_on[r].add(pname)
        kinds = collections.Counter(p.trigger_kind(r) for r in p.recipes.values())
        L += [f"## Project: {p.project_name or p.label}", "",
              f"{len(p.recipes)} recipes — " + ", ".join(f"{v} {k}" for k, v in kinds.most_common()), ""]
        L += ["| Code | Name | Kind | v | Callers | Calls | Writes | Reads | Connector actions | Py |",
              "|---|---|---|---|---|---|---|---|---|---|"]
        for r in sorted(p.recipes.values(), key=lambda x: x["code"]):
            w = sorted(t for t, ops in r["tables"].items() if ops - {"get_records", "search_records", "get_record"})
            rd = sorted(t for t, ops in r["tables"].items() if ops & {"get_records", "search_records", "get_record"} and t not in w)
            callers = sorted(short_code(c) for c in p.callers.get(r["name"], []))
            callers += sorted(f"page:{x}" for x in used_on.get(r["name"], []))
            L.append("| `{}` | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
                r["code"], md_escape(r["name"][len(short_code(r["name"])):].strip()), p.trigger_kind(r), r["version"],
                ", ".join(callers) or "—", ", ".join(sorted(set(short_code(c) for c in r["calls"]))) or "—",
                ", ".join(w) or "—", ", ".join(rd) or "—",
                ", ".join(sorted(set(a.split(".")[-1] for a in r["connector_actions"]))) or "—", r["py_steps"] or ""))
        L.append("")
        # WFA function contracts
        wfa = [r for r in p.recipes.values() if r["trigger"].startswith("workato_workflow_task")]
        if wfa:
            L += ["### WFA function contracts (trigger schemas)", "",
                  "Names below are what the pages bind to. Renaming any of them breaks the page binding.", ""]
            for r in sorted(wfa, key=lambda x: x["code"]):
                L += [f"**`{r['code']}` {md_escape(r['name'][len(short_code(r['name'])):].strip())}** — {p.trigger_kind(r)}; "
                      f"pages: {', '.join(sorted(used_on.get(r['name'], []))) or '_none_'}",
                      f"- parameters: {fields_inline(p.recipe_params(r))}"]
                if r["trigger"].endswith("load_dropdown_request"):
                    L.append("- returns: dropdown options (label + value only)")
                elif r["trigger"].endswith("load_table_request"):
                    L.append(f"- table columns: {fields_inline(p.recipe_outputs(r))}")
                else:
                    L.append(f"- outputs: {fields_inline(p.recipe_outputs(r))}")
                L.append("")
        # recipe function contracts
        rf = [r for r in p.recipes.values() if r["trigger"] == "workato_recipe_function.execute"]
        if rf:
            L += ["### Recipe function contracts", ""]
            for r in sorted(rf, key=lambda x: x["code"]):
                L += [f"**`{r['code']}` {md_escape(r['name'][len(short_code(r['name'])):].strip())}** — callers: "
                      + (", ".join(sorted(short_code(c) for c in p.callers.get(r['name'], []))) or "_none in this export_"),
                      f"- parameters: {fields_inline(p.recipe_params(r), limit=40)}",
                      f"- result: {fields_inline(p.recipe_outputs(r), limit=40)}", ""]
        # warnings
        warn = []
        for r in sorted(p.recipes.values(), key=lambda x: x["code"]):
            for u in r["unresolved_calls"]:
                warn.append(f"`{r['code']}` step {u['step']}: `call_recipe` points at recipe id `{u['id']}` which is not in this export"
                            + (f" (editor label: “{u['hint']}”)" if u.get("hint") else ""))
            for u in r["unresolved_tables"]:
                warn.append(f"`{r['code']}` step {u['step']}: `{u['op']}` on table id `{u['id']}` which is not in this export")
            if NBSP in r["name"]:
                warn.append(f"`{r['code']}`: name contains a non-breaking space (“{md_escape(r['name'])}”)")
            if r["code"].endswith("-"):
                warn.append(f"`{r['code']}`: code ends with a hyphen")
            if not re.search(r"\d", r["code"]):
                warn.append(f"`{r['code']}`: code has no number (“{md_escape(r['name'])}”)")
        codes = collections.Counter(r["code"] for r in p.recipes.values())
        for c, n in codes.items():
            if n > 1:
                warn.append(f"`{c}`: {n} recipes share this code: " + "; ".join(md_escape(r["name"]) for r in p.recipes.values() if r["code"] == c))
        L += ["### Warnings", ""]
        L += [f"- {w}" for w in warn] or ["- none"]
        L.append("")
        # connectors & connections
        L += ["### Custom connectors and connections in this export", ""]
        for a in p.adapters:
            L.append(f"- connector **{a.get('title')}** (v{a.get('version_no')}, `{a['_file']}`)")
        for c in p.connections:
            prov, _ = ref_name(c.get("provider"))
            L.append(f"- connection **{c.get('name')}** → provider `{prov}`")
        L.append("")
        if p.tags:
            L += ["### Tags defined", "", ", ".join(f"`{t['title']}`" + (f" ({t['description']})" if t.get('description') else "") for t in p.tags), ""]
        if p.properties:
            L += ["### Properties expected by this project (values are not exported)", ""]
            for f, data in p.properties.items():
                L.append(f"- `{f}`: " + ", ".join(f"`{k}`" for k in (data or {}).keys()))
            L.append("")
    return "\n".join(L)


def render_api(projects: list[Project], stamp: str) -> str:
    L = ["# API contracts — collections and endpoints", ""] + hdr(stamp, " + ".join(p.label for p in projects))
    for p in projects:
        for g in p.groups:
            L += [f"## {p.project_name or p.label}: collection “{g.get('name')}” (handle `{g.get('handle')}`, version {g.get('version')})", ""]
            if g.get("description"):
                L += [g["description"], ""]
            eps = [e for e in p.endpoints if ref_name(e.get("api_group_id"))[0] == g.get("name")]
            L += ["| Method | Path | Recipe | Timeout (s) |", "|---|---|---|---|"]
            for e in sorted(eps, key=lambda x: (x.get("path"), x.get("method"))):
                rn, _ = ref_name(e.get("recipe_id"))
                L.append(f"| {e.get('method')} | `/{e.get('path')}` | {md_escape(rn)} | {e.get('recipe_timeout')} |")
            L.append("")
            for e in sorted(eps, key=lambda x: (x.get("path"), x.get("method"))):
                rn, _ = ref_name(e.get("recipe_id"))
                r = p.recipes.get(rn or "")
                L += [f"### {e.get('method')} `/{e.get('path')}` → {md_escape(rn)}", ""]
                if not r:
                    L += ["_Recipe not found in export._", ""]; continue
                req = r["trigger_input"].get("request", {}) or {}
                headers = parse_schema(req.get("headers"))
                body = parse_schema(req.get("schema")) or parse_schema(req.get("body"))
                L.append("- Request headers: " + (", ".join(f"`{h.get('name')}`" + ("" if h.get("optional", True) else "*") for h in headers) or "none"))
                L += ["- Request body:"] + (["  " + x for x in schema_tree(body)] or ["  - _(empty)_"])
                resp = r["trigger_input"].get("response", {}) or {}
                for rs in resp.get("responses") or []:
                    L += [f"- Response **{rs.get('http_status_code')}** {rs.get('name') or ''}:"]
                    L += ["  " + x for x in schema_tree(parse_schema(rs.get("body_schema")))] or ["  - _(empty)_"]
                L.append("")
    # router route table, if present
    for p in projects:
        for r in p.recipes.values():
            if r["name"].strip().lower() == "router":
                L += ["## Router decision logic (source: Router recipe step 2, Python)", "",
                      "Reproduced verbatim from the export so the route table and reject codes are visible here.", "", "```python"]
                code = _find_python(p, r)
                L += [code.rstrip(), "```", ""]
    return "\n".join(L)


def _find_python(p: Project, r: dict) -> str:
    d = read_json(os.path.join(p.root, r["file"]))
    found = []
    def walk(b):
        for s in b:
            if s.get("provider") == "py_eval":
                found.append(s.get("input", {}).get("code", ""))
            if "block" in s:
                walk(s["block"])
    walk(d["code"].get("block", []))
    return found[0] if found else "# (no Python step found)"


def render_tables(projects: list[Project], stamp: str) -> str:
    L = ["# Data tables — columns, writers, readers", ""] + hdr(stamp, " + ".join(p.label for p in projects))
    for p in projects:
        L += [f"## Project: {p.project_name or p.label}", ""]
        for t in sorted(p.tables.values(), key=lambda x: x["name"]):
            cols = [c for c in t["schema"] if not c.get("hidden")]
            L += [f"### `{t['name']}` ({len(cols)} columns)", "",
                  "- Writers: " + (", ".join(f"`{x}`" for x in sorted({short_code(x) for x in p.table_writers.get(t['name'], [])})) or "_none in this export_"),
                  "- Readers: " + (", ".join(f"`{x}`" for x in sorted({short_code(x) for x in p.table_readers.get(t['name'], [])})) or "_none in this export_"), "",
                  "| Column | Type | Notes |", "|---|---|---|"]
            for c in cols:
                notes = []
                if c.get("required"): notes.append("required")
                if c.get("default_value") not in (None, ""): notes.append(f"default `{c['default_value']}`")
                rel_ = (c.get("metadata") or {}).get("relation")
                if rel_:
                    notes.append("relation → " + md_escape(json.dumps(rel_)))
                if c.get("hint"): notes.append(md_escape(c["hint"]))
                L.append(f"| `{c['title']}` | {c.get('type')} | {'; '.join(notes)} |")
            L.append("")
    return "\n".join(L)


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--golden", required=True, help="golden project export (.zip or folder)")
    ap.add_argument("--base", help="router (BASE) project export (.zip or folder)")
    ap.add_argument("--out", default="docs/generated", help="output folder (default docs/generated)")
    args = ap.parse_args()

    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    groot, glabel = load_export(args.golden)
    golden = Project(groot, glabel)
    projects = [golden]
    if args.base:
        broot, blabel = load_export(args.base)
        projects.append(Project(broot, blabel))

    analyzer = PageAnalyzer(golden)
    infos = {name: analyzer.analyze(pg) for name, pg in golden.pages.items()}
    issues = binding_check(golden, infos)

    os.makedirs(args.out, exist_ok=True)
    outputs = {
        "wfa-map.md": render_wfa_map(golden, infos, issues, stamp),
        "recipes.md": render_recipes(projects, {golden.label: infos}, stamp),
        "api-contracts.md": render_api(projects, stamp),
        "data-tables.md": render_tables(projects, stamp),
    }
    for fn, text in outputs.items():
        with io.open(os.path.join(args.out, fn), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    manifest = {
        "generated": stamp,
        "sources": {p.label: {"recipes": len(p.recipes), "tables": len(p.tables), "pages": len(p.pages),
                              "endpoints": len(p.endpoints)} for p in projects},
        "binding_issues": issues,
    }
    with io.open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"wrote {len(outputs)} docs + manifest.json to {args.out}")
    print(f"binding check: {len(issues)} issue(s)")
    for i in issues:
        print("  -", i)


if __name__ == "__main__":
    main()
