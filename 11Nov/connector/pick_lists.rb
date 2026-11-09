    # Insert in `pick_lists:` after target_environment_types (add a comma after its `end`).
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
