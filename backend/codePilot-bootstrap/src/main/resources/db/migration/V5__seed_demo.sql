-- ============================================================================
--  Demo seed data. MySQL 8.0+
--  Idempotent: uses INSERT IGNORE to skip existing rows.
-- ============================================================================

-- Demo tenant + user used by the Dev SSO flow.
INSERT IGNORE INTO tenants (id, slug, name)
VALUES ('00000000-0000-0000-0000-00000000dev0', 'dev', 'Developer tenant');

INSERT IGNORE INTO users (id, tenant_id, sso_subject, display_name, email)
VALUES (
  '00000000-0000-0000-0000-00000000deva',
  '00000000-0000-0000-0000-00000000dev0',
  'developer',
  'Developer',
  'developer@local.dev'
);

-- Marketplace example entries for /v1/mcp/packages.
INSERT IGNORE INTO mcp_packages (id, slug, name, type, author, latest_version, description)
VALUES
  (UUID(), 'skill.lang.java', 'Java language profile', 'skill', 'codePilot-core', '1.0.0',
   'Idiomatic guidance for Java projects: code style, exception handling, Spring conventions.'),
  (UUID(), 'skill.action.refactor', 'Refactor action skill', 'skill', 'codePilot-core', '1.0.0',
   'Drives the Refactor selection action end-to-end.');

INSERT IGNORE INTO mcp_versions (id, package_id, version, manifest_json, download_url, sha256, signature)
SELECT UUID(), p.id, '1.0.0',
       JSON_OBJECT(
         'id',     p.slug,
         'source', 'system',
         'version','1.0.0',
         'title',  p.name,
         'triggersBrief', JSON_ARRAY(JSON_OBJECT('language', JSON_ARRAY('java'))),
         'permissionsBrief', JSON_OBJECT('tools', JSON_ARRAY('fs.read','fs.replace'), 'risk', JSON_ARRAY('low','medium')),
         'audit', JSON_OBJECT('tokensEstimate', 260),
         'changelogUrl', CONCAT('https://docs.codepilot.local/skills/', p.slug, '/CHANGELOG')
       ),
       '',
       '',
       ''
  FROM mcp_packages p WHERE p.slug IN ('skill.lang.java','skill.action.refactor');

-- Plugin release row so /v1/plugin/manifest returns something in dev.
INSERT IGNORE INTO plugin_releases (id, channel, version, min_ide_build, manifest_json, rollout_percent)
VALUES (
  UUID(),
  'stable',
  '1.0.0',
  '232',
  JSON_OBJECT(
    'artifacts', JSON_ARRAY(
      JSON_OBJECT(
        'kind',     'full',
        'url',      'https://downloads.codepilot.local/plugin/1.0.0/codePilot-1.0.0.zip',
        'sha256',   '0000000000000000000000000000000000000000000000000000000000000000',
        'signature','',
        'size',     12800000,
        'covers',   JSON_ARRAY('bundle')
      )
    ),
    'changelogUrl', 'https://docs.codepilot.local/release/1.0.0'
  ),
  100
);