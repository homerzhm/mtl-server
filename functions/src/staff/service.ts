import {randomUUID} from 'node:crypto';
import type {Auth, UserRecord} from 'firebase-admin/auth';
import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool, PoolClient} from 'pg';

export type Caller = {uid: string; token: Record<string, unknown>};
export type RolesInput = {uid: string; isStaff: boolean; isAdmin: boolean; expectedRevision: number};
type AuthGateway = Pick<Auth, 'getUser' | 'setCustomUserClaims' | 'listUsers'>;
type Account = {
  uid: string; name: string | null; email: string | null; photoUrl: string | null;
  isStaff: boolean; isAdmin: boolean; revision: number; claimSyncStatus: string;
  createdAt: Date; lastSignInAt: Date | null;
};
type Change = {
  id: string; target_uid: string; is_staff: boolean; is_admin: boolean;
};
const accountColumns = `uid, name, email, photo_url AS "photoUrl", is_staff AS "isStaff",
  is_admin AS "isAdmin", revision, claim_sync_status AS "claimSyncStatus",
  created_at AS "createdAt", last_sign_in_at AS "lastSignInAt"`;

export function requireGoogle(caller: Caller | undefined, admin = false): Caller {
  if (!caller) throw new HttpsError('unauthenticated', 'Sign in with Google');
  const firebase = caller.token.firebase as {sign_in_provider?: string} | undefined;
  if (!caller.uid || firebase?.sign_in_provider !== 'google.com' || (admin && caller.token.admin !== true)) {
    throw new HttpsError('permission-denied', 'Google sign-in and the required role are necessary');
  }
  return caller;
}

function validateRoles(input: unknown): RolesInput {
  const value = input as Partial<RolesInput> | null;
  if (!value || typeof value.uid !== 'string' || !value.uid.length || value.uid.length > 128 ||
      typeof value.isStaff !== 'boolean' || typeof value.isAdmin !== 'boolean' ||
      !Number.isInteger(value.expectedRevision) || value.expectedRevision! < 0 || value.expectedRevision! >= 2147483647 ||
      Object.keys(value).some(key => !['uid', 'isStaff', 'isAdmin', 'expectedRevision'].includes(key))) {
    throw new HttpsError('invalid-argument', 'Expected uid, Boolean isStaff/isAdmin, and a nonnegative expectedRevision');
  }
  return value as RolesInput;
}

function googleProfile(user: UserRecord) {
  if (user.disabled) throw new HttpsError('permission-denied', 'Account is disabled');
  const google = user.providerData.find(provider => provider.providerId === 'google.com');
  if (!google) throw new HttpsError('permission-denied', 'A Google account is required');
  const timestamp = user.metadata.lastSignInTime;
  return [google.displayName ?? null, google.email ?? null, google.photoURL ?? null,
    timestamp ? new Date(timestamp) : null];
}

