# Build steps: GAS pass and follow-ups (after the customer logo link refresh)

Nov 16, 2026 · @Emily Cabaniss

## How to use this

Seven steps finish the GAS pass from the parking list, the Workato edits it depends on, and the portal link. This page gives each at file and field level, in build order.

The aim: an analyst goes from "Start a new implementation" to a collecting workspace with the client's logo, and every screen on the way is accurate. The sidebar lists only real, outstanding steps. The pool shows a name or a state. A released workspace carries nothing to the next client.

| Order | What | Where | Safe to stop after? |
| --- | --- | --- | --- |
| 1 | Template hand fixes | master\_config | Yes |
| 2 | Accept `customer_logo_mime_type` | Golden: API-00, PRV-01 | Yes; nothing sends it yet |
| 3 | Portal link on the pool row | BASE: RTR\_Pool, POOL-API-04, POOL-API-02 | Yes; the app ignores it until step 6 |
| 4 | lib\_sdc 1.17.0 | Seven library files | Yes; a shim that is not updated keeps working |
| 5 | Guide sidebar | Shim: `guide.js`, `guide_sidebar.html` | Yes |
| 6 | Pool section and portal link | Router app: `Index.html`, `030_Registry.js` | Yes |
| 7 | Release runs the reset | BASE: POOL-API-06, then three wording edits in the router app | The pass is complete |

Steps 2 and 3 come before the library on purpose. Both consumers reference lib\_sdc in development mode, so a library push is live at once. Workato must accept the new key before the library sends it.

Versions after the pass: library 1.17.0, payload 12.3, schema 1.13 (unchanged, so no migration).

Reading conventions:

- **Line numbers** are those of the archives you shared: `lib_sdc-9`, `app_sdc-shim-5`, `app_sdc-router-9`. If a line has moved, find it by the quoted text.
- **Checked.** I applied every GAS edit below to copies of the three archives. All 49 scripts parse. Small tests of the new functions pass, including the roster count run on the header rows of your master\_config. I can send the edited files.
- **Not seen.** I do not have the API-00, POOL-API-02, POOL-API-04 or POOL-API-06 exports. Their edits are named by field, not by step number.

## Decisions taken

These were settled on 16 Nov 2026. The steps below rest on them.

| Topic | Decision | Effect on the build |
| --- | --- | --- |
| Logo file name | Variant A: FileStorage keeps the fixed name `logo` | PRV-01 needs no Drive MIME step. The MIME type still travels: GAS decides it, the API and PRV-01 accept it |
| Roster headers | Taken from the shared master\_config | 2\_suppliers `Supplier name` joins to 3\_users `Supplier name`; a user counts when `Supplier user email` is filled |
| Pool section | Remove the full error text only | The connections badge stays. The "!" tooltip in the Implementations table stays |
| Release | Every release runs the reset, from `bound` too | Success returns the row to `available`. Anything else lands on `needs_clean`, a state that already exists |
| Workbooks in use | None | No repair code for old copies. The shim ships through the template only |
| Portal link | New, from a stakeholder | One link per workspace, shown in Implementations and in Technical details |

Two assumptions I made where the answer was open. Say if either is wrong.

- **Release waits for the reset.** The endpoint answers after API-05 returns. If resets often run past the endpoint's timeout, switch release to the job pattern Clean already uses.
- **The portal link shows for any linked implementation.** That is Ready to start, Collecting and Closed. The alternative is Collecting and Closed only.

## 1. master\_config template

Row 10 is already correct in the workbook you shared, so the parked item needs no code and no migration change.

| Check | What the shared workbook shows |
| --- | --- |
| `1_customer!C10` | "Customer logo" |
| `1_customer!D10` note | The 1.13 help text |
| `cfg_customer_logo_url` | Points at `1_customer!D10` |
| `meta.schema_version` | `1.13`, stored as text |
| `_script_logs`, 16 Nov 01:23 | "Migrated v1.12 -> v1.13: Renamed label at C10" |

The 1.12 to 1.13 step works: it ran on this file and renamed the label. A workbook that shows the old label under a 1.13 stamp was copied before that run, or had its version typed in. Nothing is live, so nothing needs repair.

- [x] Confirm this file is the one `_settings` > `template.workbookId` points at. If it is, close the parked item.

