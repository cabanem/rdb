# lib_sdc · 013_Registry.js — forward the analyst on claim

One function changes: `Registry.claim`. The router's claim endpoint now takes two optional fields; the library
sends them only when the caller supplies them, so a routing app that predates this still works.

**Current (as delivered Oct 2026):**
```javascript
Registry.claim = function(settings, args) {
  if (!args || !args.clientName)    throw new Error('Registry.claim: clientName is required.');
  if (!args.spreadsheetId)          throw new Error('Registry.claim: spreadsheetId is required.');
  return Registry._call(settings, 'post', '/workspaces/claim', {
    client_name:    String(args.clientName).trim(),
    spreadsheet_id: String(args.spreadsheetId).trim(),
    workbook_url:   args.workbookUrl || ('https://docs.google.com/spreadsheets/d/' + args.spreadsheetId),
    correlation_id: args.correlationId || Util.newCorrelationId()
  });
};
```

**Replace with:**
```javascript
/**
 * Claim the first available workspace for a config workbook. The router serialises claims (the endpoint recipe
 * runs at concurrency 1), so two analysts claiming at once get two different rows.
 *
 * @param {Object} settings
 * @param {Object} args  { clientName, spreadsheetId, workbookUrl, [correlationId], [analystEmail], [analystName] }
 *                       analystEmail, when given, has the router invite that user to the claimed workspace as a
 *                       collaborator; the outcome comes back as `invite: {attempted, status, message}`.
 */
Registry.claim = function(settings, args) {
  if (!args || !args.clientName)    throw new Error('Registry.claim: clientName is required.');
  if (!args.spreadsheetId)          throw new Error('Registry.claim: spreadsheetId is required.');
  var body = {
    client_name:    String(args.clientName).trim(),
    spreadsheet_id: String(args.spreadsheetId).trim(),
    workbook_url:   args.workbookUrl || ('https://docs.google.com/spreadsheets/d/' + args.spreadsheetId),
    correlation_id: args.correlationId || Util.newCorrelationId()
  };
  if (args.analystEmail) body.analyst_email = String(args.analystEmail).trim();
  if (args.analystName)  body.analyst_name  = String(args.analystName).trim();
  return Registry._call(settings, 'post', '/workspaces/claim', body);
};
```

Also add to the file header's endpoint list:
```
 *   POST /workspaces/claim   {client_name, spreadsheet_id, workbook_url, correlation_id, [analyst_email], [analyst_name]}
 *                            → 200 {workspace_key, state, …, invite: {attempted, status, message}}
```

No schema or payload version change: nothing in a config workbook moves. Bump LIBRARY (1.10.0 → 1.10.1) if you
version on every library edit; the routing app runs in developmentMode so HEAD is enough for it.
