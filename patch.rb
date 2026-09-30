# ============================================================================
# Patch: authorize_connections — one paced writer for connection shells
# Against: Workato Developer API connector (dev_api.rb) as pasted 30 Sep 2026
#
# Why: every Connections endpoint other than List is quota'd at 1 request per
# second. A recipe foreach over Update connection, or two writes in adjacent
# steps, puts two PUTs inside one second and 429s; a whole-action retry reruns
# inside the same second and 429s again. The fix is the recipes pattern: a long
# action that does one write per invocation with a gap between, and a gap
# after the last write before it returns.
#
# Five edits:
#   A. methods            — add connection_credential after google_service_account_input
#   B. pick_lists         — add credential_sources
#   C. actions            — add authorize_connections; delete authorize_google_connections
#                           once POOL-12 no longer references it
#   D. actions            — update_connection: fix the hint example, drop the 429 retry;
#                           disconnect_connection, delete_connection: drop the 429 retry
#   E. triggers           — new_build_completed: `listing` is undefined (NameError on poll)
# ============================================================================


# ---------------------------------------------------------------------------
# A. methods — add after google_service_account_input
# ---------------------------------------------------------------------------

    # ── connection_credential ─────────────────────────────────
    # The `input` object a connection write sends. Built fresh on every invocation
    # of a long action and never placed in `continue`, so a private key is not
    # persisted between invocations.
    connection_credential: lambda do |connection, input|
      if input['credential_source'] == 'input_json'
        error('Connection parameters (JSON) are required when Credential source is Connection parameters.') if input['input_json'].blank?
        parsed = parse_json(input['input_json'])
        error('Connection parameters must be a JSON object.') unless parsed.is_a?(::Hash)
        parsed
      else
        call('google_service_account_input', connection)
      end
    end,


# ---------------------------------------------------------------------------
# B. pick_lists — add
# ---------------------------------------------------------------------------

    credential_sources: lambda do
      [
        ['Google service account (stored on this connection)', 'google_service_account'],
        ['Connection parameters (JSON)', 'input_json']
      ]
    end,


