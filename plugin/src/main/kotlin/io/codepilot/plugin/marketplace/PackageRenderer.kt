package io.codepilot.plugin.marketplace

import com.intellij.util.ui.JBUI
import java.awt.Component
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer

/** One-line package row with name + author + description. */
class PackageRenderer : ListCellRenderer<MarketplaceClient.Package> {

    override fun getListCellRendererComponent(
        list: JList<out MarketplaceClient.Package>,
        value: MarketplaceClient.Package,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        val panel = JPanel()
        panel.layout = BoxLayout(panel, BoxLayout.Y_AXIS)
        panel.isOpaque = true
        panel.background = if (isSelected) list.selectionBackground else list.background
        panel.border = BorderFactory.createCompoundBorder(
            BorderFactory.createMatteBorder(0, 0, 1, 0, JBUI.CurrentTheme.Table.lineColor()),
            JBUI.Borders.empty(4, 6),
        )
        val title = JLabel("${value.name}  (${value.slug} ${value.latestVersion ?: ""})")
        val subtitle = JLabel("by ${value.author ?: "—"} · ${value.type}")
        val desc = JLabel(value.description ?: "")
        panel.add(title)
        panel.add(subtitle)
        panel.add(desc)
        return panel
    }
}

/** Installed row: shows id@version + scope. */
class InstalledRenderer : ListCellRenderer<LocalMarketplaceStore.ActiveSkill> {

    override fun getListCellRendererComponent(
        list: JList<out LocalMarketplaceStore.ActiveSkill>,
        value: LocalMarketplaceStore.ActiveSkill,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        val label = JLabel("${value.entry.id}@${value.entry.version}  [${value.scope}]  " +
            if (value.entry.disabled) "(disabled)" else "")
        label.isOpaque = true
        label.background = if (isSelected) list.selectionBackground else list.background
        label.foreground = if (isSelected) list.selectionForeground else list.foreground
        label.border = JBUI.Borders.empty(4, 6)
        return label
    }
}