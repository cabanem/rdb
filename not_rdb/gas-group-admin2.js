/**
 * GroupAdmin.gs — toolkit for managing Google Groups from Apps Script via the
 * Admin SDK Directory API ("AdminDirectory") and Groups Settings API
 * ("AdminGroupsSettings") advanced services.
 *
 * Setup
 *   1. Services (+) → add "Admin SDK API" and "Groups Settings API"
 *   2. appsscript.json → add:
 *        "oauthScopes": [
 *          "https://www.googleapis.com/auth/admin.directory.group",
 *          "https://www.googleapis.com/auth/admin.directory.group.member",
 *          "https://www.googleapis.com/auth/apps.groups.settings",
 *          "https://www.googleapis.com/auth/userinfo.email"
 *        ]
 *   3. The executing account needs a Workspace admin role with Groups privileges
 *      (create/read/update/delete) — the API does not check ownership, only role.
 *
 * Two API surfaces, two "shapes" of a group:
 *   - Directory API   → the object: address, name, description, aliases, members
 *   - Groups Settings → the behaviour: who can join/post/view, archiving, moderation
 *   A freshly-inserted group can take a few seconds to become visible to the
 *   Members and Settings endpoints, hence withRetry() below.
 */

// ====================================================================== Config

const CONFIG = {
  domain: 'yourdomain.com',
  managedPrefix: 'sdc-',   // guards: only groups under this prefix may be created/deleted here
  dryRun: true,            // set false to let writes through
  retries: 5,              // for eventual-consistency 404s right after group creation
};

/**
 * Groups Settings presets. All values are STRINGS — the API rejects booleans.
 * Full field list: Groups Settings API → Groups resource.
 */
const SETTINGS_PRESETS = {
  /** Internal team list: in-domain members, anyone in the domain can post, archived. */
  internalTeam: {
    whoCanJoin: 'INVITED_CAN_JOIN',
    allowExternalMembers: 'false',
    whoCanPostMessage: 'ALL_IN_DOMAIN_CAN_POST',
    whoCanViewGroup: 'ALL_MEMBERS_CAN_VIEW',
    whoCanViewMembership: 'ALL_MEMBERS_CAN_VIEW',
    whoCanContactOwner: 'ALL_IN_DOMAIN_CAN_CONTACT',
    isArchived: 'true',
    allowWebPosting: 'true',
    includeInGlobalAddressList: 'true',
    messageModerationLevel: 'MODERATE_NONE',
    spamModerationLevel: 'MODERATE',
  },
  /** Inbox that outside parties (e.g. suppliers) can mail into; members stay internal. */
  externalIntake: {
    whoCanJoin: 'INVITED_CAN_JOIN',
    allowExternalMembers: 'false',
    whoCanPostMessage: 'ANYONE_CAN_POST',
    whoCanViewGroup: 'ALL_MEMBERS_CAN_VIEW',
    whoCanViewMembership: 'ALL_MANAGERS_CAN_VIEW',
    whoCanContactOwner: 'ANYONE_CAN_CONTACT',
    isArchived: 'true',
    allowWebPosting: 'false',
    includeInGlobalAddressList: 'true',
    messageModerationLevel: 'MODERATE_NONE',
    spamModerationLevel: 'MODERATE',
  },
  /** Access-control group for Drive/GCP IAM sharing; not a mailing list. */
  accessOnly: {
    whoCanJoin: 'INVITED_CAN_JOIN',
    allowExternalMembers: 'false',
    whoCanPostMessage: 'NONE_CAN_POST',
    whoCanViewGroup: 'ALL_MANAGERS_CAN_VIEW',
    whoCanViewMembership: 'ALL_MANAGERS_CAN_VIEW',
    whoCanContactOwner: 'ALL_MANAGERS_CAN_CONTACT',
    isArchived: 'false',
    allowWebPosting: 'false',
    includeInGlobalAddressList: 'false',
  },
};

/**
 * A group spec — what createGroup() consumes. Edit this or build one at runtime.
 * `email` and `aliases` accept a local part ('sdc-analysts') or a full address
 * in CONFIG.domain. `owners` must have at least one entry so the group is never orphaned.
 */
