# =====================================================================
# clean_workspace — insertable blocks for the Workato Developer API connector
#
# Four blocks. Each is marked with where it goes. The pasted connector already
# has `project_id` and `is_project` on folder_obj, so no object-definition
# change is needed.
#
#   BLOCK 1  methods  — after `release_custom_connector` (add a comma to its
#                       closing `end`, since it is currently the last method)
#   BLOCK 2  actions  — after `create_folder`
#   BLOCK 3  actions  — after `delete_api_client`
#   BLOCK 4  actions  — after `ensure_custom_connector` (add a comma to its
#                       closing `}`, since it is currently the last action)
# =====================================================================


# ---------------------------------------------------------------------
# BLOCK 1 — methods. Insert after `release_custom_connector`.
# ---------------------------------------------------------------------

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

    # ── find_project ──────────────────────────────────────────
    # A project by its top-level folder ID or exact name (first 100 projects).
    # nil when absent; error when more than one matches — a teardown must
    # never pick one of two.
    find_project: lambda do |dc, headers, folder_id, name, env_name|
      response = get("#{dc}/projects", { 'per_page' => 100 })
                   .headers(headers)
                   .after_error_response(/.*/) do |_c, b, _h, m|
                     error("Resolve project failed in #{env_name}: #{m} — #{b}")
                   end

      projects = call('list_body', response).map { |p| call('project_summary', p) }
      projects = projects.select { |p| p['folder_id'].to_s == folder_id.to_s } if folder_id.present?
      projects = projects.select { |p| p['name'] == name } if name.present?

      if projects.length > 1
        error("Project is ambiguous in #{env_name}: #{projects.length} match.")
      end

      projects.first
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
    end


# ---------------------------------------------------------------------
# BLOCK 2 — action. Insert after `create_folder`.
# ---------------------------------------------------------------------

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
        # be a Hash before is_project is read from it.
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
        folder = (gone || !body.is_a?(::Hash)) ? {} : body

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

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },


# ---------------------------------------------------------------------
# BLOCK 3 — action. Insert after `delete_api_client`.
# ---------------------------------------------------------------------

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

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    },


# ---------------------------------------------------------------------
# BLOCK 4 — action. Insert after `ensure_custom_connector`.
# ---------------------------------------------------------------------

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

        # ── Guard: nothing running (first 100 recipes) ────
        if check
          recipes = get("#{dc}/recipes", { 'folder_id' => folder_id, 'per_page' => 100 })
                      .headers(headers)
                      .after_error_response(/.*/) do |_c, b, _h, m|
                        error("Folder listing failed in #{env['name']}: #{m} — #{b}")
                      end
          running = call('list_body', recipes).select { |r| r['running'] }

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

      retry_on_response: [429],
      retry_on_request: %w[GET PUT POST DELETE],
      max_retries: 3
    }
