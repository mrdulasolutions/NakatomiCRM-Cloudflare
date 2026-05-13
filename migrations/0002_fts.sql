-- FTS5 virtual tables + sync triggers.
--
-- Replaces the legacy Postgres pg_trgm indexes (Alembic 0006) with SQLite
-- FTS5. Triggers mirror inserts/updates/deletes on each base table into
-- the corresponding _fts table.
--
-- Kept in a separate migration from 0001_initial because the BEGIN..END
-- trigger bodies need a SQL parser that respects nested semicolons —
-- splitting it out keeps every line of 0001_initial parseable by simple
-- ;-split runners (e.g. miniflare test setup).

CREATE VIRTUAL TABLE contacts_fts USING fts5(
  workspace_id UNINDEXED,
  contact_id   UNINDEXED,
  first_name,
  last_name,
  email,
  title,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER contacts_ai AFTER INSERT ON contacts BEGIN
  INSERT INTO contacts_fts (workspace_id, contact_id, first_name, last_name, email, title)
  VALUES (NEW.workspace_id, NEW.id, NEW.first_name, NEW.last_name, NEW.email, NEW.title);
END;

CREATE TRIGGER contacts_ad AFTER DELETE ON contacts BEGIN
  DELETE FROM contacts_fts WHERE contact_id = OLD.id;
END;

CREATE TRIGGER contacts_au AFTER UPDATE ON contacts BEGIN
  DELETE FROM contacts_fts WHERE contact_id = OLD.id;
  INSERT INTO contacts_fts (workspace_id, contact_id, first_name, last_name, email, title)
  VALUES (NEW.workspace_id, NEW.id, NEW.first_name, NEW.last_name, NEW.email, NEW.title);
END;

CREATE VIRTUAL TABLE companies_fts USING fts5(
  workspace_id UNINDEXED,
  company_id   UNINDEXED,
  name,
  domain,
  industry,
  description,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER companies_ai AFTER INSERT ON companies BEGIN
  INSERT INTO companies_fts (workspace_id, company_id, name, domain, industry, description)
  VALUES (NEW.workspace_id, NEW.id, NEW.name, NEW.domain, NEW.industry, NEW.description);
END;

CREATE TRIGGER companies_ad AFTER DELETE ON companies BEGIN
  DELETE FROM companies_fts WHERE company_id = OLD.id;
END;

CREATE TRIGGER companies_au AFTER UPDATE ON companies BEGIN
  DELETE FROM companies_fts WHERE company_id = OLD.id;
  INSERT INTO companies_fts (workspace_id, company_id, name, domain, industry, description)
  VALUES (NEW.workspace_id, NEW.id, NEW.name, NEW.domain, NEW.industry, NEW.description);
END;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  workspace_id UNINDEXED,
  note_id      UNINDEXED,
  entity_type  UNINDEXED,
  entity_id    UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (workspace_id, note_id, entity_type, entity_id, body)
  VALUES (NEW.workspace_id, NEW.id, NEW.entity_type, NEW.entity_id, NEW.body);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = OLD.id;
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = OLD.id;
  INSERT INTO notes_fts (workspace_id, note_id, entity_type, entity_id, body)
  VALUES (NEW.workspace_id, NEW.id, NEW.entity_type, NEW.entity_id, NEW.body);
END;

CREATE VIRTUAL TABLE deals_fts USING fts5(
  workspace_id UNINDEXED,
  deal_id      UNINDEXED,
  name,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER deals_ai AFTER INSERT ON deals BEGIN
  INSERT INTO deals_fts (workspace_id, deal_id, name)
  VALUES (NEW.workspace_id, NEW.id, NEW.name);
END;

CREATE TRIGGER deals_ad AFTER DELETE ON deals BEGIN
  DELETE FROM deals_fts WHERE deal_id = OLD.id;
END;

CREATE TRIGGER deals_au AFTER UPDATE ON deals BEGIN
  DELETE FROM deals_fts WHERE deal_id = OLD.id;
  INSERT INTO deals_fts (workspace_id, deal_id, name)
  VALUES (NEW.workspace_id, NEW.id, NEW.name);
END;
