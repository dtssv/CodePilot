/**
 * Settings sub-sections: 连接器 · 自定义连接器 · 技能 · 远程 · 定时 · 通用
 */
import type { Codepilot } from "../../state/useCodepilot.js";
import type { Layout, Theme, ThemeName } from "../../surface.js";
import { CustomMcpPanel } from "../CustomMcpModal.js";
import { PluginsPanel } from "../PluginsPanel.js";
import { ConnectorsSection } from "./ConnectorsSection.js";
import { GeneralSection } from "./GeneralSection.js";
import { RemoteSection } from "./RemoteSection.js";
import { ScheduleSection } from "./ScheduleSection.js";
import { SkillsSection } from "./SkillsSection.js";
import { useSettingsExtras } from "./useSettingsExtras.js";
import type { SettingsExtraSection } from "./types.js";

export type { SettingsExtraSection } from "./types.js";

export function SettingsExtras({
  cp,
  section,
  onComposePrompt,
  theme,
  onTheme,
  themeName,
  onThemeName,
  layout,
  onLayout,
}: {
  cp: Codepilot;
  section: SettingsExtraSection;
  onComposePrompt?: (text: string) => void;
  theme: Theme;
  onTheme(theme: Theme): void;
  themeName: ThemeName;
  onThemeName(name: ThemeName): void;
  layout: Layout;
  onLayout(layout: Layout): void;
}): React.ReactElement {
  const extras = useSettingsExtras({ cp, section, onComposePrompt });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {extras.error && (
        <div className="mb-3 rounded-lg border border-[var(--color-remove)]/30 bg-[var(--color-remove)]/10 px-3 py-2 text-[12px] text-[var(--color-remove)]">
          {extras.error}
        </div>
      )}
      {extras.notice && (
        <div className="mb-3 rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent-dim)] px-3 py-2 text-[12px] text-[var(--color-ink)]">
          {extras.notice}
        </div>
      )}

      {section === "custom-mcp" && <CustomMcpPanel cp={cp} />}

      {section === "plugins" && <PluginsPanel cp={cp} />}

      {section === "connectors" && (
        <ConnectorsSection
          connectors={extras.connectors}
          connectorsTotal={extras.connectorsTotal}
          connectorTab={extras.connectorTab}
          connectorQueryDraft={extras.connectorQueryDraft}
          setConnectorQueryDraft={extras.setConnectorQueryDraft}
          setConnectorQuery={extras.setConnectorQuery}
          setConnectorTab={extras.setConnectorTab}
          setSelected={extras.setSelected}
          setValues={extras.setValues}
          setEditCredentials={extras.setEditCredentials}
          setError={extras.setError}
          selected={extras.selected}
          values={extras.values}
          editCredentials={extras.editCredentials}
          busy={extras.busy}
          loadConnectors={extras.loadConnectors}
          saveConnector={extras.saveConnector}
          toggleConnector={extras.toggleConnector}
        />
      )}

      {section === "skills" && (
        <SkillsSection
          onComposePrompt={onComposePrompt}
          busy={extras.busy}
          startCreateViaSkillCreator={extras.startCreateViaSkillCreator}
          skillFileRef={extras.skillFileRef}
          uploadSkillArchive={extras.uploadSkillArchive}
          skillSourceDraft={extras.skillSourceDraft}
          setSkillSourceDraft={extras.setSkillSourceDraft}
          installSkillFromSource={extras.installSkillFromSource}
          skillQueryDraft={extras.skillQueryDraft}
          setSkillQueryDraft={extras.setSkillQueryDraft}
          setSkillQuery={extras.setSkillQuery}
          skillTab={extras.skillTab}
          setSkillTab={extras.setSkillTab}
          editingSkill={extras.editingSkill}
          skillActiveFile={extras.skillActiveFile}
          skillEditHint={extras.skillEditHint}
          skillFiles={extras.skillFiles}
          skillMarkdown={extras.skillMarkdown}
          setSkillMarkdown={extras.setSkillMarkdown}
          addingSkillFile={extras.addingSkillFile}
          setAddingSkillFile={extras.setAddingSkillFile}
          newSkillFilePath={extras.newSkillFilePath}
          setNewSkillFilePath={extras.setNewSkillFilePath}
          switchSkillFile={extras.switchSkillFile}
          addSkillFile={extras.addSkillFile}
          setEditingSkill={extras.setEditingSkill}
          setSkillFiles={extras.setSkillFiles}
          setSkillActiveFile={extras.setSkillActiveFile}
          saveEditSkill={extras.saveEditSkill}
          skills={extras.skills}
          installSkill={extras.installSkill}
          openEditSkill={extras.openEditSkill}
          toggleSkill={extras.toggleSkill}
          skillsTotal={extras.skillsTotal}
          loadSkills={extras.loadSkills}
        />
      )}

      {section === "general" && (
        <GeneralSection
          cp={cp}
          state={extras.state}
          theme={theme}
          onTheme={onTheme}
          themeName={themeName}
          onThemeName={onThemeName}
          layout={layout}
          onLayout={onLayout}
          permissionMode={extras.permissionMode}
          setPermissionModeState={extras.setPermissionModeState}
          setNotice={extras.setNotice}
          lanAccess={extras.lanAccess}
          lanBusy={extras.lanBusy}
          toggleLanAccess={extras.toggleLanAccess}
          sandboxMode={extras.sandboxMode}
          sandboxBusy={extras.sandboxBusy}
          changeSandboxMode={extras.changeSandboxMode}
          updateInfo={extras.updateInfo}
          updateBusy={extras.updateBusy}
          applyUpdate={extras.applyUpdate}
          checkUpdate={extras.checkUpdate}
          imgGen={extras.imgGen}
          setImgGen={extras.setImgGen}
          saveImageGen={extras.saveImageGen}
          search={extras.search}
          setSearch={extras.setSearch}
          selectedEngine={extras.selectedEngine}
          saveWebSearch={extras.saveWebSearch}
          busy={extras.busy}
        />
      )}

      {section === "remote" && (
        <RemoteSection
          cp={cp}
          state={extras.state}
          pairCwds={extras.pairCwds}
          togglePairCwd={extras.togglePairCwd}
          busy={extras.busy}
          mintQr={extras.mintQr}
          qr={extras.qr}
          revokeAllRemote={extras.revokeAllRemote}
        />
      )}

      {section === "schedule" && (
        <ScheduleSection
          idleTitle={extras.idleTitle}
          setIdleTitle={extras.setIdleTitle}
          idlePrompt={extras.idlePrompt}
          setIdlePrompt={extras.setIdlePrompt}
          taskKind={extras.taskKind}
          setTaskKind={extras.setTaskKind}
          taskOnceAt={extras.taskOnceAt}
          setTaskOnceAt={extras.setTaskOnceAt}
          taskAt={extras.taskAt}
          setTaskAt={extras.setTaskAt}
          taskEvery={extras.taskEvery}
          setTaskEvery={extras.setTaskEvery}
          taskCron={extras.taskCron}
          setTaskCron={extras.setTaskCron}
          taskWeekdays={extras.taskWeekdays}
          setTaskWeekdays={extras.setTaskWeekdays}
          taskTimezone={extras.taskTimezone}
          setTaskTimezone={extras.setTaskTimezone}
          idleModelKey={extras.idleModelKey}
          setIdleModelKey={extras.setIdleModelKey}
          idleAgentMode={extras.idleAgentMode}
          setIdleAgentMode={extras.setIdleAgentMode}
          scheduleModels={extras.scheduleModels}
          editingTaskId={extras.editingTaskId}
          busy={extras.busy}
          saveEditIdle={extras.saveEditIdle}
          cancelEditIdle={extras.cancelEditIdle}
          addIdle={extras.addIdle}
          tasks={extras.tasks}
          beginEditIdle={extras.beginEditIdle}
          removeTask={extras.removeTask}
        />
      )}
    </div>
  );
}