One thing explains how a copy can be stamped ahead of its content. The log has no 1.11 to 1.12 line, which suggests 1.12 was typed in by hand. `Migrations.run` starts from the stamped version, so a hand stamp skips every step below it. Let the migration set the version.

### Hand fixes found while reading the file

None of these is on the parking list. Each is a template edit, not code.

- [ ] **Blank `router.apiToken` and `webhook.apiPlatformToken`.** Both are filled in the template, so every copy inherits them and every analyst with the workbook can read them. `Config.build` also reads the workbook's `router.apiToken` before the library's Script Property. If you rotate the token and leave the old one here, new workbooks send the old token and get a 401. With both blank, `SDC_ROUTER_API_TOKEN` on lib\_sdc serves every workbook and the next rotation is one place.
- [ ] **`sheets.xlsxProtectionPwd`.** None of the three GAS projects reads it. If nothing else does, delete the row instead of rotating it.
- [ ] **Delete the `webhook.*Url` rows.** The library stopped reading them at 1.9. Three of them are webhook addresses that work as credentials.
- [ ] **Clear the three `meta.pack_*` rows.** `4_fields` and `5_lookups` are empty, but the stamps still name the VNDLY pack from 29 Oct. The router's Check panel will report that pack on every new workbook.
- [ ] **Delete eight broken named ranges.** `cfg_has_seed_data`, `cfg_kickoff_email_body`, `cfg_supplier_instructions` and the five `cfg_seed_data_*` ranges all read `#REF!`. Nothing reads them any more.
- [ ] **Reword the note on `D7`.** It asks for "a single integer". The library accepts a list such as "7, 14, 21".

## 2. Golden: accept the MIME type (API-00, PRV-01)

The library will send one new key on `/provision`. Golden must accept it first.

| Key | Type | Values |
| --- | --- | --- |
| `customer_logo_mime_type` | string | `image/png`, `image/jpeg`, or empty for a legacy public URL or no logo |

Do these while PRV-01 is open for the logo block (section 6 of the logo build steps). They then ride the golden export you already owe.

1. **API-00, request body.** Add `customer_logo_mime_type`, type string, next to `customer_logo_drive_url`.
2. **API-00, the step that calls PRV-01.** Map the new pill to the PRV-01 input of the same name. Find the step by where `customer_logo_file_id` is mapped.
3. **PRV-01, step 0, input schema.** Add `customer_logo_mime_type`, type string, after `customer_logo_drive_url`.

Nothing else in PRV-01 changes. Under variant A, UTL-13 keeps `file_name` = `logo`, so no step reads the value yet. It is there so PRV-01 can check or name the file later without a Drive step.

- [ ] Check how API-00 reads `payload_version`. The library moves from 12.2 to 12.3. A recipe that compares the whole string must compare the major version instead.
- [ ] After step 4: provision a workbook with an uploaded PNG. The PRV-01 job input shows `customer_logo_mime_type` = `image/png`.

## 3. BASE: the portal link (RTR\_Pool, POOL-API-04, POOL-API-02)

The portal belongs to the workspace, not to the engagement, so its address goes on the pool row. The app already reads `link_to_workspace` from that row the same way (`030_Registry.js` line 221).

1. **RTR\_Pool.** Add a column `link_to_portal`, type text, next to `link_to_workspace`.
2. **Fill it by hand,** once per workspace, at the runbook step where `link_to_workspace` is set. The value is the address of that workspace's Workflow apps portal.
3. **POOL-API-04 (list).** Add `link_to_portal` to each workspace in the response and map the column. Find `link_to_workspace` in the recipe and add the new field beside it.
4. **POOL-API-02 (status).** The same, so the Status panel shows it.

The address survives a reset, which is why a hand-filled column is enough. Two checks keep it that way:

- [ ] POOL-API-06 step 7 (release) and POOL-API-07 (close) do not clear `link_to_portal`.
- [ ] After a Clean and redeploy, open the link once. If the portal address changed, update the row.

## 4. lib\_sdc 1.17.0

Seven edits. Each one adds something. None changes what an existing caller gets, so a workbook whose shim is not yet updated keeps working.

