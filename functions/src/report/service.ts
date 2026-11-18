import {createHash} from 'node:crypto';
import {HttpsError} from 'firebase-functions/v2/https';
import type {Pool} from 'pg';

const entryTypes = [
  'creditEMT', 'totalCash', 'paybill', 'adjust', 'cashDepositPig',
  'creditEMTDepositPig', 'otherCost', 'weeklyPayroll',
] as const;
type EntryType = typeof entryTypes[number];
type Cursor = {day: string; id: string};
type Amount = {amountCents: number; notes: string | null};
type ListRequest = {action: 'list'; startDay: string; endDay: string; after: Cursor | null};
type ChangeIdentity = {requestID: string; entryID: string};
type ChangeRequest = ChangeIdentity & (
  {action: 'create'; day: string; type: EntryType} & Amount |
  {action: 'update'; expectedRevision: number} & Amount |
  {action: 'delete'; expectedRevision: number}
);
type Actor = {uid: string; name: string};
type Entry = Cursor & Amount & {
  type: EntryType; creatorUid: string; enteredBy: string; enteredAt: string;
  revision: number; deletedAt: string | null;
};

const entriesPerPage = 100;
const maxCents = 2147483647;
const entryFields = `id, to_char(day, 'YYYY-MM-DD') AS day, type, amount_cents AS "amountCents",
  notes, creator_uid AS "creatorUid", entered_by AS "enteredBy", entered_at AS "enteredAt",
  revision, deleted_at AS "deletedAt"`;
type EntryRow = Omit<Entry, 'enteredAt' | 'deletedAt'> & {enteredAt: Date; deletedAt: Date | null};

export function requireReportAdmin(auth: {uid: string; token: Record<string, unknown>} | undefined): Actor {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in to open Report.');
  const provider = auth.token.firebase as {sign_in_provider?: string} | undefined;
  if (auth.token.admin !== true || provider?.sign_in_provider !== 'google.com') {
    throw new HttpsError('permission-denied', 'Report requires a Google admin account.');
  }
  const name = typeof auth.token.name === 'string' ? auth.token.name.trim() : '';
  const email = typeof auth.token.email === 'string' ? auth.token.email.trim() : '';
  return {uid: auth.uid, name: name || email || auth.uid};
}

function invalid(): never {
  throw new HttpsError('invalid-argument', 'Invalid Report entry or date range.');
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}

function uuid(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input)) invalid();
  return input.toLowerCase();
}

function day(input: unknown): string {
  if (typeof input !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(input)) invalid();
  const value = new Date(input + 'T00:00:00.000Z');
  if (!Number.isFinite(value.valueOf()) || value.toISOString().slice(0, 10) !== input) invalid();
  return input;
}

function number(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) invalid();
  return input;
}

function amount(input: Record<string, unknown>): Amount {
  const amountCents = number(input.amountCents, -maxCents, maxCents);
  if (amountCents === 0 || (input.notes != null && typeof input.notes !== 'string')) invalid();
  const notes = (input.notes as string | null | undefined)?.trim() || null;
  if (notes?.includes('\0')) invalid();
  return {amountCents, notes};
}

export function parseReportRequest(input: unknown, uid: string): ListRequest | ChangeRequest {
  const request = object(input);
  if (request.actorID !== uid) throw new HttpsError('permission-denied', 'The Report account changed.');
  if (request.action === 'list') {
    const startDay = day(request.startDay);
    const endDay = day(request.endDay);
    if (startDay >= endDay) invalid();
    const cursor = request.after == null ? null : object(request.after);
    const after = cursor && {day: day(cursor.day), id: uuid(cursor.id)};
    if (after && (after.day < startDay || after.day >= endDay)) invalid();
    return {action: 'list', startDay, endDay, after};
  }

  const change = object(request.change);
  if (request.action !== change.action) invalid();
  const identity = {requestID: uuid(change.requestID), entryID: uuid(change.entryID)};
  switch (change.action) {
    case 'create': {
      const type = entryTypes.find(type => type === change.type);
      const value = amount(change);
      if (!type || (value.amountCents < 0 && type !== 'adjust')) invalid();
      return {action: 'create', ...identity, day: day(change.day), type, ...value};
    }
    case 'update':
      return {action: 'update', ...identity, expectedRevision: number(change.expectedRevision, 0, maxCents - 1),
        ...amount(change)};
    case 'delete':
      return {action: 'delete', ...identity, expectedRevision: number(change.expectedRevision, 0, maxCents - 1)};
    default:
      return invalid();
  }
}

