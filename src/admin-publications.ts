import { db } from "./db.js";

export interface PublicationFilters {
  q: string;
  user: string;
  uploader: string;
  kind: "all" | "guides" | "pages" | "files";
  lifetime: "all" | "permanent" | "anonymous-active";
}

const publications = `WITH publications AS (
  SELECT p.id, 'pages' AS kind, p.updated_at AS updated, p.slug AS label,
    COALESCE(p.title, '') AS detail, p.expires_at IS NOT NULL AS anonymous,
    pv.created_by_token_id AS uploader, t.user_id AS user, COALESCE(t.name, 'Unknown uploader') AS name
  FROM pages p JOIN page_versions pv ON pv.page_id = p.id AND pv.version = p.current_version
    LEFT JOIN tokens t ON t.id = pv.created_by_token_id
  WHERE p.expires_at IS NULL OR datetime(p.expires_at) > CURRENT_TIMESTAMP
  UNION ALL
  SELECT f.id, 'files', f.created_at, f.filename, f.media_type, 0, f.created_by_token_id, t.user_id, COALESCE(t.name, 'Unknown uploader')
    FROM files f LEFT JOIN tokens t ON t.id = f.created_by_token_id
  UNION ALL
  SELECT g.id, 'guides', g.updated_at, g.slug, g.title, 0, g.owner_token_id, t.user_id, COALESCE(t.name, 'Unknown uploader')
    FROM guides g LEFT JOIN tokens t ON t.id = g.owner_token_id
)`;

export function selectAdminPublications(filters: PublicationFilters, requestedPage = 1) {
  const where = `WHERE ($user = '' OR user = $user) AND ($uploader = '' OR uploader = $uploader)
    AND ($kind = 'all' OR kind = $kind)
    AND ($lifetime = 'all' OR ($lifetime = 'permanent' AND anonymous = 0) OR ($lifetime = 'anonymous-active' AND anonymous = 1))
    AND ($q = '' OR casefold_contains(label, $q) OR casefold_contains(detail, $q) OR casefold_contains(name, $q))`;
  const params = {
    $user: filters.user,
    $uploader: filters.uploader,
    $kind: filters.kind,
    $lifetime: filters.lifetime,
    $q: filters.q,
  };
  const counts = db()
    .prepare(
      `${publications} SELECT kind, COUNT(*) AS count FROM publications ${where} GROUP BY kind`,
    )
    .all(params) as Array<{ kind: "pages" | "files" | "guides"; count: number }>;
  const totals = { pages: 0, files: 0, guides: 0 };
  for (const row of counts) totals[row.kind] = row.count;
  const total = totals.pages + totals.files + totals.guides;
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(
    pageCount,
    Number.isSafeInteger(requestedPage) ? Math.max(1, requestedPage) : 1,
  );
  const selected = db()
    .prepare(
      `${publications} SELECT id, kind FROM publications ${where} ORDER BY updated DESC, kind, id LIMIT 50 OFFSET $offset`,
    )
    .all({ ...params, $offset: (page - 1) * 50 }) as Array<{
    id: string;
    kind: "pages" | "files" | "guides";
  }>;
  const ids = { pages: [] as string[], files: [] as string[], guides: [] as string[] };
  for (const row of selected) ids[row.kind].push(row.id);
  const uploaders = db()
    .prepare(
      `${publications} SELECT DISTINCT uploader AS id, name, user AS userId FROM publications ORDER BY name, id`,
    )
    .all() as Array<{ id: string; name: string; userId: string | null }>;
  return { ids, page, pageCount, total, totals, uploaders };
}
