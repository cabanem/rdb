{
  title: "Workato Developer API",

  # --- CONNECTION --------------------------------------------------
  connection: {
    fields: [
      { name: 'workato_environments', type: :array, of: :object, label: 'Workato environments', item_label: 'Environment', list_mode: 'static',
        help: 'Register each Workato workspace you want this connector to manage. Add one row per environment (e.g. DEV, TEST, PROD). ' \
              'The connector uses these entries to route API calls to the correct workspace and to determine the promotion path when ' \
              'deploying packages between environments.',
        properties: [
          { name: 'name', control_type: 'select', optional: false,
            options: [
              %w[DEV DEV],
              %w[TEST TEST],
              %w[PROD PROD]
            ],
            hint: 'A unique label for this environment. Used by all actions to identify which workspace to target. Select each environment only once.' },
          { name: 'data_center', control_type: 'select', optional: false, default: 'https://www.workato.com/api',
            options: [
              ['US', 'https://www.workato.com/api'],
              ['EU', 'https://app.eu.workato.com/api'],
              ['SG', 'https://app.sg.workato.com/api'],
              ['JP', 'https://app.jp.workato.com/api']
            ],
            hint: 'The Workato data center region this workspace is hosted in. Must match the region shown in your workspace URL.' },
          { name: 'is_production', type: :boolean, control_type: 'checkbox', default: 'false',
            hint: 'Mark exactly one environment as production. This flag is used by promotion logic. Only one environment can be marked as production.'
          },
          { name: 'level', type: :integer, control_type: 'select', optional: false, options: (1..10).map { |n| [n.to_s, n] },
            hint: 'Promotion order. Level 1 is the lowest environment (e.g. DEV). Packages promote from lower levels to higher levels. Levels must start at 1 and be ' \
                  'sequential; gaps greater than 1 are not allowed, but duplicates are OK (e.g. 1, 2, 2, 3).' },
          { name: 'api_token', control_type: 'password', optional: false,
            hint: 'Bearer token for this workspace. Generate one from Settings > API Clients in the target workspace.' } ]
      },

      # Google service account used by Authorize Google connections. One principal for the estate;
      # stored encrypted with this connection so the key never transits a recipe input or job history.
      { name: 'google_service_account_email', label: 'Google service account email', optional: true,
        hint: 'Used by Authorize Google connections: the GCP service account that Google Drive / Sheets connections in ' \
              'target workspaces authenticate as. Leave blank if you are not using service-account authorization.' },
      { name: 'google_private_key', label: 'Google service account private key', control_type: 'password', optional: true,
        hint: 'The private_key value from the service account JSON, including the BEGIN/END lines. ' \
              'Stored encrypted with this connection.' }
    ],

    authorization: {
      type: 'custom_auth',

      apply: lambda do |_connection|
        # No-op: auth is applied per-request via get_auth_headers because each environment has its own token.
      end
    },

    base_uri: lambda do |connection|
      # Not used directly (each action resolves its own datacenter). Default to first environment's DC for pick list calls.
      envs = connection['workato_environments']
      envs&.first&.[]('data_center') || 'https://www.workato.com/api'
    end
  },

  test: lambda do |connection|
    envs = connection['workato_environments'] || []

    # Validation rules
    call('connection_validation', envs)

    # Connectivity check
    envs.each do |env|
      me = get(env['data_center'] + '/users/me')
             .headers('Authorization' => "Bearer #{env['api_token']}")
             .after_error_response(/.*/) do |_code, body, _header, message|
               error("Connection test failed for #{env['name']}: #{message} — #{body}")
             end
      # Requests are lazy; force this one so every environment is actually checked.
      me.presence
    end

    true
  end,

  # --- METHODS -----------------------------------------------------
  methods: {

    # ── connection_validation ─────────────────────────────────
    connection_validation: lambda do |envs|
      envs = envs || []

      # Rule: Max 1 production environment
      prod_count = envs.count { |e| e['is_production'].is_true? }
      if prod_count > 1
        error("More than one production environment isn't allowed.")
      end

      # Rule: All environment names must be unique (case-insensitive)
      names = envs.map { |e| (e['name'] || '').strip.downcase }
      if names.length != names.uniq.length
        error('Environment name must be unique.')
      end

      # Rule: No environment may have an empty level
      envs.each do |e|
        if e['level'].blank?
          error('Level cannot be empty.')
        end
      end

      # Rule: Levels must start at 1
      levels = envs.map { |e| e['level'].to_i }.sort
      if levels.present? && levels.first != 1
        error('Starting level is missing.')
      end

      # Rule: Levels must be sequential (gaps > 1 not allowed, duplicates OK)
      if levels.present?
        levels.uniq.sort.each_cons(2) do |a, b|
          if (b - a) > 1
            error('Levels not in allowed sequence. ' \
                  'Eg.:[1,2,3], [1,2,2], [1,1,2]')
          end
        end
      end

      nil
    end,

    # ── resolve_environment ───────────────────────────────────
    # Accepts either a registered environment name (looked up on the connection) or an
    # already-resolved environment Hash (a runtime target built by env_ref). Every
    # auth/datacenter helper goes through here, so the override works estate-wide.
    resolve_environment: lambda do |connection, env_ref|
      if env_ref.is_a?(::Hash)
        env_ref
      else
        envs    = connection['workato_environments'] || []
        # env  = envs.find { |e| e['name'] == env_ref }
        wanted  = env_ref.to_s.strip.downcase
        env     = envs.find { |e| e['name'].to_s.strip.downcase == wanted }

        if env.nil?
          error("Environment '#{env_ref}' not found in connection. " \
                'Check your environment configuration.')
        end

        env
      end
    end,

    # ── runtime_target ────────────────────────────────────────
    # True when the step targets a workspace not registered on this connection.
    # Target (target_kind) decides when set, so a token left behind after
    # switching to a registered target is ignored rather than routed to. A step
    # saved before Target existed has it nil and keeps the old rule: a Target
    # API token means runtime.
    runtime_target: lambda do |input|
      kind = input['target_kind']

      if kind.blank?
        input['target_api_token'].present?
      elsif %w[registered runtime].include?(kind)
        kind == 'runtime'
      else
        error("Target must be registered or runtime, got '#{kind}'.")
      end
    end,

    # ── target_kind_field ─────────────────────────────────────
    # The Target select every environment-scoped action leads with. Defaults to
    # registered: the Release 0 inventory (Oct 2026) found no step using a runtime
    # target. It stays optional, and execute still reads a blank Target with the old
    # rule (a token means runtime), so a step that reaches execute with it blank
    # routes as before.
    target_kind_field: lambda do |registered_hint|
      { name: 'target_kind', label: 'Target', control_type: 'select', pick_list: 'target_kinds',
        toggle_hint: 'Use datapill', optional: true, sticky: true, default: 'registered',
        hint: "Registered environment: #{registered_hint} Another workspace: a workspace not registered on this " \
              'connection — supply its data center and API token.',
        toggle_field: {
          name: 'target_kind', label: 'Target', type: :string, control_type: 'text', optional: true,
          toggle_hint: 'Select from list', hint: 'registered or runtime.'
        } }
    end,

    # ── data_center_options ───────────────────────────────────
    # [label, API base] pairs. Read by the data_centers pick list and by
    # data_center_url. The connection field's options must remain a literal.
    data_center_options: lambda do
      [
        ['US', 'https://www.workato.com/api'],
        ['EU', 'https://app.eu.workato.com/api'],
        ['SG', 'https://app.sg.workato.com/api'],
        ['JP', 'https://app.jp.workato.com/api']
      ]
    end,

    # ── data_center_url ─────────────────────────────────────── 
    # A runtime targer's data center may arrive as the pick list URL or as a
    # region code from a table row (e.g., EU, US, JP). Both must resolve to the
    # API base without a trailing slash.
    data_center_url: lambda do |value|
      v = value.to_s.strip

      if v.start_with?('https://')
        v.sub(%r{/+\z}, '')
      else
        pair = call('data_center_options').find { |label, _url| label == v.upcase }
        error("Unknown data center '#{value}'; use US, EU, SG, JP or the API base URL.") if pair.nil?
        pair.last
      end
    end,

    # ── env_name_toggle ───────────────────────────────────────
    # The text form of an environment select, so a recipe can map the name from
    # a table row. 
    env_name_toggle: lambda do |name, label, optional|
      { name: name, label: label, type: :string, control_type: 'text', optional: optional,
        toggle_hint: 'Select from list', hint: 'A registered environment name exactly as it appears on the connection.' }
    end,

    # ── data_center_toggle ────────────────────────────────────
    # The text form of the target data center selection.
    data_center_toggle: lambda do
      { name: 'target_data_center', label: 'Target data center', type: :string, control_type: 'text',
        optional: true, toggle_hint: 'Select from list',
        hint: 'EU, US, SG, JP, or the API base URL (e.g., https://app.eu.workato.com/api).'}
    end,
    
    # ── env_ref ───────────────────────────────────────────────
    # Resolve the environment an action targets. A runtime target builds an ad-hoc
    # environment (a workspace not registered on this connection, e.g. a client
    # workspace resolved from the registry at runtime); otherwise the registered name.
    env_ref: lambda do |connection, input|
      if call('runtime_target', input)
        if input['target_api_token'].blank?
          error('Target API token is required when Target is Another workspace.')
        end
        if input['target_data_center'].blank?
          error('Target data center is required when a Target API token is supplied.')
        end
        {
          'name'          => (input['target_label'].present? ? input['target_label'] : 'override'),
          'data_center'   => call('data_center_url', input['target_data_center']),
          # 'data_center'   => input['target_data_center'],
          'api_token'     => input['target_api_token'],
          'is_production' => false,
          'level'         => nil
        }
      else
        if input['workato_environment'].blank?
          error('Select an environment, or supply a Target data center and API token.')
        end
        call('resolve_environment', connection, input['workato_environment'])
      end
    end,

    # ── get_auth_headers ──────────────────────────────────────
    get_auth_headers: lambda do |connection, env_name|
      env = call('resolve_environment', connection, env_name)
      { 'Authorization' => "Bearer #{env['api_token']}" }
    end,

    # ── get_datacenter ────────────────────────────────────────
    get_datacenter: lambda do |connection, env_name|
      env = call('resolve_environment', connection, env_name)
      env['data_center']
    end,

    # ── normalize_status ──────────────────────────────────────
    normalize_status: lambda do |api_response, is_projects_mode|
      if is_projects_mode.is_true?
        raw = api_response['state'] || ''
        case raw
        when 'pending'  then 'in_progress'
        when 'success'  then 'success'
        else 'failed'
        end
      else
        raw = api_response['status'] || ''
        case raw
        when 'in_progress' then 'in_progress'
        when 'completed'   then 'success'
        else 'failed'
        end
      end
    end,

    # ── build_endpoint ────────────────────────────────────────
    # Projects endpoints (build, project_builds, deployments) are DEV-only; callers
    # pass the SOURCE data center for them. RLCM endpoints run on the target.
    build_endpoint: lambda do |datacenter, id, is_projects_mode, action|
      base = datacenter

      case action
      when 'build'
        if is_projects_mode.is_true?
          "#{base}/projects/f#{id}/build"
        else
          "#{base}/packages/export/#{id}"
        end
      when 'status'
        if is_projects_mode.is_true?
          "#{base}/project_builds/#{id}"
        else
          "#{base}/packages/#{id}"
        end
      when 'deploy'
        if is_projects_mode.is_true?
          "#{base}/project_builds/#{id}/deploy"
        else
          "#{base}/packages/import/#{id}"
        end
      when 'deploy_status'
        if is_projects_mode.is_true?
          # A deployment is its own resource; project_builds/:id/deploy is the POST.
          "#{base}/deployments/#{id}"
        else
          "#{base}/packages/#{id}"
        end
      when 'download'
        "#{base}/packages/#{id}/download"
      else
        error("Unknown endpoint action: #{action}")
      end
    end,

    # ── ok_import_results ─────────────────────────────────────
    # The two import_result values that mean "recipe is in the state you asked for".
    # Everything else (stopped, restart_failed, stop_failed, not_found) means the
    # recipe was touched but is not running.
    ok_import_results: lambda do
      %w[restarted no_update_or_updated_without_restart]
    end,

    # ── rlcm_import_url ───────────────────────────────────────
    # Target-side import URL. The field is required in RLCM mode, but a mapped
    # datapill can still be blank at run time; fail early instead of POSTing to
    # /packages/import/?... and getting an opaque API error back.
    rlcm_import_url: lambda do |dc, input|
      folder_id = input['folder_id']
      error('Target folder ID is required in RLCM mode.') if folder_id.blank?

      params = {
        'restart_recipes' => input['restart_recipes'].is_true?,
        'include_tags'    => input['include_tags'].is_true?
      }
      if input['folder_id_for_home_assets'].present?
        params['folder_id_for_home_assets'] = input['folder_id_for_home_assets']
      end

      query = params.map { |k, v| "#{k}=#{v}" }.join('&')
      "#{dc}/packages/import/#{folder_id}?#{query}"
    end,

    # ── resolve_target_env ────────────────────────────────────
    # Runtime override wins; then an explicit target; otherwise the next promotion
    # target by level. Returns a resolved environment Hash.
    resolve_target_env: lambda do |connection, input|
      if call('runtime_target', input)
        call('env_ref', connection, input)
      elsif input['target_environment'].present?
        call('resolve_environment', connection, input['target_environment'])
      else
        targets = call('get_target_environments', connection, {
          'source_env' => input['source_environment']
        })
        if targets.blank?
          error('No valid promotion target found for ' \
                "#{input['source_environment']}.")
        end
        call('resolve_environment', connection, targets.first['name'])
      end
    end,

    # ── deploy_environment_type ───────────────────────────────
    # Projects mode: the environment_type the deploy payload takes. An explicit
    # Env type wins; otherwise it is derived from the resolved target — prod when
    # that environment is marked production, test otherwise. Only registered
    # environments qualify: the deploy runs in DEV and names the target, it never
    # authenticates to it, so a runtime override has nothing to attach to.
    deploy_environment_type: lambda do |input, target_env|
      if call('runtime_target', input)
        error('Projects mode deploys within one workspace from DEV, so a Target API token cannot be used. ' \
              'Select a registered Target environment, or use RLCM mode for an external workspace.')
      end

      if input['env_type'].present?
        input['env_type']
      elsif target_env['is_production'].is_true?
        'prod'
      else
        'test'
      end
    end,

    # ── connection_summary ────────────────────────────────────
    # The subset of a Connections API record that provisioning cares about, plus a
    # derived `authorized` flag (authorization_status == success).
    connection_summary: lambda do |c|
      {
        'id'                     => c['id'],
        'name'                   => c['name'],
        'application'            => c['application'],
        'authorization_status'   => c['authorization_status'],
        'authorized'             => c['authorization_status'] == 'success',
        'authorization_error'    => c['authorization_error'],
        'authorized_at'          => c['authorized_at'],
        'folder_id'              => c['folder_id'],
        'project_id'             => c['project_id'],
        'external_id'            => c['external_id'],
        'connection_lost_at'     => c['connection_lost_at'],
        'connection_lost_reason' => c['connection_lost_reason'],
        'tags'                   => c['tags'],
        'updated_at'             => c['updated_at']
      }.compact
    end,

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

    # ── put_connection ────────────────────────────────────────
    put_connection: lambda do |dc, headers, connection_id, payload|
      put("#{dc}/connections/#{connection_id}")
        .headers(headers)
        .payload(payload)
        .after_error_response(/.*/) do |_c, b, _h, m|
          error("Update connection #{connection_id} failed: #{m} — #{b}")
        end
    end,

    # ── google_service_account_input ──────────────────────────
    # The `input` object that authenticates a Google Drive / Sheets connection with a
    # service account. Field names follow the BigQuery entry in Workato's connection
    # parameters reference (the Drive/Sheets entries are stale); the UI labels match.
    # If a probe shows different names, this is the one place to change them.
    google_service_account_input: lambda do |connection|
      email = connection['google_service_account_email']
      key   = connection['google_private_key']

      if email.blank? || key.blank?
        error('Set the Google service account email and private key on this connection first.')
      end

      # Field names captured from the native Google Drive's connect request (30 Sept 2026)
      # - the email field is called 'service_auth'
      {
        'authentication_type' => 'service_auth',
        'service_auth'        => email,
        'private_key'         => key.gsub('\\n', "\n")
      }
    end,

    # ── start_deployment ──────────────────────────────────────
    # First-invocation half of Deploy package / Deploy package (async).
    #   Projects → POST project_builds/:id/deploy on the target
    #   RLCM     → download the package from the source, POST it to
    #              packages/import/:folder_id on the target
    # Returns the raw API response; callers normalize and shape it.
    start_deployment: lambda do |connection, input, target_env|
      if input['deployment_mode'] == 'projects'
        # Project deployments are DEV-only endpoints: authenticate to the source
        # environment and name the target with environment_type.
        headers = call('get_auth_headers', connection, input['source_environment'])
        dc      = call('get_datacenter', connection, input['source_environment'])
        url     = call('build_endpoint', dc, input['id'], true, 'deploy')

        post(url)
          .headers(headers)
          .payload({
            'environment_type' => call('deploy_environment_type', input, target_env),
            'description'      => input['description'],
            'include_tags'     => (input['include_tags'].is_true? ? true : nil)
          }.compact)
          .after_error_response(/.*/) do |_c, b, _h, m|
            error("Deploy failed: #{m} — #{b}")
          end
      else
        src_headers = call('get_auth_headers', connection, input['source_environment'])
        src_dc      = call('get_datacenter', connection, input['source_environment'])

        pkg = call('download_package', {
          'headers'         => src_headers,
          'dc'              => src_dc,
          'env_name'        => input['source_environment'],
          'package_id'      => input['id'],
          'deployment_mode' => 'rlcm'
        })

        tgt_headers = call('get_auth_headers', connection, target_env)
        tgt_dc      = call('get_datacenter', connection, target_env)

        post(call('rlcm_import_url', tgt_dc, input))
          .headers(tgt_headers.merge('Content-Type' => 'application/octet-stream'))
          .request_body(pkg['content'])
          .after_error_response(/.*/) do |_c, b, _h, m|
            error("RLCM import failed: #{m} — #{b}")
          end
      end
    end,

    # ── deployment_result ─────────────────────────────────────
    # Shape a package / deployment response into deployment_obj.
    #   RLCM     → recipe_status[] (one import_result per recipe) plus per-recipe
    #              and aggregate ok flags, so a recipe can branch on "completed,
    #              but N recipes are stopped" instead of seeing plain success.
    #   Projects → detailed_state and the assets[] list (target-side id, name,
    #              type, state, folder) with new/updated counts.
    deployment_result: lambda do |response, status, is_projects|
      result = {
        'id'           => response['id'],
        'status'       => status,
        'raw_status'   => is_projects.is_true? ? response['state'] : response['status'],
        'error'        => response['error'],
        'download_url' => response['download_url']
      }

      if is_projects.is_true?
        assets = Array(response['assets']).map do |a|
          { 'id' => a['id'], 'name' => a['name'], 'type' => a['type'],
            'state' => a['state'], 'folder' => a['folder'] }.compact
        end

        result['detailed_state']   = response['detailed_state']
        result['environment_type'] = response['environment_type']
        result['project_build_id'] = response['project_build_id']

        unless status == 'in_progress'
          result['asset_count']    = assets.length
          result['assets_new']     = assets.count { |a| a['state'] == 'new' }
          result['assets_updated'] = assets.count { |a| a['state'] == 'updated' }
          result['assets']         = assets
        end
      else
        ok_values = call('ok_import_results')

        recipe_status = Array(response['recipe_status']).map do |r|
          {
            'id'            => r['id'],
            'import_result' => r['import_result'],
            'ok'            => ok_values.include?(r['import_result'])
          }
        end

        unless status == 'in_progress'
          result['recipe_count']     = recipe_status.length
          result['recipes_ok_count'] = recipe_status.count { |r| r['ok'] }
          result['all_recipes_ok']   = recipe_status.all? { |r| r['ok'] }
          result['recipe_status']    = recipe_status
        end
      end

      result.compact
    end,

    # ── manifest_result ───────────────────────────────────────
    # Manifest endpoints wrap their payload in { result: {...} }.
    manifest_result: lambda do |response|
      response['result'] || response
    end,

    # ── manifest_asset_types ──────────────────────────────────
    manifest_asset_types: lambda do
      %w[recipe connection lookup_table workato_db_table account_property
        project_property workato_schema workato_template lcap_app lcap_page
        custom_adapter topic api_group api_endpoint]
    end,

    # ── group_assets_by_type ──────────────────────────────────
    group_assets_by_type: lambda do |assets|
      known   = call('manifest_asset_types')
      groups  = known.each_with_object({}) { |t, h| h[t] = [] }
      groups['other'] = []
      Array(assets).each do |a|
        key = known.include?(a['type']) ? a['type'] : 'other'
        groups[key] << a
      end
      groups
    end,

    # ── get_target_environments ───────────────────────────────
    get_target_environments: lambda do |connection, args|
      envs = connection['workato_environments'] || []
      source_env_name = args['source_env']
      exclude_prod = args['exclude_prod']

      result = envs

      if source_env_name.present?
        source = call('resolve_environment', connection, source_env_name)
        if source['is_production'].is_true?
          # From production → all non-production envs
          result = envs.reject { |e| e['is_production'].is_true? }
        else
          # From non-prod → next level only
          source_level = source['level'].to_i
          result = envs.select { |e| e['level'].to_i == source_level + 1 }
        end
      end

      if exclude_prod.is_true?
        result = result.reject { |e| e['is_production'].is_true? }
      end

      result.map do |e|
        {
          'name'          => e['name'],
          'is_production' => e['is_production'],
          'level'         => e['level']
        }
      end
    end,

    # ── poll_or_reinvoke ──────────────────────────────────────
    poll_or_reinvoke: lambda do |input|
      status       = input['status']
      response     = input['response']
      continue     = input['continue'] || {}
      current_step = (continue['current_step'] || 1).to_i
      max_steps    = (input['max_steps'] || 10).to_i

      case status
      when 'in_progress'
        if current_step < max_steps
          reinvoke_after(
            seconds: current_step * 10,
            continue: {
              'current_step' => current_step + 1,
              'job_id'       => response['id']
            }
          )
        else
          error('Operation timed out — job took too long.')
        end
      when 'failed'
        msg = response['error'] || response['error_message'] || response['detailed_state'] || "Operation failed: status=#{response['status'].inspect}, " \
          "body=#{response.to_json[0, 600]}"
        ok_values = call('ok_import_results')
        bad = Array(response['recipe_status']).reject do |r|
          ok_values.include?(r['import_result'])
        end
        if bad.present?
          detail = bad.map { |r| "#{r['id']} (#{r['import_result']})" }.join(', ')
          msg = "#{msg} Recipes not running after import: #{detail}"
        end
        error(msg)
      when 'success'
        response
      else
        error("Unexpected normalized status: #{status}")
      end
    end,

    # ── download_package ──────────────────────────────────────
    download_package: lambda do |input|
      headers     = input['headers']
      package_id  = input['package_id']
      is_projects = input['deployment_mode'] == 'projects'
      status_url  = call('build_endpoint', input['dc'], package_id, is_projects, 'status')

      pkg = get(status_url)
              .headers(headers)
              .after_error_response(/.*/) do |_c, b, _h, m|
                error("Package #{package_id} not found in #{input['env_name']}: #{m} — #{b}")
              end
      pkg = call('resolve_response', pkg) || {}

      status = call('normalize_status', pkg, is_projects)
      if status != 'success'
        raw = pkg['status'] || pkg['state']
        error("Package #{package_id} is #{raw}#{pkg['error'].present? ? ": #{pkg['error']}" : ''}; nothing to download.")
      end
      error("Package #{package_id} has no download_url.") if pkg['download_url'].blank?

      content = get(pkg['download_url'])
                  .headers('Accept' => '*/*')
                  .response_format_raw
                  .after_error_response(/.*/) do |_c, b, _h, m|
                    error("Package download failed: #{m} — #{b}")
                  end
                  .after_response do |_code, body, _headers|
                    body
                  end
                  .presence # force resoluion to a string
              
      error("Package #{package_id} download empty.") if content.blank?
      unless content.start_with?('PK')
        error("Package #{package_id} download is not a zip (starts with #{content[0, 4].inspect}).")
      end

      { 'workato_environment' => input['env_name'], 'package_id' => package_id.to_s,
        'deployment_mode' => input['deployment_mode'], 'content' => content }
    end,

    # ── compact_schema ────────────────────────────────────────
    # Reduce verbose per-step array to a compact field contract.
    compact_schema: lambda do |schema|
      Array(schema).map do |f|
        {
          'name'            => f['name'],
          'label'           => f['label'],
          'type'            => f['type'],
          'control_type'    => f['control_type'],
          'optional'        => f['optional'].nil? ? true: f['optional'],
          'hint'            => f['hint']
        }.compact
      end
    end,

    # ── flatten_steps ─────────────────────────────────────────
    # Pre-order flatten of a recipe step tree. Carries 'schema' so build_spec can read it
    # off the trigger/output step; stripped from final step inventory.
    flatten_steps: lambda do |step, path, depth|
      here = {
        'path'            => path,
        'depth'           => depth,
        'keyword'         => step['keyword'] || (depth.zero? ? 'trigger' : 'action'),
        'provider'        => step['provider'],
        'name'            => step['name'],
        'as'              => step['as'],
        'title'           => step['title'],
        'schema'          => step['extended_input_schema']
      }

      if step['provider'] == 'workato_recipe_function'
        flow    = (step['input'] || {})['flow_id']
        callee  = flow.is_a?(::Hash) ? (flow['name'] || flow['id']) : flow
        here['calls_recipe'] = callee.to_s if callee.present?
      end

      if step['provider'] == 'workato_db_table'
        table     = (step['input'] || {})['table_id']
        table_ref = table.is_a?(::Hash) ? (table['name'] || table['id']) : table
        here['table_id'] = table_ref.to_s if table_ref.present?
      end

      children  = []
      (step['block'] || []).each_with_index do |child, idx|
        children.concat(call('flatten_steps', child, "#{path}.#{idx}", depth + 1))
      end

      [here] + children
    end,

    # ── build_spec ────────────────────────────────────────────
    # Code-tree to contract-spec transformation.
    build_spec: lambda do |args|
      log  = []
      tree = parse_json(args['code'])
      error('Recipe code did not parse to a step tree') unless tree.is_a?(::Hash)

      flat    = call('flatten_steps', tree, '0', 0)
      trigger = flat.first
      actions = flat[1..-1] || []

      providers       = flat.map { |s| s['provider'] }.compact.uniq.sort
      recipes_called  = flat.map { |s| s['calls_recipe'] }.compact.uniq.sort
      tables_used     = flat.map { |s| s['table_id'] }.compact.uniq.sort

      # Input contract == trigger's declared schema (authoritative).
      input_contract = call('compact_schema', trigger['schema'])
      log << 'trigger declares no input schema' if input_contract.empty?

      # Output contract == return/response step's declared schema (heuristic).
      hint = args['output_step_hint'].to_s.strip.downcase
      out_step =
        if hint.empty?
          actions.last
        else
          actions.find { |s| "#{s['name']} #{s['title']}".downcase.include?(hint) } || actions.last
        end
      output_contract = out_step ? call('compact_schema', out_step['schema']) : []
      log << 'no output/return contract detected' if output_contract.empty?

      # Clean inventory (drop the carried schema blob).
      steps = flat.map { |s| s.reject { |k, _v| k == 'schema' } }

      spec = {
        'recipe' => {
          'id'          => args['recipe_id'],
          'name'        => args['recipe_name'],
          'folder'      => args['folder'],
          'environment' => args['environment']
        }.compact,
        'trigger' => {
          'provider' => trigger['provider'],
          'name'     => trigger['name'],
          'as'       => trigger['as']
        }.compact,
        'input_contract'  => input_contract,
        'output_contract' => output_contract,
        'connectors_used' => providers,
        'recipes_called'  => recipes_called,
        'tables_used'     => tables_used,
        'step_count'      => steps.length,
        'steps'           => steps
      }

      if args['connection_bindings'].present?
        spec['connection_bindings'] = args['connection_bindings']
      end

      {
        'spec_json'           => spec.to_json,
        'recipe_name'         => args['recipe_name'],
        'trigger_provider'    => trigger['provider'],
        'trigger_name'        => trigger['name'],
        'step_count'          => steps.length,
        'connectors_used'     => providers,
        'recipes_called'      => recipes_called,
        'tables_used'         => tables_used,
        'input_contract'      => input_contract,
        'output_contract'     => output_contract,
        'steps'               => steps,
        'connection_bindings' => args['connection_bindings'],
        'log'                 => log.join('; ')
      }.compact
    end,
    
    # ── inspect_one ───────────────────────────────────────────
    # Per-recipe fetch + spec unit: GET the recipe, guard on a missing code field,
    # fold config bindings, build the spec, merge fetch metadata.
    # Raises via error() on any failure (callers choose the failure policy).
    inspect_one: lambda do |args|
      dc        = args['dc']
      recipe_id = args['recipe_id']

      url = "#{dc}/recipes/#{recipe_id}"
      url = "#{url}?includes[]=tags" if args['include_tags'].is_true?

      recipe = get(url)
                 .headers(args['headers'])
                 .after_error_response(/.*/) do |_c, b, _h, m|
                   error("Recipe #{recipe_id} fetch failed: #{m} — #{b}")
                 end

      if recipe['code'].blank?
        error("Recipe #{recipe_id} returned no code field.")
      end

      bindings = (recipe['config'] || []).map do |c|
        {
          'keyword'    => c['keyword'],
          'provider'   => c['provider'],
          'name'       => c['name'],
          'account_id' => c['account_id']
        }.compact
      end

      spec = call('build_spec', {
        'code'                => recipe['code'],
        'recipe_id'           => recipe['id'].to_s,
        'recipe_name'         => recipe['name'],
        'folder'              => recipe['folder_id'].to_s,
        'environment'         => args['env_name'],
        'output_step_hint'    => args['output_step_hint'],
        'connection_bindings' => bindings
      })

      spec.merge(
        'workato_environment' => args['env_name'],
        'recipe_id'           => recipe['id'],
        'folder_id'           => recipe['folder_id'],
        'running'             => recipe['running'],
        'version_no'          => recipe['version_no'],
        'updated_at'          => recipe['updated_at'],
        'tags'                => recipe['tags']
      ).compact
    end,

    # ── csv_list ──────────────────────────────────────────────
    # "a, b,,c" → ['a', 'b', 'c']. For comma-separated ID and name inputs.
    csv_list: lambda do |value|
      value.to_s.split(',').map(&:strip).reject(&:blank?).uniq
    end,

    # ── resolve_response ──────────────────────────────────────
    # Requests are lazy: nothing is sent until the result is used, and until then
    # the request object answers is_a? for itself, not for the body. Force it here
    # before any shape check, and before discarding a response you never read —
    # an unused PUT is never sent. presence maps an empty body to nil; callers
    # wrap with Array() or fall back to {}.
    resolve_response: lambda do |request|
      request.presence
    end,

    # ── success_flag ──────────────────────────────────────────
    # The success field of a write response, forced. An empty body or one with
    # no success field means the 2xx itself is the answer (true); a success
    # field the API set to false is reported as false, not overridden.
    success_flag: lambda do |request|
      body = call('resolve_response', request)

      if body.is_a?(::Hash) && body.key?('success')
        body['success'].is_true?
      else
        true
      end
    end,

    # ── list_body ─────────────────────────────────────────────
    # Force a list request and unwrap it: a bare array, an { items: [...] } hash,
    # or an empty body all become an Array. All list endpoints should route through this method.
    list_body: lambda do |request|
      body = call('resolve_response', request)
      Array(body.is_a?(::Hash) ? body['items'] : body)
    end,

    # ── id_list ───────────────────────────────────────────────
    # An ordered ID list from a recipe: a JSON array string ("[12,34]" — the safe
    # form, since names and values may contain commas), a real array (a list pill),
    # or a comma-separated string. Order kept, blanks and duplicates dropped,
    # items returned as strings.
    id_list: lambda do |value|
      items = if value.is_a?(::Array)
                value
              elsif value.to_s.strip.start_with?('[')
                parsed = parse_json(value.to_s.strip)
                error('Recipe IDs must be a JSON array, e.g. [12,34].') unless parsed.is_a?(::Array)
                parsed
              else
                value.to_s.split(',')
              end

      items.map { |v| v.to_s.strip }.reject(&:blank?).uniq
    end,

    # ── finish_build ──────────────────────────────────────────
    # Build-succeeded half of Build and download package, shared by both invocation
    # paths. Download content = No returns the package reference without the binary;
    # nil (a step configured before the field existed) means Yes.
    finish_build: lambda do |args|
      response = args['response']

      if args['download_content'].to_s == 'false'
        {
          'workato_environment' => args['env_name'],
          'package_id'          => response['id'].to_s,
          'deployment_mode'     => args['deployment_mode'],
          'content'             => nil
        }
      else
        call('download_package', {
          'headers'         => args['headers'],
          'dc'              => args['dc'],
          'env_name'        => args['env_name'],
          'package_id'      => response['id'].to_s,
          'deployment_mode' => args['deployment_mode']
        })
      end
    end,

    # ── project_summary ───────────────────────────────────────
    # A project's id is not its folder_id: properties and API clients take the
    # former, folders / imports / recipes the latter.
    project_summary: lambda do |p|
      {
        'id'          => p['id'],
        'name'        => p['name'],
        'description' => p['description'],
        'folder_id'   => p['folder_id']
      }.compact
    end,

    # ── platform_result ───────────────────────────────────────
    # The v2 API Platform endpoints wrap their payload in { data: ... }; the older
    # collection and endpoint listings return it bare. One unwrap covers both.
    platform_result: lambda do |response|
      if response.is_a?(::Hash)
        response.key?('data') ? response['data'] : response
      else
        response
      end
    end,

    # ── api_collection_summary ────────────────────────────────
    # `url` is the collection base URL — the api_base_url the registry row stores.
    # project_id comes back from this endpoint as a string; it is kept as returned.
    api_collection_summary: lambda do |c|
      {
        'id'         => c['id'],
        'name'       => c['name'],
        'version'    => c['version'],
        'url'        => c['url'],
        'project_id' => c['project_id']
      }.compact
    end,

    # ── api_endpoint_summary ──────────────────────────────────
    api_endpoint_summary: lambda do |e|
      {
        'id'                => e['id'],
        'api_collection_id' => e['api_collection_id'],
        'flow_id'           => e['flow_id'],
        'name'              => e['name'],
        'method'            => e['method'],
        'path'              => e['path'],
        'url'               => e['url'],
        'active'            => e['active']
      }.compact
    end,

    # ── api_client_summary ────────────────────────────────────
    api_client_summary: lambda do |c|
      {
        'id'                    => c['id'],
        'name'                  => c['name'],
        'description'           => c['description'],
        'project_id'            => c['project_id'],
        'auth_type'             => c['auth_type'],
        'active_api_keys_count' => c['active_api_keys_count'],
        'total_api_keys_count'  => c['total_api_keys_count'],
        'api_collections'       => Array(c['api_collections']).map { |ac| { 'id' => ac['id'], 'name' => ac['name'] } }
      }.compact
    end,

    # ── api_key_summary ───────────────────────────────────────
    # Never carries auth_token. The list endpoint returns it masked, so the token is
    # merged in only by the two actions that receive a real one (create, refresh).
    api_key_summary: lambda do |k|
      {
        'id'            => k['id'],
        'name'          => k['name'],
        'auth_type'     => k['auth_type'],
        'active'        => k['active'],
        'active_since'  => k['active_since'],
        'ip_allow_list' => k['ip_allow_list']
      }.compact
    end,

    # ── fetch_api_endpoints ───────────────────────────────────
    # Shared by List API endpoints and Set API endpoints state.
    fetch_api_endpoints: lambda do |dc, headers, collection_id|
      response = get("#{dc}/api_endpoints", { 'api_collection_id' => collection_id, 'per_page' => 100 })
                   .headers(headers)
                   .after_error_response(/.*/) do |_c, b, _h, m|
                     error("List API endpoints failed: #{m} — #{b}")
                   end

      body = call('resolve_response', response)
      Array(call('platform_result', body)).map { |e| call('api_endpoint_summary', e) }
    end,

    # ── custom_connector_summary ──────────────────────────────
    custom_connector_summary: lambda do |c|
      latest    = c['latest_version']
      released  = c['latest_released_version']
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
    # Releases the latest version. The API answers 400 when that version is
    # already released; that is the state the caller wants, so it is a no-op
    # rather than failure. Returns true when this call released something.
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
    end,

    # ── delete_or_gone ────────────────────────────────────────
    # A delete whose 404 means "already gone". Returns :deleted | :gone. Success
    # bodies vary ({"success":"true"} on projects, {"success":true} elsewhere),
    # so any 2xx counts as deleted; a verify step is what proves it. This is
    # what makes every teardown step rerunnable, and a whole-action 429 retry
    # safe.
    delete_or_gone: lambda do |url, headers, label, env_name|
      gone = false

      response = delete(url)
                   .headers(headers)
                   .after_error_response(/.*/) do |code, b, _h, m|
                     if code.to_i == 404
                       gone = true
                     else
                       error("#{label} failed in #{env_name}: #{m} — #{b}")
                     end
                   end
      call('resolve_response', response)

      gone ? :gone : :deleted
    end,

    # ── list_all_pages ────────────────────────────────────────
    # Every item of a paged list endpoint, at 100 per page. A short page ends
    # the walk. Running out of pages is an error, never a truncated list: a
    # caller that reads "absent" from a partial list would tear down, or skip,
    # the wrong thing. A page that repeats an item already seen (an API
    # ignoring `page`) errors for the same reason.
    #   args: url, params (extra query), headers, env_name,
    #         noun ('projects'), item ('project') for messages
    list_all_pages: lambda do |args|
      per_page  = 100
      max_pages = 50
      noun      = args['noun']
      env_name  = args['env_name']
      all       = []
      seen_ids  = {}
      page      = 0
      last_page = false

      until last_page
        page += 1
        if page > max_pages
          error("List #{noun} in #{env_name} exceeded #{max_pages * per_page} #{noun}; " \
                'refusing to trust a partial list.')
        end

        response = get(args['url'], (args['params'] || {}).merge('page' => page, 'per_page' => per_page))
                     .headers(args['headers'])
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List #{noun} failed in #{env_name} (page #{page}): #{m} — #{b}")
                     end

        items = call('list_body', response)
        if items.any? { |i| seen_ids[i['id'].to_s] }
          error("List #{noun} in #{env_name} repeated a #{args['item']} on page #{page}; " \
                'refusing to trust a partial list.')
        end
        items.each { |i| seen_ids[i['id'].to_s] = true }

        all.concat(items)
        last_page = items.length < per_page
      end

      all
    end,

    # ── list_all_projects ─────────────────────────────────────
    list_all_projects: lambda do |dc, headers, env_name|
      call('list_all_pages', {
        'url' => "#{dc}/projects", 'headers' => headers, 'env_name' => env_name,
        'noun' => 'projects', 'item' => 'project'
      }).map { |p| call('project_summary', p) }
    end,

    # ── list_all_recipes ──────────────────────────────────────
    # Every recipe directly in a folder, across every page.
    list_all_recipes: lambda do |dc, headers, folder_id, env_name|
      call('list_all_pages', {
        'url' => "#{dc}/recipes", 'params' => { 'folder_id' => folder_id }, 'headers' => headers,
        'env_name' => env_name, 'noun' => 'recipes', 'item' => 'recipe'
      })
    end,

    # ── folder_summary ────────────────────────────────────────
    folder_summary: lambda do |f|
      {
        'id'         => f['id'],
        'name'       => f['name'],
        'parent_id'  => f['parent_id'],
        'created_at' => f['created_at'],
        'updated_at' => f['updated_at'],
        'project_id' => f['project_id'],
        'is_project' => f['is_project']
      }.compact
    end,

    # ── read_folder ───────────────────────────────────────────
    # One folder by ID, forced. A 404 names the folder and the environment.
    read_folder: lambda do |dc, headers, id, env_name|
      response = get("#{dc}/folders/#{id}")
                   .headers(headers)
                   .after_error_response(/.*/) do |code, b, _h, m|
                     if code.to_i == 404
                       error("Folder #{id} not found in #{env_name}.")
                     else
                       error("Read folder #{id} failed in #{env_name}: #{m} — #{b}")
                     end
                   end

      folder = call('resolve_response', response)
      error("Read folder #{id} in #{env_name} returned no folder record.") unless folder.is_a?(::Hash)
      folder
    end,

    # ── folder_chain ──────────────────────────────────────────
    # A folder and its ancestors, top first, following parent_id one request
    # per level. A loop or more than 50 levels is an error, never a partial path.
    folder_chain: lambda do |dc, headers, folder, env_name|
      chain = [folder]
      seen  = { folder['id'].to_s => true }

      while chain.first['parent_id'].present?
        parent_id = chain.first['parent_id'].to_s
        error("Folder #{folder['id']} in #{env_name} has a parent loop at folder #{parent_id}.") if seen[parent_id]
        error("Folder #{folder['id']} in #{env_name} is more than 50 levels deep.") if chain.length >= 50

        seen[parent_id] = true
        chain = [call('read_folder', dc, headers, parent_id, env_name)] + chain
      end

      chain
    end,

    # ── folder_path ───────────────────────────────────────────
    # "/Top/Middle/Folder" from a top-first chain.
    folder_path: lambda do |chain|
      '/' + chain.map { |f| f['name'].to_s }.join('/')
    end,

    # ── folder_tree ───────────────────────────────────────────
    # Every folder below a parent (blank = the top level), each with its full
    # path and depth, sorted by path. One list request per folder visited, so
    # it is bounded: more than 1,000 folders, or a walk that would outrun the
    # action time limit, is an error naming a narrower Parent ID to use.
    folder_tree: lambda do |dc, headers, parent_id, env_name|
      max_folders = 1000
      deadline    = now + 2.minutes
      origins     = {}   # parent_id => { path, depth } of a top-level folder's parent

      start = if parent_id.present?
                chain = call('folder_chain', dc, headers, call('read_folder', dc, headers, parent_id, env_name), env_name)
                { 'id' => parent_id.to_s, 'path' => call('folder_path', chain), 'depth' => chain.length }
              else
                { 'id' => nil, 'path' => nil, 'depth' => nil }
              end

      queue   = [start]
      folders = []

      while queue.present?
        if now > deadline
          error("Folder tree in #{env_name} is too large to walk in one step (#{folders.length} folders so far). " \
                'Set a Parent ID lower in the tree.')
        end

        parent = queue.first
        queue  = queue.drop(1)

        children = call('list_all_pages', {
          'url' => "#{dc}/folders", 'params' => (parent['id'] ? { 'parent_id' => parent['id'] } : {}),
          'headers' => headers, 'env_name' => env_name, 'noun' => 'folders', 'item' => 'folder'
        })

        children.each do |c|
          base = parent
          if parent['id'].nil?
            # Top level: the parent (e.g. Home) is not in the listing; resolve
            # its path once so paths match Get folder's.
            pid = c['parent_id'].to_s
            unless origins.key?(pid)
              origins[pid] = if pid.present?
                               chain = call('folder_chain', dc, headers,
                                            call('read_folder', dc, headers, pid, env_name), env_name)
                               { 'path' => call('folder_path', chain), 'depth' => chain.length }
                             else
                               { 'path' => '', 'depth' => 0 }
                             end
            end
            base = origins[pid]
          end

          path  = "#{base['path']}/#{c['name']}"
          depth = base['depth'] + 1
          folders << call('folder_summary', c).merge('path' => path, 'depth' => depth)
          queue   << { 'id' => c['id'].to_s, 'path' => path, 'depth' => depth }
        end

        if folders.length > max_folders
          error("Folder tree in #{env_name} has more than #{max_folders} folders. Set a Parent ID lower in the tree.")
        end
      end

      folders.sort_by { |f| f['path'] }
    end,

    # ── find_project ──────────────────────────────────────────
    # A project by its top-level folder ID or exact name, across every page.
    # nil when absent; error when more than one matches — a teardown must
    # never pick one of two.
    find_project: lambda do |dc, headers, folder_id, name, env_name|
      call('match_project', call('list_all_projects', dc, headers, env_name), folder_id, name, env_name)
    end,

    # ── match_project ─────────────────────────────────────────
    # The one project in a full list with this folder ID and/or exact name.
    # nil when none; error when more than one.
    match_project: lambda do |projects, folder_id, name, env_name|
      matches = projects
      matches = matches.select { |p| p['folder_id'].to_s == folder_id.to_s } if folder_id.present?
      matches = matches.select { |p| p['name'] == name } if name.present?

      if matches.length > 1
        error("Project is ambiguous in #{env_name}: #{matches.length} match.")
      end

      matches.first
    end,

    # ── clean_residue ─────────────────────────────────────────
    # The workspace-level assets a project delete leaves behind, computed from
    # the inventory rather than a fixed list. Reasons are prefixed kept | no_api
    # so all_clean can test them.
    clean_residue: lambda do |groups|
      reasons = {
        'custom_adapter'   => 'kept: no delete endpoint; Ensure custom connector skips a current one on the next prepare',
        'account_property' => 'no_api: overwritten by Upsert properties on the next prepare',
        'workato_template' => 'no_api: the next import matches by name and updates',
        'topic'            => 'no_api: harmless to keep'
      }

      reasons.flat_map do |type, reason|
        Array(groups[type]).map do |a|
          { 'type' => type, 'id' => a['id'], 'name' => a['name'], 'reason' => reason }
        end
      end
    end,

    # ── disable_collection_endpoints ──────────────────────────
    # Disable every active endpoint of a collection, so it is never deleted
    # with a live surface. Shared by Delete API collection and Clean project.
    # Returns the endpoint count seen (active or not), for the caller's report.
    disable_collection_endpoints: lambda do |dc, headers, collection_id, env_name|
      endpoints = call('fetch_api_endpoints', dc, headers, collection_id)

      endpoints.select { |e| e['active'] }.each do |e|
        response = put("#{dc}/api_endpoints/#{e['id']}/disable")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Disable endpoint #{e['id']} failed in #{env_name}: #{m} — #{b}")
                     end
        call('resolve_response', response)
      end

      endpoints.length
    end,

    # ── sample_* ──────────────────────────────────────────────
    # Shapes shared by the sample_output lambdas: the datapill previews the
    # editor shows before a step has run. Illustrative values only; they make
    # no API call and carry no real credential.
    sample_manifest_asset: lambda do
      { 'id' => 3101, 'name' => 'Get order', 'type' => 'recipe', 'version' => 4, 'folder' => 'Orders',
        'absolute_path' => 'All projects/Orders', 'root_folder' => false, 'unreachable' => false,
        'zip_name' => 'get_order.recipe.json', 'checked' => true, 'status' => 'updated' }
    end,

    sample_manifest: lambda do
      { 'id' => 501, 'name' => 'Orders release', 'status' => 'working', 'project_path' => 'Orders',
        'include_tags' => false, 'last_exported_at' => '2026-10-01T09:30:00Z',
        'created_at' => '2026-09-01T09:00:00Z', 'updated_at' => '2026-10-01T09:30:00Z', 'deleted_at' => nil,
        'assets' => [call('sample_manifest_asset')] }
    end,

    sample_build: lambda do |input|
      projects = input['deployment_mode'] == 'projects'
      { 'id' => 9001, 'status' => 'success', 'deployment_mode' => (projects ? 'projects' : 'rlcm'),
        'workato_environment' => 'DEV', 'source_reference' => (projects ? '1201' : '501'),
        'download_url' => 'https://www.workato.com/packages/9001/download' }
    end,

    sample_package_content: lambda do |input|
      { 'workato_environment' => 'DEV', 'package_id' => '9001',
        'deployment_mode' => (input['deployment_mode'] == 'projects' ? 'projects' : 'rlcm'),
        'content' => '<binary package content>' }
    end,

    # Mirrors deployment_result: the per-recipe or per-asset detail only once the
    # deployment has finished.
    sample_deployment: lambda do |input, in_progress|
      projects = input['deployment_mode'] == 'projects'
      result   = { 'id' => 7001, 'status' => (in_progress ? 'in_progress' : 'success'), 'error' => nil }

      if projects
        result = result.merge('raw_status' => (in_progress ? 'pending' : 'success'),
                               'detailed_state' => (in_progress ? 'deploy_pending' : 'deploy_finished'),
                               'environment_type' => 'test', 'project_build_id' => 9001)
        unless in_progress
          result = result.merge('asset_count' => 2, 'assets_new' => 1, 'assets_updated' => 1, 'assets' => [
            { 'id' => 3101, 'name' => 'Get order', 'type' => 'recipe', 'state' => 'updated', 'folder' => 'Orders' },
            { 'id' => 4101, 'name' => 'Google Drive', 'type' => 'connection', 'state' => 'new', 'folder' => 'Orders' }
          ])
        end
      else
        result = result.merge('raw_status' => (in_progress ? 'in_progress' : 'completed'),
                               'download_url' => 'https://www.workato.com/packages/7001/download')
        unless in_progress
          result = result.merge('recipe_count' => 2, 'recipes_ok_count' => 2, 'all_recipes_ok' => true, 'recipe_status' => [
            { 'id' => 3101, 'import_result' => 'restarted', 'ok' => true },
            { 'id' => 3102, 'import_result' => 'no_update_or_updated_without_restart', 'ok' => true }
          ])
        end
      end

      result
    end,

    sample_folder: lambda do
      { 'id' => 1301, 'name' => 'Orders', 'parent_id' => 1201, 'created_at' => '2026-09-01T09:00:00Z',
        'updated_at' => '2026-09-01T09:00:00Z', 'project_id' => 77, 'is_project' => false }
    end,

    sample_project: lambda do
      { 'id' => 77, 'name' => 'Orders', 'description' => 'Order sync between ERP and CRM', 'folder_id' => 1201 }
    end,

    sample_connection: lambda do
      { 'id' => 4101, 'name' => 'Google Drive', 'application' => 'google_drive', 'authorization_status' => 'success',
        'authorized' => true, 'authorization_error' => nil, 'authorized_at' => '2026-10-01T09:40:00Z',
        'folder_id' => 1201, 'project_id' => 77, 'external_id' => 'acme', 'connection_lost_at' => nil,
        'connection_lost_reason' => nil, 'tags' => [], 'updated_at' => '2026-10-01T09:40:00Z' }
    end,

    sample_pending_connection: lambda do
      call('sample_connection').merge('id' => 4102, 'name' => 'Google Sheets', 'application' => 'google_sheets',
                                      'authorization_status' => 'failed', 'authorized' => false,
                                      'authorization_error' => 'Credentials missing', 'authorized_at' => nil)
    end,

    sample_api_collection: lambda do
      { 'id' => 601, 'name' => 'Orders API', 'version' => '1.0',
        'url' => 'https://apim.workato.com/acme/orders-v1', 'project_id' => '77' }
    end,

    sample_api_endpoint: lambda do
      { 'id' => 6101, 'api_collection_id' => 601, 'flow_id' => 3101, 'name' => 'Get order', 'method' => 'GET',
        'path' => 'orders/:id', 'url' => 'https://apim.workato.com/acme/orders-v1/orders/:id', 'active' => true }
    end,

    sample_api_client: lambda do
      { 'id' => 701, 'name' => 'Acme workspace', 'description' => 'Registry client for Acme', 'project_id' => 77,
        'auth_type' => 'token', 'active_api_keys_count' => 1, 'total_api_keys_count' => 1,
        'api_collections' => [{ 'id' => 601, 'name' => 'Orders API' }] }
    end,

    sample_api_key: lambda do
      { 'id' => 7101, 'name' => 'acme-primary', 'auth_type' => 'token', 'active' => true,
        'active_since' => '2026-10-01T09:45:00Z', 'ip_allow_list' => [] }
    end,

    sample_spec: lambda do
      contract = [{ 'name' => 'order_id', 'label' => 'Order ID', 'type' => 'string', 'control_type' => 'text',
                    'optional' => false, 'hint' => 'ERP order number.' }]
      {
        'spec_json'        => '{"recipe":{"id":"3101","name":"Get order"},"trigger":{"provider":"workato_recipe_function"}}',
        'recipe_name'      => 'Get order',
        'trigger_provider' => 'workato_recipe_function',
        'trigger_name'     => 'execute',
        'step_count'       => 2,
        'connectors_used'  => %w[google_drive workato_recipe_function],
        'recipes_called'   => [],
        'tables_used'      => [],
        'input_contract'   => contract,
        'output_contract'  => contract,
        'steps'            => [
          { 'path' => '0', 'depth' => 0, 'keyword' => 'trigger', 'provider' => 'workato_recipe_function',
            'name' => 'execute', 'as' => 'a1b2c3d4', 'title' => nil },
          { 'path' => '0.0', 'depth' => 1, 'keyword' => 'action', 'provider' => 'workato_recipe_function',
            'name' => 'return_result', 'as' => 'e5f6a7b8', 'title' => 'Return order' }
        ],
        'log'              => ''
      }
    end
  },

  # --- OBJECT DEFINITIONS ------------------------------------------
  object_definitions: {

    environment_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'name', label: 'Environment name' },
          { name: 'is_production', type: :boolean },
          { name: 'level', type: :integer }
        ]
      end
    },

    build_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'status',
            hint: 'Normalized: in_progress | success | failed' },
          { name: 'deployment_mode' },
          { name: 'workato_environment' },
          { name: 'source_reference',
            hint: 'Project ID or manifest ID' },
          { name: 'download_url' }
        ]
      end
    },

    package_content_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'workato_environment' },
          { name: 'package_id' },
          { name: 'deployment_mode' },
          { name: 'content', label: 'Binary package content',
            hint: 'Empty when Build and download package ran with Download content = No.' }
        ]
      end
    },

    # Follows the Deployment mode config field: RLCM shows the per-recipe import
    # result, Projects the per-asset deployment. A blank mode shows both.
    deployment_obj: {
      fields: lambda do |connection, config_fields|
        mode = config_fields['deployment_mode']
    
        common = [
          { name: 'id', type: :integer },
          { name: 'status',
            hint: 'Normalized: in_progress | success | failed' },
          { name: 'raw_status',
            hint: 'Status exactly as the API returned it.' },
          { name: 'error' },
          { name: 'download_url' }
        ]
    
        rlcm = [
          { name: 'recipe_count', type: :integer,
            hint: 'Number of recipes the import reported on.' },
          { name: 'recipes_ok_count', type: :integer,
            hint: 'Recipes reporting restarted or no_update_or_updated_without_restart.' },
          { name: 'all_recipes_ok', type: :boolean,
            hint: 'False when any recipe reported stopped, restart_failed, stop_failed, or not_found — ' \
                  'the import can be "completed" and still leave recipes stopped. Branch on this, not on status.' },
          { name: 'recipe_status', type: :array, of: :object,
            hint: 'One entry per recipe in the package, including newly created recipe IDs in the target.',
            properties: [
              { name: 'id', type: :integer, hint: 'Recipe ID in the target environment.' },
              { name: 'import_result',
                hint: 'restarted | no_update_or_updated_without_restart | stopped | restart_failed | stop_failed | not_found' },
              { name: 'ok', type: :boolean }
            ] }
        ]
    
        projects = [
          { name: 'detailed_state',
            hint: 'Workato\'s finer state, e.g. deploy_finished, pending_review.' },
          { name: 'environment_type', hint: 'The environment deployed to.' },
          { name: 'project_build_id', type: :integer },
          { name: 'asset_count', type: :integer, hint: 'Assets in the deployment.' },
          { name: 'assets_new', type: :integer, hint: 'Assets created in the target.' },
          { name: 'assets_updated', type: :integer, hint: 'Assets that already existed and were overwritten.' },
          { name: 'assets', type: :array, of: :object,
            hint: 'One entry per asset. id is the target-side ID; null for a new asset until it is created.',
            properties: [
              { name: 'id', type: :integer },
              { name: 'name' },
              { name: 'type' },
              { name: 'state', hint: 'new | updated | deleted' },
              { name: 'folder' }
            ] }
        ]
    
        if mode == 'rlcm'
          common + rlcm
        elsif mode == 'projects'
          common + projects
        else
          common + rlcm + projects
        end
      end
    },
    
    manifest_asset_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'type',
            hint: call('manifest_asset_types').join(' | ') },
          { name: 'version', type: :integer },
          { name: 'folder' },
          { name: 'absolute_path' },
          { name: 'root_folder', type: :boolean },
          { name: 'unreachable', type: :boolean },
          { name: 'zip_name' },
          { name: 'checked', type: :boolean },
          { name: 'status',
            hint: 'List folder assets only: added | updated | no change, relative to the last export.' }
        ]
      end
    },

    manifest_obj: {
      fields: lambda do |connection, config_fields, object_definitions|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'status', hint: 'working | archived' },
          { name: 'project_path' },
          { name: 'include_tags', type: :boolean },
          { name: 'last_exported_at' },
          { name: 'created_at' },
          { name: 'updated_at' },
          { name: 'deleted_at' },
          { name: 'assets', type: :array, of: :object,
            hint: 'Returned on update; not on create or view.',
            properties: object_definitions['manifest_asset_obj'] }
        ]
      end
    },

    manifest_asset_groups_obj: {
      fields: lambda do |_connection, _config_fields, object_definitions|
        (call('manifest_asset_types') + ['other']).map do |t|
          { name: t, label: t.split('_').map(&:capitalize).join(' '),
            type: :array, of: :object,
            properties: object_definitions['manifest_asset_obj'] }
        end
      end
    },

    # Environment selector shared by every environment-scoped action: a registered
    # environment, or a runtime target (data center + token) for a workspace that is
    # not registered on this connection.
    # Each field set hides only when the other Target is picked, so a blank
    # Target (a step saved before the field existed) shows both, as before.
    env_selector: {
      fields: lambda do |connection, config_fields|
        [
          call('target_kind_field', 'an environment on this connection.'),
          { 
            name:         'workato_environment', 
            label:        'Workato environment',
            control_type: 'select',
            pick_list:    'environments',
            toggle_hint:  'Use datapill',
            optional:     true,
            ngIf:         'input.target_kind != "runtime"',
            hint:         'The registered environment in which to act.',
            toggle_field: call('env_name_toggle', 'workato_environment', 'Workato environment', true)
          },
          { 
            name: 'target_data_center', 
            label: 'Target data center', 
            control_type: 'select', 
            pick_list: 'data_centers',
            toggle_hint: 'Use datapill', 
            optional: true, 
            ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: the data center of a workspace not registered on this connection (e.g. a client ' \
                  'workspace resolved from the registry). Requires Target API token.',
            toggle_field: call('data_center_toggle') 
          },
          { name: 'target_api_token', label: 'Target API token', control_type: 'text', optional: true,
            ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: API token for that workspace. This passes through the job as a step input — enable ' \
                  'data masking on the step.' },
          { name: 'target_label', label: 'Target label', optional: true, ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: name stamped on outputs (e.g. the client workspace name). Defaults to "override".' }
        ]
      end
    },

    connection_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'application', hint: 'Provider value, e.g. google_drive, google_sheets.' },
          { name: 'authorization_status', hint: 'success when the connection is usable.' },
          { name: 'authorized', type: :boolean },
          { name: 'authorization_error' },
          { name: 'authorized_at' },
          { name: 'folder_id', type: :integer },
          { name: 'project_id', type: :integer },
          { name: 'external_id' },
          { name: 'connection_lost_at' },
          { name: 'connection_lost_reason' },
          { name: 'tags', type: :array, of: :string },
          { name: 'updated_at' }
        ]
      end
    },

    # Shared by Deploy package and Deploy package (async).
    # Mode-specific fields follow the Deployment mode config field: RLCM gets
    # the import fields, Projects the deploy note and env type. A blank mode
    # (the editor before one is picked) shows both sets.
    deploy_input_fields: {
      fields: lambda do |connection, config_fields|
        mode     = config_fields['deployment_mode']
        rlcm     = mode != 'projects'
        projects = mode != 'rlcm'
    
        [
          { name: 'id', label: 'Build or package ID', optional: false, hint: 'The ID from a completed build.' },
          { 
            name: 'source_environment', 
            label: 'Source environment', 
            control_type: 'select', 
            pick_list: 'environments',
            toggle_hint: 'Use datapill', 
            optional: false,
            hint: 'The environment the package was built in. In Projects mode every call (deploy and status) ' \
                  'authenticates here — deployment endpoints exist only in DEV.',
            toggle_field: call('env_name_toggle', 'source_environment', 'Source environment', false) 
          },
          call('target_kind_field', 'Target environment below, or blank to promote to the next environment by level. Projects mode accepts only this.'),
          { name: 'target_environment', label: 'Target environment', control_type: 'select', pick_list: 'target_environments',
            pick_list_params: { source_environment: 'source_environment' }, toggle_hint: 'Use datapill', optional: true,
            ngIf: 'input.target_kind != "runtime"',
            hint: 'Optional. A registered environment to deploy to. If blank, promotes to the next environment by level — ' \
                  'unless a Target API token is supplied below. This list is built from Source environment, so when ' \
                  'Source environment is mapped from a datapill, map this one too.',
            toggle_field: call('env_name_toggle', 'target_environment', 'Target environment', true) },
          { name: 'target_data_center', label: 'Target data center', control_type: 'select', pick_list: 'data_centers',
            toggle_hint: 'Use datapill', optional: true, ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: the data center of a workspace not registered on this connection. Requires Target API token.',
            toggle_field: call('data_center_toggle') },
          { name: 'target_api_token', label: 'Target API token', control_type: 'text', optional: true,
            ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: API token for a workspace not registered on this connection. Overrides ' \
                  'Target environment. Passes through the job as a step input — enable data masking on the step. ' \
                  'Rejected in Projects mode, which deploys within one workspace.' },
          { name: 'target_label', label: 'Target label', optional: true, ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: name stamped on outputs. Defaults to "override".' },
          (rlcm ?
             { name: 'folder_id', label: 'Target folder ID', optional: mode != 'rlcm',
               hint: 'The folder in the target environment to import into.' } : nil),
          (rlcm ?
             { name: 'restart_recipes', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
               hint: 'When Yes, Workato restarts running recipes after import (in its own order). When No, the ' \
                     'import fails if any recipe in the package is running — stop them first, import, then start them yourself.' } : nil),
          { name: 'include_tags', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Preserve tags on deployed assets. RLCM: only has effect if the manifest was created with Include tags. ' \
                  'Projects: tags are applied in the target environment when Yes.' },
          (rlcm ?
             { name: 'folder_id_for_home_assets', label: 'Folder ID for home assets', optional: true,
               hint: 'Required when the package contains root-folder assets, or when the target workspace\'s Home ' \
                     'assets folder has been converted to a project. Cannot be the root folder.' } : nil),
          (projects ?
             { name: 'env_type', control_type: 'select', pick_list: 'target_environment_types', optional: true,
               hint: 'Leave blank to derive from the target: prod when it is marked production, else test.' } : nil),
          (projects ?
             { name: 'description', optional: true, hint: 'Optional note attached to the deployment.' } : nil)
        ].compact
      end
    },

    # Target fields for Ensure custom connector. An object definition, not inline:
    # Workato's semantic check rejects call() inside an action's input_fields.
    connector_target_fields: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'source_environment', label: 'Source environment', control_type: 'select', pick_list: 'environments',
            toggle_hint: 'Use datapill', optional: false,
            hint: 'The environment the connector code is read from (e.g. DEV).',
            toggle_field: call('env_name_toggle', 'source_environment', 'Source environment', false) },
          call('target_kind_field', 'Target environment below, or blank to install into the next environment by level.'),
          { name: 'target_environment', label: 'Target environment', control_type: 'select', pick_list: 'target_environments',
            pick_list_params: { source_environment: 'source_environment' }, toggle_hint: 'Use datapill', optional: true,
            ngIf: 'input.target_kind != "runtime"',
            hint: 'Optional. A registered environment to install into. If blank, the next environment by level — ' \
                  'unless a Target API token is supplied below. This list is built from Source environment, so when ' \
                  'Source environment is mapped from a datapill, map this one too.',
            toggle_field: call('env_name_toggle', 'target_environment', 'Target environment', true) },
          { name: 'target_data_center', label: 'Target data center', control_type: 'select', pick_list: 'data_centers',
            toggle_hint: 'Use datapill', optional: true, ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: the data center of a workspace not registered on this connection. Requires Target API token.',
            toggle_field: call('data_center_toggle') },
          { name: 'target_api_token', label: 'Target API token', control_type: 'text', optional: true,
            ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: API token for that workspace. Overrides Target environment. Passes through the job as a ' \
                  'step input — enable data masking on the step.' },
          { name: 'target_label', label: 'Target label', optional: true, ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: name stamped on outputs. Defaults to "override".' }
        ]
      end
    },

    recipe_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'folder_id' },
          { name: 'running', type: :boolean }
        ]
      end
    },

    recipe_detail_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'description' },
          { name: 'folder_id', type: :integer },
          { name: 'project_id', type: :integer },
          { name: 'running', type: :boolean },
          { name: 'version_no', type: :integer },
          { name: 'trigger_application' },
          { name: 'action_applications', type: :array, of: :string },
          { name: 'applications', type: :array, of: :string },
          { name: 'code',
            hint: 'JSON string of the recipe step tree. Feed this to the ' \
                  'Recipe to spec action to build a contract.' },
          { name: 'config', type: :array, of: :object,
            hint: 'Connection bindings, one per application.',
            properties: [
              { name: 'keyword' },
              { name: 'name' },
              { name: 'provider' },
              { name: 'account_id', type: :integer },
              { name: 'skip_validation', type: :boolean }
            ] },
          { name: 'job_succeeded_count', type: :integer },
          { name: 'job_failed_count', type: :integer },
          { name: 'lifetime_task_count', type: :integer },
          { name: 'created_at' },
          { name: 'updated_at' },
          { name: 'last_run_at' },
          { name: 'stopped_at' },
          { name: 'author_name' },
          { name: 'version_author_name' },
          { name: 'version_comment' },
          { name: 'tags', type: :array, of: :string,
            hint: 'Populated only when Include tags is enabled.' }
        ]
      end
    },

    folder_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'parent_id', type: :integer },
          { name: 'created_at' },
          { name: 'updated_at' },
          { name: 'project_id', type: :integer, hint: 'The project to which this folder belongs; not the folder ID.'},
          { name: 'is_project', type: :boolean, hint: 'True when this folder is a project\'s top-level folder.'}
        ]
      end
    },
    
    folder_lookup_obj: {
      fields: lambda do |_connection, _config_fields, object_definitions|
        [
          { name: 'found', type: :boolean, hint: 'True when every segment of the path exists.'}
        ] + object_definitions['folder_obj'] + [
          { name: 'resolved_path', hint: 'The part of the path that exists.' },
          { name: 'last_found_id', type: :integer, 
            hint: 'ID of the deepest folder that exists (e.g., the parent under which to create the first missing segment); empty when nothing matched at the root.' },
          { name: 'missing_segments', type: :array, of: :string, hint: 'Segments yet to be created, in order. Empty when found.' },
          { name: 'missing_count', type: :integer }
        ]
      end
    },

    api_result_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'result', type: :boolean }
        ]
      end
    },

    contract_field: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'name' },
          { name: 'label' },
          { name: 'type' },
          { name: 'control_type' },
          { name: 'optional', type: :boolean },
          { name: 'hint' }
        ]
      end
    },

    project_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer, hint: 'Project ID — what project properties and API clients take. Not the folder ID.' },
          { name: 'name' },
          { name: 'description' },
          { name: 'folder_id', type: :integer,
            hint: 'The project\'s top-level folder — what folder listings, RLCM imports and recipes take.' }
        ]
      end
    },

    # API Platform. Collections and endpoints come from the /api_collections and
    # /api_endpoints resources; clients and keys from the v2 /api_clients resource.
    api_collection_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'version' },
          { name: 'url', hint: 'Collection base URL. Endpoints hang off this — it is the api_base_url a registry row stores.' },
          { name: 'project_id', hint: 'Returned as a string by this endpoint.' }
        ]
      end
    },

    api_endpoint_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'api_collection_id', type: :integer },
          { name: 'flow_id', type: :integer, hint: 'The recipe behind the endpoint.' },
          { name: 'name' },
          { name: 'method' },
          { name: 'path', hint: 'Relative to the collection URL.' },
          { name: 'url' },
          { name: 'active', type: :boolean, hint: 'Only an endpoint whose recipe is running can be active.' }
        ]
      end
    },

    api_client_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'description' },
          { name: 'project_id', type: :integer },
          { name: 'auth_type', hint: 'token | jwt | oauth2 | oidc' },
          { name: 'active_api_keys_count', type: :integer },
          { name: 'total_api_keys_count', type: :integer },
          { name: 'api_collections', type: :array, of: :object,
            hint: 'Collections this client may call.',
            properties: [
              { name: 'id', type: :integer },
              { name: 'name' }
            ] }
        ]
      end
    },

    # No auth_token here: only Create or refresh API key and Refresh API key secret
    # return one, and they add it to this object explicitly.
    api_key_obj: {
      fields: lambda do |connection, config_fields|
        [
          { name: 'id', type: :integer },
          { name: 'name' },
          { name: 'auth_type' },
          { name: 'active', type: :boolean },
          { name: 'active_since' },
          { name: 'ip_allow_list', type: :array, of: :string }
        ]
      end
    }
  },

  # --- ACTIONS -----------------------------------------------------
  actions: {

    # Get environments
    get_environments: {
      title: 'Get environments',
      subtitle: 'Get list of configured environments',
      help: lambda do
        {
          body: 'Returns the environments configured in this connection, optionally filtered by promotion rules. Use Source ' \
                'environment to get only the valid promotion targets for that environment. Use Exclude production to omit ' \
                'production environments from the result.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          {
            name: 'source_environment',
            label: 'Source environment',
            control_type: 'select',
            pick_list: 'environments',
            toggle_hint: 'Use datapill',
            optional: true,
            hint: 'Optional. When set, returns only environments eligible ' \
                  'as the next promotion target. Leave blank to return all.',
            toggle_field: {
              name: 'source_environment', label: 'Source environment', type: :string, control_type: 'text',
              optional: true, toggle_hint: 'Select from list',
              hint: 'A registered environment name exactly as on the connection, e.g. TEST.'
            }
          },
          {
            name: 'exclude_prod',
            type: :boolean,
            control_type: 'checkbox',
            default: 'false',
            optional: true,
            hint: 'When Yes, production environments are excluded from ' \
                  'the results. Defaults to No.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        result = call('get_target_environments', connection, {
          'source_env'   => input['source_environment'],
          'exclude_prod' => input['exclude_prod']
        })

        { 'environments' => result }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'environments',
            type: :array,
            of: :object,
            properties: object_definitions['environment_obj']
          }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'environments' => [{ 'name' => 'TEST', 'is_production' => false, 'level' => 2 }] }
      end
    },

    # Get environment by name
    get_environment_by_name: {
      title: 'Get environment by name',
      subtitle: 'Get details for a single environment',
      help: lambda do
        { body: 'Returns the name, promotion level, and production flag for one configured environment. Useful for branching logic based on environment properties.' }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment', label: 'Workato environment', control_type: 'select', pick_list: 'environments',
            toggle_hint: 'Use datapill', optional: false, hint: 'The environment to look up.',
            toggle_field: {
              name: 'workato_environment', label: 'Workato environment', type: :string, control_type: 'text',
              optional: false, toggle_hint: 'Select from list',
              hint: 'A registered environment name exactly as on the connection, e.g. TEST.'
            } }
        ]
      end,

      execute: lambda do |connection, input|
        env = call('resolve_environment', connection,
                   input['workato_environment'])
        {
          'name'          => env['name'],
          'is_production' => env['is_production'],
          'level'         => env['level']
        }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['environment_obj']
      end,

      sample_output: lambda do |_connection, _input|
        { 'name' => 'DEV', 'is_production' => false, 'level' => 1 }
      end
    },

    # List folder assets
    list_folder_assets: {
      title: 'List folder assets',
      subtitle: 'View the packageable assets in a folder',
      help: lambda do
        { body: 'Returns every asset in a folder that an export manifest can carry — recipes, connections, lookup and data ' \
                'tables, properties, Workflow Apps, API groups and endpoints. Each asset carries a status of added, updated, ' \
                'or no change relative to the last export, so this doubles as a change-detection diff for the folder. ' \
                'Use it to see the asset shape before building an explicit manifest.' }
      end,

      config_fields: [
        { name: 'layout', label: 'Asset layout', control_type: 'select', 
          pick_list: 'asset_layouts', optional: false, default: 'flat', sticky: true,
          hint: 'Flat list: one assets array - the shape Create or update export manifest requires. ' \
                'Grouped by type: one array per asset type for reading and branching. ' \
                'Modifications re-render the output datapills.'}
      ],
      
      input_fields: lambda do |object_definitions, _connection, _config_fields|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Folder ID', optional: true, hint: 'Defaults to the root folder.' },
          { name: 'include_data', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Include asset data (e.g. lookup table rows) in the listing. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        params = {
          'folder_id'    => input['folder_id'],
          'include_data' => (input['include_data'].is_true? ? true : nil)
        }.compact

        response = get("#{dc}/export_manifests/folder_assets", params)
                    .headers(headers)
                    .after_error_response(/.*/) do |_c, b, _h, m|
                      error("List folder assets failed: #{m} — #{b}")
                    end

        assets = Array(call('manifest_result', response)['assets'])

        result = {
          'asset_count'   => assets.length,
          'changed_count' => assets.count { |a| a['status'] != 'no change' }
        }

        if input['layout'] == 'grouped'
          groups = call('group_assets_by_type', assets)
          result['type_counts'] = groups.map { |t, list| { 'type' => t, 'count' => list.length } }
                                        .reject { |c| c['count'].zero? }
          result['by_type'] = groups
        else
          result['assets'] = assets   # nil layout (pre-existing steps) → flat
        end

        result
      end,

      output_fields: lambda do |object_definitions, _connection, config_fields|
        common = [
          { name: 'asset_count', type: :integer },
          { name: 'changed_count', type: :integer,
            hint: 'Assets whose status is added or updated since the last export.' }
        ]

        if config_fields['layout'] == 'grouped'
          common + [
            { name: 'type_counts', type: :array, of: :object,
              hint: 'Types present in the folder and how many of each.',
              properties: [{ name: 'type' }, { name: 'count', type: :integer }] },
            { name: 'by_type', type: :object,
              hint: 'One list per asset type. Unrecognized types are under Other.',
              properties: object_definitions['manifest_asset_groups_obj'] }
          ]
        else
          common + [
            { name: 'assets', type: :array, of: :object,
              properties: object_definitions['manifest_asset_obj'] }
          ]
        end
      end,

      sample_output: lambda do |_connection, input|
        asset  = call('sample_manifest_asset')
        result = { 'asset_count' => 1, 'changed_count' => 1 }

        if input['layout'] == 'grouped'
          result.merge('type_counts' => [{ 'type' => 'recipe', 'count' => 1 }],
                       'by_type'     => call('group_assets_by_type', [asset]))
        else
          result.merge('assets' => [asset])
        end
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Create or update export manifest
    upsert_manifest: {
      title: 'Create or update export manifest',
      subtitle: 'Create a manifest, or re-sync an existing one to its folder',
      help: lambda do
        { body: 'Creates an export manifest, or updates one in place when a Manifest ID is given. With Auto-generate assets ' \
                'on, Workato rebuilds the asset list from the folder on every call, so assets added to the folder since the ' \
                'last run are picked up automatically — this is the mode for "package the whole project". With it off, ' \
                'supply the asset list explicitly (List folder assets shows the shape). Follow with Build package to export.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'manifest_id', label: 'Manifest ID', optional: true,
            hint: 'Leave blank to create a new manifest. Provide an ID to update it in place (assets are replaced, not merged).' },
          { name: 'name', optional: true,
            hint: 'Required when creating. On update, leave blank to keep the existing name.' },
          { name: 'folder_id', label: 'Folder ID', optional: false,
            hint: 'The folder whose assets the manifest describes.' },
          { name: 'auto_generate_assets', type: :boolean, control_type: 'checkbox', default: 'true', optional: true,
            hint: 'Yes: Workato generates the asset list from the folder. No: use the Assets list below. Defaults to Yes.' },
          { name: 'include_tags', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Carry asset tags in the package. Pair with Include tags on Deploy package. Defaults to No.' },
          { name: 'include_test_cases', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Include recipe test cases. Defaults to No.' },
          { name: 'include_data', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Include lookup-table and data-table rows. Usually No when target tables hold per-environment data. Defaults to No.' },
          { name: 'assets', type: :array, of: :object, optional: true,
            hint: 'Ignored when Auto-generate assets is Yes. Same shape as List folder assets; id and type are required.',
            properties: object_definitions['manifest_asset_obj'] }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        manifest_id = input['manifest_id']
        creating    = manifest_id.blank?

        if creating && input['name'].blank?
          error('Name is required when creating a manifest.')
        end

        manifest = {
          'name'               => input['name'],
          'folder_id'          => input['folder_id'],
          'include_tags'       => input['include_tags'].is_true?,
          'include_test_cases' => input['include_test_cases'].is_true?,
          'include_data'       => input['include_data'].is_true?
        }

        # nil = a blank pill or a step saved before the field existed. The hint
        # promises Yes, but a step that maps an asset list has always run in
        # explicit mode; keep that, and default to Yes only when no list is given.
        auto = if input['auto_generate_assets'].nil?
                 input['assets'].blank?
               else
                 input['auto_generate_assets'].is_true?
               end

        if auto
          manifest['auto_generate_assets'] = true
        else
          asset_keys = %w[id type name version folder absolute_path root_folder unreachable zip_name checked]
          assets = Array(input['assets']).map do |a|
            a.select { |k, _v| asset_keys.include?(k) }.compact
          end
          if assets.blank?
            error('Provide at least one asset, or turn on Auto-generate assets.')
          end
          manifest['assets'] = assets
        end

        payload = { 'export_manifest' => manifest.compact }

        response = if creating
                     post("#{dc}/export_manifests")
                       .headers(headers)
                       .payload(payload)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Create manifest failed: #{m} — #{b}")
                       end
                   else
                     put("#{dc}/export_manifests/#{manifest_id}")
                       .headers(headers)
                       .payload(payload)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Update manifest failed: #{m} — #{b}")
                       end
                   end

        call('manifest_result', response)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['manifest_obj']
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_manifest')
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Get export manifest
    get_manifest: {
      title: 'Get export manifest',
      subtitle: 'View an export manifest',
      help: lambda do
        { body: 'Returns a manifest by ID, including last_exported_at — useful for deciding whether the source has changed since the last build.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'manifest_id', label: 'Manifest ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        response = get("#{dc}/export_manifests/#{input['manifest_id']}")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Get manifest failed: #{m} — #{b}")
                     end

        call('manifest_result', response)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['manifest_obj']
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_manifest')
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Delete export manifest
    delete_manifest: {
      title: 'Delete export manifest',
      subtitle: 'Delete an export manifest',
      help: lambda do
        { body: 'Deletes a manifest. Packages already exported from it are unaffected.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'manifest_id', label: 'Manifest ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        response = delete("#{dc}/export_manifests/#{input['manifest_id']}")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Delete manifest failed: #{m} — #{b}")
                     end

        r = call('manifest_result', response)
        { 'success' => r['success'], 'status' => r['status'] }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'success', type: :boolean },
          { name: 'status', hint: 'destroyed on success.' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'success' => true, 'status' => 'destroyed' }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Build package (async)
    build_package: {
      title: 'Build package (async)',
      subtitle: 'Start a build and return immediately',
      help: lambda do
        { body: 'Kicks off a package build in the selected environment and returns the build ID and initial status without ' \
                   'waiting for completion. Use Get build status in a loop or Build and download package if you need to wait.' }
      end,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Projects if the workspace uses Environments; RLCM if it uses Recipe Lifecycle Management.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, config_fields|
        projects = config_fields['deployment_mode'] == 'projects'
        object_definitions['env_selector'] + [
          { name: 'id', label: (projects ? 'Project folder ID' : 'Manifest ID'), optional: false,
            hint: (projects ? 'The project\'s top-level folder ID.' : 'From Create or update export manifest.') },
          (projects ? { name: 'description', optional: true, hint: 'Optional. A note attached to the build.' } : nil)
        ].compact
      end,
      
      execute: lambda do |connection, input|
        env             = call('env_ref', connection, input)
        env_name        = env['name']
        is_projects     = input['deployment_mode'] == 'projects'
        headers         = call('get_auth_headers', connection, env)
        dc              = call('get_datacenter', connection, env)
        url             = call('build_endpoint', dc, input['id'],
                               is_projects, 'build')

        body = if is_projects
                 { 'description' => input['description'] }.compact
               else
                 {}
               end

        response = post(url)
                     .headers(headers)
                     .payload(body)
                     .after_error_response(/.*/) do |_code, resp_body, _h, msg|
                       error("Build failed: #{msg} — #{resp_body}")
                     end

        status = call('normalize_status', response, is_projects)

        {
          'id'                  => response['id'],
          'status'              => status,
          'deployment_mode'     => input['deployment_mode'],
          'workato_environment' => env_name,
          'source_reference'    => input['id'],
          'download_url'        => response['download_url']
        }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['build_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_build', input).merge('status' => 'in_progress', 'download_url' => nil)
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Get build status
    get_build: {
      title: 'Get build status',
      subtitle: 'Check the status of an existing build',
      help: lambda do
        { body: 'Returns the current status of a build. Status is normalized across both deployment modes: in_progress, success, or failed.' }
      end,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Must match the mode the build or deployment was made in.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, _config_fields|
        object_definitions['env_selector'] + [
          { name: 'id', label: 'Build or package ID', optional: false,
            hint: 'The ID returned by Build package or Build and download.' }
        ]
      end,
      
      execute: lambda do |connection, input|
        env         = call('env_ref', connection, input)
        env_name    = env['name']
        is_projects = input['deployment_mode'] == 'projects'
        headers     = call('get_auth_headers', connection, env)
        dc          = call('get_datacenter', connection, env)
        url         = call('build_endpoint', dc, input['id'],
                           is_projects, 'status')

        response = get(url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_code, body, _h, msg|
                       error("Get build status failed: #{msg} — #{body}")
                     end

        status = call('normalize_status', response, is_projects)

        source_ref = if is_projects
                       response['project_id']
                     else
                       response['export_manifest_id']
                     end

        {
          'id'                  => response['id'],
          'status'              => status,
          'deployment_mode'     => input['deployment_mode'],
          'workato_environment' => env_name,
          'source_reference'    => source_ref,
          'download_url'        => response['download_url']
        }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['build_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_build', input)
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Build and download package (long action)
    build_and_download: {
      title: 'Build and download package',
      subtitle: 'Build, wait for completion, and download the result',
      help: lambda do
        { body: 'Starts a package build, polls until it completes, then downloads the binary package content. This is a long ' \
        'action, so the recipe job pauses and resumes automatically. Returns the raw package binary, which can be passed ' \
        'directly to Deploy package. Set Download content to No when you only need to wait for the build — Deploy ' \
        'package fetches the binary from the source itself, so the package_id is all the next step needs.'}
      end,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Projects if the workspace uses Environments; RLCM if it uses Recipe Lifecycle Management.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, config_fields|
        projects = config_fields['deployment_mode'] == 'projects'
        object_definitions['env_selector'] + [
          { name: 'id', label: (projects ? 'Project folder ID' : 'Manifest ID'), optional: false,
            hint: (projects ? 'The project\'s top-level folder ID.' : 'From Create or update export manifest.') },
          (projects ? { name: 'description', optional: true, hint: 'Optional build note.' } : nil),
          { name: 'download_content', type: :boolean, control_type: 'checkbox', default: 'true', optional: true,
            hint: 'No: wait for the build and return only its package_id, keeping the binary out of job data. Defaults to Yes.' }
        ].compact
      end,
      
      execute: lambda do |connection, input, _eis, _eos, continue|
        continue    = continue || {}
        env         = call('env_ref', connection, input)
        env_name    = env['name']
        is_projects = input['deployment_mode'] == 'projects'
        headers     = call('get_auth_headers', connection, env)
        dc          = call('get_datacenter', connection, env)

        finish_args = {
          'dc'               => dc,
          'headers'          => headers,
          'env_name'         => env_name,
          'is_projects'      => is_projects,
          'deployment_mode'  => input['deployment_mode'],
          'download_content' => input['download_content']
        }

        if continue['job_id'].blank?
          # ── First invocation: kick off the build ──────────
          build_url = call('build_endpoint', dc, input['id'],
                           is_projects, 'build')

          body = if is_projects
                   { 'description' => input['description'] }.compact
                 else
                   {}
                 end

          response = post(build_url)
                       .headers(headers)
                       .payload(body)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Build failed: #{m} — #{b}")
                       end

          status = call('normalize_status', response, is_projects)

          if status == 'success'
            # Build completed immediately (rare but possible)
            call('finish_build', finish_args.merge('response' => response))
          else
            call('poll_or_reinvoke', {
              'status'   => status,
              'response' => response,
              'continue' => continue
            })
          end

        else
          # ── Reinvocation: check build status ──────────────
          status_url = call('build_endpoint', dc, continue['job_id'],
                            is_projects, 'status')

          response = get(status_url)
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Build status check failed: #{m} — #{b}")
                       end

          status = call('normalize_status', response, is_projects)

          if status == 'success'
            call('finish_build', finish_args.merge('response' => response))
          else
            call('poll_or_reinvoke', {
              'status'   => status,
              'response' => response,
              'continue' => continue
            })
          end
        end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['package_content_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_package_content', input)
      end
    },

    # Download package
    download_existing_package: {
      title: 'Download package',
      subtitle: 'Download a previously completed build',
      help: lambda do
        { body: 'Downloads the binary content of a build that has already completed. Use this when you have ' \
        'confirmed a build succeeded via Get build status and want to retrieve the package separately.'}
      end,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Must match the mode the build or deployment was made in.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, _config_fields|
        object_definitions['env_selector'] + [
          { name: 'id', label: 'Build or package ID', optional: false, hint: 'The ID of the completed build.' }
        ]
      end,
      
      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        call('download_package', {
          'headers'         => headers,
          'dc'              => dc,
          'env_name'        => env['name'],
          'package_id'      => input['id'].to_s,
          'deployment_mode' => input['deployment_mode']
        })
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['package_content_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_package_content', input)
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Deploy package (long action)
    deploy_package: {
      title: 'Deploy package',
      subtitle: 'Deploy a package to a target environment',
      help: lambda do
        { body:
          'Deploys a built package from one environment to another. This is a long action; the recipe job ' \
          'pauses and resumes automatically while waiting for completion. Projects mode deploys a build to a ' \
          'registered environment of the same workspace: the deploy and every status poll run through the source ' \
          '(DEV) environment, because deployment endpoints exist only there, and the target is named by ' \
          'environment_type. RLCM mode downloads the package binary from the source and uploads it to the target ' \
          'folder, which may be a workspace resolved at runtime. Check the mode-specific gates: all_recipes_ok in ' \
          'RLCM (a completed import can leave recipes stopped); detailed_state in Projects (a workspace with ' \
          'review-and-approval on holds a deployment at pending_review, which this action reports as a timeout).'
        }
      end,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Must match the mode the build or deployment was made in.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, _config_fields|
        object_definitions['deploy_input_fields']
      end,
      
      execute: lambda do |connection, input, _eis, _eos, continue|
        continue    = continue || {}
        is_projects = input['deployment_mode'] == 'projects'
        target_env  = call('resolve_target_env', connection, input)

        # Projects: build, deploy and deployment status are DEV-only, so the poll
        # goes to the source. RLCM: the import is polled on the target.
        status_env  = is_projects ? input['source_environment'] : target_env

        response =
          if continue['job_id'].blank?
            # ── First invocation: start deployment ────────────
            call('start_deployment', connection, input, target_env)
          else
            # ── Reinvocation: check deployment status ─────────
            headers = call('get_auth_headers', connection, status_env)
            dc      = call('get_datacenter', connection, status_env)

            get(call('build_endpoint', dc, continue['job_id'], is_projects, 'deploy_status'))
              .headers(headers)
              .after_error_response(/.*/) do |_c, b, _h, m|
                error("Deployment status check failed: #{m} — #{b}")
              end
          end

        status = call('normalize_status', response, is_projects)

        if status == 'success'
          call('deployment_result', response, status, is_projects)
        else
          # in_progress → reinvoke later; failed → error with detail
          call('poll_or_reinvoke', {
            'status'   => status,
            'response' => response,
            'continue' => continue
          })
        end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['deployment_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_deployment', input, false)
      end
    },

    # Deploy package (async)
    deploy_package_async: {
      title: 'Deploy package (async)',
      subtitle: 'Start a deployment and return immediately',
      help: lambda do
        { body: 'Starts a deployment without waiting for it to finish. Returns the deployment ID and initial status. ' \
                'Projects mode starts it through the source (DEV) environment; follow with Get deployment status ' \
                'against the same source environment. RLCM mode starts the import on the target. Useful when ' \
                'deploying to several environments in parallel.' }
      end,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Must match the mode the build or deployment was made in.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, _config_fields|
        object_definitions['deploy_input_fields']
      end,
      
      execute: lambda do |connection, input|
        is_projects = input['deployment_mode'] == 'projects'
        target_env  = call('resolve_target_env', connection, input)

        response = call('start_deployment', connection, input, target_env)
        status   = call('normalize_status', response, is_projects)

        call('deployment_result', response, status, is_projects)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['deployment_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_deployment', input, true)
      end
    },

    # Get deployment status
    get_deployment: {
      title: 'Get deployment status',
      subtitle: 'Check the status of a deployment',
      help: lambda do
        { body: 'Returns the current status of a deployment. Status is normalized across both modes: in_progress, ' \
                'success, or failed. Projects: select the environment the deployment was started from (DEV) — ' \
                'deployment endpoints exist only there — and read detailed_state and assets. RLCM: select the ' \
                'target; a finished import returns recipe_status and all_recipes_ok.' }

      end,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Must match the mode the build or deployment was made in. Projects: the environment below must be the one the deployment was started from, not the one deployed to.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, _config_fields|
        object_definitions['env_selector'] + [
          { name: 'id', label: 'Deployment ID', optional: false, hint: 'The ID returned by Deploy package.' }
        ]
      end,
      
      execute: lambda do |connection, input|
        env         = call('env_ref', connection, input)
        is_projects = input['deployment_mode'] == 'projects'
        headers     = call('get_auth_headers', connection, env)
        dc          = call('get_datacenter', connection, env)

        response = get(call('build_endpoint', dc, input['id'], is_projects, 'deploy_status'))
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Get deployment status failed: #{m} — #{b}")
                     end

        status = call('normalize_status', response, is_projects)
        call('deployment_result', response, status, is_projects)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['deployment_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_deployment', input, false)
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # List folders
    list_folders: {
      title: 'List folders',
      subtitle: 'List folders in an environment, optionally with every subfolder',
      help: lambda do
        { body: 'Returns the folders directly under a parent folder (blank = the top level), 100 per page. ' \
                'With Include subfolders = Yes it walks the whole tree below the parent instead and returns every ' \
                'folder with its full path and depth, sorted by path. That costs one request per folder, so it ' \
                'stops with an error above 1,000 folders or when the walk would outrun the action time limit; ' \
                'start from a Parent ID lower in the tree. Use Get folder to place one folder ID.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          {
            name: 'parent_id',
            optional: true,
            hint: 'Optional. Folder ID to list only its children. ' \
                  'Leave blank for root-level folders.'
          },
          {
            name: 'page',
            type: :integer,
            default: '1',
            hint: 'Page number for pagination. Defaults to 1. Ignored when Include subfolders is Yes.'
          },
          {
            name: 'include_subfolders', label: 'Include subfolders', type: :boolean, control_type: 'checkbox',
            default: 'false', optional: true,
            hint: 'Yes: return every folder below the parent, at any depth, with its path. Defaults to No.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        # nil = a step saved before the field existed; one level, as before.
        if input['include_subfolders'].is_true?
          next { 'folders_list' => call('folder_tree', dc, headers, input['parent_id'], env['name']) }
        end

        page = input['page'] || 1
        url  = "#{dc}/folders?page=#{page}&per_page=100"
        url  = "#{url}&parent_id=#{input['parent_id']}" if input['parent_id'].present?

        response = get(url)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List folders failed: #{m} — #{b}")
                     end

        { 'folders_list' => call('list_body', response) }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'folders_list',
            type: :array,
            of: :object,
            properties: object_definitions['folder_obj'] + [
              { name: 'path', hint: 'Include subfolders only. Full path from the top, e.g. /Clients/Acme/Templates.' },
              { name: 'depth', type: :integer, hint: 'Include subfolders only. 1 for a top-level folder.' }
            ]
          }
        ]
      end,

      sample_output: lambda do |_connection, input|
        folder = call('sample_folder')

        if input['include_subfolders'].is_true?
          { 'folders_list' => [
            folder.merge('path' => '/Orders', 'depth' => 1, 'parent_id' => nil),
            folder.merge('id' => 1302, 'name' => 'Templates', 'parent_id' => 1301,
                         'path' => '/Orders/Templates', 'depth' => 2)
          ] }
        else
          { 'folders_list' => [folder] }
        end
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Get folder
    get_folder: {
      title: 'Get folder',
      subtitle: 'Get a folder and its full path by ID',
      help: lambda do
        { body: 'Returns one folder and its full path from the top, e.g. /Clients/Acme/Templates. Use it to place ' \
                'a folder_id from Get recipe or List connections. Follows parent folders one request per level.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Folder ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        folder = call('read_folder', dc, headers, input['folder_id'], env['name'])
        chain  = call('folder_chain', dc, headers, folder, env['name'])

        call('folder_summary', folder).merge(
          'workato_environment' => env['name'],
          'path'                => call('folder_path', chain),
          'depth'               => chain.length,
          'ancestors'           => chain[0..-2].map { |f| { 'id' => f['id'], 'name' => f['name'] } }
        )
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['folder_obj'] + [
          { name: 'workato_environment' },
          { name: 'path', hint: 'Full path from the top, e.g. /Clients/Acme/Templates.' },
          { name: 'depth', type: :integer, hint: '1 for a top-level folder.' },
          { name: 'ancestors', type: :array, of: :object, hint: 'Parent folders, top first. Empty for a top-level folder.',
            properties: [{ name: 'id', type: :integer }, { name: 'name' }] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_folder').merge(
          'id' => 1302, 'name' => 'Templates', 'parent_id' => 1301, 'workato_environment' => 'DEV',
          'path' => '/Orders/Templates', 'depth' => 2, 'ancestors' => [{ 'id' => 1301, 'name' => 'Orders' }]
        )
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Create folder
    create_folder: {
      title: 'Create folder',
      subtitle: 'Create a new folder in an environment',
      help: lambda do
        { body: 'Creates a folder in the selected environment. Optionally nest it under a parent folder.'}
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          {
            name: 'folder_name',
            optional: false,
            hint: 'The name for the new folder.'
          },
          {
            name: 'parent_id',
            optional: true,
            hint: 'Optional. Parent folder ID. Leave blank for root level.'
          }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        created = post("#{dc}/folders")
          .headers(headers)
          .payload({
            'name'      => input['folder_name'],
            'parent_id' => input['parent_id']
          }.compact)
          .after_error_response(/.*/) { |_c, b, _h, m|
            error("Create folder failed: #{m} — #{b}") }
        new_id = (call('resolve_response', created) || {})['id']
        error('Create folder returned no ID.') if new_id.blank?

        get("#{dc}/folders/#{new_id}")
            .headers(headers)
            .after_error_response(/.*/) { |_c, b, _h, m| error("Read folder #{new_id} after create failed: #{m} - #{b}") }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['folder_obj']
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_folder')
      end

      # No retries: a 429 on the read-back would rerun the POST and create a
      # second folder.
    },

    # Delete folder
    delete_folder: {
      title: 'Delete folder',
      subtitle: 'Delete a non-project folder, optionally with the recipes and connections in it',
      help: lambda do
        { body: 'Deletes one folder. Refuses before any call when the folder is a project\'s top-level folder — ' \
                'that is Clean project\'s job. With Force = No the API refuses a folder that still holds recipes ' \
                'or connections, and that message is surfaced as-is; Force = Yes deletes them with the folder. ' \
                'Idempotent: a folder that is already gone returns success = true. The use case is the Home ' \
                'subfolder an earlier import created in a workspace where Home is a project.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Folder ID', optional: false,
            hint: 'A non-project folder. A project\'s top-level folder is refused; use Clean project for that.' },
          { name: 'force', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Yes: delete the recipes and connections inside it too. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)
        id      = input['folder_id']

        # ── Guard: read the folder first ──────────────────
        # 404 = already gone, which is the state asked for. Anything else must
        # be a Hash before is_project is read from it; an unreadable body fails
        # closed, never on to the delete.
        gone   = false
        lookup = get("#{dc}/folders/#{id}")
                   .headers(headers)
                   .after_error_response(/.*/) do |code, b, _h, m|
                     if code.to_i == 404
                       gone = true
                     else
                       error("Read folder #{id} failed in #{env['name']}: #{m} — #{b}")
                     end
                   end
        body   = call('resolve_response', lookup)
        if !gone && !body.is_a?(::Hash)
          error("Read folder #{id} in #{env['name']} returned no folder record; refusing to delete " \
                'without confirming it is not a project folder.')
        end
        folder = gone ? {} : body

        if gone
          { 'workato_environment' => env['name'], 'folder_id' => id, 'success' => true,
            'status' => 'gone', 'message' => "Folder #{id} is already gone; nothing deleted." }
        elsif folder['is_project'].is_true?
          error("Folder #{id} (#{folder['name']}) is the top-level folder of project " \
                "#{folder['project_id']} in #{env['name']}; refusing. Use Clean project.")
        else
          url = "#{dc}/folders/#{id}"
          url = "#{url}?force=true" if input['force'].is_true?

          result = call('delete_or_gone', url, headers, "Delete folder #{id}", env['name'])

          { 'workato_environment' => env['name'], 'folder_id' => id, 'success' => true,
            'status' => result.to_s,
            'message' => (result == :deleted ? "Folder #{id} (#{folder['name']}) deleted." \
                                             : "Folder #{id} was already gone.") }
        end
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'folder_id' },
          { name: 'success', type: :boolean },
          { name: 'status', hint: 'deleted | gone (already absent before this call).' },
          { name: 'message' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'workato_environment' => 'TEST', 'folder_id' => '1302', 'success' => true, 'status' => 'deleted',
          'message' => 'Folder 1302 (Home) deleted.' }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # List projects
    list_projects: {
      title: 'List projects',
      subtitle: 'List projects, or resolve a folder to its project ID',
      help: lambda do
        { body: 'Returns every project in the selected environment. A project\'s ID is not its folder ID: project ' \
                'properties and API clients take the project ID, while folders, imports and recipes take the folder ID. ' \
                'Give a Folder ID or a Name to resolve one project — found and match carry the answer. More than one ' \
                'match is an error.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Folder ID', optional: true,
            hint: 'Resolve the project whose top-level folder this is (e.g. the folder Deploy package imported into).' },
          { name: 'name', optional: true, hint: 'Exact project name to resolve.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        # Every page: a resolve that reads one page reports a real project as absent.
        projects  = call('list_all_projects', dc, headers, env['name'])
        resolving = input['folder_id'].present? || input['name'].present?
        match     = resolving ? call('match_project', projects, input['folder_id'], input['name'], env['name']) : nil

        {
          'workato_environment' => env['name'],
          'project_count'       => projects.length,
          'found'               => resolving && !match.nil?,
          'match'               => match,
          'projects'            => projects
        }.compact
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'project_count', type: :integer },
          { name: 'found', type: :boolean, hint: 'True when a Folder ID or Name was given and one project matched it.' },
          { name: 'match', type: :object, properties: object_definitions['project_obj'] },
          { name: 'projects', type: :array, of: :object, properties: object_definitions['project_obj'] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        project = call('sample_project')
        { 'workato_environment' => 'DEV', 'project_count' => 1, 'found' => true, 'match' => project, 'projects' => [project] }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Get recipe
    get_recipe: {
      title: 'Get recipe',
      subtitle: 'Get full details for a single recipe, including its code',
      help: lambda do |input, picklist_label|
        {
          body: 'Returns the full definition of one recipe, including the code field (the JSON step tree). Unlike List recipes, the single-recipe endpoint always returns code, so this is the action to use when you need the recipe body for inspection or spec generation.'
        }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'recipe_id', label: 'Recipe ID', optional: false, hint: 'The ID of the recipe to fetch.' },
          { name: 'include_tags', type: :boolean, control_type: 'checkbox', default: 'false', optional: true, hint: 'When Yes, includes tag handles in the response. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        url = "#{dc}/recipes/#{input['recipe_id']}"
        url = "#{url}?includes[]=tags" if input['include_tags'].is_true?

        get(url)
          .headers(headers)
          .after_error_response(/.*/) do |_c, b, _h, m|
            error("Get recipe failed: #{m} — #{b}")
          end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['recipe_detail_obj']
      end,

      sample_output: lambda do |_connection, _input|
        {
          'id' => 3101, 'name' => 'Get order', 'description' => 'Returns one order from the ERP.', 'folder_id' => 1301,
          'project_id' => 77, 'running' => true, 'version_no' => 4, 'trigger_application' => 'workato_recipe_function',
          'action_applications' => %w[google_drive], 'applications' => %w[workato_recipe_function google_drive],
          'code' => '{"number":0,"provider":"workato_recipe_function","name":"execute","block":[]}',
          'config' => [{ 'keyword' => 'application', 'name' => 'google_drive', 'provider' => 'google_drive',
                         'account_id' => 4101, 'skip_validation' => false }],
          'job_succeeded_count' => 120, 'job_failed_count' => 2, 'lifetime_task_count' => 480,
          'created_at' => '2026-09-01T09:00:00Z', 'updated_at' => '2026-10-01T09:30:00Z',
          'last_run_at' => '2026-10-12T16:05:00Z', 'stopped_at' => nil, 'author_name' => 'Builder',
          'version_author_name' => 'Builder', 'version_comment' => 'Add order lookup', 'tags' => []
        }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Recipe to spec (pure transform)
    recipe_to_spec: {
      title: 'Recipe to spec',
      subtitle: "Walk a recipe's code tree into a contract spec",
      help: lambda do
        { body: 'Pure transform: takes a recipe code JSON string (from Get recipe, a package export, or a stored snapshot) and ' \
          'emits a contract-style spec. No API call is made. When inspecting a live recipe, prefer Inspect recipe, which ' \
          'fetches and transforms in one step.'}
      end,

      input_fields: lambda do |_object_definitions|
        [
          { name: 'code',             label: 'Recipe code (JSON string)', optional: false, hint: 'The <b>code</b> field from GET /api/recipes/:id.' },
          { name: 'recipe_id',        label: 'Recipe ID',                 optional: true },
          { name: 'recipe_name',      label: 'Recipe name',               optional: true },
          { name: 'folder',           label: 'Folder or project path',    optional: true },
          { name: 'output_step_hint', label: 'Output step hint',          optional: true,  hint: 'Substring matched against a step name/title to choose the return/response step (e.g. "return", "respond"). Leave blank to use the last step.' }
        ]
      end,

      execute: lambda do |_connection, input|
        call('build_spec', {
          'code'             => input['code'],
          'recipe_id'        => input['recipe_id'],
          'recipe_name'      => input['recipe_name'],
          'folder'           => input['folder'],
          'output_step_hint' => input['output_step_hint']
        })
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'spec_json',        label: 'Spec (JSON string)' },
          { name: 'recipe_name' },
          { name: 'trigger_provider' },
          { name: 'trigger_name' },
          { name: 'step_count', type: 'integer' },
          { name: 'connectors_used', type: 'array', of: 'string' },
          { name: 'recipes_called', type: 'array', of: 'string', hint: 'Distinct recipe-function callees (call-graph edges).'},
          { name: 'tables_used', type: 'array', of: 'string', hint: 'Distinct data table identifiers touched by this recipe.' },
          { name: 'input_contract',  type: 'array', of: 'object', properties: object_definitions['contract_field'] },
          { name: 'output_contract', type: 'array', of: 'object', properties: object_definitions['contract_field'] },
          { name: 'steps', type: 'array', of: 'object', properties: [
            { name: 'path' },
            { name: 'depth', type: 'integer' },
            { name: 'keyword' },
            { name: 'provider' },
            { name: 'name' },
            { name: 'as' },
            { name: 'title' }
          ] },
          { name: 'log' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_spec')
      end
    },

    # Inspect recipe
    inspect_recipe: {
      title: 'Inspect recipe',
      subtitle: 'Fetch a recipe and emit its contract spec in one call',
      help: lambda do
        {body: 'Fetches the full recipe definition from the selected environment, then walks its code tree into a contract spec. Recipe ' \
         'ID, name, folder, and environment are stamped into the spec from the live fetch, and connection bindings from ' \
         'the recipe config block are folded in. Use in a List recipes → repeat loop for estate-wide spec generation and drift detection.'}
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'recipe_id',        label: 'Recipe ID', optional: false, hint: 'The ID of the recipe to fetch and inspect.' },
          { name: 'output_step_hint', label: 'Output step hint', optional: true, hint: 'Substring matched against a step name/title to choose the return/response step (e.g. "return", "respond"). Leave blank to use the last step.' },
          { name: 'include_tags',     type: :boolean, control_type: 'checkbox', default: 'false', optional: true, hint: 'When Yes, tag handles are fetched and passed through in the output. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        env_name = env['name']

        call('inspect_one', {
          'headers'          => call('get_auth_headers', connection, env),
          'dc'               => call('get_datacenter', connection, env),
          'env_name'         => env_name,
          'recipe_id'        => input['recipe_id'],
          'output_step_hint' => input['output_step_hint'],
          'include_tags'     => input['include_tags']
        })
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'spec_json', label: 'Spec (JSON string)' },
          { name: 'workato_environment' },
          { name: 'recipe_id', type: :integer },
          { name: 'recipe_name' },
          { name: 'folder_id', type: :integer },
          { name: 'running', type: :boolean },
          { name: 'version_no', type: :integer },
          { name: 'updated_at' },
          { name: 'trigger_provider' },
          { name: 'trigger_name' },
          { name: 'step_count', type: :integer },
          { name: 'connectors_used', type: :array, of: :string },
          { name: 'recipes_called', type: :array, of: :string, hint: 'Distinct recipe-function callees (call-graph edges).' },
          { name: 'tables_used', type: :array, of: :string, hint: 'Distinct data table identifiers touched by this recipe.' },
          { name: 'connection_bindings', type: :array, of: :object, properties: [
            { name: 'keyword' },
            { name: 'provider' },
            { name: 'name' },
            { name: 'account_id', type: :integer }
          ] },
          { name: 'input_contract',  type: :array, of: :object, properties: object_definitions['contract_field'] },
          { name: 'output_contract', type: :array, of: :object, properties: object_definitions['contract_field'] },
          { name: 'steps', type: :array, of: :object, properties: [
            { name: 'path' },
            { name: 'depth', type: :integer },
            { name: 'keyword' },
            { name: 'provider' },
            { name: 'name' },
            { name: 'as' },
            { name: 'title' },
            { name: 'calls_recipe' },
            { name: 'table_id' }
          ] },
          { name: 'tags', type: :array, of: :string },
          { name: 'log' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_spec').merge(
          'workato_environment' => 'DEV', 'recipe_id' => 3101, 'folder_id' => 1301, 'running' => true, 'version_no' => 4,
          'updated_at' => '2026-10-01T09:30:00Z',
          'connection_bindings' => [{ 'keyword' => 'application', 'provider' => 'google_drive', 'name' => 'google_drive',
                                      'account_id' => 4101 }],
          'tags' => []
        )
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Inspect recipes (batch)
    inspect_recipes: {
      title: 'Inspect recipes (batch)',
      subtitle: 'Fetch and spec a group of recipes in one call',
      batch: true,
      help: lambda do
        {body: 'Runs Inspect recipe over a group: either an explicit list of recipe IDs or every recipe in a folder. Fetches ' \
        'are sequential; a failure on one recipe is recorded in the errors list and the batch continues. Batches are ' \
        'capped at 50 recipes to stay inside the SDK action timeout — chunk larger estates by folder. Successful ' \
        'specs are returned per recipe and also combined into specs_json.'}
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'recipe_ids',       label: 'Recipe IDs', optional: true, hint: 'Comma-separated recipe IDs, or a JSON array such as [12,34]. From a List recipes step, use the formula <b>items.pluck(:id).join(",")</b>. Provide this or Folder ID, not both.' },
          { name: 'folder_id',        label: 'Folder ID',  optional: true, hint: 'Inspect every recipe directly in this folder (50 at most). Provide this or Recipe IDs, not both.' },
          { name: 'output_step_hint', label: 'Output step hint', optional: true, hint: 'Substring matched against a step name/title to choose the return/response step (e.g. "return", "respond"). Applied to every recipe in the batch. Leave blank to use the last step.' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        env_name = env['name']
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        ids_given    = input['recipe_ids'].present?
        folder_given = input['folder_id'].present?

        if ids_given && folder_given
          error('Provide Recipe IDs or Folder ID, not both.')
        end
        if !ids_given && !folder_given
          error('Provide Recipe IDs or a Folder ID.')
        end

        # Every page of the folder, so a folder over 100 recipes hits the cap
        # below instead of being silently cut to its first page.
        ids = if ids_given
                call('id_list', input['recipe_ids'])
              else
                call('list_all_recipes', dc, headers, input['folder_id'], env_name).map { |r| r['id'].to_s }
              end

        error('No recipes to inspect.') if ids.blank?
        if ids.length > 50
          error("Batch of #{ids.length} recipes exceeds the 50-recipe cap " \
                '(SDK actions have a 180-second execution limit). Split the ' \
                'batch — run per folder, or chunk the ID list.')
        end

        results = []
        errors  = []

        ids.each do |rid|
          begin
            one = call('inspect_one', {
              'headers'          => headers,
              'dc'               => dc,
              'env_name'         => env_name,
              'recipe_id'        => rid,
              'output_step_hint' => input['output_step_hint']
            })

            results << {
              'recipe_id'       => one['recipe_id'],
              'recipe_name'     => one['recipe_name'],
              'folder_id'       => one['folder_id'],
              'running'         => one['running'],
              'version_no'      => one['version_no'],
              'updated_at'      => one['updated_at'],
              'step_count'      => one['step_count'],
              'connectors_used' => one['connectors_used'],
              'recipes_called'  => one['recipes_called'],
              'tables_used'     => one['tables_used'],
              'spec_json'       => one['spec_json'],
              'log'             => one['log']
            }.compact
          rescue StandardError => e
            errors << { 'recipe_id' => rid, 'error' => e.message }
          end
        end

        {
          'requested_count' => ids.length,
          'succeeded_count' => results.length,
          'failed_count'    => errors.length,
          'specs_json'      => "[#{results.map { |r| r['spec_json'] }.join(',')}]",
          'results'         => results,
          'errors'          => errors
        }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'requested_count', type: :integer },
          { name: 'succeeded_count', type: :integer },
          { name: 'failed_count',    type: :integer },
          { name: 'specs_json', label: 'Specs (JSON array string)',
            hint: 'All successful specs combined into one JSON array — ' \
                  'write straight to FileStorage, Drive, or GCS.' },
          { name: 'results', type: :array, of: :object, properties: [
            { name: 'recipe_id', type: :integer },
            { name: 'recipe_name' },
            { name: 'folder_id', type: :integer },
            { name: 'running', type: :boolean },
            { name: 'version_no', type: :integer },
            { name: 'updated_at' },
            { name: 'step_count', type: :integer },
            { name: 'connectors_used', type: :array, of: :string },
            { name: 'recipes_called', type: :array, of: :string },
            { name: 'tables_used', type: :array, of: :string },
            { name: 'spec_json' },
            { name: 'log' }
          ] },
          { name: 'errors', type: :array, of: :object, properties: [
            { name: 'recipe_id' },
            { name: 'error' }
          ] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        spec = call('sample_spec')
        {
          'requested_count' => 2, 'succeeded_count' => 1, 'failed_count' => 1,
          'specs_json' => "[#{spec['spec_json']}]",
          'results' => [{ 'recipe_id' => 3101, 'recipe_name' => 'Get order', 'folder_id' => 1301, 'running' => true,
                          'version_no' => 4, 'updated_at' => '2026-10-01T09:30:00Z', 'step_count' => spec['step_count'],
                          'connectors_used' => spec['connectors_used'], 'recipes_called' => [], 'tables_used' => [],
                          'spec_json' => spec['spec_json'], 'log' => '' }],
          'errors' => [{ 'recipe_id' => '3109', 'error' => 'Recipe 3109 fetch failed: 404 Not Found' }]
        }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # List recipes
    list_recipes: {
      title: 'List recipes',
      subtitle: 'List recipes in an environment',
      help: lambda do
        { body: 'Returns recipes from the selected environment. Optionally filter to a specific folder.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', optional: true, sticky: true, hint: 'Optional. Folder ID to list only recipes in that folder.' },
          { name: 'page', type: :integer, optional: true, default: '1',
            hint: 'Page number, 100 recipes per page. Defaults to 1.' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        # nil page = a step saved before the field existed; page 1, as the
        # API's default was.
        params = { 'page' => (input['page'].presence || 1), 'per_page' => 100 }
        params['folder_id'] = input['folder_id'] if input['folder_id'].present?

        response = get("#{dc}/recipes", params)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List recipes failed: #{m} — #{b}")
                     end

        { 'items' => call('list_body', response) }
      end,

      output_fields: lambda do |object_definitions|
        [
          {
            name: 'items',
            type: :array,
            of: :object,
            properties: object_definitions['recipe_obj']
          }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'items' => [{ 'id' => 3101, 'name' => 'Get order', 'folder_id' => '1301', 'running' => true }] }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Manage recipe
    manage_recipe: {
      title: 'Manage recipe',
      subtitle: 'Start, stop, or delete a recipe',
      help: lambda do
        { body: 'Performs a lifecycle action on a single recipe. Start  activates the recipe. Stop pauses it. Delete permanently removes it.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'recipe_action', control_type: 'select', pick_list: 'recipe_actions', toggle_hint: 'Use datapill',
            optional: false, hint: 'The action to perform: Start, Stop, or Delete.' },
          { name: 'recipe_id', optional: false, hint: 'The ID of the recipe to manage.' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)
        action   = input['recipe_action']
        error("Unknown recipe action: '#{action}'. Use start, stop or delete.") unless %w[start stop delete].include?(action)
        url      = "#{dc}/recipes/#{input['recipe_id']}"

        response = if action == 'delete'
                     delete(url)
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Delete recipe failed: #{m} — #{b}")
                       end
                   else
                     put("#{url}/#{action}")
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("#{action.capitalize} recipe failed: " \
                               "#{m} — #{b}")
                       end
                   end

        { 'result' => call('success_flag', response) }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['api_result_obj']
      end,

      sample_output: lambda do |_connection, _input|
        { 'result' => true }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Set recipes state (long action)
    set_recipes_state: {
      title: 'Set recipes state',
      subtitle: 'Start or stop a list of recipes in the order given, paced to the API quota',
      batch: true,
      help: lambda do
        { body: 'Starts or stops recipes one at a time, in the order given — the ordered_ids from your sequencing ' \
                'step, already reversed for stop. This is a long action: it works through up to 40 recipes per ' \
                'invocation, then sleeps 60 seconds if any remain, and does the same the moment the Recipes quota ' \
                '(60 per minute) answers 429, resuming where it stopped. A recipe the API refuses to start — an ' \
                'unauthorized connection, say — lands in failed with the API\'s message and the run carries on. ' \
                'Give the Folder ID and the folder is listed once at the end, so all_ok and each running flag come ' \
                'from the API rather than from the requests sent. An empty list is a no-op: nothing is called and ' \
                'all_ok is true, so a sequencing step that finds every recipe already in state needs no branch here. ' \
                'No retries on this action — a rerun would restart the list from the top.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'action', control_type: 'select', pick_list: 'recipe_state_actions', toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Start or Stop. Chooses the API verb and what "in state" means for the check at the end; the order is yours.' },
          { name: 'recipe_ids', label: 'Recipe IDs', optional: true,
            hint: 'A JSON array of recipe IDs in the order to act on, e.g. [123,456] — the ordered_ids output of your ' \
                  'sequencing step (map the pill with the <b>.to_json</b> formula). Comma-separated also works. ' \
                  'Blank or [] does nothing and returns all_ok = true.' },
          { name: 'folder_id', label: 'Folder ID', optional: true,
            hint: 'Recommended. When set, the folder is listed once at the end and every result is checked against ' \
                  'the API (every recipe directly in the folder). Blank = all_ok rests on the start/stop responses alone.' }
        ]
      end,

      execute: lambda do |connection, input, _eis, _eos, continue|
        continue = continue || {}
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        action = input['action']
        error("Unknown recipe state action: #{action}") unless %w[start stop].include?(action)
        want_running = action == 'start'
        outcome_ok   = want_running ? 'started' : 'stopped'

        # Pacing. batch_size sits under the 60/min Recipes quota and, at a few
        # seconds per call, the 180 s action limit; the deadline catches slow calls.
        # max_steps bounds the whole run: 400 recipes, or ten minutes of 429s.
        batch_size = 40
        max_steps  = 10
        deadline   = now + 2.minutes

        if continue['step'].blank?
          # ── First invocation: take the list as given ──────
          queue = call('id_list', input['recipe_ids'])
          done  = []
          step  = 1
        else
          # ── Reinvocation: resume where the last one stopped
          queue = continue['queue'] || []
          done  = continue['done']  || []
          step  = continue['step'].to_i
        end

        budget       = batch_size
        rate_limited = false

        while queue.present? && budget > 0 && !rate_limited && now < deadline
          rid = queue.first

          begin
            # A 429 sets the flag from inside the handler; anything else raises
            # and is recorded below. The block's return value is not relied on.
            response = put("#{dc}/recipes/#{rid}/#{action}")
                         .headers(headers)
                         .after_error_response(/.*/) do |code, b, _h, m|
                           if code.to_i == 429
                             rate_limited = true
                           else
                             error("#{action.capitalize} recipe #{rid} failed: #{m} — #{b}")
                           end
                         end
            call('resolve_response', response)

            unless rate_limited
              done << { 'id' => rid.to_i, 'outcome' => outcome_ok }
              queue = queue.drop(1)
              budget -= 1
            end
          rescue StandardError => e
            done << { 'id' => rid.to_i, 'outcome' => 'failed', 'error' => e.message }
            queue = queue.drop(1)
            budget -= 1
          end
        end

        if queue.present?
          if step >= max_steps
            failed_so_far = done.count { |r| r['outcome'] == 'failed' }
            error("Set recipes state stopped after #{max_steps} invocations with #{queue.length} recipes left " \
                  "(#{done.length - failed_so_far} #{outcome_ok}, #{failed_so_far} failed). Rerun for the remainder.")
          end

          reinvoke_after(
            seconds: 60,
            continue: { 'queue' => queue, 'done' => done, 'step' => step + 1 }
          )
        end

        # ── Done: check against the API when a folder was given ──
        results  = done
        checking = input['folder_id'].present? && done.present?

        if checking
          by_id = call('list_all_recipes', dc, headers, input['folder_id'], env['name'])
                    .each_with_object({}) { |r, h| h[r['id'].to_s] = r }

          results = done.map do |r|
            rec = by_id[r['id'].to_s]
            if rec.nil?
              r                                   # not in this folder; cannot be checked
            elsif r['outcome'] != 'failed' && rec['running'] != want_running
              r.merge('name' => rec['name'], 'running' => rec['running'], 'outcome' => 'failed',
                      'error' => "#{action.capitalize} was accepted but the recipe reports running = #{rec['running']}.")
            else
              r.merge('name' => rec['name'], 'running' => rec['running'])
            end
          end
        end

        # Verified only when every recipe acted on was found in the folder; one
        # outside it rests on its start/stop response alone.
        verified = checking && results.all? { |r| r.key?('running') }
        failed   = results.select { |r| r['outcome'] == 'failed' }

        {
          'workato_environment' => env['name'],
          'action'              => action,
          'recipe_count'        => results.length,
          'changed_count'       => results.length - failed.length,
          'failed_count'        => failed.length,
          'invocations'         => step,
          'verified'            => verified,
          'all_ok'              => failed.empty?,
          'failed'              => failed,
          'results'             => results
        }
      end,

      output_fields: lambda do |_object_definitions|
        result_fields = [
          { name: 'id', type: :integer },
          { name: 'name', hint: 'Only when verified.' },
          { name: 'outcome', hint: 'started | stopped | failed' },
          { name: 'running', type: :boolean, hint: 'Only when verified: the flag the API reported at the end.' },
          { name: 'error' }
        ]

        [
          { name: 'workato_environment' },
          { name: 'action', hint: 'start | stop' },
          { name: 'recipe_count', type: :integer, hint: 'Recipe IDs given.' },
          { name: 'changed_count', type: :integer, hint: 'Recipes now in the requested state.' },
          { name: 'failed_count', type: :integer },
          { name: 'invocations', type: :integer,
            hint: 'How many times the action ran; there is a 60-second sleep between each.' },
          { name: 'verified', type: :boolean,
            hint: 'True when a Folder ID was given and every recipe acted on was found in it and checked.' },
          { name: 'all_ok', type: :boolean,
            hint: 'True when every recipe ended in the requested state (verified), or every call succeeded (not verified).' },
          { name: 'failed', type: :array, of: :object, properties: result_fields },
          { name: 'results', type: :array, of: :object, hint: 'In the order acted on.', properties: result_fields }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        failed = { 'id' => 3102, 'name' => 'Sync orders', 'outcome' => 'failed', 'running' => false,
                   'error' => 'Start recipe 3102 failed: 422 Unprocessable Entity — connection not authorized' }
        {
          'workato_environment' => 'TEST', 'action' => 'start', 'recipe_count' => 2, 'changed_count' => 1,
          'failed_count' => 1, 'invocations' => 1, 'verified' => true, 'all_ok' => false, 'failed' => [failed],
          'results' => [{ 'id' => 3101, 'name' => 'Get order', 'outcome' => 'started', 'running' => true }, failed]
        }
      end
    },

    # Upsert properties
    upsert_properties: {
      title: 'Upsert properties',
      subtitle: 'Create or update account-level or project-level properties',
      help: lambda do
        {
          body: 'Sets one or more properties in the selected environment. Existing properties are updated; new ones ' \
                'are created. Leave Project ID blank for account (environment) properties; give it to write project ' \
                'properties — the project_property asset type in a package. Commonly used to push environment-specific ' \
                'configuration during deployment.'
        }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'project_id', label: 'Project ID', optional: true,
            hint: 'Blank = account properties. Set to write project properties. This is the project ID (List projects), not the folder ID.' },
          { name: 'properties', type: :array, of: :object, optional: false, hint: 'A list of name/value pairs.',
            properties: [
              { name: 'name', optional: false },
              { name: 'value', optional: false }
            ] }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        # Transform [{name:k, value:v}] → { k: v }
        props_hash = (input['properties'] || []).each_with_object({}) do |p, h|
          h[p['name']] = p['value']
        end

        url = "#{dc}/properties"
        url = "#{url}?project_id=#{input['project_id']}" if input['project_id'].present?

        response = post(url)
                     .headers(headers)
                     .payload({ 'properties' => props_hash })
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Upsert properties failed: #{m} — #{b}")
                     end

        { 'result' => call('success_flag', response) }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['api_result_obj']
      end,

      sample_output: lambda do |_connection, _input|
        { 'result' => true }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # List connections
    list_connections: {
      title: 'List connections',
      subtitle: 'List connections and their authorization status',
      help: lambda do
        { body: 'Returns connections in the selected environment with their authorization status. Filter by folder after a ' \
                'package import to see the shells the import created: all_authorized is the readiness gate before ' \
                'starting recipes, and pending lists exactly which connections still need credentials.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Folder ID', optional: true, hint: 'Only connections in this folder.', type: :integer },
          { name: 'project_id', label: 'Project ID', optional: true, hint: 'Only connections in this project.', type: :integer },
          { name: 'external_id', label: 'External ID', optional: true, hint: 'Only connections stamped with this external ID.' },
          { name: 'include_tags', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Include tag handles on each connection. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        params = {
          'folder_id'   => input['folder_id'],
          'project_id'  => input['project_id'],
          'external_id' => input['external_id']
        }.reject { |_k, v| v.blank? }
        params['includes[]'] = 'tags' if input['include_tags'].is_true?

        response = get("#{dc}/connections", params)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List connections failed: #{m} — #{b}")
                     end

        body = call('resolve_response', response)
        raw = Array(body.is_a?(::Hash) ? body['items'] : body)
        conns = raw.map { |c| call('connection_summary', c) }
        pending = conns.reject { |c| c['authorized'] }

        {
          'workato_environment' => env['name'],
          'total_count'         => conns.length,
          'authorized_count'    => conns.length - pending.length,
          'pending_count'       => pending.length,
          'all_authorized'      => pending.empty?,
          'pending'             => pending,
          'connections'         => conns
        }
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'total_count', type: :integer },
          { name: 'authorized_count', type: :integer },
          { name: 'pending_count', type: :integer },
          { name: 'all_authorized', type: :boolean,
            hint: 'True when every listed connection has authorization_status = success. The readiness gate.' },
          { name: 'pending', type: :array, of: :object,
            hint: 'Connections that still need credentials.',
            properties: object_definitions['connection_obj'] },
          { name: 'connections', type: :array, of: :object,
            properties: object_definitions['connection_obj'] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        ok      = call('sample_connection')
        pending = call('sample_pending_connection')
        { 'workato_environment' => 'TEST', 'total_count' => 2, 'authorized_count' => 1, 'pending_count' => 1,
          'all_authorized' => false, 'pending' => [pending], 'connections' => [ok, pending] }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Update connection
    update_connection: {
      title: 'Update connection',
      subtitle: 'Rename, move, tag, or authenticate a connection',
      help: lambda do
        { body: 'Updates one connection in place. Connection parameters are passed through as the API input object, so ' \
                'this works for any provider: fill an imported shell with credentials (field names per Workato\'s connection ' \
                'parameters reference, or the connection fields of a custom connector), stamp an external ID, or move it to ' \
                'a folder. With Shell connection = Yes the credentials are stored without being tested.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'connection_id', label: 'Connection ID', optional: false },
          { name: 'name', optional: true, hint: 'New name. Leave blank to keep.' },
          { name: 'folder_id', label: 'Folder ID', optional: true, hint: 'Move to this folder. Leave blank to keep.' },
          { name: 'external_id', label: 'External ID', optional: true,
            hint: 'Your own identifier for this connection, e.g. the registry or client workspace ID.' },
          { name: 'shell_connection', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Yes: store the parameters without testing them. Defaults to No (tested and established).' },
          { name: 'input_json', label: 'Connection parameters (JSON)', optional: true,
            hint: 'A JSON object of provider-specific connection parameters, sent as the API input object. ' \
                  'Example for a native Google Drive service account: ' \
                  '{"authentication_type":"service_auth","service_auth":"...@....iam.gserviceaccount.com","private_key":"..."}. ' \
                  'For several connections use Authorize connections, which paces writes to the 1/s quota.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        payload = {
          'name'        => input['name'],
          'folder_id'   => input['folder_id'],
          'external_id' => input['external_id']
        }.reject { |_k, v| v.blank? }
        payload['shell_connection'] = true if input['shell_connection'].is_true?

        if input['input_json'].present?
          parsed = parse_json(input['input_json'])
          error('Connection parameters must be a JSON object.') unless parsed.is_a?(::Hash)
          payload['input'] = parsed
        end

        error('Nothing to update: provide a name, folder, external ID, or connection parameters.') if payload.empty?

        response = call('put_connection', dc, headers, input['connection_id'], payload)
        call('connection_summary', response)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['connection_obj']
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_connection')
      end

    },

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
                'with a pause between, and pauses once more after the last write, so the step after this one cannot ' \
                'collide with it. The platform holds each pause to at least 60 seconds, so allow about a minute per ' \
                'connection. The set is listed again at the end, so authorized and all_ok are what the API ' \
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

          if queue.present? && step >= max_steps
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
          { name: 'invocations', type: :integer, hint: 'How many times the action ran. Each pause between runs lasts at least 60 seconds on the platform.' },
          { name: 'all_ok', type: :boolean,
            hint: 'True when no selected connection failed and every one written now reports success. The readiness gate ' \
                  'for this set.' },
          { name: 'failed', type: :array, of: :object, properties: result_fields },
          { name: 'results', type: :array, of: :object, properties: result_fields }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'workato_environment' => 'TEST', 'matched_count' => 2, 'authorized_count' => 1, 'skipped_count' => 1,
          'failed_count' => 0, 'invocations' => 2, 'all_ok' => true, 'failed' => [],
          'results' => [call('sample_connection').merge('id' => 4102, 'name' => 'Google Sheets',
                                                        'application' => 'google_sheets', 'outcome' => 'authorized'),
                        call('sample_connection').merge('outcome' => 'skipped')]
        }
      end
    },

    # Authorize Google connections
    authorize_google_connections: {
      title: 'Authorize Google connections',
      subtitle: 'Authenticate Google Drive / Sheets shells with the service account',
      help: lambda do
        { body: 'Finds Google connections in the target (optionally within one folder — the imported project) that are not ' \
                'yet authorized and authenticates each with the service account stored on this connection. Idempotent: ' \
                'already-authorized connections are skipped unless Re-authorize is Yes. The key never leaves the ' \
                'connection, so nothing sensitive appears in job data. Check all_ok, then List connections for the full gate.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Folder ID', optional: true, type: :integer,
            hint: 'Limit to connections in this folder (the imported project). Blank = the whole workspace.' },
          { name: 'applications', optional: true, default: 'google_drive,google_sheets',
            hint: 'Comma-separated application values to authorize. Defaults to google_drive,google_sheets.' },
          { name: 'reauthorize', label: 'Re-authorize', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Yes: push the service account even to connections already authorized (e.g. after a key rotation). Defaults to No.',
            toggle_hint: 'Select from the list',
            toggle_field: {
              name: 'reauthorize', label: 'Re-authorize', type: :boolean, control_type: 'text',
              default: 'false', optional: true, toggle_hint: 'Map from input',
              hint: 'Yes: push the service account even to connections already authorized (e.g. after a key rotation). Defaults to No.'
            }
          }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        sa_input = call('google_service_account_input', connection)

        apps = (input['applications'].present? ? input['applications'] : 'google_drive,google_sheets')
                 .to_s.split(',').map(&:strip).reject(&:blank?)

        params = {}
        params['folder_id'] = input['folder_id'] if input['folder_id'].present?

        listing = get("#{dc}/connections", params)
                    .headers(headers)
                    .after_error_response(/.*/) do |_c, b, _h, m|
                      error("List connections failed: #{m} — #{b}")
                    end

        body    = call('resolve_response', listing)
        raw     = Array(body.is_a?(::Hash) ? body['items'] : body)
        matched = raw.map { |c| call('connection_summary', c) }
                     .select { |c| apps.include?(c['application']) }

        skipped = input['reauthorize'].is_true? ? [] : matched.select { |c| c['authorized'] }
        todo    = matched - skipped

        results = todo.map do |c|
          begin
            updated = call('put_connection', dc, headers, c['id'], { 'input' => sa_input })
            call('connection_summary', updated).merge('outcome' => 'authorized')
          rescue StandardError => e
            c.merge('outcome' => 'failed', 'error' => e.message)
          end
        end

        results.concat(skipped.map { |c| c.merge('outcome' => 'skipped') })

        failed = results.select { |r| r['outcome'] == 'failed' || (r['outcome'] == 'authorized' && !r['authorized']) }

        {
          'workato_environment' => env['name'],
          'matched_count'       => matched.length,
          'authorized_count'    => results.count { |r| r['outcome'] == 'authorized' && r['authorized'] },
          'skipped_count'       => skipped.length,
          'failed_count'        => failed.length,
          'all_ok'              => failed.empty?,
          'results'             => results
        }
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'matched_count', type: :integer, hint: 'Connections whose application matched.' },
          { name: 'authorized_count', type: :integer, hint: 'Connections now reporting authorization_status = success.' },
          { name: 'skipped_count', type: :integer, hint: 'Already authorized; left alone.' },
          { name: 'failed_count', type: :integer },
          { name: 'all_ok', type: :boolean,
            hint: 'True when no matched connection failed and every one pushed now reports success.' },
          { name: 'results', type: :array, of: :object,
            properties: object_definitions['connection_obj'] + [
              { name: 'outcome', hint: 'authorized | skipped | failed' },
              { name: 'error' }
            ] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'workato_environment' => 'TEST', 'matched_count' => 2, 'authorized_count' => 1, 'skipped_count' => 1,
          'failed_count' => 0, 'all_ok' => true,
          'results' => [call('sample_connection').merge('id' => 4102, 'name' => 'Google Sheets',
                                                        'application' => 'google_sheets', 'outcome' => 'authorized'),
                        call('sample_connection').merge('outcome' => 'skipped')]
        }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Disconnect connection
    disconnect_connection: {
      title: 'Disconnect connection',
      subtitle: 'Revoke a connection\'s authorization',
      help: lambda do
        { body: 'Disconnects an active connection (no-op if already disconnected). Use Force to disconnect one that active ' \
                'recipes still use.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'connection_id', label: 'Connection ID', optional: false },
          { name: 'force', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Yes: disconnect even if active recipes use it. Defaults to No.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        response = post("#{dc}/connections/#{input['connection_id']}/disconnect")
                     .headers(headers)
                     .payload({ 'force' => input['force'].is_true? })
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Disconnect connection failed: #{m} — #{b}")
                     end

        { 'success' => response['success'], 'status' => response['status'], 'message' => response['message'] }.compact
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'success', type: :boolean },
          { name: 'status', hint: 'disconnected on success.' },
          { name: 'message' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'success' => true, 'status' => 'disconnected', 'message' => nil }
      end
      
    },

    # Delete connection
    delete_connection: {
      title: 'Delete connection',
      subtitle: 'Delete a connection',
      help: lambda do
        { body: 'Deletes an active or disconnected connection. The API refuses while active recipes still use it ' \
                '(success = false, status = rejected), which forces the stop-recipes-then-delete order for teardown.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'connection_id', label: 'Connection ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        response = delete("#{dc}/connections/#{input['connection_id']}")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Delete connection failed: #{m} — #{b}")
                     end

        { 'success' => response['success'], 'status' => response['status'], 'message' => response['message'] }.compact
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'success', type: :boolean },
          { name: 'status', hint: 'deleted on success; rejected when active recipes still use the connection.' },
          { name: 'message' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'success' => true, 'status' => 'deleted', 'message' => nil }
      end
      
    },

    # List properties
    list_properties: {
      title: 'List properties',
      subtitle: 'List account-level or project-level properties by prefix',
      help: lambda do
        { body: 'Returns the properties in the selected environment whose names start with Prefix. Leave Project ID ' \
                'blank for account (environment) properties; give it to read project properties. The API returns a ' \
                'name → value object; this action reshapes it into a list of name/value pairs.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'prefix', optional: true,
            hint: 'Only properties whose name starts with this, e.g. sdc_. The API documents it as required; ' \
                  'leave blank only if a probe shows your workspace accepts that.' },
          { name: 'project_id', label: 'Project ID', optional: true,
            hint: 'Blank = account properties. Set to read project properties. This is the project ID (List projects), not the folder ID.' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        env_name = env['name']
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        params = {
          'prefix'     => input['prefix'],
          'project_id' => input['project_id']
        }.reject { |_k, v| v.blank? }

        response = get("#{dc}/properties", params)
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List properties failed: #{m} — #{b}")
                     end

        # { k: v } → [{name:k, value:v}], the inverse of Upsert properties
        body       = call('resolve_response', response)
        properties = if body.is_a?(::Hash)
                       body.map { |k, v| { 'name' => k, 'value' => v } }
                     else
                       Array(body)
                     end

        {
          'workato_environment' => env_name,
          'property_count'      => properties.length,
          'properties'          => properties
        }
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'property_count', type: :integer },
          { name: 'properties', type: :array, of: :object,
            properties: [
              { name: 'name' },
              { name: 'value' }
            ]
          }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'workato_environment' => 'TEST', 'property_count' => 1,
          'properties' => [{ 'name' => 'sdc_region', 'value' => 'eu' }] }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Lookup folder by path
    lookup_folder_by_path: {
      title: 'Lookup folder by path',
      subtitle: 'Resolve a folder path to a folder ID',
      help: lambda do
        { body: 'Walks the folder tree to find a folder by its path (e.g. /Team/Project/Subfolder). Returns the folder ' \
         'details including its ID. Each path segment is matched by exact folder name.',}
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'path', optional: false, hint: 'Forward-slash separated folder path. Example:  /Client Automations/Onboarding/Templates' }
        ]
      end,

      execute: lambda do |connection, input|
        env      = call('env_ref', connection, input)
        env_name = env['name']
        headers  = call('get_auth_headers', connection, env)
        dc       = call('get_datacenter', connection, env)

        segments = input['path']
                     .split('/')
                     .reject(&:blank?)

        if segments.blank?
          error('Path cannot be empty.')
        end

        current_parent_id = nil
        current_folder    = nil
        missing           = []

        segments.each_with_index do |segment, idx|
          # Every page of this level; list_all_pages errors rather than loop
          # forever on an API that ignores `page`.
          params = current_parent_id.present? ? { 'parent_id' => current_parent_id } : {}
          folder_list = call('list_all_pages', {
            'url' => "#{dc}/folders", 'params' => params, 'headers' => headers, 'env_name' => env_name,
            'noun' => 'folders', 'item' => 'folder'
          })

          match = folder_list.find { |f| f['name'].to_s.strip == segment.strip }

          if match.nil?
            missing = segments[idx..-1]
            break
          end

          current_folder    = match
          current_parent_id = match['id']
        end

        found = missing.empty?
        folder = found ? current_folder : {}

        {
          'found'             => found,
          'id'                => folder['id'],
          'name'              => folder['name'],
          'parent_id'         => folder['parent_id'],
          'created_at'        => folder['created_at'],
          'updated_at'        => folder['updated_at'],
          'resolved_path'     => '/' + segments.first(segments.length - missing.length).join('/'),
          'last_found_id'     => current_parent_id,
          'missing_segments'  => missing,
          'missing_count'     => missing.length,
          'project_id'        => folder['project_id'],
          'is_project'        => folder['is_project']
        }
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['folder_lookup_obj']
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_folder').merge(
          'found' => true, 'resolved_path' => '/Orders', 'last_found_id' => 1301, 'missing_segments' => [], 'missing_count' => 0
        )
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # ── API Platform ──────────────────────────────────────────
    # Collections and endpoints arrive with the package; clients and keys are what a
    # registered workspace needs on top: one client per workspace, one auth-token key,
    # its token in secrets storage. All of these share the 60/min API Platform quota.

    # List API collections
    list_api_collections: {
      title: 'List API collections',
      subtitle: 'List API collections, or find one by name',
      help: lambda do
        { body: 'Returns the API collections in the selected environment. url is the collection base URL — the ' \
                'api_base_url a registry row stores. Give a Name (and optionally a Project ID) to find one collection: ' \
                'found and match carry the answer.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'name', optional: true, hint: 'Exact collection name to find.' },
          { name: 'project_id', label: 'Project ID', optional: true,
            hint: 'Only collections in this project. This is the project ID (List projects), not the folder ID.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        response = get("#{dc}/api_collections", { 'per_page' => 100 })
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List API collections failed: #{m} — #{b}")
                     end

        body        = call('resolve_response', response)
        collections = Array(call('platform_result', body)).map { |c| call('api_collection_summary', c) }

        if input['project_id'].present?
          collections = collections.select { |c| c['project_id'].to_s == input['project_id'].to_s }
        end

        resolving = input['name'].present?
        match     = resolving ? collections.find { |c| c['name'] == input['name'] } : nil

        {
          'workato_environment' => env['name'],
          'collection_count'    => collections.length,
          'found'               => resolving && !match.nil?,
          'match'               => match,
          'collections'         => collections
        }.compact
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'collection_count', type: :integer, hint: 'After the Project ID filter, if one was given.' },
          { name: 'found', type: :boolean, hint: 'True when a Name was given and one collection matched it.' },
          { name: 'match', type: :object, properties: object_definitions['api_collection_obj'] },
          { name: 'collections', type: :array, of: :object, properties: object_definitions['api_collection_obj'] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        collection = call('sample_api_collection')
        { 'workato_environment' => 'TEST', 'collection_count' => 1, 'found' => true, 'match' => collection,
          'collections' => [collection] }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # List API endpoints
    list_api_endpoints: {
      title: 'List API endpoints',
      subtitle: 'List the endpoints in an API collection and whether they are active',
      help: lambda do
        { body: 'Returns every endpoint in a collection with its active flag. all_active is the readiness gate for the ' \
                'collection. An endpoint can only be enabled while its recipe is running, so an inactive endpoint after ' \
                'the recipes were started means that recipe did not start. Use Set API endpoints state to change them.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'api_collection_id', label: 'API collection ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        endpoints = call('fetch_api_endpoints', dc, headers, input['api_collection_id'])
        inactive  = endpoints.reject { |e| e['active'] }

        {
          'workato_environment' => env['name'],
          'api_collection_id'   => input['api_collection_id'],
          'endpoint_count'      => endpoints.length,
          'active_count'        => endpoints.length - inactive.length,
          'inactive_count'      => inactive.length,
          'all_active'          => inactive.empty?,
          'inactive'            => inactive,
          'endpoints'           => endpoints
        }
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'api_collection_id' },
          { name: 'endpoint_count', type: :integer },
          { name: 'active_count', type: :integer },
          { name: 'inactive_count', type: :integer },
          { name: 'all_active', type: :boolean,
            hint: 'True when every endpoint in the collection is active. The readiness gate.' },
          { name: 'inactive', type: :array, of: :object,
            hint: 'Endpoints that cannot be called yet.',
            properties: object_definitions['api_endpoint_obj'] },
          { name: 'endpoints', type: :array, of: :object,
            properties: object_definitions['api_endpoint_obj'] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        active   = call('sample_api_endpoint')
        inactive = active.merge('id' => 6102, 'flow_id' => 3102, 'name' => 'List orders', 'path' => 'orders',
                                'url' => 'https://apim.workato.com/acme/orders-v1/orders', 'active' => false)
        { 'workato_environment' => 'TEST', 'api_collection_id' => '601', 'endpoint_count' => 2, 'active_count' => 1,
          'inactive_count' => 1, 'all_active' => false, 'inactive' => [inactive], 'endpoints' => [active, inactive] }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Set API endpoints state
    set_api_endpoints_state: {
      title: 'Set API endpoints state',
      subtitle: 'Enable or disable the endpoints of an API collection',
      batch: true,
      help: lambda do
        { body: 'Enables or disables every endpoint in a collection, or only the Endpoint IDs given. Idempotent: ' \
                'endpoints already in the requested state are skipped. Enabling needs the endpoint\'s recipe to be ' \
                'running — one whose recipe is stopped lands in the results as failed with the API\'s message, so start ' \
                'recipes first and disable endpoints before stopping them. The collection is listed again afterwards, ' \
                'so all_ok and all_active reflect the real state, not the requests sent.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'action', control_type: 'select', pick_list: 'endpoint_actions', toggle_hint: 'Use datapill',
            optional: false, hint: 'Enable or Disable.' },
          { name: 'api_collection_id', label: 'API collection ID', optional: false },
          { name: 'endpoint_ids', label: 'Endpoint IDs', optional: true,
            hint: 'Comma-separated endpoint IDs to limit the change to. Blank = every endpoint in the collection.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        action = input['action']
        error("Unknown endpoint action: #{action}") unless %w[enable disable].include?(action)
        want_active = action == 'enable'

        endpoints = call('fetch_api_endpoints', dc, headers, input['api_collection_id'])

        ids = call('csv_list', input['endpoint_ids'])
        if ids.present?
          endpoints = endpoints.select { |e| ids.include?(e['id'].to_s) }
          error('None of the Endpoint IDs are in this collection.') if endpoints.empty?
        end

        skipped = endpoints.select { |e| e['active'] == want_active }
        todo    = endpoints - skipped

        results = todo.map do |e|
          begin
            response = put("#{dc}/api_endpoints/#{e['id']}/#{action}")
                         .headers(headers)
                         .after_error_response(/.*/) do |_c, b, _h, m|
                           error("#{action.capitalize} endpoint #{e['id']} failed: #{m} — #{b}")
                         end
            call('resolve_response', response)
            e.merge('outcome' => "#{action}d")
          rescue StandardError => ex
            e.merge('outcome' => 'failed', 'error' => ex.message)
          end
        end

        results.concat(skipped.map { |e| e.merge('outcome' => 'skipped') })

        # Re-list so the active flags (and the gates) are what the API reports now.
        after     = call('fetch_api_endpoints', dc, headers, input['api_collection_id'])
        active_by = after.each_with_object({}) { |e, h| h[e['id'].to_s] = e['active'] }
        results   = results.map { |r| r.merge('active' => active_by.fetch(r['id'].to_s, r['active'])) }

        failed = results.select { |r| r['outcome'] == 'failed' || r['active'] != want_active }

        {
          'workato_environment' => env['name'],
          'api_collection_id'   => input['api_collection_id'],
          'action'              => action,
          'endpoint_count'      => results.length,
          'changed_count'       => results.count { |r| r['outcome'] == "#{action}d" && r['active'] == want_active },
          'skipped_count'       => skipped.length,
          'failed_count'        => failed.length,
          'all_ok'              => failed.empty?,
          'all_active'          => after.all? { |e| e['active'] },
          'results'             => results
        }
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'api_collection_id' },
          { name: 'action', hint: 'enable | disable' },
          { name: 'endpoint_count', type: :integer, hint: 'Endpoints this call looked at.' },
          { name: 'changed_count', type: :integer, hint: 'Endpoints now in the requested state because of this call.' },
          { name: 'skipped_count', type: :integer, hint: 'Already in the requested state; left alone.' },
          { name: 'failed_count', type: :integer },
          { name: 'all_ok', type: :boolean,
            hint: 'True when every endpoint this call looked at now reports the requested state.' },
          { name: 'all_active', type: :boolean,
            hint: 'True when every endpoint in the whole collection is active — same gate as List API endpoints.' },
          { name: 'results', type: :array, of: :object,
            properties: object_definitions['api_endpoint_obj'] + [
              { name: 'outcome', hint: 'enabled | disabled | skipped | failed' },
              { name: 'error' }
            ] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        endpoint = call('sample_api_endpoint')
        {
          'workato_environment' => 'TEST', 'api_collection_id' => '601', 'action' => 'enable', 'endpoint_count' => 2,
          'changed_count' => 1, 'skipped_count' => 1, 'failed_count' => 0, 'all_ok' => true, 'all_active' => true,
          'results' => [endpoint.merge('outcome' => 'enabled'),
                        endpoint.merge('id' => 6102, 'name' => 'List orders', 'path' => 'orders', 'outcome' => 'skipped')]
        }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Find or create API client
    find_or_create_api_client: {
      title: 'Find or create API client',
      subtitle: 'Reuse an API client by name, or create it with auth-token authentication',
      help: lambda do
        { body: 'Looks for an API client with this Name (in the Project, if given) and returns it; creates it when ' \
                'absent, assigned to the collections given, with auth-token authentication. Idempotent: rerunning ' \
                'returns the existing client with created = false. If that client is not assigned to every collection ' \
                'asked for, collections_match is false and the client is returned untouched — updating one needs an ' \
                'API policy ID, which this action will not guess. Follow with Create or refresh API key.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'name', optional: false, hint: 'Client name. Matched exactly when looking for an existing client.' },
          { name: 'api_collection_ids', label: 'API collection IDs', optional: false,
            hint: 'Comma-separated collection IDs the client may call (List API collections). From a list step, use ' \
                  'the formula <b>collections.pluck(:id).join(",")</b>.' },
          { name: 'project_id', label: 'Project ID', optional: true,
            hint: 'Create the client in this project, and look for an existing one only there. This is the project ID (List projects), not the folder ID.' },
          { name: 'api_policy_id', label: 'API policy ID', optional: true,
            hint: 'Optional policy to apply on create. Leave blank to take the workspace default.' },
          { name: 'description', optional: true }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        wanted = call('id_list', input['api_collection_ids']).map(&:to_i)
        #wanted = call('csv_list', input['api_collection_ids']).map(&:to_i)
        error('Provide at least one API collection ID.') if wanted.blank?
        if wanted.any?(&:zero?)
          error("API collection IDs must be numeric; got #{input['api_collection_ids'].inspect}.")
        end

        params = { 'per_page' => 100 }
        params['project_id'] = input['project_id'] if input['project_id'].present?

        listing = get("#{dc}/v2/api_clients", params)
                    .headers(headers)
                    .after_error_response(/.*/) do |_c, b, _h, m|
                      error("List API clients failed: #{m} — #{b}")
                    end

        body     = call('resolve_response', listing)
        clients  = Array(call('platform_result', body)).map { |c| call('api_client_summary', c) }
        existing = clients.find { |c| c['name'] == input['name'] }

        if existing
          have = Array(existing['api_collections']).map { |c| c['id'].to_i }
          existing.merge(
            'created'           => false,
            'collections_match' => (wanted - have).empty?
          )
        else
          payload = {
            'name'               => input['name'],
            'description'        => input['description'],
            'project_id'         => (input['project_id'].present? ? input['project_id'].to_i : nil),
            'api_collection_ids' => wanted,
            'api_policy_id'      => (input['api_policy_id'].present? ? input['api_policy_id'].to_i : nil),
            'auth_type'          => 'token'
          }.compact

          response = post("#{dc}/v2/api_clients")
                       .headers(headers)
                       .payload(payload)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Create API client failed: #{m} — #{b}")
                       end

          # collections_match is asserted here, not read back: the create response
          # may list api_collections as empty even though the assignment was accepted.
          created = call('platform_result', call('resolve_response', response)) || {}
          call('api_client_summary', created).merge(
            'created'           => true,
            'collections_match' => true
          )
        end
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['api_client_obj'] + [
          { name: 'created', type: :boolean, hint: 'True when this call created the client; false when it was found.' },
          { name: 'collections_match', type: :boolean,
            hint: 'True when the client is assigned to every API collection ID asked for.' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_api_client').merge('created' => true, 'collections_match' => true)
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Create or refresh API key
    ensure_api_key: {
      title: 'Create or refresh API key',
      subtitle: 'Create an auth-token API key, or refresh the secret of one with the same name',
      help: lambda do
        { body: 'Looks for an API key with this Name on the client. None: creates it, active, with auth-token ' \
                'authentication. Found: refreshes its secret instead, because a listed key only ever shows a masked ' \
                'token. Either way auth_token is the full, current token — this is the only place it appears, so ' \
                'enable data masking on this step and write it to secrets storage right away. Rerunning rotates the ' \
                'token; a key that exists but is disabled is refreshed as-is and returned with active = false.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'api_client_id', label: 'API client ID', optional: false },
          { name: 'name', optional: false, hint: 'Key name. Matched exactly when looking for an existing key.' },
          { name: 'ip_allow_list', label: 'IP allow list', optional: true,
            hint: 'Comma-separated IPs or CIDRs allowed to use the key. Applied on create only. Blank = any.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        keys_url = "#{dc}/v2/api_clients/#{input['api_client_id']}/api_keys"

        listing = get(keys_url, { 'per_page' => 100 })
                    .headers(headers)
                    .after_error_response(/.*/) do |_c, b, _h, m|
                      error("List API keys failed: #{m} — #{b}")
                    end

        body     = call('resolve_response', listing)
        existing = Array(call('platform_result', body)).find { |k| k['name'] == input['name'] }

        response = if existing
                     put("#{keys_url}/#{existing['id']}/refresh_secret")
                       .headers(headers)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Refresh API key secret failed: #{m} — #{b}")
                       end
                   else
                     payload = { 'name' => input['name'], 'active' => true }
                     allow   = call('csv_list', input['ip_allow_list'])
                     payload['ip_allow_list'] = allow if allow.present?

                     post(keys_url)
                       .headers(headers)
                       .payload(payload)
                       .after_error_response(/.*/) do |_c, b, _h, m|
                         error("Create API key failed: #{m} — #{b}")
                       end
                   end

        key = call('platform_result', call('resolve_response', response)) || {}
        call('api_key_summary', key).merge(
          'outcome'    => (existing ? 'refreshed' : 'created'),
          'auth_token' => key['auth_token']
        )
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['api_key_obj'] + [
          { name: 'outcome', hint: 'created | refreshed' },
          { name: 'auth_token', hint: 'The full token. Shown only here — enable data masking on this step.' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_api_key').merge('outcome' => 'created', 'auth_token' => 'sample-not-a-real-token')
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Refresh API key secret
    refresh_api_key_secret: {
      title: 'Refresh API key secret',
      subtitle: 'Rotate the auth token of an API key',
      help: lambda do
        { body: 'Generates a new auth token for the key and invalidates the old one. Rotation only — use Create or ' \
                'refresh API key when registering a workspace. Enable data masking on this step.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'api_client_id', label: 'API client ID', optional: false },
          { name: 'api_key_id', label: 'API key ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        response = put("#{dc}/v2/api_clients/#{input['api_client_id']}/api_keys/#{input['api_key_id']}/refresh_secret")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Refresh API key secret failed: #{m} — #{b}")
                     end

        key = call('platform_result', call('resolve_response', response)) || {}
        call('api_key_summary', key).merge('auth_token' => key['auth_token'])
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['api_key_obj'] + [
          { name: 'auth_token', hint: 'The new token. Enable data masking on this step.' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        call('sample_api_key').merge('auth_token' => 'sample-not-a-real-token')
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # List API keys
    list_api_keys: {
      title: 'List API keys',
      subtitle: 'List the API keys of an API client',
      help: lambda do
        { body: 'Returns the keys of one API client. Tokens are never included — the API masks them on this endpoint, ' \
                'and the full value exists only where a key is created or refreshed.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'api_client_id', label: 'API client ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        response = get("#{dc}/v2/api_clients/#{input['api_client_id']}/api_keys", { 'per_page' => 100 })
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("List API keys failed: #{m} — #{b}")
                     end

        body = call('resolve_response', response)
        keys = Array(call('platform_result', body)).map { |k| call('api_key_summary', k) }

        {
          'workato_environment' => env['name'],
          'api_client_id'       => input['api_client_id'],
          'key_count'           => keys.length,
          'active_count'        => keys.count { |k| k['active'] },
          'keys'                => keys
        }
      end,

      output_fields: lambda do |object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'api_client_id' },
          { name: 'key_count', type: :integer },
          { name: 'active_count', type: :integer },
          { name: 'keys', type: :array, of: :object, properties: object_definitions['api_key_obj'] }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'workato_environment' => 'TEST', 'api_client_id' => '701', 'key_count' => 1, 'active_count' => 1,
          'keys' => [call('sample_api_key')] }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Delete API client
    delete_api_client: {
      title: 'Delete API client',
      subtitle: 'Delete an API client and its keys',
      help: lambda do
        { body: 'Deletes the client. Its keys go with it, so any token issued for them stops working immediately. ' \
                'Teardown only.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'api_client_id', label: 'API client ID', optional: false }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        response = delete("#{dc}/v2/api_clients/#{input['api_client_id']}")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Delete API client failed: #{m} — #{b}")
                     end

        { 'success' => response['success'], 'message' => response['message'] }.compact
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'success', type: :boolean },
          { name: 'message' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'success' => true, 'message' => nil }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Delete API collection
    delete_api_collection: {
      title: 'Delete API collection',
      subtitle: 'Delete an API collection and its endpoints',
      help: lambda do
        { body: 'Deletes the collection; its endpoints go with it. With Disable first = Yes every active endpoint ' \
                'is disabled before the delete, so a collection is never removed with a live surface. Idempotent: ' \
                'a collection that is already gone returns success = true. Deletes by ID only — a same-named ' \
                'collection elsewhere in the workspace is never touched. Teardown only.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'api_collection_id', label: 'API collection ID', optional: false },
          { name: 'disable_first', label: 'Disable first', type: :boolean, control_type: 'checkbox',
            default: 'true', optional: true,
            hint: 'Yes: disable the collection\'s active endpoints before deleting it. Defaults to Yes.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)
        id      = input['api_collection_id']

        # nil = a step configured before the field existed; defaults to Yes.
        disable = input['disable_first'].nil? || input['disable_first'].is_true?

        endpoint_count = if disable
                           call('disable_collection_endpoints', dc, headers, id, env['name'])
                         else
                           call('fetch_api_endpoints', dc, headers, id).length
                         end

        result = call('delete_or_gone', "#{dc}/api_collections/#{id}", headers,
                      "Delete API collection #{id}", env['name'])

        {
          'workato_environment' => env['name'],
          'api_collection_id'   => id,
          'success'             => true,
          'status'              => result.to_s,
          'endpoint_count'      => endpoint_count,
          'message'             => (result == :deleted ? "Collection #{id} deleted with #{endpoint_count} endpoints." \
                                                       : "Collection #{id} was already gone.")
        }
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'workato_environment' },
          { name: 'api_collection_id' },
          { name: 'success', type: :boolean },
          { name: 'status', hint: 'deleted | gone (already absent before this call).' },
          { name: 'endpoint_count', type: :integer, hint: 'Endpoints seen before deletion.' },
          { name: 'message' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'workato_environment' => 'TEST', 'api_collection_id' => '601', 'success' => true, 'status' => 'deleted',
          'endpoint_count' => 2, 'message' => 'Collection 601 deleted with 2 endpoints.' }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # ── CUSTOM CONNECTOR ──────────────────────────────────────
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
          { name: 'title', label: 'Connector title', optional: false,
            hint: 'The connector\'s title as shown under Tools > Connector SDK — matched exactly in both environments. ' \
                  'Not the provider key, which every workspace mints for itself.' }
        ] + object_definitions['connector_target_fields'] + [
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

        if !call('runtime_target', input) && tgt['name'] == src['name']
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

      sample_output: lambda do |_connection, _input|
        { 'workato_environment' => 'TEST', 'title' => 'Workato Developer API', 'id' => 801,
          'provider' => 'workato_developer_api_connector_801', 'created' => false, 'updated' => true, 'released' => true,
          'released_version' => 12, 'latest_version' => 12, 'current' => true }
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # ── TEARDOWN ──────────────────────────────────────────────
    # Clean is the inverse of prepare. The recipe (POOL-15) owns the pool tables,
    # the ordering and the guards, and stops recipes through Set recipes state;
    # this action owns the target-side deletes, which are one request per
    # collection or table and fit one invocation.

    # Clean project
    clean_project: {
      title: 'Clean project',
      subtitle: 'Delete a project, its API collections and any surviving tables; report what is left',
      help: lambda do
        { body: 'Returns a target to empty. Inventories the project folder, disables and deletes its API ' \
                'collections, deletes the project (recipes, connections, tables, Workflow app included), sweeps ' \
                'any table that survived, and re-lists to prove the project is gone. Dry run is the default and ' \
                'writes nothing. Refuses while any recipe in the folder is running — stop them first with Set ' \
                'recipes state. Custom connectors, account properties, email templates and topics are ' \
                'workspace-level and are reported as residue, not deleted. Idempotent: on an already-clean ' \
                'workspace found = false and nothing is done. Every delete treats 404 as done, so a 429 retry ' \
                'of the whole action is safe.' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'folder_id', label: 'Project folder ID', optional: true,
            hint: 'The project\'s top-level folder (what the pool row stores). Provide this or Project name.' },
          { name: 'project_name', label: 'Project name', optional: true,
            hint: 'Exact name, e.g. Randstad DataBridge. Provide this or Project folder ID. Ambiguous = error.' },
          { name: 'expected_recipes_stopped', label: 'Expect recipes stopped', type: :boolean,
            control_type: 'checkbox', default: 'true', optional: true,
            hint: 'Yes: refuse if any recipe in the folder is running. Defaults to Yes. Turn off only for tests.' },
          { name: 'dry_run', label: 'Dry run', type: :boolean, control_type: 'checkbox', default: 'true', optional: true,
            hint: 'Yes: return the inventory and plan without deleting anything. Defaults to Yes.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        # nil = a step configured before the field existed; both default to Yes.
        dry   = input['dry_run'].nil?                  || input['dry_run'].is_true?
        check = input['expected_recipes_stopped'].nil? || input['expected_recipes_stopped'].is_true?

        if input['folder_id'].blank? && input['project_name'].blank?
          error('Provide a Project folder ID or a Project name.')
        end

        # ── Resolve: absent is a no-op, not an error ──────
        # find_project reads every page, so "absent" means absent, not "past
        # the first 100".
        project = call('find_project', dc, headers, input['folder_id'], input['project_name'], env['name'])

        if project.nil?
          next {
            'workato_environment' => env['name'],
            'found'               => false,
            'dry_run'             => dry,
            'deleted'             => {},
            'tables_swept'        => 0,
            'residue'             => [],
            'verified'            => true,
            'all_clean'           => true
          }
        end

        folder_id = project['folder_id']

        # ── Inventory: same call that drives the golden manifest ──
        listing = get("#{dc}/export_manifests/folder_assets", { 'folder_id' => folder_id })
                    .headers(headers)
                    .after_error_response(/.*/) do |_c, b, _h, m|
                      error("Inventory failed in #{env['name']}: #{m} — #{b}")
                    end
        assets  = Array(call('manifest_result', call('resolve_response', listing) || {})['assets'])
        groups  = call('group_assets_by_type', assets)
        residue = call('clean_residue', groups)

        counts = {
          'recipes'     => groups['recipe'].length,
          'connections' => groups['connection'].length,
          'tables'      => groups['workato_db_table'].length,
          'pages'       => groups['lcap_page'].length,
          'collections' => groups['api_group'].length,
          'endpoints'   => groups['api_endpoint'].length
        }

        # ── Guard: nothing running (every page of the top folder) ──
        if check
          running = call('list_all_recipes', dc, headers, folder_id, env['name']).select { |r| r['running'] }

          if running.present?
            error("#{running.length} recipes still running in #{env['name']}; stop them first: " \
                  "#{running.first(5).map { |r| "#{r['name']} (#{r['id']})" }.join(', ')}")
          end
        end

        base = {
          'workato_environment' => env['name'],
          'found'               => true,
          'project_id'          => project['id'],
          'folder_id'           => folder_id,
          'project_name'        => project['name'],
          'dry_run'             => dry,
          'residue'             => residue
        }

        # ── Dry run: the plan, nothing written ────────────
        if dry
          next base.merge('deleted' => {}, 'would_delete' => counts, 'tables_swept' => 0,
                          'verified' => false, 'all_clean' => false)
        end

        # ── API collections: disable, then delete (by ID) ─
        groups['api_group'].each do |g|
          call('disable_collection_endpoints', dc, headers, g['id'], env['name'])
          call('delete_or_gone', "#{dc}/api_collections/#{g['id']}", headers,
               "Delete API collection #{g['id']}", env['name'])
        end

        # ── Project: takes folders, recipes, connections and Workflow app with it ──
        call('delete_or_gone', "#{dc}/projects/#{project['id']}", headers,
             "Delete project #{project['id']}", env['name'])

        # ── Sweep: tables the project delete may have left ──
        # Counts only :deleted, so tables_swept measures whether the project
        # delete really covers tables (expect 0). 404 is the expected answer.
        swept = groups['workato_db_table'].count do |t|
          call('delete_or_gone', "#{dc}/data_tables/#{t['id']}", headers,
               "Delete data table #{t['id']}", env['name']) == :deleted
        end

        # ── Verify: the output is what the API reports, not what was sent ──
        still = call('find_project', dc, headers, folder_id, nil, env['name'])

        conns = get("#{dc}/connections", { 'project_id' => project['id'] })
                  .headers(headers)
                  .after_error_response(/.*/) do |_c, b, _h, m|
                    error("List connections failed in #{env['name']}: #{m} — #{b}")
                  end
        left  = call('list_body', conns)

        if still.present? || left.present?
          error("Project #{project['id']} delete reported success in #{env['name']} but assets remain " \
                "(project present: #{still.present?}, connections: #{left.length}).")
        end

        base.merge(
          'deleted'      => counts,
          'tables_swept' => swept,
          'verified'     => true,
          'all_clean'    => residue.all? { |r| r['reason'].start_with?('kept', 'no_api') }
        )
      end,

      output_fields: lambda do |_object_definitions|
        count_fields = [
          { name: 'recipes', type: :integer },
          { name: 'connections', type: :integer },
          { name: 'tables', type: :integer },
          { name: 'pages', type: :integer },
          { name: 'collections', type: :integer },
          { name: 'endpoints', type: :integer }
        ]

        [
          { name: 'workato_environment' },
          { name: 'found', type: :boolean,
            hint: 'A project matched. False on an already-clean workspace: nothing is done and no error is raised.' },
          { name: 'project_id', type: :integer },
          { name: 'folder_id', type: :integer },
          { name: 'project_name' },
          { name: 'dry_run', type: :boolean },
          { name: 'would_delete', type: :object, properties: count_fields,
            hint: 'Dry run only. Counts per type a real run would delete.' },
          { name: 'deleted', type: :object, properties: count_fields,
            hint: 'Counts per type deleted. Empty on a dry run.' },
          { name: 'tables_swept', type: :integer,
            hint: 'Tables that survived the project delete and were removed by the sweep. Expect 0.' },
          { name: 'residue', type: :array, of: :object,
            hint: 'Workspace-level assets left in place: custom adapters, account properties, templates, topics.',
            properties: [
              { name: 'type' },
              { name: 'id', type: :integer },
              { name: 'name' },
              { name: 'reason', hint: 'kept: … | no_api: …' }
            ] },
          { name: 'verified', type: :boolean,
            hint: 'True when the project is absent from List projects and holds no connections after the delete.' },
          { name: 'all_clean', type: :boolean,
            hint: 'True when verified and every residue entry is kept or no_api — the gate for resetting the pool row.' }
        ]
      end,

      sample_output: lambda do |_connection, input|
        # Mirrors execute: nil Dry run (a step saved before the field) means Yes.
        dry    = input['dry_run'].nil? || input['dry_run'].is_true?
        counts = { 'recipes' => 4, 'connections' => 2, 'tables' => 1, 'pages' => 0, 'collections' => 1, 'endpoints' => 3 }
        result = {
          'workato_environment' => 'TEST', 'found' => true, 'project_id' => 77, 'folder_id' => 1201,
          'project_name' => 'Orders', 'dry_run' => dry, 'tables_swept' => 0,
          'residue' => call('clean_residue', { 'custom_adapter' => [{ 'id' => 801, 'name' => 'Workato Developer API' }] })
        }

        if dry
          result.merge('would_delete' => counts, 'deleted' => {}, 'verified' => false, 'all_clean' => false)
        else
          result.merge('deleted' => counts, 'verified' => true, 'all_clean' => true)
        end
      end,

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },

    # Invite collaborator
    # Endpoint: POST /member_invitations (workspace collaborators). The API client behind the token must have
    # access to the DEV environment of the target workspace and the collaborator privileges — true for a
    # client workspace's seeded dev_api_token when that client was created as Admin.
    invite_collaborator: {
      title: 'Invite collaborator',
      subtitle: 'Invite a user to the target workspace, idempotent by email',
      help: lambda do
        { body: 'Looks the email up in the workspace\'s collaborators first: when it is already there the action ' \
                'returns already_member with the roles held and sends nothing. Otherwise it posts an invitation ' \
                'for one environment (dev for a single-environment client workspace; test or prod for a row of this ' \
                'workspace) with the role given, and Workato emails the user. Not retried on 429: Workato allows one ' \
                'invitation per email and workspace every 20 minutes, so a 429 here means "already invited, wait".' }
      end,

      input_fields: lambda do |object_definitions|
        object_definitions['env_selector'] + [
          { name: 'email', optional: false, hint: 'The collaborator\'s sign-in email. Matched case-insensitively against existing collaborators.' },
          { name: 'name', optional: true,
            hint: 'Display name on the invitation. Blank = derived from the email local part (jane.doe → "Jane Doe").' },
          { name: 'environment_type', label: 'Environment type', control_type: 'select', pick_list: 'collaborator_environment_types',
            optional: true, default: 'dev', toggle_hint: 'Use datapill',
            hint: 'Environment the role applies to. A client workspace has one environment: dev. For a TEST/PROD row of ' \
                  'this workspace map the pool row\'s target_environment, lowercased. Other environments get No access.',
            toggle_field: { name: 'environment_type', label: 'Environment type', type: :string, control_type: 'text',
                            optional: true, toggle_hint: 'Select from list', hint: 'dev, test or prod.' } },
          { name: 'role_name', label: 'Role', optional: false, default: 'Analyst',
            hint: 'A system role (Admin, Analyst, Operator) or a custom role name exactly as the workspace spells it. ' \
                  'A role the workspace does not have is a 400 from Workato.' },
          { name: 'role_type', label: 'Role type', control_type: 'select', pick_list: 'collaborator_role_types', optional: true,
            hint: 'Leave blank for privilege_group (the default on both access models).',
            toggle_hint: 'Use datapill',
            toggle_field: { name: 'role_type', label: 'Role type', type: :string, control_type: 'text', optional: true,
                            toggle_hint: 'Select from list', hint: 'privilege_group or environment.' } },
          { name: 'user_group_ids', label: 'Collaborator group IDs', optional: true,
            hint: 'Comma-separated collaborator group IDs (ug-…) to add the user to. Optional.' }
        ]
      end,

      execute: lambda do |connection, input|
        env     = call('env_ref', connection, input)
        headers = call('get_auth_headers', connection, env)
        dc      = call('get_datacenter', connection, env)

        email = input['email'].to_s.strip.downcase
        error('Email is required.') if email.blank?
        error("'#{input['email']}' does not look like an email address.") unless email.include?('@')

        name = input['name'].to_s.strip
        if name.blank?
          name = email.split('@').first.to_s.split(/[._\-+]+/).reject(&:blank?).map(&:capitalize).join(' ')
          name = email if name.blank?
        end
        env_type = (input['environment_type'].presence || 'dev').to_s.strip.downcase
        error("Environment type must be dev, test or prod; got '#{env_type}'.") unless %w[dev test prod].include?(env_type)
        role = input['role_name'].to_s.strip
        error('Role is required.') if role.blank?

        # 1. Already a collaborator? The API filter is a substring match, so re-check exactly here.
        listing = get("#{dc}/members", 'email' => email)
                    .headers(headers)
                    .after_error_response(/.*/) do |_c, b, _h, m|
                      error("List collaborators failed: #{m} — #{b}")
                    end
        body    = call('resolve_response', listing)
        members = Array(body.is_a?(::Hash) ? body['data'] : body)
        member  = members.find { |u| u['email'].to_s.strip.downcase == email }

        if member
          roles = Array(member['roles']).map do |r|
            { 'environment_type' => r['environment_type'], 'role_name' => r['role_name'], 'role_type' => r['role_type'] }
          end
          {
            'status'           => 'already_member',
            'invited'          => false,
            'already_member'   => true,
            'email'            => email,
            'name'             => member['name'],
            'member_id'        => member['id'],
            'environment_type' => env_type,
            'role_name'        => (roles.find { |r| r['environment_type'] == env_type } || {})['role_name'],
            'roles'            => roles,
            'message'          => "#{email} is already a collaborator (#{member['grant_type']})."
          }
        else
          # 2. Invite. One env_roles entry; Workato assigns No access to the environments left out.
          payload = {
            'name'      => name,
            'email'     => email,
            'env_roles' => [{ 'environment_type' => env_type, 'name' => role, 'role_type' => input['role_type'].presence }.compact]
          }
          groups = call('csv_list', input['user_group_ids'])
          payload['user_group_ids'] = groups if groups.present?

          response = post("#{dc}/member_invitations")
                       .headers(headers)
                       .payload(payload)
                       .after_error_response(/.*/) do |code, b, _h, m|
                         hint = code.to_i == 429 ? ' (one invitation per email and workspace every 20 minutes; the earlier invitation stands)' : ''
                         error("Invite collaborator failed for #{email}: #{m} — #{b}#{hint}")
                       end
          result = call('resolve_response', response)
          ok     = result.is_a?(::Hash) ? result['result'].to_s == 'ok' : true

          {
            'status'           => 'invited',
            'invited'          => ok,
            'already_member'   => false,
            'email'            => email,
            'name'             => name,
            'member_id'        => nil,
            'environment_type' => env_type,
            'role_name'        => role,
            'roles'            => [{ 'environment_type' => env_type, 'role_name' => role,
                                     'role_type' => (input['role_type'].presence || 'privilege_group') }],
            'message'          => "Invitation sent to #{email} as #{role} (#{env_type})."
          }
        end
      end,

      output_fields: lambda do |_object_definitions|
        [
          { name: 'status', hint: 'invited | already_member' },
          { name: 'invited', type: :boolean, hint: 'True when this call sent an invitation.' },
          { name: 'already_member', type: :boolean },
          { name: 'email' },
          { name: 'name' },
          { name: 'member_id', type: :integer, hint: 'Collaborator ID when already a member; empty for a fresh invitation.' },
          { name: 'environment_type' },
          { name: 'role_name', hint: 'Role granted (invited) or held in that environment (already_member).' },
          { name: 'roles', type: :array, of: :object,
            properties: [{ name: 'environment_type' }, { name: 'role_name' }, { name: 'role_type' }] },
          { name: 'message' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'status' => 'invited', 'invited' => true, 'already_member' => false, 'email' => 'jane.doe@example.com',
          'name' => 'Jane Doe', 'member_id' => nil, 'environment_type' => 'dev', 'role_name' => 'Analyst',
          'roles' => [{ 'environment_type' => 'dev', 'role_name' => 'Analyst', 'role_type' => 'privilege_group' }],
          'message' => 'Invitation sent to jane.doe@example.com as Analyst (dev).' }
      end
    }

  },

  # --- TRIGGERS ----------------------------------------------------
  triggers: {

    new_build_completed: {
      title: 'New completed build',
      subtitle: 'Triggers when a build completes successfully',
      description: 'Polls for newly completed builds in the selected ' \
                   'environment. Only successful builds trigger the recipe. ' \
                   'Checks every 5 minutes by default.',
      type: :paging_desc,

      config_fields: [
        { name: 'deployment_mode', label: 'Deployment mode', control_type: 'select', pick_list: 'deployment_mode',
          optional: false, sticky: true,
          hint: 'Projects only: RLCM has no endpoint that lists packages.' }
      ],
      
      input_fields: lambda do |object_definitions, _connection, _config_fields|
        object_definitions['env_selector']
      end,
      
      poll: lambda do |connection, input, closure|
        closure    = closure || {}
        env        = call('env_ref', connection, input)
        env_name   = env['name']
        is_projects = input['deployment_mode'] == 'projects'
        headers    = call('get_auth_headers', connection, env)
        dc         = call('get_datacenter', connection, env)

        unless is_projects
          error('RLCM has no list-packages endpoint (only GET /packages/:id), so this trigger cannot poll ' \
                'in RLCM mode. Use Build and download package, or poll Get build status on a known package ID.')
        end

        since = closure['since'] || (now - 1.hour).utc.iso8601

        response = get("#{dc}/project_builds?since=#{since}")
                     .headers(headers)
                     .after_error_response(/.*/) do |_c, b, _h, m|
                       error("Trigger poll failed: #{m} — #{b}")
                     end

        items = call('list_body', response)

        # Filter to successful builds and normalize
        completed = items.select do |item|
          status = call('normalize_status', item, is_projects)
          status == 'success'
        end

        builds = completed.map do |item|
          {
            'id'                  => item['id'],
            'status'              => 'success',
            'deployment_mode'     => input['deployment_mode'],
            'workato_environment' => env_name,
            'source_reference'    => item['project_id'] || item['export_manifest_id'],
            'download_url'        => item['download_url']
          }
        end

        next_since = if builds.present?
                       now.utc.iso8601
                     else
                       since
                     end

        {
          events: builds,
          next_poll: { 'since' => next_since },
          can_poll_more: false
        }
      end,

      dedup: lambda do |record|
        record['id']
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['build_obj']
      end,

      sample_output: lambda do |_connection, input|
        call('sample_build', input)
      end
    }
  },

  # --- PICK LISTS --------------------------------------------------
  pick_lists: {

    asset_layouts: lambda do
      [
        ['Flat list', 'flat'],
        ['Grouped by type', 'grouped']
      ]
    end,

    credential_sources: lambda do
      [
        ['Google service account (stored on this connection)', 'google_service_account'],
        ['Connection parameters (JSON)', 'input_json']
      ]
    end,

    data_centers: lambda do
      call('data_center_options')
    end,

    deployment_mode: lambda do
      [
        ['Projects (Environments)', 'projects'],
        ['Recipe Lifecycle Management', 'rlcm']
      ]
    end,

    endpoint_actions: lambda do
      [
        %w[Enable enable],
        %w[Disable disable]
      ]
    end,

    environments: lambda do |connection|
      (connection['workato_environments'] || []).map do |env|
        [env['name'], env['name']]
      end
    end,

    recipe_actions: lambda do
      [
        %w[Start start],
        %w[Stop stop],
        %w[Delete delete]
      ]
    end,

    recipe_state_actions: lambda do
      [
        %w[Start start],
        %w[Stop stop]
      ]
    end,
    
    target_environments: lambda do |connection, source_environment: nil|
      envs = connection ['workato_environments'] || []
      wanted = source_environment.to_s.strip.downcase
      known = envs.any? { |e| e['name'].to_s.strip.downcase == wanted }

      targets = call('get_target_environments', connection, {
        'source_env' => (known ? source_environment : nil )
      })
      targets.map { |env| [env['name'], env['name']] }
    end,

    target_kinds: lambda do
      [
        ['Registered environment', 'registered'],
        ['Another workspace', 'runtime']
      ]
    end,

    target_environment_types: lambda do
      [
        %w[Test test],
        %w[Production prod]
      ]
    end,

    collaborator_environment_types: lambda do
      [
        %w[Dev dev],
        %w[Test test],
        %w[Production prod]
      ]
    end,

    collaborator_role_types: lambda do
      [
        ['Privilege group (default on both access models)', 'privilege_group'],
        ['Environment role (RBAC 2.0)', 'environment']
      ]
    end
  }
}
