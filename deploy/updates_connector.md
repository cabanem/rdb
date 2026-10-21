Here are the edits, grouped by location in the file. Each block is a full replacement for the declaration it names, so you can select the existing one in the SDK editor and paste over it.

## 1. Methods — add after `target_kind_field`

```ruby
    # ── data_center_options ───────────────────────────────────
    # [label, API base] pairs. Read by the data_centers pick list and by
    # data_center_url. The connection field's options must stay a literal.
    data_center_options: lambda do
      [
        ['US', 'https://www.workato.com/api'],
        ['EU', 'https://app.eu.workato.com/api'],
        ['SG', 'https://app.sg.workato.com/api'],
        ['JP', 'https://app.jp.workato.com/api']
      ]
    end,

    # ── data_center_url ───────────────────────────────────────
    # A runtime target's data center may arrive as the pick-list URL or as a
    # region code from a table row (EU, US, SG, JP). Both resolve to the API
    # base with no trailing slash, since every endpoint is built as "#{dc}/...".
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
    # The text form of an environment select, so a recipe can map the name
    # from a table row. Same name as the select it pairs with; optional mirrors it.
    env_name_toggle: lambda do |name, label, optional|
      { name: name, label: label, type: :string, control_type: 'text', optional: optional,
        toggle_hint: 'Select from list',
        hint: 'A registered environment name exactly as on the connection, e.g. TEST.' }
    end,

    # ── data_center_toggle ────────────────────────────────────
    # The text form of the Target data center select.
    data_center_toggle: lambda do
      { name: 'target_data_center', label: 'Target data center', type: :string, control_type: 'text',
        optional: true, toggle_hint: 'Select from list',
        hint: 'US, EU, SG, JP, or the API base URL (e.g. https://app.eu.workato.com/api).' }
    end,
```

## 2. Methods — `resolve_environment`

Replace the one lookup line:

```ruby
        env  = envs.find { |e| e['name'] == env_ref }
```

with:

```ruby
        # Case-insensitive, so a name mapped from a table row matches; the
        # canonical connection entry is what is returned and stamped on outputs.
        wanted = env_ref.to_s.strip.downcase
        env    = envs.find { |e| e['name'].to_s.strip.downcase == wanted }
```

## 3. Methods — `env_ref`

In the runtime branch, replace:

```ruby
          'data_center'   => input['target_data_center'],
```

with:

```ruby
          'data_center'   => call('data_center_url', input['target_data_center']),
```

## 4. Object definitions — `env_selector`

Replace the `workato_environment` and `target_data_center` entries (the `target_kind_field` call, `target_api_token` and `target_label` are unchanged):

```ruby
          { name: 'workato_environment', label: 'Workato environment', control_type: 'select', pick_list: 'environments',
            toggle_hint: 'Use datapill', optional: true, ngIf: 'input.target_kind != "runtime"',
            hint: 'The registered environment to act in.',
            toggle_field: call('env_name_toggle', 'workato_environment', 'Workato environment', true) },
          { name: 'target_data_center', label: 'Target data center', control_type: 'select', pick_list: 'data_centers',
            toggle_hint: 'Use datapill', optional: true, ngIf: 'input.target_kind != "registered"',
            hint: 'Runtime target: the data center of a workspace not registered on this connection (e.g. a client ' \
                  'workspace resolved from the registry). Requires Target API token.',
            toggle_field: call('data_center_toggle') },
```

## 5. Object definitions — `deploy_input_fields`

Replace the `source_environment`, `target_environment` and `target_data_center` entries:

```ruby
          { name: 'source_environment', label: 'Source environment', control_type: 'select', pick_list: 'environments',
            toggle_hint: 'Use datapill', optional: false,
            hint: 'The environment the package was built in. In Projects mode every call (deploy and status) ' \
                  'authenticates here — deployment endpoints exist only in DEV.',
            toggle_field: call('env_name_toggle', 'source_environment', 'Source environment', false) },
          call('target_kind_field', 'Target environment below, or blank to promote to the next environment by level. ' \
                                    'Projects mode accepts only this.'),
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
```

## 6. Object definitions — `connector_target_fields`

Full replacement. `source_environment` moves in here from the action so it can use `call()`:

```ruby
    # Source and target fields for Ensure custom connector. An object definition,
    # not inline: Workato's semantic check rejects call() inside an action's input_fields.
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
```

## 7. Action — `ensure_custom_connector` `input_fields`

Replace the whole lambda (title stays first; the inline `source_environment` is gone):

```ruby
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
```

## 8. Actions — `get_environments` and `get_environment_by_name`

These are action-level, so the toggle is written out rather than called.

`get_environments` — replace the `source_environment` entry:

```ruby
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
```

`get_environment_by_name` — replace the `workato_environment` entry:

```ruby
          { name: 'workato_environment', label: 'Workato environment', control_type: 'select', pick_list: 'environments',
            toggle_hint: 'Use datapill', optional: false, hint: 'The environment to look up.',
            toggle_field: {
              name: 'workato_environment', label: 'Workato environment', type: :string, control_type: 'text',
              optional: false, toggle_hint: 'Select from list',
              hint: 'A registered environment name exactly as on the connection, e.g. TEST.'
            } }
```

## 9. Pick lists — `data_centers`

```ruby
    data_centers: lambda do
      call('data_center_options')
    end,
```

## Not changed, on purpose

- The connection field's `data_center` `options` stays a literal (connection fields can't `call`).
- `deployment_mode` and `layout` config fields stay as they are.
- `env_selector`'s `target_kind_field`, `target_api_token` and `target_label` are untouched.
- `recipe_action`, `action` and `credential_source` keep their current declarations; that's the separate follow-up.

Order to apply: 1–3 first and run an existing pick-list step to confirm no regression, then 4–9, then open a registered step, a runtime step, and a Deploy step with source and target both toggled.