| Edit | File | Change |
| --- | --- | --- |
| A | `015_Logo.js` | `Logo.resolve` decides the type from the bytes and returns it |
| B | `004_Customer.js` | New `Customer.missingRequired` |
| C | `005_Preflight.js` | 5b calls it; 5d carries the type |
| D | `005_Provision.js` | Passes the type to the payload |
| E | `003_Payload.js` | New key `customer_logo_mime_type` |
| F | `013_Registry.js` | Release waits the way Provision does |
| G | `008_Version.js` | Library 1.17.0, payload 12.3 |

### A. `015_Logo.js`, `Logo.resolve` (lines 234 to 276)

Today an upload is checked by its bytes (`validateFile`). A Drive link pasted into the cell is checked by the type Drive reports (line 253), which is whatever the uploader's browser declared. After this edit both paths use `sniffMime`.

1. Line 238: add `mimeType: null` to `out`.
2. Replace lines 253 to 263, from `var mime = String(file.getMimeType()` down to `if (Logo._readableBy(...)) return out;`, with the block below.
3. Line 268: build the copy from the sniffed type. Line 275: return the type.

```js
  // Size first: the type check below downloads the file.
  var size = Number(file.getSize() || 0);
  if (size > Logo.MAX_BYTES) {
    throw new Error(where + ' points at "' + file.getName() + '", which is ' + Logo._mb(size) + ' MB; the limit for a logo is ' +
      Logo._mb(Logo.MAX_BYTES) + ' MB. Upload a smaller export of the image.');
  }
  var declared = String(file.getMimeType() || '');
  var bytes;
  try { bytes = file.getBlob().getBytes(); }
  catch (e) {
    throw new Error(where + ' points at "' + file.getName() + '", which could not be read to check its type: ' + e.message);
  }
  var mime = Logo.sniffMime(bytes);
  if (!mime || !Logo.ALLOWED[mime]) {
    throw new Error(where + ' points at "' + file.getName() + '", which is not a ' + Logo._allowedList() + ' image' +
      (declared ? ' (Drive reports ' + declared + ')' : '') + '. Upload the logo as PNG or JPEG.');
  }
  out.mimeType = mime;
  if (Logo._readableBy(file, integrationEmail)) return out;
```

```js
    // line 268
    landed = Logo._land(ss, config, Utilities.newBlob(bytes, mime, file.getName()), integrationEmail);
  // line 275
  return { kind: 'drive', fileId: landed.fileId, driveUrl: landed.driveUrl, legacyUrl: null, mimeType: mime, copied: true };
```

The copy changes because `_land` picks the file extension from the blob's type. With Drive's declared type, a mislabelled file would be saved as `.bin`.

The cost is one Drive read of at most 2 MB on each Validate, Preview, Start and Update.

### B. `004_Customer.js`, new function above `Customer.ensureNamedRanges` (line 101)

This is the loop from Preflight 5b, moved. The sidebar and Preflight then share one rule for "blank". It takes the result of `Customer.read` and checks presence only. Shape checks stay in Preflight.

```js
Customer.missingRequired = function (read) {
  var out = [];
  CUSTOMER_FIELDS.forEach(function (def) {
    if (!def.required) return;
    var v = read.values[def.key];
    var blank;
    switch (def.type) {
      case 'intList':
        blank = v.ints.length === 0 && v.invalid.length === 0;
        break;
      case 'date': {
        var rd = read.raw[def.key];
        blank = rd === null || rd === undefined || rd === '';
        break;
      }
      case 'bool':
        blank = false;  // booleans coerce blank -> false; never "missing"
        break;
      default:
        blank = v === null;
    }
    if (blank) out.push({ key: def.key, friendly: def.friendly, type: def.type });
  });
  return out;
};
```

### C. `005_Preflight.js`

Replace the 5b loop (lines 126 to 147) with one line:

```js
    var missingFields = Customer.missingRequired(read).map(function (m) { return m.friendly; });
```

After line 227 (`customerData.customerLogoUrl = logo.legacyUrl;`), add:

```js
    customerData.customerLogoMimeType = logo.mimeType;
```

### D. `005_Provision.js`, the `Payload.provision` call

After line 145 (`customerLogoUrl: pf.customerLogoUrl,`), add:

```js
      customerLogoMimeType: pf.customerLogoMimeType,
```

### E. `003_Payload.js`, `Payload.provision`

After line 77 (`customer_logo_url: ...`), add:

```js
    customer_logo_mime_type: args.customerLogoMimeType || '',
```

