# ============================================================================
# Patch: Projects-mode deployment — route through DEV, poll /deployments/:id
# Against: Workato Developer API connector (dev_api.rb) as pasted 30 Sep 2026
#
# What was wrong (per docs.workato.com/workato-api/projects and /api-clients):
#   • Project build/deploy/deployment endpoints exist only in the DEV environment.
#     start_deployment and deploy_package authenticated the deploy and the status
#     poll to the TARGET environment, whose client cannot see them.
#   • The status URL for a deployment is GET /deployments/:id. build_endpoint
#     returned project_builds/:id/deploy for 'deploy_status' — that is the POST.
#   • The deployment object carries detailed_state and an assets[] list; the
#     result shape dropped both.
#
# Seven edits, all inside existing blocks. RLCM mode is untouched.
#   A. methods.build_endpoint         — replace whole lambda
#   B. methods                        — add deploy_environment_type after resolve_target_env
#   C. methods.start_deployment       — replace the projects branch only
#   D. methods.deployment_result      — replace whole lambda
#   E. methods.poll_or_reinvoke       — one line in the 'failed' branch
#   F. object_definitions             — deployment_obj fields, deploy_input_fields hints
#   G. actions.deploy_package         — replace execute; help text on deploy_package,
#                                       deploy_package_async, get_deployment
# ============================================================================


# ---------------------------------------------------------------------------
# A. methods.build_endpoint — replace the whole lambda
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# B. methods — add after resolve_target_env
# ---------------------------------------------------------------------------

    # ── deploy_environment_type ───────────────────────────────
    # Projects mode: the environment_type the deploy payload takes. An explicit
    # Env type wins; otherwise it is derived from the resolved target — prod when
    # that environment is marked production, test otherwise. Only registered
    # environments qualify: the deploy runs in DEV and names the target, it never
    # authenticates to it, so a runtime override has nothing to attach to.
    deploy_environment_type: lambda do |input, target_env|
      if input['target_api_token'].present?
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


# ---------------------------------------------------------------------------
# C. methods.start_deployment — replace the `if input['deployment_mode'] == 'projects'`
#    branch (up to, not including, the `else`). The RLCM branch stays as it is.
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# D. methods.deployment_result — replace the whole lambda
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# E. methods.poll_or_reinvoke — in the `when 'failed'` branch, replace
#      msg = response['error'] || 'Operation failed.'
#    with:
# ---------------------------------------------------------------------------

        msg = response['error'] || response['detailed_state'] || 'Operation failed.'


# ---------------------------------------------------------------------------
# F. object_definitions
# ---------------------------------------------------------------------------

# F1. deployment_obj — append these after the recipe_status field:

          { name: 'detailed_state',
            hint: 'Projects only. Workato\'s finer state, e.g. deploy_finished, pending_review.' },
          { name: 'environment_type', hint: 'Projects only. The environment deployed to.' },
          { name: 'project_build_id', type: :integer, hint: 'Projects only.' },
          { name: 'asset_count', type: :integer, hint: 'Projects only. Assets in the deployment.' },
          { name: 'assets_new', type: :integer, hint: 'Projects only. Assets created in the target.' },
          { name: 'assets_updated', type: :integer, hint: 'Projects only. Assets that already existed and were overwritten.' },
          { name: 'assets', type: :array, of: :object,
            hint: 'Projects only. One entry per asset. id is the target-side ID; null for a new asset until it is created.',
            properties: [
              { name: 'id', type: :integer },
              { name: 'name' },
              { name: 'type' },
              { name: 'state', hint: 'new | updated | deleted' },
              { name: 'folder' }
            ] }

# F2. deploy_input_fields — replace these four field definitions in place
#     (source_environment, target_api_token, include_tags, env_type):

          { name: 'source_environment', control_type: 'select', pick_list: 'environments', toggle_hint: 'Use datapill',
            optional: false,
            hint: 'The environment the package was built in. In Projects mode every call (deploy and status) ' \
                  'authenticates here — deployment endpoints exist only in DEV.' },

          { name: 'target_api_token', label: 'Target API token', control_type: 'text', optional: true,
            hint: 'RLCM only. Runtime target: API token for a workspace not registered on this connection. Overrides ' \
                  'Target environment. Passes through the job as a step input — enable data masking on the step. ' \
                  'Rejected in Projects mode, which deploys within one workspace.' },

          { name: 'include_tags', type: :boolean, control_type: 'checkbox', default: 'false', optional: true,
            hint: 'Preserve tags on deployed assets. RLCM: only has effect if the manifest was created with Include tags. ' \
                  'Projects: tags are applied in the target environment when Yes.' },

          { name: 'env_type', control_type: 'select', pick_list: 'target_environment_types', optional: true,
            ngIf: 'input.deployment_mode == "projects"',
            hint: 'Projects only. Leave blank to derive from the target: prod when it is marked production, else test.' },


# ---------------------------------------------------------------------------
# G. actions
# ---------------------------------------------------------------------------

# G1. actions.deploy_package.help — replace body:

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

# G2. actions.deploy_package.execute — replace the whole lambda:

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

# G3. actions.deploy_package_async.help — replace body:

        { body: 'Starts a deployment without waiting for it to finish. Returns the deployment ID and initial status. ' \
                'Projects mode starts it through the source (DEV) environment; follow with Get deployment status ' \
                'against the same source environment. RLCM mode starts the import on the target. Useful when ' \
                'deploying to several environments in parallel.' }

# G4. actions.get_deployment — replace the help body and the deployment_mode field hint:

        { body: 'Returns the current status of a deployment. Status is normalized across both modes: in_progress, ' \
                'success, or failed. Projects: select the environment the deployment was started from (DEV) — ' \
                'deployment endpoints exist only there — and read detailed_state and assets. RLCM: select the ' \
                'target; a finished import returns recipe_status and all_recipes_ok.' }

          {
            name: 'deployment_mode',
            control_type: 'select',
            pick_list: 'deployment_mode',
            toggle_hint: 'Use datapill',
            optional: false,
            hint: 'Must match the mode used for the deployment. Projects: the environment above must be the one ' \
                  'the deployment was started from, not the one deployed to.'
          },
