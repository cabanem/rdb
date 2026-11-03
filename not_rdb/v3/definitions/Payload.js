/**
 * @file definitions/Payload.gs
 * The wire vocabulary and the push payload. toSnake_/wireKey_ are the ONE key shared by the payload, the `_schema`
 * cache and the Workato recipe; buildPayload_ is the shape that leaves for Workato. All pure.
 */

// --- WIRE KEYS -----------------------------------------------------------------------------------
/**
 * Deterministic label --> API key: lowercase, runs of non-alphanumerics -> '_', edges trimmed.
 *
 * @param {string} label
 * @return {string}
 * @private
 */
function toSnake_(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Wire key for a Config label: the alias target's snake form when the output_fields line had "=> Salesforce label",
 * else toSnake_(label). This is the one vocabulary shared by the payload, the `_schema` cache and the recipe.
 * @param {Config} cfg
 * @param {string} label
 * @return {string}
 * @private
 */
function wireKey_(cfg, label) {
  return (cfg && cfg.field_keys && cfg.field_keys[label]) || toSnake_(label);
}

/**
 * Rekey a label-keyed object (as readApproval_ returns it) to wire keys.
 * @param {Object.<string,*>} obj
 * @param {Config} cfg
 * @return {Object.<string,*>}
 * @private
 */
function rekey_(obj, cfg) {
  const out = {};
  Object.keys(obj || {}).forEach(function (label) { out[wireKey_(cfg, label)] = obj[label]; });
  return out;
}

// --- PAYLOAD -------------------------------------------------------------------------------------
/**
 * Build the Workato payload. `fields` is the approved truth — typed by the gate when `typedFields` is given, else
 * the raw Approved cells — minus any `[info]` rows, which are for the reviewer's eyes only; `provenance.extracted`
 * is the pre-review snapshot, always raw and complete, so the correction delta stays auditable downstream.
 * `owner_email` is a business rule of the intake (Config), not a review decision, so it joins `fields` here and
 * the recipe resolves it to a User Id; blank Config = absent from the payload = the recipe falls back to the
 * opportunity's owner.
 * @param {Approval} approval
 * @param {Config} cfg Supplies field_keys, field_roles and contract_owner_email.
 * @param {Object.<string,*>} [typedFields] Label -> typed value from validateApproval_(). Omit for dry runs/tests.
 * @return {Object}
 * @private
 */
function buildPayload_(approval, cfg, typedFields) {
  const fields = rekey_(withoutRole_(typedFields || approval.fields, cfg, 'info'), cfg);
  if (cfg && cfg.contract_owner_email) fields.owner_email = cfg.contract_owner_email;
  return {
    correlation_id: approval.correlationId,
    source: {
      file_id: approval.fileId,
      file_name: approval.fileName,
      drive_url: driveUrl_(approval.fileId)
    },
    extracted_at: approval.extractedAt,
    model: approval.model,
    fields: fields,                                            // <- pushed to Salesforce
    provenance: { extracted: rekey_(approval.extracted, cfg) } // <- original, for audit
  };
}

/**
 * A copy of a label-keyed object without the labels that carry `role`. Pure.
 * @param {Object.<string,*>} obj
 * @param {Config} cfg
 * @param {string} role
 * @return {Object.<string,*>}
 * @private
 */
function withoutRole_(obj, cfg, role) {
  const out = {};
  Object.keys(obj || {}).forEach(function (label) {
    if (fieldRole_(cfg, label) !== role) out[label] = obj[label];
  });
  return out;
}

/**
 * Canonical Drive viewer link for the file ID.
 */
function driveUrl_(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view';
}