export class StaffService {
  constructor(private readonly pool: Pool, private readonly auth: AuthGateway) {}

  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { db.release(); }
  }

  private async lock(db: PoolClient): Promise<string | null> {
    await db.query("INSERT INTO staff_role_control (id) VALUES ('roles') ON CONFLICT (id) DO NOTHING");
    const result = await db.query("SELECT pending_change_id FROM staff_role_control WHERE id='roles' FOR UPDATE");
    return result.rows[0].pending_change_id;
  }

  private async account(db: PoolClient, uid: string): Promise<Account> {
    const result = await db.query<Account>(`SELECT ${accountColumns} FROM staff_account WHERE uid=$1`, [uid]);
    if (!result.rows[0]) throw new HttpsError('not-found', 'Staff profile not found');
    return result.rows[0];
  }

  async register(caller: Caller | undefined, input: unknown): Promise<Account> {
    const actor = requireGoogle(caller);
    if (input != null && (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)) {
      throw new HttpsError('invalid-argument', 'Registration accepts no profile or role fields');
    }
    const user = await this.auth.getUser(actor.uid);
    const profile = googleProfile(user);
    return this.transaction(async db => {
      // Deliberately never copies token claims. Existing grants are imported by setup.
      await db.query(`INSERT INTO staff_account
        (uid, name, email, photo_url, last_sign_in_at, is_staff, is_admin, revision, claim_sync_status, created_at)
        VALUES ($1,$2,$3,$4,$5,false,false,0,'APPLIED',now())
        ON CONFLICT (uid) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, photo_url=EXCLUDED.photo_url,
          last_sign_in_at=CASE WHEN staff_account.last_sign_in_at IS NULL THEN EXCLUDED.last_sign_in_at
            ELSE GREATEST(staff_account.last_sign_in_at, EXCLUDED.last_sign_in_at) END`, [actor.uid, ...profile]);
      return this.account(db, actor.uid);
    });
  }

  async setRoles(caller: Caller | undefined, input: unknown): Promise<Account> {
    const actor = requireGoogle(caller, true);
    const roles = validateRoles(input);
    const changeId = await this.transaction(async db => {
      const pending = await this.lock(db);
      const acting = await this.account(db, actor.uid);
      if (!acting.isAdmin) throw new HttpsError('permission-denied', 'Current admin access required');
      if (pending) throw new HttpsError('failed-precondition', 'STAFF_SYNC_PENDING');
      // Fresh Auth state prevents disabled/deleted admins from administering roles.
      const actingAuth = await this.auth.getUser(actor.uid);
      if (actingAuth.disabled || actingAuth.customClaims?.admin !== true) {
        throw new HttpsError('permission-denied', 'Current admin access required');
      }
      const targetAuth = await this.auth.getUser(roles.uid);
      if (roles.isStaff || roles.isAdmin) googleProfile(targetAuth);
      const target = await this.account(db, roles.uid);
      if (target.revision !== roles.expectedRevision) throw new HttpsError('aborted', 'STAFF_CONFLICT');
      if (actor.uid === roles.uid && !roles.isAdmin) throw new HttpsError('failed-precondition', 'STAFF_SELF_DEMOTION');
      if (target.isAdmin && !roles.isAdmin) {
        const count = await db.query('SELECT count(*)::int AS count FROM staff_account WHERE is_admin=true');
        if (count.rows[0].count <= 1) throw new HttpsError('failed-precondition', 'STAFF_LAST_ADMIN');
      }
      if (target.isStaff === roles.isStaff && target.isAdmin === roles.isAdmin) return null;
      return this.createChange(db, actor.uid, target, roles.isStaff, roles.isAdmin);
    });
    if (changeId) await this.reconcile();
    return this.transaction(db => this.account(db, roles.uid));
  }

  private async createChange(db: PoolClient, actorUid: string, target: Account, isStaff: boolean, isAdmin: boolean): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO staff_role_change
      (id, actor_uid, target_uid, role_revision, previous_staff, previous_admin, is_staff, is_admin, status, attempts, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',0,now())`,
    [id, actorUid, target.uid, target.revision + 1, target.isStaff, target.isAdmin, isStaff, isAdmin]);
    await db.query(`UPDATE staff_account SET is_staff=$2, is_admin=$3, revision=revision+1,
      claim_sync_status='PENDING' WHERE uid=$1`, [target.uid, isStaff, isAdmin]);
    await db.query("UPDATE staff_role_control SET pending_change_id=$1 WHERE id='roles'", [id]);
    return id;
  }

  async reconcile(): Promise<{status: 'IDLE' | 'APPLIED' | 'FAILED'; changeId?: string}> {
    return this.transaction(async db => {
      const id = await this.lock(db);
      if (!id) return {status: 'IDLE'};
      const change = (await db.query<Change>('SELECT * FROM staff_role_change WHERE id=$1', [id])).rows[0];
      if (!change) throw new Error('Missing durable role change');
      // Hold the singleton row lock across Auth AND finalization. Every worker
      // re-reads the pointer under this lock; a late worker cannot replay an old event.
      try {
        const user = await this.auth.getUser(change.target_uid);
        await this.auth.setCustomUserClaims(change.target_uid, {
          ...user.customClaims, staff: change.is_staff, admin: change.is_admin,
        });
      } catch (error) {
        const code = typeof (error as {code?: unknown})?.code === 'string' ? (error as {code: string}).code : 'auth/unknown';
        await db.query("UPDATE staff_role_change SET status='FAILED', attempts=attempts+1, error_code=$2 WHERE id=$1", [id, code]);
        await db.query("UPDATE staff_account SET claim_sync_status='FAILED' WHERE uid=$1", [change.target_uid]);
        return {status: 'FAILED', changeId: id};
      }
      await db.query("UPDATE staff_role_change SET status='APPLIED', attempts=attempts+1, error_code=NULL, applied_at=now() WHERE id=$1", [id]);
      await db.query("UPDATE staff_account SET claim_sync_status='APPLIED' WHERE uid=$1", [change.target_uid]);
      await db.query("UPDATE staff_role_control SET pending_change_id=NULL WHERE id='roles'");
      return {status: 'APPLIED', changeId: id};
    });
  }

  // Trusted CLI only. Never exported as a callable. Existing rows/roles are not overwritten.
  async importExisting(): Promise<number> {
    let pageToken: string | undefined;
    let imported = 0;
    do {
      const page = await this.auth.listUsers(1000, pageToken);
      for (const user of page.users) {
        const roles = user.customClaims;
        if (user.disabled || (!roles?.staff && !roles?.admin) || !user.providerData.some(p => p.providerId === 'google.com')) continue;
        if (roles.staff !== true && roles.admin !== true) continue;
        const profile = googleProfile(user);
        imported += await this.transaction(async db => {
          if (await this.lock(db)) throw new HttpsError('failed-precondition', 'STAFF_SYNC_PENDING');
          const result = await db.query(`INSERT INTO staff_account
            (uid,name,email,photo_url,last_sign_in_at,is_staff,is_admin,revision,claim_sync_status,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,0,'APPLIED',now()) ON CONFLICT (uid) DO NOTHING`,
          [user.uid, ...profile, roles.staff === true, roles.admin === true]);
          if (result.rowCount) {
            await db.query(`INSERT INTO staff_role_change
              (id,actor_uid,target_uid,role_revision,previous_staff,previous_admin,is_staff,is_admin,status,attempts,occurred_at,applied_at)
              VALUES ($1,'setup:import',$2,0,false,false,$3,$4,'APPLIED',0,now(),now())`,
            [randomUUID(), user.uid, roles.staff === true, roles.admin === true]);
          } else {
            const existing = await this.account(db, user.uid);
            if (existing.isStaff !== (roles.staff === true) || existing.isAdmin !== (roles.admin === true)) {
              throw new HttpsError('failed-precondition', 'STAFF_IMPORT_CONFLICT', {uid: user.uid});
            }
          }
          return result.rowCount ?? 0;
        });
      }
      pageToken = page.pageToken;
    } while (pageToken);
    return imported;
  }

  async ensureAdmin(bootstrapUid?: string): Promise<void> {
    await this.transaction(async db => {
      if (await this.lock(db)) throw new HttpsError('failed-precondition', 'STAFF_SYNC_PENDING');
      const count = await db.query('SELECT count(*)::int AS count FROM staff_account WHERE is_admin=true');
      if (count.rows[0].count > 0) return;
      if (!bootstrapUid) throw new Error('No admin exists. Rerun setup with --bootstrap-admin <explicit Firebase UID>');
      const user = await this.auth.getUser(bootstrapUid);
      const profile = googleProfile(user);
      await db.query(`INSERT INTO staff_account
        (uid,name,email,photo_url,last_sign_in_at,is_staff,is_admin,revision,claim_sync_status,created_at)
        VALUES ($1,$2,$3,$4,$5,false,false,0,'APPLIED',now()) ON CONFLICT (uid) DO NOTHING`, [bootstrapUid, ...profile]);
      const target = await this.account(db, bootstrapUid);
      // Bootstrap both flags so the initial admin can also edit products.
      await this.createChange(db, 'setup:bootstrap', target, true, true);
    });
    const sync = await this.reconcile();
    if (sync.status === 'FAILED') throw new Error('Bootstrap claim sync failed; retry reconciliation before continuing');
  }
}
