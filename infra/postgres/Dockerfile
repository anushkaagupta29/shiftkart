# Postgres 16 with PostGIS (geofences, Phase 2) and pgvector (face-embedding dedup, Phase 2).
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-postgis-3 postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
COPY init.sql /docker-entrypoint-initdb.d/01-init.sql
