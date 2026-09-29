list_folder_assets: {
  title: 'List folder assets',
  # ... help unchanged, plus a sentence on the two layouts ...

  config_fields: [
    { name: 'layout', label: 'Asset layout', control_type: 'select',
      pick_list: 'asset_layouts', optional: false, default: 'flat', sticky: true,
      hint: 'Flat list: one assets array — the shape Create or update export manifest takes. ' \
            'Grouped by type: one array per asset type for reading and branching. ' \
            'Changing this re-renders the output datapills.' }
  ],

  input_fields: lambda do |object_definitions, _connection, _config_fields|
    # unchanged
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

  # retry block unchanged
}