function snapshot(row: EntryRow): Entry {
  return {...row, enteredAt: row.enteredAt.toISOString(), deletedAt: row.deletedAt?.toISOString() ?? null};
}

export class ReportService {
  constructor(private readonly pool: Pool) {}

  async list({startDay, endDay, after}: ListRequest) {
    const {rows} = await this.pool.query<EntryRow>(`
      SELECT ${entryFields} FROM report_entry
      WHERE day >= $1::date AND day < $2::date AND deleted_at IS NULL
        AND ($3::date IS NULL OR (day,id) > ($3::date,$4::uuid))
      ORDER BY day,id LIMIT $5`, [startDay, endDay, after?.day, after?.id, entriesPerPage + 1]);
    const hasNext = rows.length > entriesPerPage;
    const entries = rows.slice(0, entriesPerPage).map(snapshot);
    const last = entries.at(-1);
    return {entries, next: hasNext && last ? {day: last.day, id: last.id} : null};
  }

  async write(actor: Actor, change: ChangeRequest) {
    const fingerprint = createHash('sha256').update(JSON.stringify(change)).digest('hex');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('report-request:' || $1::text, 0))", [change.requestID]);
      const {rows: [saved]} = await db.query<{actor_uid: string; payload_hash: string; snapshot: Entry}>(
        'SELECT actor_uid,payload_hash,snapshot FROM report_entry_change WHERE id=$1', [change.requestID]);
      if (saved) {
        if (saved.actor_uid !== actor.uid || saved.payload_hash !== fingerprint) {
          throw new HttpsError('already-exists', 'The Report request ID is already in use.');
        }
        await db.query('COMMIT');
        return {entry: saved.snapshot};
      }

      let row: EntryRow | undefined;
      if (change.action === 'create') {
        const result = await db.query<EntryRow>(`
          INSERT INTO report_entry (id,day,type,amount_cents,notes,creator_uid,entered_by,entered_at,revision)
          VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),0)
          ON CONFLICT (id) DO NOTHING RETURNING ${entryFields}`,
        [change.entryID, change.day, change.type, change.amountCents, change.notes, actor.uid, actor.name]);
        row = result.rows[0];
        if (!row) throw new HttpsError('already-exists', 'The Report entry already exists.');
      } else {
        const {rows: [current]} = await db.query<{revision: number; type: EntryType; deleted_at: Date | null}>(
          'SELECT revision,type,deleted_at FROM report_entry WHERE id=$1 FOR UPDATE', [change.entryID]);
        if (!current || current.deleted_at) throw new HttpsError('not-found', 'The Report entry was deleted.');
        if (current.revision !== change.expectedRevision) {
          throw new HttpsError('aborted', 'The Report entry changed. Reload before trying again.');
        }
        if (change.action === 'update') {
          if (change.amountCents < 0 && current.type !== 'adjust') invalid();
          const result = await db.query<EntryRow>(`
            UPDATE report_entry SET amount_cents=$2,notes=$3,revision=revision+1
            WHERE id=$1 RETURNING ${entryFields}`, [change.entryID, change.amountCents, change.notes]);
          row = result.rows[0];
        } else {
          const result = await db.query<EntryRow>(`
            UPDATE report_entry SET deleted_at=clock_timestamp(),revision=revision+1
            WHERE id=$1 RETURNING ${entryFields}`, [change.entryID]);
          row = result.rows[0];
        }
      }
      const entry = snapshot(row);
      await db.query(`
        INSERT INTO report_entry_change (id,entry_id,revision,operation,actor_uid,actor_name,occurred_at,payload_hash,snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),$7,$8)`,
      [change.requestID, entry.id, entry.revision, change.action, actor.uid, actor.name, fingerprint, entry]);
      await db.query('COMMIT');
      return {entry};
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
