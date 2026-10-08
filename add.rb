# frozen_string_literal: true
#
# Wave 3 - the form channel. Additions to sdc_compute_connector.rb (DataBridge Compute, Waves 1+2).
#
#   create_suppliers_plan   <- WFA-009c "Resolve input against CFG_Variant, CFG_TemplateVersion"
#   count_requests          <- WFA-05b  "Get data for page event/dropdown selection"
#   load_form_slots         <- WFA-018c "Load form slots for form-based supplier input"
#   stage_form_record       <- UTL-10   "Save a single resource to RUN_ManualEntry"
#   pivot_staged_rows       <- FRM-01   "Pivot the staged EAV -> submission payload"
#   (WFA-05c becomes a formula in the call_recipe input; see WAVE3_GUIDE.md)
#
# This file is three blocks plus two one-line entity edits. Splice each block into the matching section of the
# connector, at the anchor named in its header. Nothing in Waves 1-2 changes except the two entity extensions.
#
# Wave 3 rules, on top of the connector's:
#   - ONE slot table (slot_capacities) generates form_values, load_form_slots' 81 outputs, and the known-slot set.
#   - coerce_value is FRM-01's contract toward the file channel and is deliberately NOT to_int / to_bool: a value that
#     will not coerce passes through unchanged, so validate_upload reports it field-by-field.
#   - is_blank_value: nil or whitespace-only. 0 and false are values.
#   - Two actions are the platform's write path (stage_form_record stages RUN_ManualEntry; pivot_staged_rows' rows_json
#     is stored as the file the validator reads). Their real-job proof is part of this wave, not a follow-up.
# =====================================================================================================================


