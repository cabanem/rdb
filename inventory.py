import json
import re

GATES = ['all_ok', 'all_authorized', 'all_active', 'all_recipes_ok', 'current', 'found']
MODE_ACTIONS = ['build_package', 'get_build', 'build_and_download', 'download_existing_package',
                'deploy_package', 'deploy_package_async', 'get_deployment', 'new_build_completed']
DP_NEW = re.compile(r"_dp\('(\{.*?\})'\)")
DP_OLD = re.compile(r"_\('data\.([^.']+)\.([^.']+)\.([A-Za-z0-9_]+)")


def is_pill(value):
    return isinstance(value, str) and ("_dp(" in value or "_('data." in value)


def source(value):
    if value is None or value == '':
        return 'blank'
    if isinstance(value, str) and value.startswith('='):
        return 'formula'
    if is_pill(value):
        return 'datapill'
    return 'static'


def walk(step, path, out):
    out.append((path, step))
    for i, child in enumerate(step.get('block') or []):
        walk(child, path + '.' + str(i), out)


def strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            for s in strings(v):
                yield s
    elif isinstance(node, list):
        for v in node:
            for s in strings(v):
                yield s


def pill_reads(tree, provider):
    """{step 'as': set of top-level output fields read anywhere in the recipe}."""
    reads = {}
    for text in strings(tree):
        for m in DP_NEW.finditer(text):
            try:
                pill = json.loads(m.group(1))
            except ValueError:
                continue
            path = pill.get('path') or []
            if pill.get('provider') == provider and path and isinstance(path[0], str):
                reads.setdefault(pill.get('line'), set()).add(path[0])
        for m in DP_OLD.finditer(text):
            if m.group(1) == provider:
                reads.setdefault(m.group(2), set()).add(m.group(3))
    return reads


def main(input):
    provider = (input.get('provider') or '').strip()
    if not provider:
        raise ValueError('provider is required: the connector provider key in this workspace')
    tree = json.loads(input['code'])

    steps = []
    walk(tree, '0', steps)
    reads = pill_reads(tree, provider)

    rows = []
    for path, step in steps:
        if step.get('provider') != provider:
            continue
        inp = step.get('input') or {}
        action = step.get('name') or ''
        token = inp.get('target_api_token')
        mode = inp.get('deployment_mode')
        gate_reads = sorted(f for f in reads.get(step.get('as'), set()) if f in GATES)
        rows.append({
            'step_path': path,
            'keyword': step.get('keyword') or ('trigger' if path == '0' else 'action'),
            'action': action,
            'step_title': step.get('title') or '',
            'target_kind': '' if inp.get('target_kind') is None else str(inp.get('target_kind')),
            'runtime_target': 'yes' if token not in (None, '') else 'no',
            'mode_source': source(mode) if action in MODE_ACTIONS else '',
            'mode_value': mode if action in MODE_ACTIONS and source(mode) == 'static' else '',
            'gate_reads': ','.join(gate_reads),
        })

    return {'rows': rows, 'step_count': len(rows), 'pill_steps_seen': len(reads)}
