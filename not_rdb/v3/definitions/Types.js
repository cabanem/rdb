/**
 * @file definitions/Types.gs
 * Shared type definitions (JSDoc only — no code). The data contracts the other files pass around.
 */

/**
 * Typed view of the Config tab.
 * @typedef {Object} Config
 * @property {string}           folder_id_ingestion   Drop folder for incoming contracts.
 * @property {string}           folder_id_processed   Originals land here after extraction.
 * @property {string}           folder_id_failed      Originals land here on failure.
 * @property {string}           folder_id_pending     Review sheets awaiting approval.
 * @property {string}           folder_id_pushed      Review sheets after a successful push.
 * @property {string}           folder_id_cancelled   Review sheets after a reviewer selects "Cancel?"
 * @property {string}           prompt_template       Extraction prompt prefix.
 * @property {string[]}         output_fields         Fields to extract, in display order (the labels the model and the reviewer see).
 * @property {Object.<string,string>} field_keys      Label -> wire key. From "Label => Salesforce label" lines in output_fields; a bare line's key is toSnake_(label).
 * @property {Object.<string,string>} field_roles     Label -> 'manual' | 'info' for lines carrying that marker; absent = 'extract'. See parseOutputFields_.
 * @property {string[]}         required_fields       output_fields labels the gate must see non-blank before a push (resolved; a `false` boolean counts as present).
 * @property {string[]}         blank_phrases         Extracted values that mean "not found" (e.g. "Not mentioned in the document"); shown, never seeded or sent. Defaults when the key is absent.
 * @property {string}           opportunity_search_label Optional. The output_fields label whose extracted text seeds the opportunity search (e.g. "Account Name"). Blank = no search.
 * @property {string}           contract_owner_email  Optional. Email of the Salesforce user who owns contracts this tool creates; sent as fields.owner_email. Blank = opportunity owner.
 * @property {string}           system_instruction    Optional system instruction.
 * @property {string}           project_id            GCP project for Vertex.
 * @property {string}           location              Vertex location ('global' default).
 * @property {string}           vertex_service_account Optional. Service account the runner impersonates for Vertex calls; blank = the runner itself.
 * @property {string}           model                 Model id (gemini-2.5-pro default).
 * @property {number|undefined} temperature           Sampling temperature, if set.
 * @property {number|undefined} max_tokens            Max output tokens, if set.
 * @property {boolean}          grounding             Attach Google Search grounding.
 * @property {boolean}          grounding_debug       Dump grounding metadata keys.
 * @property {string}           workato_webhook_url   Push target.
 * @property {string}           workato_schema_url    Field-schema endpoint (GET), without the query string. See Schema.gs.
 * @property {string}           workato_search_url    Optional. Opportunity-search endpoint (GET), without the query string. Blank = the Opportunity row is paste-only.
 * @property {string}           chat_webhook_url      Optional Google Chat webhook.
 * @property {string[]}         upload_allowed_emails Lower-cased emails allowed to upload from the dashboard; [] = anyone who can open it.
 * @property {string[]}         config_allowed_emails Lower-cased emails allowed to edit Config from the dashboard; [] = the deployer only.
 * @property {string}           guide_url             Optional. Where the user guide lives; shown as a "Guide" link in the dashboard header when set.
 * @property {string}           picker_url            Optional. /exec URL of the DrivePicker helper web app. Present = "Add from Drive" on.
 * @property {string}           support_contact       Optional. Who the dashboard tells people to ask for access or help.
 */

/**
 * A Gemini `contents[].parts[]` entry: either {text} or {inlineData:{...}}.
 * @typedef {Object} ContentPart
 */

/**
 * The model call behind the pipeline, as one method. pipeline/Extract.gs talks to this shape and nothing else;
 * adapters/Vertex.gs supplies the real one (vertexExtractor_), tests supply a fake, and a service-account-backed
 * call later is another implementation of the same shape.
 * @typedef {Object} Extractor
 * @property {function(Config, string, ContentPart[]): GeminiResult} extract  Prompt + content parts in, GeminiResult out; throws on any non-text outcome.
 */

/**
 * Structured result of one Gemini call.
 * @typedef {Object} GeminiResult
 * @property {string} text    Concatenated text from the first candidate.
 * @property {string} sources Grounding sources, "title — uri" per line; '' if none.
 * @property {string} debug   Grounding metadata key dump when debug is on; '' otherwise.
 */

/**
 * Reference to a freshly created review Sheet.
 * @typedef {Object} ReviewSheetRef
 * @property {string} id            Spreadsheet id.
 * @property {string} url           Spreadsheet url.
 * @property {string} correlationId Idempotency key minted for this contract.
 */

/**
 * Read-back of a review Sheet's approval state and values.
 * @typedef {Object} Approval
 * @property {boolean} approved      Whether the "Approved?" box is ticked.
 * @property {boolean} cancelled     Whether the "Cancel?" box is ticked.
 * @property {string}  correlationId Idempotency key for the push.
 * @property {string}  fileId        Source Drive file id.
 * @property {string}  fileName      Source Drive file name.
 * @property {string}  model         Model used at extraction.
 * @property {string}  extractedAt   ISO timestamp of extraction.
 * @property {string}  status        Status cell: 'Pending Review' | 'Pushed' | 'Error'.
 * @property {string}  lastError     Last Error cell; '' if the sheet has never errored.
 * @property {Object.<string,string>} fields    Human-approved values (pushed).
 * @property {Object.<string,string>} extracted Original extracted values (audit).
 */