# =====================================================================================================================
# BLOCK 1 of 3 - OBJECT DEFINITIONS
# Splice point: inside `object_definitions: { ... }`, after `will_reseed_flag` (the last Wave 2 definition).
# =====================================================================================================================

    # --- Wave 3 additions ------------------------------------------------------------------------------------------

    apply_variant_filter_flag: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          {
            name: 'apply_variant_filter', type: 'boolean', control_type: 'checkbox', label: 'Apply variant filter', optional: true,
            hint: 'Show only the slots whose field is in variant_fields. Default off. (The recipe passed the literal "false" to the Python step.)',
            toggle_hint: 'Use a value or pill',
            toggle_field: {
              name: 'apply_variant_filter', type: 'boolean', control_type: 'text', label: 'Apply variant filter', optional: true,
              convert_input: 'boolean_conversion', toggle_hint: 'Use checkbox', hint: 'true or false, or map a pill'
            }
          }
        ]
      end
    },

    # The CFG_Field columns the form channel reads. CAN-01 brings the full canonical shape in Wave 4 and extends this
    # additively.
    cfg_field: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'field_id', type: 'string', label: 'Field ID' },
          { name: 'field_name', type: 'string', label: 'Field name', hint: 'The identity key: the file channel and validate_upload look fields up by name' },
          { name: 'data_type', type: 'string', label: 'Data type', hint: 'text, integer, float, float (2), decimal, boolean, date ...' }
        ]
      end
    },

    # A CFG_FormSlotMapping row: the union of what stage_form_record and load_form_slots read. Map the table's columns
    # onto these names once. (The Python step's input schema named the label column `field_name`; the code read
    # `display_label`, so RUN_ManualEntry.label has been blank on every row ever staged. Here the column has one name.)
    form_slot: {
      fields: lambda do |_connection, _config_fields, object_definitions|
        [
          { name: 'slot_name', type: 'string', label: 'Slot name', hint: 'slot_text_01 ... slot_float_04' },
          { name: 'position', type: 'integer', label: 'Position' },
          { name: 'field_id', type: 'string', label: 'Field ID' },
          { name: 'display_label', type: 'string', label: 'Display label', hint: 'Blank hides the slot on the page' },
          { name: 'description', type: 'string', label: 'Description', hint: 'Help text under the component' },
          *object_definitions['required_flag'],
          { name: 'depends_on_slot_name', type: 'string', label: 'Depends on slot name', hint: 'Cascade parent (select slots only)' },
          { name: 'lookup_name', type: 'string', label: 'Lookup name', hint: 'Blank on a select slot = not_applicable' }
        ]
      end
    },

    # The object the page sends to stage_form_record: one property per physical slot, bare names (text_01 ... float_04),
    # typed per family. Generated from slot_capacities so it cannot disagree with load_form_slots about what a slot is.
    # Boolean slots carry the same-name text toggle every boolean input in this connector has.
    form_values: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        types = { 'text' => 'string', 'int' => 'integer', 'bool' => 'boolean', 'sel' => 'string', 'date' => 'date', 'float' => 'number' }
        controls = { 'text' => 'text', 'int' => 'integer', 'bool' => 'checkbox', 'sel' => 'text', 'date' => 'date', 'float' => 'number' }
        call(:slot_capacities).flat_map do |fam, count|
          (1..count).map do |i|
            name = format('%s_%02d', fam, i)
            field = { name: name, type: types[fam], control_type: controls[fam], label: name, optional: true }
            if fam == 'bool'
              field[:toggle_hint] = 'Use a value or pill'
              field[:toggle_field] = { name: name, type: 'boolean', control_type: 'text', label: name, optional: true,
                                       convert_input: 'boolean_conversion', toggle_hint: 'Use checkbox', hint: 'true or false, or map a pill' }
            end
            field
          end
        end
      end
    },

    # A RUN_ManualEntry row, one definition for both directions: stage_form_record writes all seven columns,
    # pivot_staged_rows reads record_index, field_id and value.
    manual_entry_row: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'supplier_request_id', type: 'string', label: 'Supplier request ID' },
          { name: 'record_index', type: 'integer', label: 'Record index', hint: '1-based; one per staged record of the request' },
          { name: 'field_id', type: 'string', label: 'Field ID' },
          { name: 'slot_name', type: 'string', label: 'Slot name' },
          { name: 'label', type: 'string', label: 'Label' },
          { name: 'value', type: 'string', label: 'Value', hint: 'Passed through exactly as the page sent it; may be a number, boolean or date' },
          { name: 'is_blank', type: 'boolean', control_type: 'checkbox', label: 'Is blank' }
        ]
      end
    },

    # One (supplier_name, variant_id) slot from the multi-supplier create page.
    new_supplier_slot: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'supplier_name', type: 'string', label: 'Supplier name' },
          { name: 'variant_id', type: 'string', label: 'Variant ID' }
        ]
      end
    },

    # A slot create_suppliers_plan would not create, and why.
    rejected_slot: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          { name: 'slot', type: 'integer', label: 'Slot', hint: '1-based position on the page' },
          { name: 'supplier_name', type: 'string', label: 'Supplier name' },
          { name: 'variant_id', type: 'string', label: 'Variant ID' },
          { name: 'reason', type: 'string', label: 'Reason' }
        ]
      end
    },

    required_flag: {
      fields: lambda do |_connection, _config_fields, _object_definitions|
        [
          {
            name: 'required', type: 'boolean', control_type: 'checkbox', label: 'Required', optional: true,
            hint: 'true / 1 / yes / y / t are all read as true; adds " *" to the label',
            toggle_hint: 'Use a value or pill',
            toggle_field: {
              name: 'required', type: 'boolean', control_type: 'text', label: 'Required', optional: true,
              convert_input: 'boolean_conversion', toggle_hint: 'Use checkbox', hint: 'true or false, or map a pill'
            }
          }
        ]
      end
    },


# =====================================================================================================================
# ENTITY EDITS (two lines) - apply with find-and-replace in the existing definitions.
# =====================================================================================================================
#
# In `supplier`, after the `status` line, add:
#
#          { name: 'default_variant_id', type: 'string', label: 'Default variant ID', hint: 'SUP_Supplier column; written by create_suppliers_plan' }
#
# In `supplier_request`, after the `*object_definitions['has_seeded_data_flag'],` line, add:
#
#          { name: 'seeded_template_file_id', type: 'string', label: 'Seeded template file ID', hint: 'Set once INC-02 has written the seeded file' },


