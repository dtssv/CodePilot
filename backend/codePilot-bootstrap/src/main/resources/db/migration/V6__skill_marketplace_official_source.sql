-- Marketplace skills that appear in the catalog are installable IDE-side; mark as official (not server-only).
-- Keeps runtime semantics: bundled YAML in codePilot-core may still contain source: system for classpath loading.
UPDATE mcp_versions v
    INNER JOIN mcp_packages p ON p.id = v.package_id
SET v.manifest_json = JSON_SET(v.manifest_json, '$.source', 'official')
WHERE p.slug IN ('skill.lang.java', 'skill.action.refactor')
  AND v.version = '1.0.0';