### F. `013_Registry.js`

After step 7 a release waits for the reset, so it passes the same option Provision passes. `_call` (line 285) gains a fifth argument. Before step 7 this changes nothing: release answers at once.

```js
Registry.RELEASE_TIMEOUT_SECONDS = 250;

Registry.release = function(settings, workspaceKey, correlationId) {
  return Registry._call(settings, 'post', '/workspaces/' + Registry._key(workspaceKey) + '/release',
    { correlation_id: correlationId || Util.newCorrelationId() },
    { fetchTimeoutSeconds: Registry.RELEASE_TIMEOUT_SECONDS });
};

Registry._call = function(settings, method, path, body, opts) {
  // ... unchanged down to line 299, then:
  if (opts && opts.fetchTimeoutSeconds) options.fetchTimeoutSeconds = opts.fetchTimeoutSeconds;
  var resp   = UrlFetchApp.fetch(url, options);
```

### G. `008_Version.js`

Set `LIBRARY: '1.17.0'` and `PAYLOAD: '12.3'`. `SCHEMA` stays `'1.13'`. Add a 12.3 entry to the payload history.

### Left alone on purpose

- **`Customer.serialize`.** The `_customer` block is inside `config_fingerprint` (`001_Drive.js` lines 90 to 93). A new key there would make every workbook's next Update cut a new version. The type travels on the payload only.
- **The schema and the migration chain.** The workbook's shape does not change.

### Test

- [ ] Upload a PNG in the sidebar and run Start. The PRV-01 job input shows `image/png`.
- [ ] Put a JPEG named `x.png` on Drive, paste its link into `D10`, run Validate. No logo error appears, and Start sends `image/jpeg`.
- [ ] Paste the link of a WebP file renamed to `.png`. Validate fails with "is not a PNG or JPEG image".
- [ ] Clear the customer name and run Start. The "Required customer fields missing" message is the same as before.

## 5. Shim: guide sidebar

Five parking items land in two files, `guide.js` and `guide_sidebar.html`.

| Parking item | Edits |
| --- | --- |
| Remove "Set up field IDs" | C2 |
| "Describe the client" ticks from the cells | A, C1 |
| "Send supplier invitations" only with a roster | A, B, C3 |
| "Update configuration" as a separate kind of action | C4, D, E |
| "Request portal access" as a separate kind of action | C4, D, E |

### A. `guide.js`, `guideFacts_` (lines 247 to 258)

Replace from `var config = safe_(...)` down to `f.provisioned = isProvisioned_(f);`. One `Customer.read` now feeds the client name, the logo and the completeness check. Two facts are new: `customerMissing` and `invitable`.

```js
  var config = safe_(function () { return SDC.Config.build(ss); }, null);
  var read = config ? safe_(function () { return SDC.Customer.read(ss, config); }, null) : null;
  f.workspaceKey = config ? String(config.router.workspaceKey || '').trim() : '';
  f.linked       = !!(f.workspaceKey && config.router.baseUrl);
  f.clientName   = read ? String(read.values.clientName || '').trim() : '';
  f.canLink      = typeof SDC.Registry.link === 'function';
  // Required fields still blank. The logo is left out: it has its own step. Null = cannot tell.
  f.customerMissing = read && typeof SDC.Customer.missingRequired === 'function' ? safe_(function () {
    return SDC.Customer.missingRequired(read)
      .filter(function (m) { return m.type !== 'driveFile'; })
      .map(function (m) { return m.friendly; });
  }, null) : null;
  f.logo = read ? safe_(function () {
    var p = SDC.Logo.parseCell(read.values.customerLogo);
    return { kind: p.kind, fileId: p.fileId, driveUrl: p.driveUrl, legacyUrl: p.legacyUrl };
  }, null) : null;
  // Suppliers on 2_suppliers that have a user on 3_users. Null = cannot tell.
  f.invitable = safe_(function () { return suppliersWithUsers_(ss, config); }, null);
  f.provisioned = isProvisioned_(f);
  return f;
```

### B. `guide.js`, new roster helpers below `guideFacts_`

The headers come from your master\_config.

| Tab | Header row | Columns used |
| --- | --- | --- |
| `2_suppliers` | 8 | C `Supplier name`, D `Template variation` |
| `3_users` | 8 | C `Supplier user email`, D `Supplier name` |