# =====================================================================================================================
# BLOCK 2 of 3 - METHODS
# Splice point: inside `methods: { ... }`, after `py_repr` (the last Wave 2 method).
# =====================================================================================================================

    # --- Wave 3 additions ------------------------------------------------------------------------------------------

    # The page's physical layout: slot families and how many of each (WFA-018c's PAGE_CAPACITIES). The ONE place the
    # capacities live: it generates form_values, load_form_slots' 81 output fields, and the known-slot set. A capacity
    # change is one edit here.
    slot_capacities: lambda do
      [['text', 10], ['int', 4], ['bool', 2], ['sel', 10], ['date', 4], ['float', 4]]
    end,

    # slot_text_01 ... slot_float_04, in family order (the Python's SLOT_NAMES).
    slot_names: lambda do
      call(:slot_capacities).flat_map { |fam, count| (1..count).map { |i| format('slot_%s_%02d', fam, i) } }
    end,

    # UTL-10's rule: a bare page key (text_01) is the slot slot_text_01; a name already prefixed is left alone.
    # Blank stays blank. The first of the design record's four key normalisers to land.
    canonical_slot: lambda do |name|
      n = call(:clean, name)
      return '' if n.empty?
      n.start_with?('slot_') ? n : "slot_#{n}"
    end,

    # nil or a whitespace-only string. 0 and false are values. (UTL-10's rule, used three times.)
    is_blank_value: lambda do |value|
      value.nil? || (value.is_a?(String) && value.strip.empty?)
    end,

    # FRM-01's coercion toward the shapes the file channel produces. blank -> nil; integer -> Integer; float / float (2) /
    # decimal -> Float; boolean -> true/false; and ANYTHING THAT DOES NOT COERCE PASSES THROUGH UNCHANGED, because
    # validate_upload owns validation and raises a field-scoped error. This is deliberately not to_int / to_bool:
    # to_int would turn "1.0" into 1 and to_bool would read "maybe" as false, and both would hide a validation error
    # behind a clean value. Cascade values keep their '~' suffix. (Ruby's Float() rejects "nan", "inf" and "1." where
    # Python accepted them, and accepts "0x10" where Python did not; the hex case is refused here so it passes through.)
    coerce_value: lambda do |raw, data_type|
      return nil if raw.nil?
      text = raw.to_s.strip
      return nil if text.empty?
      kind = call(:norm, data_type)
      if kind == 'integer'
        begin
          Integer(text, 10)
        rescue ArgumentError, TypeError
          text
        end
      elsif ['float (2)', 'float', 'decimal'].include?(kind)
        begin
          text.match?(/\A[+-]?0[xX]/) ? text : Float(text)
        rescue ArgumentError, TypeError
          text
        end
      elsif kind == 'boolean'
        lowered = text.downcase
        if %w[true 1 yes t y].include?(lowered)
          true
        elsif %w[false 0 no f n].include?(lowered)
          false
        else
          text
        end
      else
        text
      end
    end,


