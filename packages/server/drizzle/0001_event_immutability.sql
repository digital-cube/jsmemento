-- memento_event is an immutable log: rows are never deleted, and the only change ever
-- allowed is archiving (setting archived_at once, from NULL). TRUNCATE (used by tests
-- and by tenant transfer tooling) is not a row operation and is not affected.
CREATE OR REPLACE FUNCTION memento_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memento_event is immutable: DELETE is not allowed (archive instead)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL
     OR NEW.archived_at IS NULL
     OR (to_jsonb(NEW) - 'archived_at') IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at') THEN
    RAISE EXCEPTION 'memento_event is immutable: only archiving (archived_at) is allowed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER memento_event_immutable
  BEFORE UPDATE OR DELETE ON memento_event
  FOR EACH ROW EXECUTE FUNCTION memento_event_guard();