Two things in the template shape the code:

- **"Supplier name" also sits on row 6,** the definition row. `findHeaderRow_` returns the first row that holds every header asked for, so each lookup asks for two headers.
- **The `Number of users` column is not usable.** Its formula is in row 9 only and counts `3_users!D9:D11`. The count is done in script.

```js
var GUIDE_ROSTER = {
  suppliers: { name: 'Supplier name', anchor: 'Template variation' },
  users:     { email: 'Supplier user email', supplier: 'Supplier name' }
};

/** Suppliers with at least one user. A user counts when its row has an email and its supplier is on 2_suppliers. */
function suppliersWithUsers_(ss, config) {
  var tabs = config ? config.sheets : { suppliers: '2_suppliers', users: '3_users' };
  var S = GUIDE_ROSTER.suppliers, U = GUIDE_ROSTER.users;
  var sup = headedRows_(ss, tabs.suppliers, [S.name, S.anchor]);
  var usr = headedRows_(ss, tabs.users, [U.email, U.supplier]);
  if (!sup || !usr) return null;

  var hasUser = {};
  usr.rows.forEach(function (r) {
    var supplier = trim_(r[usr.col[U.supplier]]).toLowerCase();
    if (supplier && trim_(r[usr.col[U.email]]) !== '') hasUser[supplier] = true;
  });
  var counted = {}, n = 0;
  sup.rows.forEach(function (r) {
    var name = trim_(r[sup.col[S.name]]).toLowerCase();
    if (name && hasUser[name] && !counted[name]) { counted[name] = true; n++; }
  });
  return n;
}

/** Rows below a tab's header row, plus header text -> column index. null when the tab or the headers are missing. */
function headedRows_(ss, sheetName, requiredHeaders) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  var hr = findHeaderRow_(values, requiredHeaders);
  if (hr === -1) return null;
  return { col: headerMap_(values[hr]), rows: values.slice(hr + 1) };
}
```

`findHeaderRow_`, `headerMap_` and `trim_` already exist in `migration.js`. The match on supplier name is trimmed and ignores case.

### C. `guide.js`, `GUIDE_STEPS`

**C1. "Describe the client" (lines 326 to 330).** In shim-5 this step is hard-coded `manual`, so it never ticks. Replace it. A workbook created from the router app arrives filled in, so it opens ticked.

```js
  function (f) {
    var missing = f.customerMissing;
    if (missing === null) {                         // cannot tell: say what to do, tick nothing
      return step_('customer', 'Prepare', 'Describe the client',
        'Fill in 1_customer, including the supplier manager email. Start checks it before anything is sent.',
        'manual', [], ['1_customer']);
    }
    return step_('customer', 'Prepare', 'Describe the client',
      missing.length ? 'Still needed in 1_customer: ' + missing.join(', ') + '.'
                     : 'Every required field in 1_customer is filled in.',
      missing.length ? 'todo' : 'done', [], ['1_customer']);
  },
```

**C2. "Set up field IDs" (lines 373 to 380).** Delete the whole entry. Validate, Preview, Start, Update and a pack apply all stamp missing IDs through `PrimaryKey.backfill`. Keep the menu item under "Setup and advanced tools".

**C3. "Send supplier invitations" (line 437).** Add the first line, and move the entry up so it follows "Start".

```js
  function (f) {
    if (f.invitable === 0) return null;             // no supplier has a user yet. null (unknown) still shows
    var m = f.marks['invitations'], done = okMark_(m);
    return step_('invitations', 'Push to Workato', 'Send supplier invitations',
      done ? 'Last batch ' + when_(m) + '.'
           : 'Invites every pending supplier. If you added suppliers or users since the last push, run Update first.',
      done ? 'done' : (f.provisioned ? 'todo' : 'blocked'),
      [act_('Send invitations', 'sendAllInvitations', f.provisioned, f.provisioned, 'invitations')], []);
  },
```

**C4. "Update configuration" and "Request portal access" (lines 428 to 435 and 445 to 451).** Move both to the end of the array and mark them `kind: 'action'`.

