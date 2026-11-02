/**
 * GroupAdmin.gs — small toolkit for managing Google Groups from Apps Script
 * via the Admin SDK Directory API (advanced service "AdminDirectory").
 *
 * Setup
 *   1. Services (+) → Admin SDK API → Add
 *   2. appsscript.json → add:
 *        "oauthScopes": [
 *          "https://www.googleapis.com/auth/admin.directory.group",
 *          "https://www.googleapis.com/auth/admin.directory.group.member",
 *          "https://www.googleapis.com/auth/userinfo.email"
 *        ]
 *   3. The executing account needs a Workspace admin role with Groups privileges.
 *
 * Note on the owner check: a Groups Admin can delete any group regardless of
 * ownership — the API doesn't care. The owner guard below is a *policy* guard
 * this script imposes on itself, not a permission the API enforces.
 */

const CONFIG = {
  domain: 'yourdomain.com',
  managedPrefix: 'sdc-',   // only groups whose email starts with this may be deleted
  dryRun: true,            // set false to let destructive calls through
};

// ---------------------------------------------------------------- Read

function getGroup(groupKey) {
  return AdminDirectory.Groups.get(groupKey);   // throws on 404
}

/**
 * All direct members, following pagination.
 * @param {string} groupKey  group email or id
 * @param {string} [role]    optional filter: 'OWNER' | 'MANAGER' | 'MEMBER'
 */
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

/** Lower-cased emails of the group's OWNER-role members (may include nested groups). */
function getOwners(groupKey) {
  return listMembers(groupKey, 'OWNER').map(m => m.email.toLowerCase());
}

/** Is `userEmail` (default: the executing user) an owner of the group? */
function isOwner(groupKey, userEmail) {
  const email = (userEmail || Session.getActiveUser().getEmail()).toLowerCase();
  return getOwners(groupKey).includes(email);
}

/** Logs and returns a readable summary: metadata plus members grouped by role. */
function inspectGroup(groupKey) {
  const g = getGroup(groupKey);
  const byRole = listMembers(groupKey).reduce((acc, m) => {
    (acc[m.role] = acc[m.role] || []).push(`${m.email} [${m.type}]`);
    return acc;
  }, {});
  const summary = {
    email: g.email,
    name: g.name,
    id: g.id,
    description: g.description || '',
    aliases: g.aliases || [],
    directMembersCount: Number(g.directMembersCount || 0),
    owners: byRole.OWNER || [],
    managers: byRole.MANAGER || [],
    members: byRole.MEMBER || [],
  };
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/** Every group in the customer's directory, across all domains. */
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

// ---------------------------------------------------------------- Write

/**
 * Create a group and (optionally) seed its owners.
 * @param {string}   localPart     e.g. 'sdc-analysts' → sdc-analysts@CONFIG.domain
 * @param {string}   name
 * @param {string}   description
 * @param {string[]} [ownerEmails]
 */
function createGroup(localPart, name, description, ownerEmails) {
  const email = `${localPart}@${CONFIG.domain}`;
  if (CONFIG.dryRun) {
    Logger.log(`[DRY RUN] Would create ${email} "${name}" with owners ${(ownerEmails || []).join(', ') || '(none)'}`);
    return null;
  }
  const group = AdminDirectory.Groups.insert({ email, name, description });
  (ownerEmails || []).forEach(o => addMember(email, o, 'OWNER'));
  Logger.log(`Created ${group.email} (id ${group.id})`);
  return group;
}

function addMember(groupKey, memberEmail, role) {
  return AdminDirectory.Members.insert({ email: memberEmail, role: role || 'MEMBER' }, groupKey);
}

function removeMember(groupKey, memberEmail) {
  AdminDirectory.Members.remove(groupKey, memberEmail);
}

function setMemberRole(groupKey, memberEmail, role) {
  return AdminDirectory.Members.patch({ role }, groupKey, memberEmail);
}

/**
 * Delete a group only if every guard passes:
 *   - the group exists
 *   - its email starts with CONFIG.managedPrefix
 *   - the executing user is an OWNER (bypass with { allowNonOwner: true })
 *   - CONFIG.dryRun is false
 * Returns true if deleted, false on dry run; throws when a guard refuses.
 */
function deleteGroupSafely(groupKey, options) {
  const opts = options || {};
  const g = getGroup(groupKey);
  const email = g.email.toLowerCase();
  const owners = getOwners(email);
  const me = Session.getActiveUser().getEmail().toLowerCase();

  if (!email.startsWith(CONFIG.managedPrefix)) {
    throw new Error(`Refusing to delete ${email}: not under managed prefix "${CONFIG.managedPrefix}"`);
  }
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

// ---------------------------------------------------------------- Examples

function example() {
  const target = `sdc-test@${CONFIG.domain}`;
  // createGroup('sdc-test', 'SDC Test', 'Scratch group', [Session.getActiveUser().getEmail()]);
  inspectGroup(target);
  Logger.log(`Am I an owner? ${isOwner(target)}`);
  // deleteGroupSafely(target);
}