const GROUP_SPEC = {
  email: 'sdc-analysts',
  name: 'SDC Analysts',
  description: 'Analyst distribution list for the SDC platform',
  owners: ['you@yourdomain.com'],
  managers: [],
  members: [],
  aliases: [],                              // e.g. ['sdc-team']
  settings: SETTINGS_PRESETS.internalTeam,  // or a custom object / null to leave defaults
  ifExists: 'error',                        // 'error' | 'reuse' (skip insert, still apply members/settings)
};

// ====================================================================== Helpers

/** Local part → full address; full address → validated + lower-cased. */
function resolveAddress_(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) throw new Error('Address is empty');
  const [local, domain] = v.includes('@') ? v.split('@') : [v, CONFIG.domain];
  if (domain !== CONFIG.domain.toLowerCase()) {
    throw new Error(`Address "${v}" is not in managed domain ${CONFIG.domain}`);
  }
  if (!/^[a-z0-9][a-z0-9._'-]{0,63}$/.test(local)) {
    throw new Error(`Invalid local part "${local}": use a-z, 0-9, . _ ' - (max 64 chars)`);
  }
  return `${local}@${domain}`;
}

function assertManaged_(email) {
  if (!email.toLowerCase().startsWith(CONFIG.managedPrefix)) {
    throw new Error(`Refusing: ${email} is not under managed prefix "${CONFIG.managedPrefix}"`);
  }
}