```js
  function (f) {
    var m = f.marks['provision:update'];
    return step_('update', 'Any time', 'Update configuration',
      !f.provisioned ? 'Available after Start. Re-sends the configuration when you change it.'
      : okMark_(m)   ? 'Last update ' + when_(m) + '.'
                     : 'Re-sends the configuration after you change it.',
      f.provisioned ? 'action' : 'blocked',
      [act_('Update', 'updateWorkspace', false, f.provisioned, 'update')], [], { kind: 'action' });
  },

  function (f) {
    var m = f.marks['portalInvite'];
    return step_('portal', 'Any time', 'Request portal access',
      okMark_(m) ? 'Requested ' + when_(m) + '.' : 'Gets you (the analyst) into the supplier portal for this application.',
      'action', [act_('Request access', 'requestPortalAccess', false)], [], { kind: 'action' });
  }
```

### D. `guide.js`, `guideStatus` (lines 56 to 92)

Split the list in two. Only the checklist is numbered and can be "Next". The mark map is built from both lists, because the sidebar still polls Update's mark.

```js
  var all = GUIDE_STEPS
    .map(function (def) { return def(facts); })
    .filter(function (s) { return !!s; });
  var steps   = all.filter(function (s) { return s.kind !== 'action'; });
  var actions = all.filter(function (s) { return s.kind === 'action'; });

  // A blocking step (schema migration) greys out everything after it, the any-time actions included.
  var block = function (s) { s.state = 'blocked'; s.actions.forEach(function (a) { a.enabled = false; }); };
  var blocked = false;
  steps.forEach(function (s, i) {
    if (blocked) block(s);
    if (s.blocksRest) blocked = true;
    s.n = i + 1;
  });
  if (blocked) actions.forEach(block);
```

Further down, change `steps.forEach` to `all.forEach` where `marks` is built (line 76), and add `actions: actions` to the returned object.

### E. `guide_sidebar.html`

1. **CSS, after line 37.** An action has no marker column.

   ```css
   .step.plain { grid-template-columns: 1fr; }
   .step.plain .acts { grid-column: 1; }
   ```
2. **`render` (lines 81 to 103).** Move the body of `st.steps.forEach` into a function `draw(out, s, numbered)`. Two lines differ from today: the class gains `plain` when `numbered` is false, and the marker is written only when `numbered` is true. `render` then reads:

   ```js
   function render(st) {
     var out = [], phase = null;
     st.steps.forEach(function (s) {
       if (s.phase !== phase) { phase = s.phase; out.push('<div class="phase">' + esc(phase) + '</div>'); }
       draw(out, s, true);
     });
     if (st.actions && st.actions.length) {
       out.push('<div class="phase">Any time</div>');
       st.actions.forEach(function (s) { draw(out, s, false); });
     }
     $('steps').innerHTML = out.join('');
     // ... the rest of render is unchanged
   ```
3. **Line 108.** The banner no longer mentions invitations: "Nothing pending. Use Update after you change the configuration."

### One limit to know

The invitations step reads the workbook's roster. Workato holds the real one, and the two match only after the last Start or Update. The step's hint says so.

### Test

- [ ] Open a workbook created from the router app. "Describe the client" is ticked.
- [ ] Clear Target VMS and refresh. The step reads "Still needed in 1\_customer: Target VMS." and becomes Next.
- [ ] There is no "Set up field IDs" step. Add a field row and run Validate: its ID is stamped.
- [ ] With an empty roster there is no "Send supplier invitations" step. Add a supplier and a user for it, then refresh: the step appears.
- [ ] "Update configuration" and "Request portal access" sit under "Any time" with no number. Update is greyed before Start.
- [ ] Run Update from the sidebar. The progress window opens, and afterwards the hint reads "Last update ...".

## 6. Router app: pool section and portal link

Two items, two files. Neither depends on step 7.

### A. Pool section (`Index.html`, line 459)

Delete this line from `renderPoolStrip`. It prints `last_error` in full on the card.

```js
             (w.last_error ? '<div class="who bad" title="' + esc(w.last_error) + '">' + esc(w.last_error) + '</div>' : '') +
```

The card then shows the workspace name, the state badge, and one line: the client name, "Ready to link", or the short state. A failed workspace reads "Needs attention". The error text stays on Technical details.

Two things stay as they are, as decided:

- The "N pending" connections badge on the card (line 460).
- The "!" with its tooltip in the Implementations table (line 394).

### B. Portal link

**B1. `030_Registry.js`, `impl_`.** After line 221 (`workspace_url: ...`), add:

