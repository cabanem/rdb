# ============================================================================
# Patch: ensure_custom_connector — install golden's custom connectors in a target
# Against: Workato Developer API connector (dev_api.rb) as pasted 30 Sep 2026
#
# Two insertions:
#   A. methods:  append after `fetch_api_endpoints` (add a comma after its `end`)
#   B. actions:  append after `delete_api_client` (add a comma after its closing `}`)
# No changes to connection, object_definitions, triggers or pick_lists.
# ============================================================================


# ---------------------------------------------------------------------------
# A. methods — append after fetch_api_endpoints
# ---------------------------------------------------------------------------

    # ── Custom connectors ─────────────────────────────────────
    # GET /custom_connectors/search?title= is a partial, case-sensitive match on the
    # connector's *title*; the API's `name` is the provider key each workspace mints
    # for itself, never the same in two workspaces. Search and code wrap in
    # { data: ... }, create / update / release return the record bare —
    # platform_result covers both. The whole resource is quota'd at 1 request/s.

    # ── custom_connector_summary ──────────────────────────────
    # `current`: the released version is the latest one — nothing left to release.
    custom_connector_summary: lambda do |c|
      latest   = c['latest_version']
      released = c['latest_released_version']
      {
        'id'                      => c['id'],
        'title'                   => c['title'],
        'provider'                => c['name'],
        'latest_version'          => latest,
        'latest_released_version' => released,
        'current'                 => released.present? && released.to_i == latest.to_i
      }.compact
    end,

    # ── find_custom_connector ─────────────────────────────────
    # Exact-title match on the search result. nil when absent; error when the title
    # is ambiguous — an installer must never pick one of two.
    find_custom_connector: lambda do |dc, headers, title, env_name|
      response = get("#{dc}/custom_connectors/search", { 'title' => title })
                   .headers(headers)
                   .after_error_response(/.*/) do |_c, b, _h, m|
                     error("Search connector failed in #{env_name}: #{m} — #{b}")
                   end

      body    = call('resolve_response', response)
      matches = Array(call('platform_result', body)).select { |c| c['title'] == title }

      if matches.length > 1
        error("Connector '#{title}' is ambiguous in #{env_name}: " \
              "#{matches.length} connectors carry that exact title.")
      end

      matches.empty? ? nil : call('custom_connector_summary', matches.first)
    end,

    # ── get_custom_connector_code ─────────────────────────────
    get_custom_connector_code: lambda do |dc, headers, id, env_name|
      response = get("#{dc}/custom_connectors/#{id}/code")
                   .headers(headers)
                   .after_error_response(/.*/) do |_c, b, _h, m|
                     error("Get connector code failed in #{env_name}: #{m} — #{b}")
                   end

      body = call('platform_result', call('resolve_response', response)) || {}
      code = body.is_a?(::Hash) ? body['code'] : nil
      error("Connector #{id} returned no code from #{env_name}.") if code.blank?
      code
    end,

    # ── write_custom_connector ────────────────────────────────
    # POST to create (no id) or PUT to replace the code (id). Either way the target
    # gets a new, unreleased version; the returned summary carries its number.
    write_custom_connector: lambda do |args|
      dc       = args['dc']
      headers  = args['headers']
      env_name = args['env_name']
      payload  = { 'title' => args['title'], 'code' => args['code'], 'note' => args['note'] }.compact

      response = if args['id'].blank?
                   post("#{dc}/custom_connectors")
                     .headers(headers)
                     .payload(payload)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Create connector failed in #{env_name}: #{m} — #{b}")
                     end
                 else
                   put("#{dc}/custom_connectors/#{args['id']}")
                     .headers(headers)
                     .payload(payload)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Update connector failed in #{env_name}: #{m} — #{b}")
                     end
                 end

      body = call('platform_result', call('resolve_response', response)) || {}
      call('custom_connector_summary', body)
    end,

    # ── release_custom_connector ──────────────────────────────
    # Releases the latest version. The API answers 400 when that version is already
    # released; that is the state the caller wants, so it is a no-op, not a failure.
    # Returns true when this call released something.
    release_custom_connector: lambda do |dc, headers, id, env_name|
      already = false

      response = post("#{dc}/custom_connectors/#{id}/release")
                   .headers(headers)
                   .after_error_response(/.*/) do |code, b, _h, m|
                     if code.to_i == 400 && b.to_s =~ /already/i
                       already = true
                     else
                       error("Release connector failed in #{env_name}: #{m} — #{b}")
                     end
                   end
      call('resolve_response', response)

      !already
    end