function assertEmailLike_(email, label) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${label} "${email}" is not an email address`);
  return email.toLowerCase();
}

/** HTTP status from an advanced-service error, or 0 if unknown. */
function statusOf_(e) {
  if (e && e.details && e.details.code) return Number(e.details.code);
  const m = /\b(4\d\d|5\d\d)\b/.exec(String(e && e.message));
  return m ? Number(m[1]) : 0;
}

/** Retry fn() on 404/429/5xx with exponential backoff — for post-create propagation lag. */
function withRetry_(fn, label) {
  let lastErr;
  for (let i = 0; i < CONFIG.retries; i++) {
    try {
      return fn();
    } catch (e) {
      const s = statusOf_(e);
      if (![404, 429, 500, 503].includes(s)) throw e;
      lastErr = e;
      Utilities.sleep(1000 * Math.pow(2, i));
      Logger.log(`retry ${i + 1}/${CONFIG.retries} for ${label} (${s})`);
    }
  }
  throw lastErr;
}

// ====================================================================== Read

function getGroup(groupKey) {
  return AdminDirectory.Groups.get(groupKey);   // throws on 404
}

/** null instead of throwing when the group doesn't exist. */
function findGroup(groupKey) {
  try { return getGroup(groupKey); }
  catch (e) { if (statusOf_(e) === 404) return null; throw e; }
}

/** All direct members, following pagination. role: 'OWNER' | 'MANAGER' | 'MEMBER' (optional). */
function listMembers(groupKey, role) {
  const members = [];
  let pageToken;
  do {
    const params = { maxResults: 200, pageToken };
    if (role) params.roles = role;
    const resp = AdminDirectory.Members.list(groupKey, params);
    members.push(...(resp.members || []));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return members;
}

function getOwners(groupKey) {
  return listMembers(groupKey, 'OWNER').map(m => m.email.toLowerCase());
}

function isOwner(groupKey, userEmail) {
  const email = (userEmail || Session.getActiveUser().getEmail()).toLowerCase();
  return getOwners(groupKey).includes(email);
}

function getGroupSettings(groupKey) {
  return AdminGroupsSettings.Groups.get(groupKey);
}

/** Metadata + members by role + the settings that most affect behaviour. */
function inspectGroup(groupKey) {
  const g = getGroup(groupKey);
  const s = getGroupSettings(g.email);
  const byRole = listMembers(g.email).reduce((acc, m) => {
    (acc[m.role] = acc[m.role] || []).push(`${m.email} [${m.type}${m.status ? ', ' + m.status : ''}]`);
    return acc;
  }, {});
  const summary = {
    email: g.email, name: g.name, id: g.id,
    description: g.description || '',
    aliases: g.aliases || [],
    directMembersCount: Number(g.directMembersCount || 0),
    owners: byRole.OWNER || [], managers: byRole.MANAGER || [], members: byRole.MEMBER || [],
    settings: {
      whoCanJoin: s.whoCanJoin, allowExternalMembers: s.allowExternalMembers,
      whoCanPostMessage: s.whoCanPostMessage, whoCanViewMembership: s.whoCanViewMembership,
      isArchived: s.isArchived, includeInGlobalAddressList: s.includeInGlobalAddressList,
    },
  };
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** Every group in the customer's directory (all domains). */
function listAllGroups() {
  const groups = [];
  let pageToken;
  do {
    const resp = AdminDirectory.Groups.list({ customer: 'my_customer', maxResults: 200, pageToken });
    groups.push(...(resp.groups || []));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  Logger.log(groups.map(g => `${g.email}\t${g.directMembersCount} members\t${g.name}`).join('\n'));
  return groups;
}

// ====================================================================== Write: create

/**
 * Create a group from a spec (see GROUP_SPEC). Validates first, then: insert →
 * aliases → members by role → settings, and returns a report of what happened.
 * Member/alias failures are collected rather than aborting, because a group with
 * one bad address is still worth finishing. Duplicates (409) are treated as success.
 */
function createGroup(spec) {
  const s = normalizeSpec_(spec);
  assertManaged_(s.email);

  const existing = findGroup(s.email);
  if (existing && s.ifExists !== 'reuse') {
    throw new Error(`Group ${s.email} already exists (id ${existing.id}). Set ifExists: 'reuse' to update it instead.`);
  }

  const plan = {
    action: existing ? 'reuse' : 'create',
    email: s.email, name: s.name, aliases: s.aliases,
    owners: s.owners, managers: s.managers, members: s.members,
    settings: s.settings ? Object.keys(s.settings) : [],
  };
  if (CONFIG.dryRun) {
    Logger.log(`[DRY RUN] ${JSON.stringify(plan, null, 2)}`);
    return { dryRun: true, plan };
  }

  const group = existing || AdminDirectory.Groups.insert({
    email: s.email, name: s.name, description: s.description,
  });
  const report = { group: group.email, id: group.id, created: !existing, aliases: [], members: [], settings: null, errors: [] };

  s.aliases.forEach(alias => {
    try {
      withRetry_(() => AdminDirectory.Groups.Aliases.insert({ alias }, group.email), `alias ${alias}`);
      report.aliases.push(alias);
    } catch (e) {
      if (statusOf_(e) === 409) report.aliases.push(`${alias} (already)`);
      else report.errors.push(`alias ${alias}: ${e.message}`);
    }
  });

  [['OWNER', s.owners], ['MANAGER', s.managers], ['MEMBER', s.members]].forEach(([role, emails]) => {
    emails.forEach(email => {
      try {
        withRetry_(() => addMember(group.email, email, role), `${role} ${email}`);
        report.members.push(`${email} → ${role}`);
      } catch (e) {
        if (statusOf_(e) === 409) report.members.push(`${email} → ${role} (already a member; role unchanged)`);
        else report.errors.push(`${role} ${email}: ${e.message}`);
      }
    });
  });

  if (s.settings) {
    try {
      withRetry_(() => AdminGroupsSettings.Groups.patch(s.settings, group.email), 'settings');
      report.settings = 'applied';
    } catch (e) {
      report.errors.push(`settings: ${e.message}`);
    }
  }

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Validate/normalise a spec. Throws with a specific message on the first problem. */
function normalizeSpec_(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('createGroup needs a spec object');
  const email = resolveAddress_(spec.email);
  const name = String(spec.name || '').trim();
  if (!name) throw new Error('spec.name is required');
  if (name.length > 73) throw new Error('spec.name must be ≤ 73 characters');

  const owners = (spec.owners || []).map(e => assertEmailLike_(e, 'owner'));
  if (owners.length === 0) throw new Error('spec.owners must contain at least one address — never create an orphaned group');
  const managers = (spec.managers || []).map(e => assertEmailLike_(e, 'manager'));
  const members = (spec.members || []).map(e => assertEmailLike_(e, 'member'));

  // One address, one role: a 409 on the second insert would silently keep the first role.
  const seen = new Set();
  [...owners, ...managers, ...members].forEach(e => {
    if (seen.has(e)) throw new Error(`${e} appears in more than one role`);
    seen.add(e);
  });
  if (seen.has(email)) throw new Error('A group cannot be a member of itself');

  const aliases = (spec.aliases || []).map(resolveAddress_).filter(a => a !== email);
  const settings = spec.settings ? Object.assign({}, spec.settings) : null;
  if (settings) {
    Object.entries(settings).forEach(([k, v]) => {
      if (typeof v === 'boolean') settings[k] = String(v);          // API wants 'true'/'false'
    });
  }
  return {
    email, name, description: String(spec.description || ''),
    owners, managers, members, aliases, settings,
    ifExists: spec.ifExists === 'reuse' ? 'reuse' : 'error',
  };
}

// ====================================================================== Write: maintain

function addMember(groupKey, memberEmail, role) {
  return AdminDirectory.Members.insert({ email: memberEmail, role: role || 'MEMBER' }, groupKey);
}

function removeMember(groupKey, memberEmail) {
  AdminDirectory.Members.remove(groupKey, memberEmail);
}

/** Also the way to promote/demote: patch the role of an existing member. */
function setMemberRole(groupKey, memberEmail, role) {
  return AdminDirectory.Members.patch({ role }, groupKey, memberEmail);
}

/** Patch any subset of Groups Settings fields (pass a preset or your own object). */
function updateGroupSettings(groupKey, settings) {
  if (CONFIG.dryRun) { Logger.log(`[DRY RUN] Would patch ${groupKey} settings: ${JSON.stringify(settings)}`); return null; }
  return AdminGroupsSettings.Groups.patch(settings, groupKey);
}

/** Rename / re-describe without touching membership. */
function updateGroupMetadata(groupKey, fields) {
  const allowed = {};
  ['name', 'description'].forEach(k => { if (fields[k] !== undefined) allowed[k] = fields[k]; });
  if (CONFIG.dryRun) { Logger.log(`[DRY RUN] Would patch ${groupKey}: ${JSON.stringify(allowed)}`); return null; }
  return AdminDirectory.Groups.patch(allowed, groupKey);
}

// ====================================================================== Write: delete

/**
 * Delete a group only if every guard passes:
 *   - the group exists
 *   - it is under CONFIG.managedPrefix
 *   - the executing user is an OWNER (bypass with { allowNonOwner: true })
 *   - CONFIG.dryRun is false
 * Returns true if deleted, false on dry run; throws when a guard refuses.
 * Deletion is immediate and unrecoverable — there is no restore window for groups.
 */
function deleteGroupSafely(groupKey, options) {
  const opts = options || {};
  const g = getGroup(groupKey);
  const email = g.email.toLowerCase();
  assertManaged_(email);

  const owners = getOwners(email);
  const me = Session.getActiveUser().getEmail().toLowerCase();
  if (!opts.allowNonOwner && !owners.includes(me)) {
    throw new Error(`Refusing to delete ${email}: ${me} is not an owner. Owners: ${owners.join(', ') || '(none)'}`);
  }
  if (CONFIG.dryRun) {
    Logger.log(`[DRY RUN] Would delete ${email} (${g.directMembersCount} members; owners: ${owners.join(', ') || '(none)'})`);
    return false;
  }
  AdminDirectory.Groups.remove(email);
  Logger.log(`Deleted ${email}`);
  return true;
}

// ====================================================================== Entry points

/** Run this from the editor after editing GROUP_SPEC above. */
function runCreateFromSpec() {
  return createGroup(GROUP_SPEC);
}

function example() {
  // createGroup({
  //   email: 'sdc-test', name: 'SDC Test', description: 'Scratch group',
  //   owners: [Session.getActiveUser().getEmail()],
  //   settings: SETTINGS_PRESETS.accessOnly,
  // });
  const target = resolveAddress_('sdc-test');
  inspectGroup(target);
  Logger.log(`Am I an owner? ${isOwner(target)}`);
  // deleteGroupSafely(target);
}