```js
      portal_url:      (w && w.link_to_portal) || '',
```

`w` is the pool row, and it exists only once the workbook is linked. That gives "as applicable" for free: a workbook with no workspace has no link.

**B2. `Index.html`, the Implementations table (`renderImplementations`).**

- Line 384: add `<th>Portal</th>` after `<th>Workspace</th>`.
- After line 400, the end of the Workspace cell, add the line below.
- Line 407: change `colspan="7"` to `colspan="8"`.

```js
        '<td>' + (r.portal_url ? ext(r.portal_url, 'Open') : '') + '</td>' +
```

**B3. `Index.html`, the Technical details table (`renderPoolTable`).**

- Line 492: change `'<th>Workbook</th><th></th>'` to `'<th>Workbook</th><th>Portal</th><th></th>'`.
- After line 495, the Workbook cell, add the line below.

```js
      html += '<td>' + (r.link_to_portal ? ext(r.link_to_portal, 'Open') : '') + '</td>';
```

`ext` is the helper the Workbook link already uses. It opens a new tab.

| View | Rows that show the link |
| --- | --- |
| Implementations | Ready to start, Collecting and Closed, when the workspace has an address |
| Technical details | Every pool row with an address, free workspaces included |

### Test

- [ ] A failed workspace card reads "Needs attention" and shows no error text.
- [ ] A workspace waiting on connections still shows "N pending".
- [ ] A linked implementation shows "Open" under Portal, and it opens the portal in a new tab. A "Workbook created" row shows nothing.
- [ ] Technical details shows the link for each workspace whose `link_to_portal` is filled.
- [ ] Before step 3 is done, the column is empty and nothing breaks.

## 7. Release runs the reset

Release calls the target workspace's API-05 every time and waits for the answer. The router is the caller. This closes "Release calls API-05" on the parking list.

### POOL-API-06 Release a workspace (v18)

This is the contract. The step-level edit still needs the POOL-API-06 export.

| State at release | API-05 returns `ok: true` | Anything else: error, `ok: false`, timeout |
| --- | --- | --- |
| `bound` | `available` | `needs_clean`, with the reason in `last_error` |
| `inactive` | `available` | `needs_clean`, with the reason in `last_error` |

1. **Call API-05 before step 7 clears the row.** Reach the target the way `Route` does: its API base URL from RTR\_Pool, its token from RTR\_Secrets.
2. **Clear the binding in both outcomes.** The workbook is unbound either way. Only the state differs.
3. **A timeout is not success.** It lands on `needs_clean`.
4. **Add no state.** `needs_clean` exists, and Clean already takes a workspace from there to `empty`.

Release resets from `bound` too, for one reason. A first Start that fails part-way leaves the row `bound`, because the router writes `active` only after a successful `/provision`. Tables and the logo property may already be written by then. One rule, "every release resets", makes "a reset runs before every re-claim" true.

That is the precondition in section 11 of the logo build steps. Once this step is live, the four claim edits in POOL-API-05 can go ahead, and then `RTR_Pool` > `customer_logo_url` can be deleted.

### What the three claim rollbacks now do

Three places call `Registry.release` seconds after a claim, when writing the binding into the workbook fails.

| Caller | Where |
| --- | --- |
| Menu "Claim workspace..." | `Code.js` line 149 |
| Web app "Link a workspace" | `030_Registry.js` line 149 |
| Sidebar "Link to a workspace" | lib\_sdc `013_Registry.js` line 252 |

Each now runs a reset on a workspace claimed seconds earlier. The reset finds nothing to remove and the row returns to `available`. The rollback is slower. No code changes.

### Router app wording

Push these three only once POOL-API-06 is changed. They describe the new behaviour.

**`Index.html` line 522, `CONFIRM.release`:**

```js
                  release:  'Release this workspace? Its client data is reset (tables, files, users and the logo) and it returns to the pool as available. This can take a few minutes. If the reset does not finish, the workspace shows as “Needs cleaning”.',
```

**`Code.js` lines 172 to 173, the text in `releaseWorkspace`:**

```js
    'Resets the client data in the workspace (tables, files, users, logo) and returns it to the pool: bound or inactive → available.\n' +
    'This can take a few minutes. If the reset does not finish, the row lands on needs_clean (run "Clean workspace…" next).');
```

