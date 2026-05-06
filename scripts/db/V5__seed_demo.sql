-- ============================================================================
--  Demo seed data. This migration is purely additive and idempotent; it is safe
--  to apply in dev and removed by operators in locked-down environments.
-- ============================================================================

-- Demo tenant + user used by the Dev SSO flow (matches `<dev-token>:<userId>:<tenant>:<device>`).
INSERT INTO tenants (id, slug, name)
VALUES ('00000000-0000-0000-0000-00000000dev0', 'dev', 'Developer tenant')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (id, tenant_id, sso_subject, display_name, email)
VALUES (
  '00000000-0000-0000-0000-00000000deva',
  '00000000-0000-0000-0000-00000000dev0',
  'developer',
  'Developer',
  'developer@local.dev'
)
ON CONFLICT (tenant_id, sso_subject) DO NOTHING;

-- Marketplace example entries for `/v1/mcp/packages`.
INSERT INTO mcp_packages (slug, name, type, author, latest_version, description)
VALUES
  ('skill.lang.java',    'Java language profile',    'skill', 'codePilot-core', '1.0.0',
   'Idiomatic guidance for Java projects: code style, exception handling, Spring conventions.'),
  ('skill.action.refactor', 'Refactor action skill', 'skill', 'codePilot-core', '1.0.0',
   'Drives the "Refactor selection" action end-to-end.')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO mcp_versions (package_id, version, manifest_json, download_url, sha256, signature)
SELECT p.id, '1.0.0',
       jsonb_build_object(
         'id',     p.slug,
         'source', 'system',
         'version','1.0.0',
         'title',  p.name,
         'triggersBrief', jsonb_build_array(jsonb_build_object('language', jsonb_build_array('java'))),
         'permissionsBrief', jsonb_build_object('tools', jsonb_build_array('fs.read','fs.replace'), 'risk', jsonb_build_array('low','medium')),
         'audit', jsonb_build_object('tokensEstimate', 260),
         'changelogUrl', 'https://docs.codepilot.local/skills/' || p.slug || '/CHANGELOG'
       )::jsonb,
       '',
       '',
       ''
  FROM mcp_packages p WHERE p.slug IN ('skill.lang.java','skill.action.refactor')
ON CONFLICT (package_id, version) DO NOTHING;

-- Plugin release row so /v1/plugin/manifest returns something in dev.
INSERT INTO plugin_releases (channel, version, min_ide_build, manifest_json, rollout_percent)
VALUES (
  'stable',
  '1.0.0',
  '232',
  jsonb_build_object(
    'artifacts', jsonb_build_array(
      jsonb_build_object(
        'kind',     'full',
        'url',      'https://downloads.codepilot.local/plugin/1.0.0/codePilot-1.0.0.zip',
        'sha256',   '0000000000000000000000000000000000000000000000000000000000000000',
        'signature','',
        'size',     12800000,
        'covers',   jsonb_build_array('bundle')
      )
    ),
    'changelogUrl', 'https://docs.codepilot.local/release/1.0.0'
  )::jsonb,
  100
)
ON CONFLICT (channel, version) DO NOTHING;