    # Invite collaborator
    # Insert in `actions:` after clean_project (before the closing `},` of actions).
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
    },
