/**
 * @file 004_Customer.gs (SDC library)
 * Typed reads of 1_customer, driven by the CUSTOMER_FIELDS registry.
 *
 * Read contract per field (schema 1.4+):
 *   1. Named range (rangeName)      — primary; survives label edits and row/column insertion, copies with the file.
 *   2. Label search + self-heal     — fallback; on a hit, the value cell is derived from valueOffset and the named range is recreated on the spot.
 *   3. Neither found                — reported on `unresolved`; the caller decides whether that's fatal (Preflight does, for required fields).
 *
 * The heal-on-read mutation is deliberate and consistent with the library's existing self-healing sheets (Log.ensureSchema, ValidationReport) and with
 * PK stamping during validate.
 *
 * Broken named ranges (e.g. the anchored row was deleted, leaving a #REF!) behave inconsistently across runtimes — getRangeByName may return null or
 * return a range that throws on read. Both are handled: any throw on the named-range path drops to the label fallback.
 *
 * Public:
 *   Customer.read(ss, config)                  -> { values, raw, healed, unresolved }
 *   Customer.readOne(ss, config, key)          -> coerced value (null-ish when absent)
 *   Customer.ensureNamedRanges(ss, sheetName?) -> { created, existing, unresolved }
 *   Customer.parseIntList(raw)                 -> { ints, invalid }
 *   Customer.serialize(ss, config)             -> { values, unresolved }   JSON-safe view for config export
 */

var Customer = {};

/**
 * Read every registered 1_customer field.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      config - From Config.build (for config.sheets.customer).
 * @returns {{
 *   values:     Object,             // key -> coerced value (see _coerce)
 *   raw:        Object,             // key -> raw cell value (blank-vs-invalid checks)
 *   healed:     string[],           // rangeNames recreated from a label hit this read
 *   unresolved: Array<{key: string, rangeName: string, label: string}>
 * }}
 */
Customer.read = function (ss, config) {
  if (!ss) throw new Error('Customer.read: ss is required.');
  if (!config) throw new Error('Customer.read: config is required.');

  var sheet = ss.getSheetByName(config.sheets.customer);
  if (!sheet) {
    throw new Error('Customer.read: sheet "' + config.sheets.customer + '" not found.');
  }

  var tz = ss.getSpreadsheetTimeZone();
  var out = { values: {}, raw: {}, healed: [], unresolved: [] };

  CUSTOMER_FIELDS.forEach(function (def) {
    var r = Customer._readField(ss, sheet, def);

    if (!r.found) {
      out.unresolved.push({ key: def.key, rangeName: def.rangeName, label: def.label });
      out.raw[def.key] = null;
      out.values[def.key] = Customer._coerce(null, def.type, tz);
      return;
    }
    if (r.healed) out.healed.push(def.rangeName);

    out.raw[def.key] = r.raw;
    out.values[def.key] = Customer._coerce(r.raw, def.type, tz);
  });

  if (out.healed.length > 0) {
    console.log('Customer.read: recreated named range(s) from label fallback: ' +
      out.healed.join(', '));
  }
  return out;
};

/**
 * Read a single registered field. Used where reading the full set is overkill (Variant._readVariantCount).
 * Missing sheet or unresolved field coerces from null (e.g. int -> null; caller maps to its own default).
 */
Customer.readOne = function (ss, config, key) {
  var def = null;
  for (var i = 0; i < CUSTOMER_FIELDS.length; i++) {
    if (CUSTOMER_FIELDS[i].key === key) { def = CUSTOMER_FIELDS[i]; break; }
  }
  if (!def) throw new Error('Customer.readOne: unknown field key "' + key + '".');

  var tz = ss.getSpreadsheetTimeZone();
  var sheet = ss.getSheetByName(config.sheets.customer);
  if (!sheet) return Customer._coerce(null, def.type, tz);

  var r = Customer._readField(ss, sheet, def);
  return Customer._coerce(r.found ? r.raw : null, def.type, tz);
};

/**
 * Idempotently create named ranges for every registered field whose label can be located. Called by the 1.3 -> 1.4
 * migration; safe to also call best-effort from the container's onOpen shim.
 *
 * @param {Spreadsheet} ss
 * @param {string}      [customerSheetName] - Defaults to DEFAULT_SHEETS.customer. Pass config.sheets.customer for workbooks that override it.
 * @returns {{created: string[], existing: string[], unresolved: Array<{rangeName: string, label: string}>}}
 */