**`030_Registry.js`, the `catch` in `action` (lines 275 to 278):**

```js
    } catch (e) {
      log('ERROR', op + (dryRun ? ' (dry run)' : '') + ' ' + workspaceKey + ' failed: ' + e.message);
      // An error or a timeout does not say how a release ended: the router finishes on its own.
      if (op === 'release') {
        try { refreshRegistry_(ss, settings); } catch (ignore) {}
        throw new Error(e.message + ' The release may still be running; refresh to see where the workspace ended up.');
      }
      throw e;
    }
```

`ACTIONS_BY_STATE` needs no change. `needs_clean: ['clean']` is already the fallback.

### Test, on TEST

- [ ] Release an `inactive` workspace. The row returns to `available`, the target's tables are empty, and `IMAGE_PUBLIC_URL_CLIENT` equals the default.
- [ ] Release a `bound` workspace that was never started. The row returns to `available`.
- [ ] Break the target's token in RTR\_Secrets and release. The row lands on `needs_clean` with a reason. Restore the token; Clean still works.
- [ ] Claim the released workspace for another workbook and provision it. The portal shows no trace of the previous client.
- [ ] Release from the web app. The confirm text matches the behaviour.

## 8. Roll out and test

Three pushes, in this order. Each reaches a different set of users.

| Push | What it reaches | When |
| --- | --- | --- |
| lib\_sdc | Every workbook and the router app, at once | After steps 2 and 3 |
| Shim | New workbooks only, through the script bound to the template | After the library |
| Router app | The routing workbook and its web app | After step 3. The release wording waits for step 7 |

- **Shim.** Push to the script bound to the template, and to the test-01 workbook if you keep one. Nothing else is live, so no other workbook needs it.
- **Web app.** If analysts use the `/exec` address, update the deployment to a new version after the push. The `/dev` address serves the pushed code directly.

### One run through everything, on TEST

Each section above has its own tests. This run checks that the parts agree.

- [ ] In the web app, start a new implementation with a PNG logo.
- [ ] Open the workbook. "Describe the client" and the logo step are ticked. There is no "Set up field IDs" step and no invitations step.
- [ ] Link, apply a pack, Validate, Start. The PRV-01 job input shows `customer_logo_mime_type` = `image/png`, and the portal shows the logo.
- [ ] Add one supplier and one user for it, then Update. The invitations step appears. Send.
- [ ] In the web app, the row reads Collecting and its Portal link opens the portal.
- [ ] Close, then Release. The row returns to `available`. Claim it for a second workbook: the portal shows the default image and no data.

## 9. Still parked

These stay open after the seven steps. None blocks them.

### Workato

- [ ] **POOL-API-06, step level.** Section 7 gives the contract. The steps need the POOL-API-06 export.
- [ ] **Users the reset removes.** Suppliers only, or supplier-management and implementation-team members too. This decides what API-05 does. It changes nothing in GAS.
- [ ] **Claim edits.** The four POOL-API-05 edits and the `RTR_Pool` > `customer_logo_url` delete, from section 11 of the logo build steps. Unblocked once step 7 is live.

### Operations and decisions

- [ ] **Credentials.** Rotate `router.apiToken`, `webhook.apiPlatformToken` and `sheets.xlsxProtectionPwd`. This is now certain, not conditional: the workbook shared on 16 Nov carries all three. Put the new router token in two places only: `SDC_ROUTER_API_TOKEN` on lib\_sdc, and `_settings` > `router.apiToken` in the routing workbook. Leave the template blank (section 1).
- [ ] **test-01.** By hand: the role, client and token, the connection, the two `IMAGE_PUBLIC_URL_*` properties, and now `link_to_portal` on its pool row.
- [ ] **Default image.** Which stable public image `DEFAULT_CLIENT_LOGO_URL` points at, and who owns it.

### Docs

- [ ] **Handoff and ADR.** Fold these changes into the handoff and set ADR 0001 to Accepted. Record four things: variant A, payload 12.3, the release contract, and the `link_to_portal` column.
- [ ] **The four docs outside the repo.**

### Template, optional

- [ ] **`2_suppliers` > `Number of users`.** The formula is in row 9 only and counts `3_users!D9:D11`. The sidebar no longer depends on it. Fill it down, or remove the column.
