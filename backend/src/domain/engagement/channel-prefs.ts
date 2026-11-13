// src/domain/engagement/channel-prefs.ts
//
// CRUD + query helpers for user_channel_prefs. The routes under /api/me/channels
// and NotificationService.fanOutToUser both go through this module so channel-
// resolution rules live in exactly one place.
import { and, asc, eq, desc } from 'drizzle-orm';
import { db, userChannelPrefs } from '../../db/client';

export interface UserChannelPref {
  id: string;
  user_id: string;
  channel: string;
  address: string;
  tenant_id: string | null;
  enabled: boolean;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserChannelPrefInput {
  id?: string;
  channel: string;
  address: string;
  tenant_id?: string | null;
  enabled?: boolean;
  is_default?: boolean;
}

export interface ResolvedRecipient {
  channel: string;
  address: string;
}

/** List all prefs for a user, defaults first, then newest first. */
export async function getPrefsForUser(userId: string): Promise<UserChannelPref[]> {
  const rows = await db.select()
    .from(userChannelPrefs)
    .where(eq(userChannelPrefs.user_id, userId))
    .orderBy(desc(userChannelPrefs.is_default), desc(userChannelPrefs.created_at));
  return rows as UserChannelPref[];
}

/** Get a single pref by id, scoped to the owning user. */
export async function getPrefById(
  userId: string,
  prefId: string,
): Promise<UserChannelPref | null> {
  const [row] = await db.select()
    .from(userChannelPrefs)
    .where(and(eq(userChannelPrefs.user_id, userId), eq(userChannelPrefs.id, prefId)));
  return (row as UserChannelPref | undefined) ?? null;
}

/** Insert a single pref for a user. */
export async function addPref(
  userId: string,
  input: UserChannelPrefInput,
): Promise<UserChannelPref> {
  const [row] = await db.insert(userChannelPrefs).values({
    user_id: userId,
    channel: input.channel,
    address: input.address,
    tenant_id: input.tenant_id ?? null,
    enabled: input.enabled ?? true,
    is_default: input.is_default ?? false,
  }).returning();
  if (!row) throw new Error('Failed to insert channel pref');
  return row as UserChannelPref;
}

/** Delete a pref scoped to the owning user. Returns true if a row was deleted. */
export async function deletePref(userId: string, prefId: string): Promise<boolean> {
  const deleted = await db.delete(userChannelPrefs)
    .where(and(eq(userChannelPrefs.user_id, userId), eq(userChannelPrefs.id, prefId)))
    .returning({ id: userChannelPrefs.id });
  return deleted.length > 0;
}

/**
 * Replace-all upsert: the payload becomes the full set of prefs for this user.
 * Rows not in the payload are deleted. Payload rows with an `id` that already
 * belongs to the user are updated in place; the rest are inserted.
 */
export async function replacePrefs(
  userId: string,
  prefs: UserChannelPrefInput[],
): Promise<UserChannelPref[]> {
  const incomingIds = new Set(prefs.map((p) => p.id).filter((id): id is string => !!id));

  // Atomic replace: the read + deletes + upserts run in ONE transaction so a
  // mid-batch failure or a concurrent edit can never leave a half-applied set
  // (mirrors replaceNotificationPrefs in notification-prefs.ts). The diff is
  // computed against the transaction's own snapshot — never via the pooled `db`
  // handle (getPrefsForUser/addPref) inside the tx.
  await db.transaction(async (tx) => {
    const existing = (await tx.select()
      .from(userChannelPrefs)
      .where(eq(userChannelPrefs.user_id, userId))) as UserChannelPref[];
    const existingIds = new Set(existing.map((r) => r.id));

    // Delete rows not in the payload.
    for (const row of existing) {
      if (!incomingIds.has(row.id)) {
        await tx.delete(userChannelPrefs).where(eq(userChannelPrefs.id, row.id));
      }
    }

    for (const input of prefs) {
      if (input.id && existingIds.has(input.id)) {
        await tx.update(userChannelPrefs)
          .set({
            channel: input.channel,
            address: input.address,
            tenant_id: input.tenant_id ?? null,
            enabled: input.enabled ?? true,
            is_default: input.is_default ?? false,
            updated_at: new Date(),
          })
          .where(and(
            eq(userChannelPrefs.id, input.id),
            eq(userChannelPrefs.user_id, userId),
          ));
      } else {
        await tx.insert(userChannelPrefs).values({
          user_id: userId,
          channel: input.channel,
          address: input.address,
          tenant_id: input.tenant_id ?? null,
          enabled: input.enabled ?? true,
          is_default: input.is_default ?? false,
        });
      }
    }
  });

  return getPrefsForUser(userId);
}

/**
 * Reverse lookup: find the user_ids that have registered `address` on
 * `channel` (enabled prefs only). This is the inbound-identity seam for
 * channels keyed by an opaque address — the Telegram webhook resolves a
 * replier's numeric `from.id` to an fr/Keycloak user this way, the analog of
 * A channel's address→Keycloak-user lookup. Returns all matches (an address
 * could in theory be shared) so the caller can intersect with the approval's
 * required approvers.
 */
export async function findUserIdsByChannelAddress(
  channel: string,
  address: string,
): Promise<string[]> {
  const rows = await db.select({ user_id: userChannelPrefs.user_id })
    .from(userChannelPrefs)
    .where(and(
      eq(userChannelPrefs.channel, channel),
      eq(userChannelPrefs.address, address),
      eq(userChannelPrefs.enabled, true),
    ))
    // Deterministic: callers that take "the first match" must not depend on
    // heap order (an UPDATE moves a row to the end and silently changes it).
    .orderBy(asc(userChannelPrefs.created_at), asc(userChannelPrefs.user_id));
  return rows.map((r) => r.user_id);
}

/**
 * The workspace the sender's link acts in: the `tenant_id` of `userId`'s enabled
 * pref for (`channel`, `address`). Null when the link is unpinned, or when the
 * user linked the same address twice for different workspaces (ambiguous).
 */
export async function findLinkedTenant(
  channel: string,
  address: string,
  userId: string,
): Promise<string | null> {
  const rows = await db.select({ tenant_id: userChannelPrefs.tenant_id })
    .from(userChannelPrefs)
    .where(and(
      eq(userChannelPrefs.channel, channel),
      eq(userChannelPrefs.address, address),
      eq(userChannelPrefs.user_id, userId),
      eq(userChannelPrefs.enabled, true),
    ));
  const tenants = new Set(rows.map((r) => r.tenant_id));
  if (tenants.size !== 1) return null;
  return [...tenants][0] ?? null;
}

/**
 * Resolve the list of enabled (channel, address) pairs for a user, default
 * prefs first. Callers (NotificationService) iterate this list and dispatch
 * one send per entry. With `tenantId`, a link pinned to ANOTHER workspace is
 * skipped (an unpinned link always receives).
 */
export async function resolveRecipients(userId: string, tenantId?: string | null): Promise<ResolvedRecipient[]> {
  const prefs = await getPrefsForUser(userId);
  return prefs
    .filter((p) => p.enabled && (!tenantId || !p.tenant_id || p.tenant_id === tenantId))
    .map((p) => ({ channel: p.channel, address: p.address }));
}
