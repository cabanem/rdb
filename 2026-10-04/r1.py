# One row lands in exactly one bucket. Buckets are what Invitations._formatSummary (lib_sdc) renders.
#   invited            transitioned, primary sent, every secondary sent (or none)
#   partial            transitioned, primary sent, at least one secondary not sent
#   already_invited    primary already invited
#   assignee_failed    primary invite failed
#   skipped_state      INV-01 reason not_pending
#   skipped_no_primary INV-01 reason no_supplier_users | primary_count_invalid
#   skipped_excluded   left out by the request's exclude list (INV-01 never called)
#   system_errored     INV-01 threw, request_not_found, template_path_missing,
#                      transition_refused:*, or an unrecognised outcome

REASON_BUCKETS = {
    "not_pending":           ("skipped_state",      "Request is not pending."),
    "no_supplier_users":     ("skipped_no_primary", "No supplier users on this request."),
    "primary_count_invalid": ("skipped_no_primary", "Request must have exactly one primary contact."),
    "request_not_found":     ("system_errored",     "Supplier request not found."),
    "template_path_missing": ("system_errored",     "No template path on this request."),
}

def to_bool(v):
    return v is True or str(v).strip().lower() in ("true", "1", "yes")

def main(input):
    rows     = input.get("results")  or []
    excluded = input.get("excluded") or []
    summary  = {k: 0 for k in ("total", "invited", "partial", "already_invited", "assignee_failed",
                               "skipped_excluded", "skipped_no_primary", "skipped_state", "system_errored")}
    out = []

    for r in rows:
        err    = str(r.get("error") or "").strip()
        reason = str(r.get("reason") or "").strip()
        disp   = str(r.get("assignee_disposition") or "").strip().lower()
        secs   = r.get("secondary_dispositions") or []
        transitioned = to_bool(r.get("transitioned"))
        sec_failed = [s.get("secondary_user_email") or "?" for s in secs
                      if str(s.get("disposition") or "").strip().lower() != "sent"]

        if err:
            bucket, message = "system_errored", err
        elif reason in REASON_BUCKETS:
            bucket, message = REASON_BUCKETS[reason]
        elif reason.startswith("transition_refused"):
            bucket  = "system_errored"
            message = "Invited, but the state transition was refused (" + reason.split(":", 1)[1].strip() + ")."
        elif disp == "already_invited":
            bucket, message = "already_invited", "Primary contact was already invited."
        elif disp == "failed":
            bucket, message = "assignee_failed", "Invitation to the primary contact failed."
        elif disp == "sent" and transitioned:
            if sec_failed:
                bucket  = "partial"
                message = "Primary invited; secondary contact(s) not sent: " + ", ".join(sec_failed)
            else:
                bucket  = "invited"
                message = "Invited" + (" (+%d secondary)" % len(secs) if secs else "") + "."
        else:
            bucket  = "system_errored"
            message = "Unrecognised outcome (transitioned=%s, disposition=%r, reason=%r)." % (transitioned, disp, reason)

        summary[bucket] += 1
        summary["total"] += 1
        out.append({
            "supplier_request_id":   r.get("supplier_request_id") or "",
            "supplier_name":         r.get("supplier_name") or "",
            "assignee":              r.get("assignee_email") or "",
            "status":                bucket,
            "message":               message,
            "transitioned":          transitioned,
            "assignee_disposition":  disp,
            "secondary_dispositions": secs,
        })

    for e in excluded:
        summary["skipped_excluded"] += 1
        summary["total"] += 1
        out.append({
            "supplier_request_id":   e.get("supplier_request_id") or "",
            "supplier_name":         e.get("supplier_name") or "",
            "assignee":              e.get("assignee_email") or "",
            "status":                "skipped_excluded",
            "message":               "Excluded by the request.",
            "transitioned":          False,
            "assignee_disposition":  "",
            "secondary_dispositions": [],
        })

    return {"summary": summary, "results": out}
