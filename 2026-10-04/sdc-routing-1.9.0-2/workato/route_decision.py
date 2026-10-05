import json

# Route decision — Route recipe, step 2.
#
# Inputs (code_input):
#   rows        list  RTR_Pool records where spreadsheet_id = trigger.spreadsheet_id (limit 1), mapped to
#                     {workspace_key, state, api_base_url, client_name, closed_at}
#   path        str   trigger.path
#   is_initial  str   trigger.is_initial (Workato passes booleans as strings into Python)
#
# Outputs:
#   action           "forward" | "reject"
#   activate         bool   forward only: flip the row to active after a 200
#   target_key       str    RTR_Secrets lookup key
#   target_base_url  str    client collection base URL (no trailing slash)
#   http_status      int    reject only
#   body_json        str    reject only: {"error_details": {...}}
#
# Route table: which registry states may call which path. /provision also needs is_initial to agree with the
# state (bound+initial = first provision; active+update = re-version). Nothing here knows about Google Sheets.

ROUTES = {
    "/provision":             {"bound", "active"},
    "/validate_configuration": {"bound", "active"},
    "/preview-template_file":  {"bound", "active"},
    "/invitations":           {"active"},
    "/portal-invite":         {"active"},
}


def pick(row, name):
    """Read a column whether the name was left alone or suffixed (name, name1, name_1)."""
    if not row:
        return None
    if name in row:
        return row[name]
    for key, value in row.items():
        if key.startswith(name) and key[len(name):].lstrip("_").isdigit():
            return value
    return None


def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("true", "1", "yes", "y", "t")


def main(input):
    rows = input.get("rows") or []
    row = rows[0] if rows else {}
    state = str(pick(row, "state") or "").strip().lower()
    path = str(input.get("path") or "").strip()
    is_initial = to_bool(input.get("is_initial"))
    client = pick(row, "client_name") or "its client"

    def reject(http_status, code, message):
        body = {"error_details": {"code": code, "error_message": message, "errored_action": "router"}}
        return {"action": "reject", "activate": False, "target_key": "", "target_base_url": "",
                "http_status": http_status, "body_json": json.dumps(body)}

    def forward(activate):
        base = str(pick(row, "api_base_url") or "").strip().rstrip("/")
        key = str(pick(row, "workspace_key") or "").strip()
        if not base or not key:
            return reject(500, "REGISTRY_INCOMPLETE",
                          "Workspace {} is bound but has no api_base_url; register it from the routing workbook.".format(key or "?"))
        return {"action": "forward", "activate": activate, "target_key": key, "target_base_url": base,
                "http_status": 0, "body_json": ""}

    if path not in ROUTES:
        return reject(404, "UNKNOWN_PATH", "The router has no route for '{}'.".format(path))

    if not rows:
        return reject(404, "NOT_REGISTERED",
                      "This workbook is not bound to a workspace. Claim a workspace for it from the routing workbook first.")

    if state == "inactive":
        return reject(409, "WORKSPACE_CLOSED",
                      "This workbook belongs to a closed engagement ({}, closed {}). To start a new engagement, "
                      "claim a fresh workspace from the routing workbook.".format(client, pick(row, "closed_at") or "date unknown"))

    if state not in ("bound", "active"):
        return reject(409, "WORKSPACE_NOT_READY",
                      "Workspace for this workbook is in state '{}'; it is not ready to receive calls.".format(state))

    if state not in ROUTES[path]:
        return reject(404, "NOT_PROVISIONED",
                      "This workbook has not been provisioned yet. Run Start supplier data collection first.")

    if path == "/provision":
        if state == "bound" and not is_initial:
            return reject(404, "NOT_PROVISIONED",
                          "This workbook has not been provisioned yet. Run Start supplier data collection first.")
        if state == "active" and is_initial:
            return reject(409, "ALREADY_PROVISIONED",
                          "This workbook is already live for {}. Use Update configuration to send changes.".format(client))
        return forward(state == "bound")

    return forward(False)