Customer.ensureNamedRanges = function (ss, customerSheetName) {
  var name = customerSheetName || DEFAULT_SHEETS.customer;
  var sheet = ss.getSheetByName(name);
  var out = { created: [], existing: [], unresolved: [] };

  if (!sheet) {
    CUSTOMER_FIELDS.forEach(function (def) {
      out.unresolved.push({ rangeName: def.rangeName, label: def.label });
    });
    return out;
  }

  CUSTOMER_FIELDS.forEach(function (def) {
    try {
      var existing = ss.getRangeByName(def.rangeName);
      if (existing) {
        existing.getValue();   // probe: a broken (#REF!) range throws here
        out.existing.push(def.rangeName);
        return;
      }
    } catch (e) { /* broken -> recreate below */ }

    var cell = Util.findLabelCell(sheet, def.label);
    if (!cell) {
      out.unresolved.push({ rangeName: def.rangeName, label: def.label });
      return;
    }
    ss.setNamedRange(def.rangeName, sheet.getRange(cell.row, cell.col + def.valueOffset));
    out.created.push(def.rangeName);
  });

  return out;
};

/**
 * Parse a comma/semicolon/whitespace-separated list of positive integers.
 * "7, 14, 21" -> { ints: [7,14,21], invalid: [] }
 * "7, soon"   -> { ints: [7],       invalid: ['soon'] }
 * Order is preserved as entered; the wire contract carries analyst order.
 */
Customer.parseIntList = function (raw) {
  var tokens = String(raw === null || raw === undefined ? '' : raw)
    .split(/[,;\s]+/)
    .map(function (t) { return t.trim(); })
    .filter(function (t) { return t !== ''; });

  var ints = [], invalid = [];
  tokens.forEach(function (t) {
    var n = Number(t);
    if (Number.isInteger(n) && n > 0) ints.push(n);
    else invalid.push(t);
  });
  return { ints: ints, invalid: invalid };
};

/**
 * JSON-safe view of 1_customer for the config export (Drive.serializeConfig -> `_customer`).
 * Same named-range read as Customer.read, so the export and the provision webhook cannot disagree.
 * Keys are the CUSTOMER_FIELDS registry keys. Types on the wire:
 *   string  -> string | null      int -> number | null      bool -> boolean
 *   date    -> 'yyyy-MM-dd' | null
 *   intList -> number[]  (valid tokens only; Preflight rejects invalid tokens before a provision,
 *              and the validate path does not gate on customer data)
 * Never throws on unresolved fields: they are listed on `unresolved` and null on `values`, so the
 * connector can report them rather than the export failing.
 */
Customer.serialize = function (ss, config) {
  var read = Customer.read(ss, config);
  var values = {};
  CUSTOMER_FIELDS.forEach(function (def) {
    var v = read.values[def.key];
    values[def.key] = (def.type === 'intList') ? (v ? v.ints : []) : (v === undefined ? null : v);
  });
  return {
    values: values,
    unresolved: read.unresolved.map(function (u) { return u.key; })
  };
};

// --- Private ---------------------------------------------------------

/**
 * Resolve and read one field's value cell: named range first, label
 * fallback second (healing the named range on a hit).
 *
 * @returns {{found: boolean, raw: *, healed: boolean}}
 */
Customer._readField = function (ss, sheet, def) {
  // 1. Named range — the primary contract.
  try {
    var r = ss.getRangeByName(def.rangeName);
    if (r) return { found: true, raw: r.getValue(), healed: false };
  } catch (e) {
    console.warn('Named range "' + def.rangeName + '" unreadable (' + e.message +
      '); falling back to label search.');
  }

  // 2. Label fallback + heal.
  var cell = Util.findLabelCell(sheet, def.label);
  if (!cell) return { found: false, raw: null, healed: false };

  var valueRange = sheet.getRange(cell.row, cell.col + def.valueOffset);
  var healed = false;
  try {
    ss.setNamedRange(def.rangeName, valueRange);
    healed = true;
  } catch (e) {
    // Read still succeeds this run; the heal just didn't stick.
    console.warn('Could not recreate named range "' + def.rangeName + '": ' + e.message);
  }
  return { found: true, raw: valueRange.getValue(), healed: healed };
};

/**
 * Normalize a raw cell value at the boundary. Downstream code never sees
 * a Date object, an untrimmed string, or an unparsed list.
 */
Customer._coerce = function (raw, type, tz) {
  switch (type) {
    case 'string': {
      var s = String(raw === null || raw === undefined ? '' : raw).trim();
      return s === '' ? null : s;
    }
    case 'int': {
      var t = String(raw === null || raw === undefined ? '' : raw).trim();
      if (t === '') return null;
      var n = parseInt(t, 10);
      return isNaN(n) ? null : n;
    }
    case 'intList': return Customer.parseIntList(raw);
    case 'date': return Util.toIsoDate(raw, tz);
    case 'bool': return Util.coerceTruthy(raw);
    default: return raw;
  }
};