# =====================================================================================================================
# BLOCK 3 of 3 - ACTIONS
# Splice point: inside `actions: { ... }`, after `health_snapshot` (the last Wave 2 action). Add a comma after
# health_snapshot's closing `}` first.
# =====================================================================================================================

    # =================================================================================================================
    # WAVE 3 - The form channel
    # =================================================================================================================

    # ---- WFA-009c ---------------------------------------------------------------------------------------------------
    create_suppliers_plan: {
      title: 'Plan supplier creation',
      subtitle: 'Resolve the page\'s supplier slots against CFG_Variant and CFG_TemplateVersion; rows for the batch create',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the WFA-009c Python step. Each slot is created only if its variant exists and points at a template ' \
                'version that exists; otherwise it is rejected with a reason. Blank slots are skipped; a name already accepted ' \
                '(case-insensitive) is a duplicate. `created` is true when at least one supplier resolved (the Python step\'s ' \
                '`ok`); the envelope\'s `ok` only says the action ran. status is success | partial | failed.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'new_suppliers', type: 'array', of: 'object', optional: true, label: 'New supplier slots', hint: 'The page\'s (supplier_name, variant_id) slots, in page order',
            properties: object_definitions['new_supplier_slot'] },
          { name: 'variants', type: 'array', of: 'object', optional: true, label: 'Variants (CFG_Variant)', hint: 'variant_id and template_version_id are read',
            properties: object_definitions['variant'] },
          { name: 'versions', type: 'array', of: 'object', optional: true, label: 'Template versions (CFG_TemplateVersion)', hint: 'template_version_id is read',
            properties: object_definitions['template_version_row'] }
        ]
      end,

      execute: lambda do |_connection, input|
        new_suppliers = call(:rows, input['new_suppliers'])
        variants = call(:rows, input['variants'])
        versions = call(:rows, input['versions'])

        variant_to_version = {}
        variants.each do |v|
          next unless v.is_a?(Hash)
          vid = call(:clean, v['variant_id'])
          variant_to_version[vid] = call(:clean, v['template_version_id']) unless vid.empty?
        end
        known_versions = {}
        versions.each do |tv|
          next unless tv.is_a?(Hash)
          id = call(:clean, tv['template_version_id'])
          known_versions[id] = true unless id.empty?
        end

        records = []
        rejected = []
        log = []
        accepted_names = {}
        new_suppliers.each_with_index do |item, i|
          slot = i + 1
          item = {} unless item.is_a?(Hash)
          name = call(:clean, item['supplier_name'])
          variant_id = call(:clean, item['variant_id'])
          if name.empty? && variant_id.empty?
            log << "slot #{slot}: blank, skipped"
            next
          end
          key = name.downcase
          reason = if name.empty?
                     'supplier_name is missing'
                   elsif variant_id.empty?
                     'variant_id is missing'
                   elsif accepted_names.key?(key)
                     "duplicate of slot #{accepted_names[key]}"
                   elsif !variant_to_version.key?(variant_id)
                     "variant_id '#{variant_id}' was not found in CFG_Variant"
                   elsif !known_versions.key?(variant_to_version[variant_id])
                     "variant_id '#{variant_id}' points at template_version_id '#{variant_to_version[variant_id]}', which was not found in CFG_TemplateVersion"
                   end
          if reason
            rejected << { 'slot' => slot, 'supplier_name' => name, 'variant_id' => variant_id, 'reason' => reason }
            log << "slot #{slot}: REJECTED \u2014 #{reason}"
            next
          end
          accepted_names[key] = slot
          records << { 'supplier_id' => call(:new_uuid), 'supplier_name' => name, 'default_variant_id' => variant_id, 'status' => 'active' }
          log << "slot #{slot}: OK \u2014 '#{name}' -> variant #{variant_id} -> version #{variant_to_version[variant_id]}"
        end

        status = if !records.empty? && rejected.empty?
                   'success'
                 elsif !records.empty?
                   'partial'
                 else
                   'failed'
                 end
        problems = rejected.map { |r|
          label = r['supplier_name'].empty? ? "slot #{r['slot']}" : r['supplier_name']
          "#{label} (#{r['reason']})"
        }.join('; ')
        summary = case status
                  when 'success' then "#{records.length} #{records.length == 1 ? 'supplier' : 'suppliers'} added."
                  when 'partial' then "#{records.length} of #{records.length + rejected.length} suppliers added. Not added: #{problems}."
                  else rejected.empty? ? 'No suppliers were provided.' : "No suppliers were added. #{problems}."
                  end

        call(:ok,
             'created' => !records.empty?,
             'status' => status,
             'summary' => summary,
             'created_count' => records.length,
             'rejected_count' => rejected.length,
             'records' => records,
             'rejected' => rejected,
             'log' => log.join("\n"))
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'created', type: 'boolean', control_type: 'checkbox', label: 'Created', hint: 'true when at least one supplier resolved (the Python step\'s `ok`)' },
          { name: 'status', type: 'string', label: 'Status', hint: 'success | partial | failed' },
          { name: 'summary', type: 'string', label: 'Summary', hint: 'One line for the page' },
          { name: 'created_count', type: 'integer', label: 'Created count' },
          { name: 'rejected_count', type: 'integer', label: 'Rejected count' },
          { name: 'records', type: 'array', of: 'object', label: 'Records', hint: 'Rows for Create records (batch) on SUP_Supplier; map created_at to now in that step', properties: [
            { name: 'supplier_id', type: 'string', label: 'Supplier ID' },
            { name: 'supplier_name', type: 'string', label: 'Supplier name' },
            { name: 'default_variant_id', type: 'string', label: 'Default variant ID' },
            { name: 'status', type: 'string', label: 'Status' }
          ] },
          { name: 'rejected', type: 'array', of: 'object', label: 'Rejected', properties: object_definitions['rejected_slot'] },
          { name: 'log', type: 'string', label: 'Log', hint: 'One line per slot' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' }, 'created' => true, 'status' => 'partial',
          'summary' => '1 of 2 suppliers added. Not added: Bolt (variant_id \'var-9\' was not found in CFG_Variant).',
          'created_count' => 1, 'rejected_count' => 1,
          'records' => [{ 'supplier_id' => '6f1c...', 'supplier_name' => 'Acme', 'default_variant_id' => 'var-1', 'status' => 'active' }],
          'rejected' => [{ 'slot' => 2, 'supplier_name' => 'Bolt', 'variant_id' => 'var-9', 'reason' => 'variant_id \'var-9\' was not found in CFG_Variant' }],
          'log' => "slot 1: OK \u2014 'Acme' -> variant var-1 -> version ver-3\nslot 2: REJECTED \u2014 variant_id 'var-9' was not found in CFG_Variant"
        }
      end
    },

    # ---- WFA-05b ----------------------------------------------------------------------------------------------------
    count_requests: {
      title: 'Count requests for the seed-data page',
      subtitle: 'Flagged, seeded and eligible request counts',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the WFA-05b Python step. flagged = has_seeded_data; seeded = has a seeded_template_file_id; ' \
                'eligible = no seeded file and status pending or sent. started and complete count legacy status values ' \
                'outside the canonical six and are expected to be 0. Rows may arrive as rows or as JSON text.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'requests', type: 'array', of: 'object', optional: true, label: 'Requests', hint: 'SUP_SupplierRequest rows: status, has_seeded_data, seeded_template_file_id are read',
            properties: object_definitions['supplier_request'],
            toggle_hint: 'Map rows', toggle_field: { name: 'requests', type: 'string', control_type: 'text-area', optional: true,
                                                     label: 'Requests (JSON list)', toggle_hint: 'Use JSON text',
                                                     hint: 'e.g. data_table_query(...)["records"].pluck("fields").to_json' } }
        ]
      end,

      execute: lambda do |_connection, input|
        blank = { 'total' => 0, 'flagged' => 0, 'seeded' => 0, 'eligible' => 0, 'started' => 0, 'complete' => 0 }
        ok, requests = call(:json_list, input['requests'])
        unless ok
          next call(:fail, 'recipe_invariant',
                    "requests is not a JSON list (starts with: #{call(:clean, input['requests'])[0, 60]}). End the formula with .to_json.",
                    blank)
        end

        seeded_file = lambda { |r| !call(:clean, r['seeded_template_file_id']).empty? }
        call(:ok,
             'total' => requests.length,
             'flagged' => requests.count { |r| call(:to_bool, r['has_seeded_data'], false) },
             'seeded' => requests.count { |r| seeded_file.call(r) },
             'eligible' => requests.count { |r| !seeded_file.call(r) && %w[pending sent].include?(call(:norm, r['status'])) },
             'started' => requests.count { |r| call(:norm, r['status']) == 'started' },
             'complete' => requests.count { |r| call(:norm, r['status']) == 'complete' })
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'total', type: 'integer', label: 'Total' },
          { name: 'flagged', type: 'integer', label: 'Flagged', hint: 'has_seeded_data' },
          { name: 'seeded', type: 'integer', label: 'Seeded', hint: 'has a seeded_template_file_id' },
          { name: 'eligible', type: 'integer', label: 'Eligible', hint: 'no seeded file and status pending or sent' },
          { name: 'started', type: 'integer', label: 'Started', hint: 'Legacy status; expected 0' },
          { name: 'complete', type: 'integer', label: 'Complete', hint: 'Legacy status; expected 0' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        { 'ok' => true, 'error' => { 'code' => '', 'message' => '' }, 'total' => 4, 'flagged' => 1, 'seeded' => 1, 'eligible' => 2, 'started' => 0, 'complete' => 0 }
      end
    },

    # ---- WFA-018c ---------------------------------------------------------------------------------------------------
    load_form_slots: {
      title: 'Load form slots',
      subtitle: 'Labels, descriptions and select states for the page\'s 34 physical slots, from the version\'s slot mapping',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the WFA-018c Python step. Every slot output is always present: a blank label is the page\'s ' \
                '"hide me" signal. A slot is shown when its mapping row has a display_label (and, with the variant filter ' \
                'on, its field is in variant_fields); required adds " *". Select slots whose cascade parent is hidden are ' \
                'hidden too, to a fixpoint, so a parent in a higher-numbered slot than its child still works. A slot name the ' \
                'page has no component for fails the action rather than silently losing supplier data.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'slot_map', type: 'array', of: 'object', optional: true, label: 'Form slot mapping', hint: 'CFG_FormSlotMapping rows for the template version',
            properties: object_definitions['form_slot'] },
          *object_definitions['apply_variant_filter_flag'],
          { name: 'variant_fields', type: 'array', of: 'object', optional: true, label: 'Variant fields', hint: 'The variant\'s field rows (field_id is read); only consulted when the filter is on',
            properties: object_definitions['cfg_field'] }
        ]
      end,

      execute: lambda do |_connection, input|
        slot_names = call(:slot_names)
        sel_slots = slot_names.select { |n| n.start_with?('slot_sel_') }
        required_marker = ' *'

        # Every declared key present. The key set is fixed because the page binds at design time; an absent key would
        # leave a component's visibility condition undefined, and "" is a reliable "hide me".
        blank = { 'visible_slot_count' => 0 }
        slot_names.each do |n|
          blank["#{n}_label"] = ''
          blank["#{n}_description"] = ''
        end
        sel_slots.each { |n| blank["#{n}_state"] = 'unused' }

        rows = call(:rows, input['slot_map']).select { |r| r.is_a?(Hash) }
        next call(:fail, 'recipe_invariant', 'no form slot mapping rows for this version', blank) if rows.empty?

        # An unmapped property yields rows of the right length with empty values, which would otherwise surface as
        # unknown slot "" and send you looking at CAN-01. Name the real cause instead.
        if rows.none? { |r| !call(:clean, r['slot_name']).empty? }
          seen = rows.first.keys.sort.join(', ')
          next call(:fail, 'recipe_invariant',
                    "#{rows.length} slot mapping row(s) received, but none carried a slot_name - the slot_name property is unmapped " \
                    "in this action's input. Properties seen: #{seen.empty? ? '(none)' : seen}",
                    blank)
        end

        variant_field_ids = nil
        if call(:to_bool, input['apply_variant_filter'], false)
          variant_field_ids = {}
          call(:rows, input['variant_fields']).each do |r|
            next unless r.is_a?(Hash)
            fid = call(:clean, r['field_id'])
            variant_field_ids[fid] = true unless fid.empty?
          end
          next call(:fail, 'recipe_invariant', 'variant filter requested but no variant fields found', blank) if variant_field_ids.empty?
        end

        out = blank.dup
        known = {}
        slot_names.each { |n| known[n] = true }
        active = {}
        unknown_slot = nil

        # Pass 1 - labels, descriptions, visibility. Label and description always move together.
        rows.each do |row|
          slot_name = call(:clean, row['slot_name'])
          unless known.key?(slot_name)
            unknown_slot = slot_name
            break
          end
          next if !variant_field_ids.nil? && !variant_field_ids.key?(call(:clean, row['field_id']))
          label = call(:clean, row['display_label'])
          next if label.empty?
          label += required_marker if call(:to_bool, row['required'], false)
          out["#{slot_name}_label"] = label
          out["#{slot_name}_description"] = call(:clean, row['description'])
          out['visible_slot_count'] += 1
          active[slot_name] = row
        end
        unless unknown_slot.nil?
          next call(:fail, 'state_inconsistent',
                    "slot map references unknown slot '#{unknown_slot}' - CAN-01's SLOT_POOL and this page's slots have drifted",
                    blank)
        end

        # Pass 2 - prune cascade orphans to a fixpoint (order-independent: a parent may sit in a higher slot than its child).
        sel_set = {}
        sel_slots.each { |n| sel_set[n] = true }
        loop do
          orphans = active.keys.select do |n|
            parent = call(:clean, active[n]['depends_on_slot_name'])
            sel_set.key?(n) && !parent.empty? && !active.key?(parent)
          end
          break if orphans.empty?
          orphans.each do |n|
            out["#{n}_label"] = ''
            out["#{n}_description"] = ''
            out['visible_slot_count'] -= 1
            active.delete(n)
          end
        end

        # Pass 3 - structural select state for the survivors; the options function refines open vs awaiting_parent.
        sel_slots.each do |n|
          row = active[n]
          next if row.nil?
          out["#{n}_state"] = call(:clean, row['lookup_name']).empty? ? 'not_applicable' : 'open'
        end

        call(:ok, out)
      end,

      output_fields: lambda do |object_definitions|
        # 81 fields from the slot table, not 81 hand-written lines: 34 labels, 34 descriptions, 10 select states.
        names = call(:slot_names)
        labels = names.flat_map { |n| [{ name: "#{n}_label", type: 'string', label: "#{n} label", hint: 'Blank hides the component' },
                                       { name: "#{n}_description", type: 'string', label: "#{n} description" }] }
        states = names.select { |n| n.start_with?('slot_sel_') }
                      .map { |n| { name: "#{n}_state", type: 'string', label: "#{n} state", hint: 'unused | not_applicable | open' } }
        object_definitions['result_envelope'] + [{ name: 'visible_slot_count', type: 'integer', label: 'Visible slot count' }] + labels + states
      end,

      sample_output: lambda do |_connection, _input|
        out = { 'ok' => true, 'error' => { 'code' => '', 'message' => '' }, 'visible_slot_count' => 2 }
        call(:slot_names).each do |n|
          out["#{n}_label"] = ''
          out["#{n}_description"] = ''
        end
        call(:slot_names).select { |n| n.start_with?('slot_sel_') }.each { |n| out["#{n}_state"] = 'unused' }
        out.merge('slot_text_01_label' => 'Legal name *', 'slot_text_01_description' => 'As registered',
                  'slot_sel_01_label' => 'Country', 'slot_sel_01_state' => 'open')
      end
    },

    # ---- UTL-10 -----------------------------------------------------------------------------------------------------
    stage_form_record: {
      title: 'Stage a form record',
      subtitle: 'Join one record\'s slot values to the slot mapping and stamp them with a record_index - rows for RUN_ManualEntry',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the UTL-10 Python step; the recipe stays the sole writer of RUN_ManualEntry and sole allocator of ' \
                'record_index (concurrency 1 is the serialisation). An all-blank form is a clean no-op (nothing_to_stage), ' \
                'not an error. A prior record_index under the caller\'s idempotency key is reused (replace semantics keep a ' \
                'record\'s identity across corrections); otherwise max(existing) + 1. A mapping row without a field_id, or a ' \
                'slot the page did not send, fails here at write time, where the config defect is. Values pass through exactly ' \
                'as sent; 0 and false are values, not blanks.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'form_slots', type: 'array', of: 'object', optional: true, label: 'Form slot mapping', hint: 'CFG_FormSlotMapping rows for the template version',
            properties: object_definitions['form_slot'] },
          { name: 'request', type: 'object', optional: true, label: 'Form values', hint: 'The page\'s slot values, text_01 ... float_04',
            properties: object_definitions['form_values'] },
          { name: 'supplier_request_id', type: 'string', optional: true, label: 'Supplier request ID' },
          { name: 'reuse_record_index', type: 'integer', optional: true, label: 'Reuse record index',
            hint: 'The record_index found under the caller\'s idempotency key; blank or 0 allocates a fresh one' },
          { name: 'existing_rows', type: 'array', of: 'object', optional: true, label: 'Existing RUN_ManualEntry rows',
            hint: 'Rows for this request, fetched newest first; only record_index is read, and only on fresh allocation',
            properties: object_definitions['manual_entry_row'] }
        ]
      end,

      execute: lambda do |_connection, input|
        blank = { 'rows' => [], 'rows_count' => 0, 'record_index' => 0, 'nothing_to_stage' => false }

        slot_map = call(:rows, input['form_slots']).select { |m| m.is_a?(Hash) }
        next call(:fail, 'recipe_invariant', 'no form slot mapping rows for this template version', blank) if slot_map.empty?

        raw = input['request']
        if raw.is_a?(String)
          raw = begin
            JSON.parse(raw)
          rescue StandardError
            nil
          end
        end
        raw = {} unless raw.is_a?(Hash)
        slots = {}
        raw.each do |k, v|
          ck = call(:canonical_slot, k)
          slots[ck] = v unless ck.empty?
        end
        supplier_request_id = call(:clean, input['supplier_request_id'])

        # An all-blank record is a no-op the caller decides about. The recipe's delete still runs on this path: under
        # replace semantics a blank form is content, and the key's stale record must not survive it.
        all_blank = slots.empty? || slots.values.all? { |v| call(:is_blank_value, v) }
        next call(:ok, blank.merge('nothing_to_stage' => true)) if all_blank

        # Reuse beats allocation, and the reuse branch never consults existing_rows: the key's old rows are still in the
        # table at this point, so max + 1 would double-count them.
        reuse = call(:to_int, input['reuse_record_index'], 0)
        record_index = if reuse > 0
                         reuse
                       else
                         max_index = 0
                         call(:rows, input['existing_rows']).each do |r|
                           next unless r.is_a?(Hash)
                           idx = call(:to_int, r['record_index'], 0)
                           max_index = idx if idx > max_index
                         end
                         max_index + 1
                       end

        joined = []
        missing = {}
        slot_map.each do |m|
          slot_name = call(:canonical_slot, m['slot_name'])
          field_id = call(:clean, m['field_id'])
          next if slot_name.empty?
          if field_id.empty?
            missing["#{slot_name} (no field_id)"] = true
            next
          end
          unless slots.key?(slot_name)
            missing[slot_name] = true
            next
          end
          value = slots[slot_name]
          joined << {
            'supplier_request_id' => supplier_request_id,
            'record_index' => record_index,
            'field_id' => field_id,
            'slot_name' => slot_name,
            'label' => call(:clean, m['display_label']),
            'value' => value,
            'is_blank' => call(:is_blank_value, value)
          }
        end
        unless missing.empty?
          next call(:fail, 'state_inconsistent', "slot column(s) not stageable: #{missing.keys.sort.join(', ')}", blank)
        end

        call(:ok, 'rows' => joined, 'rows_count' => joined.length, 'record_index' => record_index, 'nothing_to_stage' => false)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'rows', type: 'array', of: 'object', label: 'Rows', hint: 'Map straight into Create records (batch) on RUN_ManualEntry', properties: object_definitions['manual_entry_row'] },
          { name: 'rows_count', type: 'integer', label: 'Row count' },
          { name: 'record_index', type: 'integer', label: 'Record index', hint: 'The index stamped on every row (reused or freshly allocated); 0 when nothing was staged' },
          { name: 'nothing_to_stage', type: 'boolean', control_type: 'checkbox', label: 'Nothing to stage', hint: 'true for an all-blank form; ok is still true' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' },
          'rows' => [{ 'supplier_request_id' => 'req-1', 'record_index' => 3, 'field_id' => 'fld-1', 'slot_name' => 'slot_text_01', 'label' => 'Legal name',
                       'value' => 'Acme Ltd', 'is_blank' => false }],
          'rows_count' => 1, 'record_index' => 3, 'nothing_to_stage' => false
        }
      end
    },

    # ---- FRM-01 -----------------------------------------------------------------------------------------------------
    pivot_staged_rows: {
      title: 'Pivot staged rows to submission payload',
      subtitle: 'Group RUN_ManualEntry rows by record_index, resolve field_id to field_name, coerce toward the file channel',
      help: lambda do |_input, _picklist_label|
        {
          body: 'Replaces the FRM-01 Python step. One source (the staged rows), one transformation: the output is what the ' \
                'XLSX parser emits, keyed by field NAME, because validate_upload looks fields up by name. Every field of the ' \
                'version appears in every record (null when the supplier never saw it). Values are coerced toward the file ' \
                'channel\'s shapes and a value that will not coerce passes through unchanged for validate_upload to report. ' \
                'A staged field_id unknown to this version fails loudly: it is the mixed-version canary. rows_json is JSON ' \
                'text, stored as-is as the file the validator reads.'
        }
      end,

      input_fields: lambda do |object_definitions|
        [
          { name: 'all_fields', type: 'array', of: 'object', optional: true, label: 'Fields (CFG_Field, this version)', hint: 'field_id, field_name and data_type are read',
            properties: object_definitions['cfg_field'] },
          { name: 'staged_rows', type: 'array', of: 'object', optional: true, label: 'Staged rows (RUN_ManualEntry)', hint: 'record_index, field_id and value are read',
            properties: object_definitions['manual_entry_row'] }
        ]
      end,

      execute: lambda do |_connection, input|
        blank = { 'rows_json' => '[]', 'row_count' => 0 }

        # Record template: every field of the canonical model, nil by default, in CFG_Field order.
        template = {}
        by_field_id = {}
        call(:rows, input['all_fields']).each do |f|
          next unless f.is_a?(Hash)
          name = call(:clean, f['field_name'])
          next if name.empty?
          template[name] = nil
          fid = call(:clean, f['field_id'])
          by_field_id[fid] = [name, f['data_type']] unless fid.empty?
        end
        if template.empty?
          next call(:fail, 'recipe_invariant', 'no field names resolved from CFG_Field - check that field_name is mapped into all_fields', blank)
        end

        groups = {}
        unknown_ids = {}
        corrupt = false
        call(:rows, input['staged_rows']).each do |r|
          next unless r.is_a?(Hash)
          idx = call(:to_int, r['record_index'], nil)
          if idx.nil?
            corrupt = true
            break
          end
          fid = call(:clean, r['field_id'])
          info = by_field_id[fid]
          if info.nil?
            unknown_ids[fid.empty? ? '(blank)' : fid] = true
            next
          end
          (groups[idx] ||= template.dup)[info[0]] = call(:coerce_value, r['value'], info[1])
        end
        if corrupt
          next call(:fail, 'state_inconsistent', 'staged row missing a usable record_index - RUN_ManualEntry staging is corrupt for this request', blank)
        end
        unless unknown_ids.empty?
          next call(:fail, 'state_inconsistent',
                    "staged rows reference field_id(s) unknown to this template version: #{unknown_ids.keys.sort.join(', ')}",
                    blank)
        end

        # An empty submission emits [] - a content outcome owned by VAL-01's 'empty' verdict, not here.
        records = groups.keys.sort.map { |k| groups[k] }
        call(:ok, 'rows_json' => records.to_json, 'row_count' => records.length)
      end,

      output_fields: lambda do |object_definitions|
        object_definitions['result_envelope'] + [
          { name: 'rows_json', type: 'string', label: 'Rows (JSON)', hint: 'A JSON array of records keyed by field name; store as the submission file' },
          { name: 'row_count', type: 'integer', label: 'Row count' }
        ]
      end,

      sample_output: lambda do |_connection, _input|
        {
          'ok' => true, 'error' => { 'code' => '', 'message' => '' },
          'rows_json' => '[{"Legal name":"Acme Ltd","Headcount":120,"Country":"FR~Commercial","Certified":true}]', 'row_count' => 1
        }
      end
    }