# ---------------------------------------------------------------------------
# B. actions — append after delete_api_client
# ---------------------------------------------------------------------------

    # Ensure custom connector
    ensure_custom_connector: {
      title: 'Ensure custom connector',
      subtitle: 'Copy a connector from the source environment into a target and release it',
      help: lambda do
        { body: 'Reads the connector\'s current code from the source environment, creates or updates a connector ' \
                'of the same title in the target, and releases it when the target\'s latest version is not yet ' \
                'released. Idempotent: rerunning pushes whatever the source has now, and with Skip if current a ' \
                'no-change rerun writes nothing and releases nothing. RLCM will not import a package whose custom ' \
                'connectors are missing from the target, so run this for every custom_adapter in the manifest ' \
                'before Deploy package. The target resolves as in Deploy package: a Target API token wins, then ' \
                'Target environment, else the next environment by level. Four to seven requests per call against ' \
                'a quota of one per second; a 429 reruns the action, which is safe because every step finds before ' \
                'it writes (with Skip if current = No, a rerun after a successful update cuts one extra, identical ' \
                'version). Enable data masking on the step when passing a Target API token.' }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'source_environment', control_type: 'select', pick_list: 'environments', toggle_hint: 'Use datapill',
            optional: false, hint: 'The environment the connector code is read from (e.g. DEV).' },
          { name: 'title', label: 'Connector title', optional: false,
            hint: 'The connector\'s title as shown under Tools > Connector SDK — matched exactly in both environments. ' \
                  'Not the provider key, which every workspace mints for itself.' },
          { name: 'target_environment', control_type: 'select', pick_list: 'target_environments',
            pick_list_params: { source_environment: 'source_environment' }, toggle_hint: 'Use datapill', optional: true,
            hint: 'Optional. A registered environment to install into. If blank, the next environment by level — ' \
                  'unless a Target API token is supplied below.' },
          { name: 'target_data_center', label: 'Target data center', control_type: 'select', pick_list: 'data_centers',
            toggle_hint: 'Use datapill', optional: true,
            hint: 'Runtime target: the data center of a workspace not registered on this connection. Requires Target API token.' },
          { name: 'target_api_token', label: 'Target API token', control_type: 'text', optional: true,
            hint: 'Runtime target: API token for that workspace. Overrides Target environment. Passes through the job as a ' \
                  'step input — enable data masking on the step.' },
          { name: 'target_label', label: 'Target label', optional: true,
            hint: 'Runtime target: name stamped on outputs. Defaults to "override".' },
          { name: 'note', label: 'Version note', optional: true,
            hint: 'Optional note stamped on the version this call creates in the target, e.g. the prepare job\'s ' \
                  'correlation ID. Visible in the target\'s connector version history.' },
          { name: 'release', type: :boolean, control_type: 'checkbox', default: 'true', optional: true,
            hint: 'No: create or update without releasing (staging a change). Defaults to Yes.' },
          { name: 'skip_if_current', label: 'Skip if current', type: :boolean, control_type: 'checkbox', default: 'true',
            optional: true,
            hint: 'Yes: fetch the target\'s code and skip the write when it already equals the source\'s, so a ' \
                  'no-change redeploy does not cut a new version. Costs one extra request. Defaults to Yes.' }
        ]
      end,

      execute: lambda do |connection, input|
        src = call('resolve_environment', connection, input['source_environment'])
        tgt = call('resolve_target_env', connection, input)

        if input['target_api_token'].blank? && tgt['name'] == src['name']
          error("Source and target are both #{src['name']}; pick a different target.")
        end

        src_headers = call('get_auth_headers', connection, src)
        src_dc      = call('get_datacenter', connection, src)
        tgt_headers = call('get_auth_headers', connection, tgt)
        tgt_dc      = call('get_datacenter', connection, tgt)

        title = input['title'].to_s.strip
        error('Connector title is required.') if title.blank?

        # nil = a step configured before the field existed; both default to Yes.
        release = input['release'].nil?         || input['release'].is_true?
        skip    = input['skip_if_current'].nil? || input['skip_if_current'].is_true?

        # ── Source: find, then read ───────────────────────
        source = call('find_custom_connector', src_dc, src_headers, title, src['name'])
        error("Connector '#{title}' not found in #{src['name']}.") if source.nil?
        code = call('get_custom_connector_code', src_dc, src_headers, source['id'], src['name'])

        # ── Target: find, then create or update ───────────
        target  = call('find_custom_connector', tgt_dc, tgt_headers, title, tgt['name'])
        created = false
        updated = false

        write_args = {
          'dc'       => tgt_dc,
          'headers'  => tgt_headers,
          'env_name' => tgt['name'],
          'title'    => title,
          'code'     => code,
          'note'     => input['note']
        }

        if target.nil?
          target  = call('write_custom_connector', write_args)
          created = true
        else
          same = skip &&
                 call('get_custom_connector_code', tgt_dc, tgt_headers, target['id'], tgt['name']) == code
          unless same
            target  = call('write_custom_connector', write_args.merge('id' => target['id']))
            updated = true
          end
        end

        # ── Release only when something is unreleased ─────
        # The API answers 400 otherwise; `current` from the search or write result
        # already says whether there is anything to release.
        released = false
        if release && !target['current']
          released = call('release_custom_connector', tgt_dc, tgt_headers, target['id'], tgt['name'])
        end

        # ── Read back: the output is what the API reports, not what was sent ──
        final = call('find_custom_connector', tgt_dc, tgt_headers, title, tgt['name'])
        error("Connector '#{title}' is not in #{tgt['name']} after the write.") if final.nil?

        if release && !final['current']
          error("Connector '#{title}' in #{tgt['name']} is at version #{final['latest_version']} but the released " \
                "version is #{final['latest_released_version'] || 'none'}; recipes cannot use it until it is released.")
        end

        {
          'workato_environment' => tgt['name'],
          'title'               => final['title'],
          'id'                  => final['id'],
          'provider'            => final['provider'],
          'created'             => created,
          'updated'             => updated,
          'released'            => released,
          'released_version'    => final['latest_released_version'],
          'latest_version'      => final['latest_version'],
          'current'             => final['current']
        }.compact
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'title' },
          { name: 'id', type: :integer, hint: 'Connector ID in the target.' },
          { name: 'provider',
            hint: 'The target\'s provider key (the API\'s name field). Differs per workspace; never reference it literally.' },
          { name: 'created', type: :boolean, hint: 'This call created the connector.' },
          { name: 'updated', type: :boolean, hint: 'This call replaced its code.' },
          { name: 'released', type: :boolean, hint: 'This call released a version.' },
          { name: 'released_version', type: :integer,
            hint: 'Version now released in the target, as the API reports it after the write.' },
          { name: 'latest_version', type: :integer },
          { name: 'current', type: :boolean,
            hint: 'True when the released version is the latest one — the readiness gate for recipes.' }
        ]
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    }