# ---------------------------------------------------------------------------
# C. actions — add (place where authorize_google_connections is now)
# ---------------------------------------------------------------------------

    # Authorize connections (long action)
    authorize_connections: {
      title: 'Authorize connections',
      subtitle: 'Fill connection shells with credentials, paced to the Connections quota',
      batch: true,
      help: lambda do
        { body: 'Authenticates a set of connections in the target — the shells an import created — with one credential: ' \
                'the Google service account stored on this connection, or a JSON object of connection parameters you ' \
                'supply (a custom connector\'s connection fields, an API token, ...). Select the set by Applications ' \
                '(provider values, e.g. google_drive) or by Connection IDs (a list pill from List connections › pending — ' \
                'use this for custom connectors, whose provider key differs per workspace). Idempotent: connections ' \
                'already authorized are skipped unless Re-authorize is Yes. This is a long action because every ' \
                'Connections write shares a quota of one request per second: it writes one connection per invocation ' \
                'with a two-second gap, and pauses once more after the last write, so the step after this one cannot ' \
                'collide with it. The set is listed again at the end, so authorized and all_ok are what the API ' \
                'reports, not what was sent. A connection the API rejects lands in failed with the message and the run ' \
                'carries on. No retries on this action. Enable data masking on the step when supplying parameters.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Folder ID', optional: true, type: :integer,
            hint: 'Limit to connections in this folder (the imported project). Blank = the whole workspace.' },
          { name: 'applications', optional: true,
            hint: 'Comma-separated provider values to authorize, e.g. google_drive,google_sheets. Provide this or ' \
                  'Connection IDs. Not usable for custom connectors — their provider key is minted per workspace.' },
          { name: 'connection_ids', label: 'Connection IDs', optional: true,
            hint: 'A JSON array of connection IDs, e.g. [1117422] — map a list pill with the <b>.pluck(:id).to_json</b> ' \
                  'formula. Comma-separated also works. Provide this or Applications.' },
          { name: 'credential_source', label: 'Credential source', control_type: 'select', pick_list: 'credential_sources',
            toggle_hint: 'Use datapill', optional: false, default: 'google_service_account',
            hint: 'Google service account: the email and key stored on this connection; nothing sensitive appears in ' \
                  'job data. Connection parameters: the JSON below is sent as the API input object.' },
          { name: 'input_json', label: 'Connection parameters (JSON)', optional: true,
            ngIf: 'input.credential_source == "input_json"',
            hint: 'A JSON object of provider-specific connection parameters, sent to every selected connection. ' \
                  'Passes through the job as a step input — enable data masking on the step.' },
          { name: 'reauthorize', label: 'Re-authorize', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Yes: push the credential even to connections already authorized (e.g. after a key rotation). Defaults to No.',
            toggle_hint: 'Select from the list',
            toggle_field: {
              name: 'reauthorize', label: 'Re-authorize', type: :boolean, control_type: 'text',
              default: 'false', optional: true, toggle_hint: 'Map from input',
              hint: 'Yes: push the credential even to connections already authorized. Defaults to No.'
            } }
        ]
      end,

      execute: lambda do |connection, input, _eis, _eos, continue|
        continue = continue || {}
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        # Pacing. Connections writes are quota'd at 1/s; one write per invocation
        # with a gap between, and one more gap after the last write. max_steps
        # bounds the run — 100 connections, or a long stretch of 429s.
        gap       = 2
        max_steps = 100

        list_params = {}
        list_params['folder_id'] = input['folder_id'] if input['folder_id'].present?

        # Recomputed every invocation; never stored in continue.
        credential = call('connection_credential', connection, input)

        if continue['phase'].blank?
          # ── First invocation: list, select, split ─────────
          listing = get("#{dc}/connections", list_params)
                      .headers(headers)
                      .after_error_response(/.*/) do |_c, b, _h, m|
                        error("List connections failed: #{m} — #{b}")
                      end
          conns = call('list_body', listing).map { |c| call('connection_summary', c) }

          ids  = call('id_list', input['connection_ids'])
          apps = call('csv_list', input['applications'])

          matched = if ids.present?
                      conns.select { |c| ids.include?(c['id'].to_s) }
                    elsif apps.present?
                      conns.select { |c| apps.include?(c['application']) }
                    else
                      error('Provide Connection IDs or Applications.')
                    end

          skipped = input['reauthorize'].is_true? ? [] : matched.select { |c| c['authorized'] }
          queue   = matched - skipped
          done    = skipped.map { |c| c.merge('outcome' => 'skipped') }
          step    = 1
          matched_count = matched.length
        else
          # ── Reinvocation: resume ──────────────────────────
          queue         = continue['queue'] || []
          done          = continue['done']  || []
          step          = continue['step'].to_i
          matched_count = continue['matched_count'].to_i
        end

        if continue['phase'] != 'finalize' && queue.present?
          # ── Write one connection ──────────────────────────
          c            = queue.first
          rate_limited = false

          begin
            # A 429 sets the flag from inside the handler; anything else raises
            # and is recorded below. The block's return value is not relied on.
            updated = put("#{dc}/connections/#{c['id']}")
                        .headers(headers)
                        .payload({ 'input' => credential })
                        .after_error_response(/.*/) do |code, b, _h, m|
                          if code.to_i == 429
                            rate_limited = true
                          else
                            error("Update connection #{c['id']} failed: #{m} — #{b}")
                          end
                        end
            body = call('resolve_response', updated)

            unless rate_limited
              done << call('connection_summary', body || {}).merge('id' => c['id'], 'outcome' => 'authorized')
              queue = queue.drop(1)
            end
          rescue StandardError => e
            done << c.merge('outcome' => 'failed', 'error' => e.message)
            queue = queue.drop(1)
          end

          if step >= max_steps
            error("Authorize connections stopped after #{max_steps} invocations with #{queue.length} connections left. " \
                  'Rerun for the remainder.')
          end

          # Always pause after a write: the next PUT, or the closing re-list and
          # whatever the recipe does next, must not land inside this write's second.
          reinvoke_after(
            seconds: rate_limited ? 5 : gap,
            continue: {
              'phase'         => (queue.present? ? 'write' : 'finalize'),
              'queue'         => queue,
              'done'          => done,
              'step'          => step + 1,
              'matched_count' => matched_count
            }
          )
        else
          # ── Finalize: re-list so authorized is what the API reports now ──
          listing = get("#{dc}/connections", list_params)
                      .headers(headers)
                      .after_error_response(/.*/) do |_c, b, _h, m|
                        error("List connections failed: #{m} — #{b}")
                      end
          by_id = call('list_body', listing)
                    .map { |c| call('connection_summary', c) }
                    .each_with_object({}) { |c, h| h[c['id'].to_s] = c }

          results = done.map do |r|
            current = by_id[r['id'].to_s]
            if current
              current.merge('outcome' => r['outcome'], 'error' => r['error']).compact
            else
              r                                   # not in the listing any more; keep what we have
            end
          end

          failed = results.select { |r| r['outcome'] == 'failed' || (r['outcome'] == 'authorized' && !r['authorized']) }

          {
            'workato_environment' => env['name'],
            'matched_count'       => matched_count,
            'authorized_count'    => results.count { |r| r['outcome'] == 'authorized' && r['authorized'] },
            'skipped_count'       => results.count { |r| r['outcome'] == 'skipped' },
            'failed_count'        => failed.length,
            'invocations'         => step,
            'all_ok'              => failed.empty?,
            'failed'              => failed,
            'results'             => results
          }
        end
      end,

      output_fields: lambda do |object_definitions|
        result_fields = object_definitions['connection_obj'] + [
          { name: 'outcome', hint: 'authorized | skipped | failed' },
          { name: 'error' }
        ]

        [
          { name: 'workato_environment' },
          { name: 'matched_count', type: :integer, hint: 'Connections the selection matched.' },
          { name: 'authorized_count', type: :integer, hint: 'Connections now reporting authorization_status = success.' },
          { name: 'skipped_count', type: :integer, hint: 'Already authorized; left alone.' },
          { name: 'failed_count', type: :integer },
          { name: 'invocations', type: :integer, hint: 'How many times the action ran; there is a two-second gap between each.' },
          { name: 'all_ok', type: :boolean,
            hint: 'True when no selected connection failed and every one written now reports success. The readiness gate ' \
                  'for this set.' },
          { name: 'failed', type: :array, of: :object, properties: result_fields },
          { name: 'results', type: :array, of: :object, properties: result_fields }
        ]
      end
    },


# ---------------------------------------------------------------------------
# D. actions — small edits
# ---------------------------------------------------------------------------

# D1. update_connection — replace the input_json hint (the example still says service_email):

          { name: 'input_json', label: 'Connection parameters (JSON)', optional: true,
            hint: 'A JSON object of provider-specific connection parameters, sent as the API input object. ' \
                  'Example for a native Google Drive service account: ' \
                  '{"authentication_type":"service_auth","service_auth":"...@....iam.gserviceaccount.com","private_key":"..."}. ' \
                  'For several connections use Authorize connections, which paces writes to the 1/s quota.' },

# D2. update_connection, disconnect_connection, delete_connection — delete these three
#     lines from each. A rerun of a single write inside the same second is the
#     failure, not the recovery; the recipe orders writes, the long action paces them.

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3


# ---------------------------------------------------------------------------
# E. triggers.new_build_completed — bug: `listing` is not defined in poll.
#    Replace
#        body    = call('resolve_response', listing)
#        items   = Array(body.is_a?(::Hash) ? body['items'] : body)
#    with:
# ---------------------------------------------------------------------------

        items = call('list_body', response)
