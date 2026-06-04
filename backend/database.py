from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from pathlib import Path

BASE_DIR = Path(__file__).parent
SQLALCHEMY_DATABASE_URL = f"sqlite:///{BASE_DIR / 'fec.db'}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def _enable_foreign_keys(dbapi_conn, _connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


event.listen(engine, "connect", _enable_foreign_keys)


def run_migrations():
    """
    Idempotent lightweight migrations for SQLite.

    Base.metadata.create_all() creates missing TABLES but never ALTERs existing
    ones, so columns added to the ORM models after a table already exists must be
    backfilled here. Safe to run on every startup — each ALTER only fires when the
    column is absent. Call this AFTER create_all() so the tables are guaranteed to
    exist (a fresh DB already gets the new columns and skips every ALTER).
    """
    migrations = [
        ("detections", "is_confirmed",      "ALTER TABLE detections ADD COLUMN is_confirmed BOOLEAN DEFAULT 0"),
        ("batches",    "confidence_threshold", "ALTER TABLE batches ADD COLUMN confidence_threshold FLOAT DEFAULT 0.7"),
        ("batches",    "elapsed_seconds",    "ALTER TABLE batches ADD COLUMN elapsed_seconds FLOAT"),
    ]
    with engine.begin() as conn:
        for table, column, ddl in migrations:
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()}
            if column not in existing:
                conn.exec_driver_sql(ddl)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
