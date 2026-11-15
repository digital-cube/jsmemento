-- memento_event is an immutable log, as on PostgreSQL (drizzle/0001_event_immutability.sql):
-- rows are never deleted, and the only change ever allowed is archiving (setting archived_at
-- once, from NULL). SQLite has no to_jsonb(NEW): every other column is compared by name, so a
-- column added to memento_event later must be added to the second trigger too.
CREATE TRIGGER memento_event_no_delete
  BEFORE DELETE ON memento_event
BEGIN
  SELECT RAISE(ABORT, 'memento_event is immutable: DELETE is not allowed (archive instead)');
END;
--> statement-breakpoint
CREATE TRIGGER memento_event_archive_only
  BEFORE UPDATE ON memento_event
  WHEN OLD.archived_at IS NOT NULL
    OR NEW.archived_at IS NULL
    OR NEW.id IS NOT OLD.id
    OR NEW.tenant_id IS NOT OLD.tenant_id
    OR NEW.occurred_at IS NOT OLD.occurred_at
    OR NEW.received_at IS NOT OLD.received_at
    OR NEW.event_type IS NOT OLD.event_type
    OR NEW.instance_type IS NOT OLD.instance_type
    OR NEW.instance_id IS NOT OLD.instance_id
    OR NEW.actor_id IS NOT OLD.actor_id
    OR NEW.payload IS NOT OLD.payload
    OR NEW.rendered IS NOT OLD.rendered
    OR NEW.rendered_locale IS NOT OLD.rendered_locale
    OR NEW.api_key_id IS NOT OLD.api_key_id
BEGIN
  SELECT RAISE(ABORT, 'memento_event is immutable: only archiving (archived_at) is allowed');
END;
