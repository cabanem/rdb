# Schema refresh from the dashboard — the edits outside Schema.gs

`getConfigForEdit()` already returns `schema` — that is `CONFIG_SCHEMA`, the form definition the drawer is built
from, and `buildForm` iterates `meta.schema`. The Salesforce field schema therefore travels under a different key,
`fieldSchema`, and nothing in the drawer's existing code is touched by it. Everything below follows the drawer's
own conventions: primitives across the wire, writes gated by `config_allowed_emails`, `[data-key]` controls are the
form and nothing else is.

## 1. ConfigEditor.gs — `getConfigForEdit()`

Add one key to the returned object:

```js
    models: readModelIds_(sheet.getParent()),
    fieldSchema: schemaStatus_()       // {fetchedAt, fields, unmatchedConfig, unmatchedSf}; see Schema.gs
  };
```

and extend the function's `@return` JSDoc with `fieldSchema`. That is the only change to ConfigEditor.gs:
`refreshSchemaFromDashboard()` lives in Schema.gs and reuses `assertConfigEditAllowed_`, `viewerEmail_` and
`currentConfigAllowList_` from here without modifying them.

## 2. Dashboard.html — one more block in the drawer

**a. Render it.** In `buildForm(meta)`, after the `groups.forEach(...)` loop closes and before
`drawerBody.innerHTML = html;`:

```js
        html += '<fieldset><legend>Salesforce field schema</legend>' +
          '<div class="help" id="schemaStatus">' + fieldSchemaText(meta.fieldSchema) + '</div>' +
          '<div style="margin-top:8px">' +
          '<button class="refresh" id="schemaRefresh" type="button"' + (readOnly ? ' disabled' : '') + '>Refresh now</button>' +
          '</div></fieldset>';
```

The button has no `data-key`, so `collectDraft()` never sends it, and a click is not an `input` event, so it never
marks the form dirty.

**b. Attach the handler.** Right after `drawerBody.innerHTML = html;`:

```js
        var schemaBtn = $('schemaRefresh');
        if (schemaBtn) schemaBtn.addEventListener('click', refreshFieldSchema);
```

**c. Two functions**, placed next to `submitSettings`. `stamp` and `ago` are the page's existing formatters;
`esc`, `setStatus` and `plural` already exist.

```js
      function fieldSchemaText(s) {
        if (!s || !s.fetchedAt) {
          return 'Not cached yet. Picklist values, field lengths and types are enforced only once this has been refreshed.';
        }
        var t = 'Cached ' + esc(stamp(s.fetchedAt)) + ' (' + esc(ago(s.fetchedAt, Date.now()) || '') + ') · ' +
          plural(s.fields, 'field', 'fields') + '.';
        if (s.unmatchedConfig && s.unmatchedConfig.length) {
          t += ' <b>' + plural(s.unmatchedConfig.length, 'label', 'labels') + ' not in Salesforce:</b> ' +
            esc(s.unmatchedConfig.join(', ')) + '. Rename these under "Fields to extract" to match the Salesforce label.';
        }
        return t;
      }

      function refreshFieldSchema() {
        var btn = $('schemaRefresh'), out = $('schemaStatus');
        if (!btn || btn.disabled || !settings.meta) return;
        btn.disabled = true;
        out.textContent = 'Refreshing from Salesforce…';
        google.script.run
          .withSuccessHandler(function (r) {
            btn.disabled = false;
            settings.meta.fieldSchema = r;
            out.innerHTML = fieldSchemaText(r);
            setStatus(r.message, r.unmatchedConfig && r.unmatchedConfig.length ? 'bad' : 'good');
          })
          .withFailureHandler(function (err) {
            btn.disabled = false;
            out.innerHTML = fieldSchemaText(settings.meta.fieldSchema);
            setStatus('Schema refresh failed: ' + (err && err.message ? err.message : String(err)) +
              ' The previous cache is unchanged.', 'bad');
          })
          .refreshSchemaFromDashboard();
      }
```

The `readOnly` disable on the button is cosmetic; `refreshSchemaFromDashboard()` enforces the same
`config_allowed_emails` rule server-side whatever the page sends.

## 3. ContractIntake.gs — `setupTriggers()`

```js
  ScriptApp.newTrigger('processApprovals').timeBased().everyMinutes(POLL_MINUTES).create();
  setupSchemaTrigger();
```

`setupSchemaTrigger()` is idempotent (it removes prior `refreshSchema` triggers first), so `setupTriggers()` stays
safe to re-run.

## 4. Tests.gs

Paste the contents of `Schema.tests.gs` in and add `registerSchemaTests_(t);` to `runTests()`.

## Deploy

`clasp push`, then a **new web-app version** (Dashboard.html changed). Run `setupTriggers()` once. Open Settings on
the dashboard and press Refresh now; the status line and rows 2–3 of `_schema` show which Config labels do not join.
